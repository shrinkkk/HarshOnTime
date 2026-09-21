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
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO events (id, group_id, kind, actor_id, subject_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), groupId, kind, actorId, subjectId, text, Date.now())
    .run();
}

/** Something to run after the response is sent (ctx.waitUntil). Pushes always go through this. */
export type Defer = (work: Promise<unknown>) => void;
