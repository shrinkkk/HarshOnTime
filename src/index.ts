import { createActivity } from "./activities";
import type { Defer } from "./common";
import {
  type Env,
  type MemberRow,
  authenticate,
  createGroup,
  createInvite,
  creatorAnswerOk,
  formatTokenForDisplay,
  joinGroup,
  memberView,
  previewInvite,
  removeMember,
  UserError,
  validNickname,
} from "./identity";
import { getPrefs, savePrefs } from "./prefs";
import { NORMAL, isActivityKind, parseSubscribeInput, pushToMembers, recordReceipt, rotateSubscription, upsertSubscription } from "./push";
import { cancelWakeup, claimWakeup, createWakeup, listWakeups, markAwake, runWakeupCron } from "./wakeups";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const bad = (message: string, status = 400) => json({ error: message }, status);

async function body(req: Request): Promise<Record<string, unknown>> {
  const b = await req.json().catch(() => null);
  return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
}

async function handleApi(req: Request, env: Env, path: string, defer: Defer): Promise<Response> {
  // ---- Unauthenticated: creating and previewing/using an invite happen before a device has a secret. ----

  const WRONG_ANSWER = "fuck off :P";

  // Step one of creating a group: prove you're Shri before the form even appears.
  if (path === "/api/groups/check" && req.method === "POST") {
    const b = await body(req);
    if (!(await creatorAnswerOk(env, b.answer))) return bad(WRONG_ANSWER, 403);
    return json({ ok: true });
  }

  if (path === "/api/groups" && req.method === "POST") {
    const b = await body(req);
    // Checked again here: the /check call only gates the UI, this is what actually protects creation.
    if (!(await creatorAnswerOk(env, b.answer))) return bad(WRONG_ANSWER, 403);
    const groupName = typeof b.groupName === "string" ? b.groupName.trim().slice(0, 40) : "";
    const nickname = validNickname(b.nickname);
    if (!groupName) return bad("Give the group a name.");
    if (!nickname) return bad("Nicknames are 2-20 characters.");
    const out = await createGroup(env, groupName, nickname);
    return json({ deviceSecret: out.deviceSecret, group: { id: out.groupId, name: groupName }, member: { id: out.memberId, nickname } });
  }

  const inviteMatch = /^\/api\/invites\/([^/]+)$/.exec(path);
  if (inviteMatch && req.method === "GET") {
    const preview = await previewInvite(env, decodeURIComponent(inviteMatch[1]));
    return json(preview);
  }

  if (path === "/api/join" && req.method === "POST") {
    const b = await body(req);
    const nickname = validNickname(b.nickname);
    if (typeof b.token !== "string" || !b.token) return bad("Missing invite token.");
    if (!nickname) return bad("Nicknames are 2-20 characters.");
    const out = await joinGroup(env, b.token, nickname);
    return json({ deviceSecret: out.deviceSecret, group: { id: out.groupId, name: out.groupName }, member: { id: out.memberId, nickname } });
  }

  // The service worker has no access to the device secret, so these two identify themselves by
  // knowledge only a device that holds the subscription can have (its id / its old endpoint).
  if (path === "/api/receipt" && req.method === "POST") {
    const b = await body(req);
    if (typeof b.subId === "string" && /^[0-9a-f-]{36}$/.test(b.subId)) await recordReceipt(env, b.subId);
    return json({ ok: true });
  }
  if (path === "/api/subscriptions/rotate" && req.method === "POST") {
    const b = await body(req);
    const sub = parseSubscribeInput(b);
    if (!sub || typeof b.oldEndpoint !== "string") return bad("Bad subscription.");
    return json({ ok: await rotateSubscription(env, b.oldEndpoint, sub) });
  }

  // ---- Authenticated: everything else acts on the caller's own group. ----

  const ctx = await authenticate(req, env);
  if (!ctx) return bad("Not signed in on this device.", 401);

  if ((path === "/api/me" || path === "/api/home") && req.method === "GET") {
    const members = await env.DB.prepare("SELECT * FROM members WHERE group_id = ? AND removed_at IS NULL ORDER BY joined_at")
      .bind(ctx.group.id)
      .all<MemberRow>();
    const subCounts = await env.DB.prepare(
      "SELECT member_id, COUNT(*) AS n, MAX(last_error) AS err FROM subscriptions WHERE member_id IN (SELECT id FROM members WHERE group_id = ?) GROUP BY member_id",
    )
      .bind(ctx.group.id)
      .all<{ member_id: string; n: number; err: string | null }>();
    const subsByMember = new Map(subCounts.results.map((r) => [r.member_id, r]));
    const out: Record<string, unknown> = {
      group: { id: ctx.group.id, name: ctx.group.name },
      member: { id: ctx.member.id, nickname: ctx.member.nickname },
      members: members.results.map((m) => {
        const s = subsByMember.get(m.id);
        return { ...memberView(m), pushOkAt: m.push_ok_at, subscriptions: s?.n ?? 0, pushError: s?.err ?? null };
      }),
      vapidPublicKey: env.VAPID_PUBLIC_KEY,
      now: Date.now(),
    };
    if (path === "/api/home") {
      const events = await env.DB.prepare("SELECT id, kind, actor_id, text, created_at FROM events WHERE group_id = ? ORDER BY created_at DESC LIMIT 20")
        .bind(ctx.group.id)
        .all<{ id: string; kind: string; actor_id: string | null; text: string; created_at: number }>();
      out.wakeups = await listWakeups(env, ctx.group.id);
      out.events = events.results.map((e) => ({ id: e.id, kind: e.kind, actorId: e.actor_id, text: e.text, at: e.created_at }));
    }
    return json(out);
  }

  if (path === "/api/invites" && req.method === "POST") {
    const out = await createInvite(env, ctx);
    const url = new URL(req.url);
    return json({ token: out.token, code: formatTokenForDisplay(out.token), url: `${url.origin}/join#${out.token}`, expiresAt: out.expiresAt });
  }

  const removeMatch = /^\/api\/members\/([^/]+)\/remove$/.exec(path);
  if (removeMatch && req.method === "POST") {
    await removeMember(env, ctx, decodeURIComponent(removeMatch[1]));
    return json({ ok: true });
  }

  // ---- Push plumbing ----
  if (path === "/api/subscriptions" && req.method === "POST") {
    const sub = parseSubscribeInput(await body(req));
    if (!sub) return bad("Bad subscription.");
    return json({ id: await upsertSubscription(env, ctx.member.id, sub) });
  }
  if (path === "/api/push/test" && req.method === "POST") {
    // Sent synchronously (not deferred) so the caller sees what the push service said.
    const summary = await pushToMembers(
      env,
      [ctx.member.id],
      { title: "Test push", body: `If you can read this, HarshOnTime can reach ${ctx.member.nickname}'s phone.`, url: "/", tag: "test" },
      { ...NORMAL, ttlSeconds: 120 },
    );
    return json(summary);
  }

  // ---- Wake-ups ----
  if (path === "/api/wakeups" && req.method === "POST") {
    const b = await body(req);
    return json(await createWakeup(env, ctx, b.wakeAt, b.note, defer));
  }
  const wakeMatch = /^\/api\/wakeups\/([^/]+)\/(claim|awake|cancel)$/.exec(path);
  if (wakeMatch && req.method === "POST") {
    const id = decodeURIComponent(wakeMatch[1]);
    if (wakeMatch[2] === "claim") return json(await claimWakeup(env, ctx, id, defer));
    if (wakeMatch[2] === "awake") return json(await markAwake(env, ctx, id, defer));
    return json(await cancelWakeup(env, ctx, id, defer));
  }

  // ---- Activities ----
  if (path === "/api/activities" && req.method === "POST") {
    const b = await body(req);
    if (!isActivityKind(b.kind)) return bad("Unknown activity.");
    return json(await createActivity(env, ctx, b.kind, defer));
  }

  // ---- Preferences ----
  if (path === "/api/prefs" && req.method === "GET") return json(await getPrefs(env, ctx));
  if (path === "/api/prefs" && req.method === "PUT") return json(await savePrefs(env, ctx, await body(req)));

  return bad("Not found", 404);
}

export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(req, env, url.pathname, (p) => exec.waitUntil(p.catch((e) => console.error("deferred", e))));
      } catch (err) {
        if (err instanceof UserError) return bad(err.message, 409);
        console.error(err);
        return json({ error: "Server error" }, 500);
      }
    }
    return env.ASSETS.fetch(req);
  },

  async scheduled(_event: ScheduledController, env: Env, exec: ExecutionContext): Promise<void> {
    exec.waitUntil(runWakeupCron(env));
  },
} satisfies ExportedHandler<Env>;
