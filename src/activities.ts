// Quick activities: five buttons, one push each, no RSVP.

import { type Defer, logEvent } from "./common";
import { type AuthContext, type Env, UserError } from "./identity";
import { type ActivityKind, NORMAL, listNames, parseAudience, pushToMembers, recipients } from "./push";

const RATE_LIMIT_MS = 10 * 60 * 1000;
const CUSTOM_RATE_LIMIT_MS = 2 * 60 * 1000;
const CUSTOM_MAX = 120;

export const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  breakfast: "breakfast",
  lunch: "lunch",
  snacks: "snacks",
  dinner: "dinner",
  sutta: "sutta",
  campus: "campus",
};

/**
 * kind is one of the five buttons, or "custom" with free text typed by the sender.
 * toRaw optionally narrows the audience to chosen members (preferences and mutes still apply).
 */
export async function createActivity(env: Env, ctx: AuthContext, kind: ActivityKind | "custom", customText: unknown, toRaw: unknown, defer: Defer) {
  const now = Date.now();
  const limit = kind === "custom" ? CUSTOM_RATE_LIMIT_MS : RATE_LIMIT_MS;
  const last = await env.DB.prepare(
    "SELECT created_at FROM activities WHERE member_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(ctx.member.id, kind)
    .first<{ created_at: number }>();
  if (last && now - last.created_at < limit) {
    const mins = Math.max(1, Math.ceil((limit - (now - last.created_at)) / 60000));
    throw new UserError(kind === "custom" ? `Easy. Try again in ${mins} min.` : `You already said ${ACTIVITY_LABEL[kind]}. Try again in ${mins} min.`);
  }
  let text: string;
  let custom: string | null = null;
  if (kind === "custom") {
    custom = typeof customText === "string" ? customText.trim().replace(/\s+/g, " ").slice(0, CUSTOM_MAX) : "";
    if (!custom) throw new UserError("Type something first.");
    text = `${ctx.member.nickname}: ${custom}`;
  } else {
    text = `${ctx.member.nickname} wants to go for ${ACTIVITY_LABEL[kind]}`;
  }
  const audience = await parseAudience(env, ctx.group.id, ctx.member.id, toRaw);

  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO activities (id, group_id, member_id, kind, text, audience, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(
      id, ctx.group.id, ctx.member.id, kind, custom, audience ? JSON.stringify(audience.ids) : null, now,
    ),
    // Whoever suggests a plan is obviously in.
    env.DB.prepare("INSERT INTO rsvps (activity_id, member_id, status, at) VALUES (?, ?, 'in', ?)").bind(id, ctx.member.id, now),
  ]);
  // A targeted plan is between the sender and the people they picked: the feed says it happened, not what it said.
  const feedText = audience
    ? kind === "custom"
      ? `${ctx.member.nickname} sent a plan to ${listNames(audience.names)}`
      : `${ctx.member.nickname} asked ${listNames(audience.names)} to go for ${ACTIVITY_LABEL[kind]}`
    : text;
  await logEvent(env, ctx.group.id, `activity.${kind}`, ctx.member.id, null, feedText, id);
  defer(
    (async () => {
      const to = await recipients(env, ctx.group.id, ctx.member.id, { kind: "activities", activity: kind }, audience?.ids ?? null);
      const payload =
        kind === "custom"
          ? { title: ctx.member.nickname, body: custom as string, url: "/", tag: `custom-${now}` }
          : { title: text, body: `Quick plan in ${ctx.group.name}`, url: "/", tag: `activity-${kind}` };
      await pushToMembers(env, to, payload, NORMAL);
    })(),
  );
  return { ok: true, text };
}

export type RsvpStatus = "in" | "out";

/** Sets, changes, or (status null) clears the caller's in/out on a plan. Only people the plan was sent to may reply. */
export async function setRsvp(env: Env, ctx: AuthContext, activityId: string, status: RsvpStatus | null) {
  const a = await env.DB.prepare("SELECT id, member_id, audience FROM activities WHERE id = ? AND group_id = ?")
    .bind(activityId, ctx.group.id)
    .first<{ id: string; member_id: string; audience: string | null }>();
  if (!a) throw new UserError("That plan doesn't exist.");
  if (a.audience) {
    let ids: unknown = [];
    try { ids = JSON.parse(a.audience); } catch {}
    if (a.member_id !== ctx.member.id && !(Array.isArray(ids) && ids.includes(ctx.member.id))) throw new UserError("This plan wasn't sent to you.");
  }
  if (status === null) {
    await env.DB.prepare("DELETE FROM rsvps WHERE activity_id = ? AND member_id = ?").bind(activityId, ctx.member.id).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO rsvps (activity_id, member_id, status, at) VALUES (?, ?, ?, ?) ON CONFLICT(activity_id, member_id) DO UPDATE SET status = excluded.status, at = excluded.at",
    )
      .bind(activityId, ctx.member.id, status, Date.now())
      .run();
  }
  return { ok: true };
}

export interface RsvpSummary {
  in: string[]; // nicknames
  out: string[];
  mine: RsvpStatus | null;
  canReply: boolean;
}

/** In/out state for a set of plans, as seen by the caller. Keyed by activity id. */
export async function rsvpSummaries(env: Env, ctx: AuthContext, activityIds: string[]): Promise<Record<string, RsvpSummary>> {
  const out: Record<string, RsvpSummary> = {};
  const ids = [...new Set(activityIds)];
  if (ids.length === 0) return out;
  const marks = ids.map(() => "?").join(",");
  const acts = await env.DB.prepare(`SELECT id, member_id, audience FROM activities WHERE group_id = ? AND id IN (${marks})`)
    .bind(ctx.group.id, ...ids)
    .all<{ id: string; member_id: string; audience: string | null }>();
  const rows = await env.DB.prepare(
    `SELECT r.activity_id, r.member_id, r.status, m.nickname FROM rsvps r JOIN members m ON m.id = r.member_id
      WHERE r.activity_id IN (${marks}) ORDER BY r.at`,
  )
    .bind(...ids)
    .all<{ activity_id: string; member_id: string; status: RsvpStatus; nickname: string }>();
  for (const a of acts.results) {
    let canReply = true;
    if (a.audience && a.member_id !== ctx.member.id) {
      try { const list = JSON.parse(a.audience); canReply = Array.isArray(list) && list.includes(ctx.member.id); } catch { canReply = false; }
    }
    out[a.id] = { in: [], out: [], mine: null, canReply };
  }
  for (const r of rows.results) {
    const s = out[r.activity_id];
    if (!s || !s.canReply) continue; // a plan not sent to you shows neither its text nor who's in
    (r.status === "in" ? s.in : s.out).push(r.nickname);
    if (r.member_id === ctx.member.id) s.mine = r.status;
  }
  return out;
}
