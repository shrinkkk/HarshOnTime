import {
  type Env,
  authenticate,
  createGroup,
  createInvite,
  formatTokenForDisplay,
  joinGroup,
  memberView,
  previewInvite,
  removeMember,
  UserError,
  validNickname,
} from "./identity";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const bad = (message: string, status = 400) => json({ error: message }, status);

async function handleApi(req: Request, env: Env, path: string): Promise<Response> {
  // ---- Unauthenticated: creating and previewing/using an invite happen before a device has a secret. ----

  if (path === "/api/groups" && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { groupName?: string; nickname?: string };
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
    const b = (await req.json().catch(() => ({}))) as { token?: string; nickname?: string };
    const nickname = validNickname(b.nickname);
    if (typeof b.token !== "string" || !b.token) return bad("Missing invite token.");
    if (!nickname) return bad("Nicknames are 2-20 characters.");
    try {
      const out = await joinGroup(env, b.token, nickname);
      return json({ deviceSecret: out.deviceSecret, group: { id: out.groupId, name: out.groupName }, member: { id: out.memberId, nickname } });
    } catch (e) {
      if (e instanceof UserError) return bad(e.message, 409);
      throw e;
    }
  }

  // ---- Authenticated: everything else acts on the caller's own group. ----

  const ctx = await authenticate(req, env);
  if (!ctx) return bad("Not signed in on this device.", 401);

  if (path === "/api/me" && req.method === "GET") {
    const members = await env.DB.prepare(
      "SELECT * FROM members WHERE group_id = ? AND removed_at IS NULL ORDER BY joined_at",
    )
      .bind(ctx.group.id)
      .all<Parameters<typeof memberView>[0]>();
    return json({
      group: { id: ctx.group.id, name: ctx.group.name },
      member: { id: ctx.member.id, nickname: ctx.member.nickname },
      members: members.results.map(memberView),
    });
  }

  if (path === "/api/invites" && req.method === "POST") {
    try {
      const out = await createInvite(env, ctx);
      const url = new URL(req.url);
      return json({ token: out.token, code: formatTokenForDisplay(out.token), url: `${url.origin}/join#${out.token}`, expiresAt: out.expiresAt });
    } catch (e) {
      if (e instanceof UserError) return bad(e.message, 409);
      throw e;
    }
  }

  const removeMatch = /^\/api\/members\/([^/]+)\/remove$/.exec(path);
  if (removeMatch && req.method === "POST") {
    try {
      await removeMember(env, ctx, decodeURIComponent(removeMatch[1]));
      return json({ ok: true });
    } catch (e) {
      if (e instanceof UserError) return bad(e.message, 409);
      throw e;
    }
  }

  return bad("Not found", 404);
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(req, env, url.pathname);
      } catch (err) {
        console.error(err);
        return json({ error: "Server error" }, 500);
      }
    }
    return env.ASSETS.fetch(req);
  },

  // Wake-up reminders (Phase 3) and push delivery (Phase 2) land here; nothing is scheduled yet.
  async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {},
} satisfies ExportedHandler<Env>;
