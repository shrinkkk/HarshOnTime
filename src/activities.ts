// Quick activities: five buttons, one push each, no RSVP.

import { type Defer, logEvent } from "./common";
import { type AuthContext, type Env, UserError } from "./identity";
import { type ActivityKind, NORMAL, pushToMembers, recipients } from "./push";

const RATE_LIMIT_MS = 10 * 60 * 1000;

export const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  breakfast: "breakfast",
  lunch: "lunch",
  snacks: "snacks",
  sutta: "sutta",
  campus: "campus",
};

export async function createActivity(env: Env, ctx: AuthContext, kind: ActivityKind, defer: Defer) {
  const now = Date.now();
  const last = await env.DB.prepare(
    "SELECT created_at FROM activities WHERE member_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(ctx.member.id, kind)
    .first<{ created_at: number }>();
  if (last && now - last.created_at < RATE_LIMIT_MS) {
    const mins = Math.max(1, Math.ceil((RATE_LIMIT_MS - (now - last.created_at)) / 60000));
    throw new UserError(`You already said ${ACTIVITY_LABEL[kind]}. Try again in ${mins} min.`);
  }
  const text = `${ctx.member.nickname} wants to go for ${ACTIVITY_LABEL[kind]}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO activities (id, group_id, member_id, kind, created_at) VALUES (?, ?, ?, ?, ?)").bind(
      crypto.randomUUID(), ctx.group.id, ctx.member.id, kind, now,
    ),
  ]);
  await logEvent(env, ctx.group.id, `activity.${kind}`, ctx.member.id, null, text);
  defer(
    (async () => {
      const to = await recipients(env, ctx.group.id, ctx.member.id, { kind: "activities", activity: kind });
      await pushToMembers(env, to, { title: text, body: `Quick plan in ${ctx.group.name}`, url: "/", tag: `activity-${kind}` }, NORMAL);
    })(),
  );
  return { ok: true, text };
}
