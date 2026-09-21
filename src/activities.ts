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

  await env.DB.prepare("INSERT INTO activities (id, group_id, member_id, kind, text, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), ctx.group.id, ctx.member.id, kind, custom, now)
    .run();
  // A targeted plan is between the sender and the people they picked: the feed says it happened, not what it said.
  const feedText = audience
    ? kind === "custom"
      ? `${ctx.member.nickname} sent a plan to ${listNames(audience.names)}`
      : `${ctx.member.nickname} asked ${listNames(audience.names)} to go for ${ACTIVITY_LABEL[kind]}`
    : text;
  await logEvent(env, ctx.group.id, `activity.${kind}`, ctx.member.id, null, feedText);
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
