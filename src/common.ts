// Small helpers shared by the feature modules: the recent-activity feed, and formatting times
// in the group's one time zone (India) for push text.

import type { Env } from "./identity";

export const TZ = "Asia/Kolkata";

const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });

/** "6:00 AM" in India time, for push bodies and feed text. */
export function fmtTime(ms: number): string {
  return timeFmt.format(new Date(ms));
}

export async function logEvent(
  env: Env,
  groupId: string,
  kind: string,
  actorId: string | null,
  subjectId: string | null,
  text: string,
  refId: string | null = null,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO events (id, group_id, kind, actor_id, subject_id, text, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), groupId, kind, actorId, subjectId, text, refId, Date.now())
    .run();
}

export const FEED_RETENTION_MS = 24 * 60 * 60 * 1000;

/** The feed only ever shows the last day. Run from the cron; deletes are idempotent. */
export async function pruneOldFeed(env: Env): Promise<void> {
  const cutoff = Date.now() - FEED_RETENTION_MS;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM events WHERE created_at < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM rsvps WHERE activity_id IN (SELECT id FROM activities WHERE created_at < ?)").bind(cutoff),
    env.DB.prepare("DELETE FROM activities WHERE created_at < ?").bind(cutoff),
  ]);
}

/** Something to run after the response is sent (ctx.waitUntil). Pushes always go through this. */
export type Defer = (work: Promise<unknown>) => void;
