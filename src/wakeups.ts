// Wake-up requests: create, list, claim (atomic), awake, cancel, and the per-minute cron that
// sends reminders and expires stale requests. See docs/SPEC.md section 5.

import { type Defer, fmtTime, logEvent } from "./common";
import { type AuthContext, type Env, UserError } from "./identity";
import { NORMAL, URGENT, listNames, parseAudience, pushToMembers, recipients } from "./push";

const MIN_AHEAD_MS = 60 * 1000; // at least a minute out, otherwise the reminder window has already passed
const MAX_AHEAD_MS = 36 * 60 * 60 * 1000; // "today or tomorrow"
const REMINDER_LEAD_MS = 5 * 60 * 1000;
const EXPIRE_AFTER_MS = 30 * 60 * 1000;
const SHOW_FINISHED_FOR_MS = 3 * 60 * 60 * 1000; // awake/expired stay on the home screen this long
const NOTE_MAX = 200;

export interface WakeupRow {
  id: string;
  group_id: string;
  requester_id: string;
  wake_at: number;
  note: string | null;
  status: "upcoming" | "claimed" | "awake" | "expired" | "cancelled";
  claimed_by: string | null;
  claimed_at: number | null;
  awake_at: number | null;
  reminder_sent_at: number | null;
  audience: string | null; // JSON array of member ids, or NULL = everyone
  created_at: number;
}

function audienceOf(w: WakeupRow): string[] | null {
  if (!w.audience) return null;
  try { const a = JSON.parse(w.audience); return Array.isArray(a) ? a : null; } catch { return null; }
}

type Joined = WakeupRow & { requester: string; claimer: string | null };

const SELECT_JOINED = `SELECT w.*, r.nickname AS requester, c.nickname AS claimer
  FROM wakeups w JOIN members r ON r.id = w.requester_id LEFT JOIN members c ON c.id = w.claimed_by`;

export function wakeupView(w: Joined) {
  return {
    id: w.id,
    requesterId: w.requester_id,
    requester: w.requester,
    wakeAt: w.wake_at,
    note: w.note,
    status: w.status,
    claimedBy: w.claimed_by,
    claimer: w.claimer,
    claimedAt: w.claimed_at,
    awakeAt: w.awake_at,
    // "Unclaimed" is the nervous red state: reminder is out and still nobody has it.
    unclaimed: w.status === "upcoming" && w.reminder_sent_at !== null,
    audience: audienceOf(w),
    createdAt: w.created_at,
  };
}

async function getJoined(env: Env, groupId: string, id: string): Promise<Joined | null> {
  return env.DB.prepare(`${SELECT_JOINED} WHERE w.id = ? AND w.group_id = ?`).bind(id, groupId).first<Joined>();
}

export async function listWakeups(env: Env, groupId: string) {
  const now = Date.now();
  const rows = await env.DB.prepare(
    `${SELECT_JOINED} WHERE w.group_id = ? AND (w.status IN ('upcoming','claimed') OR (w.status IN ('awake','expired') AND w.wake_at > ?))
     ORDER BY w.wake_at`,
  )
    .bind(groupId, now - SHOW_FINISHED_FOR_MS)
    .all<Joined>();
  return rows.results.map(wakeupView);
}

export async function createWakeup(env: Env, ctx: AuthContext, wakeAtRaw: unknown, noteRaw: unknown, toRaw: unknown, defer: Defer) {
  const now = Date.now();
  if (typeof wakeAtRaw !== "number" || !Number.isFinite(wakeAtRaw)) throw new UserError("Pick a time.");
  const wakeAt = Math.round(wakeAtRaw);
  if (wakeAt < now + MIN_AHEAD_MS) throw new UserError("That time has already passed. Pick a later one.");
  if (wakeAt > now + MAX_AHEAD_MS) throw new UserError("Only today or tomorrow. Ask again closer to the time.");
  const note = typeof noteRaw === "string" && noteRaw.trim() ? noteRaw.trim().slice(0, NOTE_MAX) : null;
  const audience = await parseAudience(env, ctx.group.id, ctx.member.id, toRaw);

  // One live request per person at a time keeps the screen and the pushes sane.
  const existing = await env.DB.prepare(
    "SELECT id FROM wakeups WHERE group_id = ? AND requester_id = ? AND status IN ('upcoming','claimed')",
  )
    .bind(ctx.group.id, ctx.member.id)
    .first<{ id: string }>();
  if (existing) throw new UserError("You already have a wake-up pending. Cancel it first to ask for another.");

  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO wakeups (id, group_id, requester_id, wake_at, note, status, audience, created_at) VALUES (?, ?, ?, ?, ?, 'upcoming', ?, ?)",
  )
    .bind(id, ctx.group.id, ctx.member.id, wakeAt, note, audience ? JSON.stringify(audience.ids) : null, now)
    .run();

  const time = fmtTime(wakeAt);
  await logEvent(
    env, ctx.group.id, "wakeup.created", ctx.member.id, null,
    audience ? `${ctx.member.nickname} asked ${listNames(audience.names)} for a ${time} wake-up` : `${ctx.member.nickname} asked for a ${time} wake-up`,
  );

  defer(
    (async () => {
      const to = await recipients(env, ctx.group.id, ctx.member.id, { kind: "wakeups" }, audience?.ids ?? null);
      await pushToMembers(
        env,
        to,
        {
          title: `${ctx.member.nickname} needs a ${time} wake-up`,
          body: note ? `Who's got it? "${note}"` : "Who's got it?",
          url: `/?wakeup=${id}`,
          tag: `wakeup-${id}`,
          actions: [{ action: "claim", title: "I'll do it" }],
        },
        { ...NORMAL, ttlSeconds: Math.max(60, Math.min(NORMAL.ttlSeconds, Math.floor((wakeAt - now) / 1000))) },
      );
    })(),
  );

  const created = await getJoined(env, ctx.group.id, id);
  return created ? wakeupView(created) : { id };
}

export async function claimWakeup(env: Env, ctx: AuthContext, id: string, defer: Defer) {
  const now = Date.now();
  // The single conditional UPDATE is the whole concurrency story: two people tapping Claim in the
  // same second both run it, and exactly one sees changes === 1.
  const r = await env.DB.prepare(
    `UPDATE wakeups SET claimed_by = ?, claimed_at = ?, status = 'claimed'
      WHERE id = ? AND group_id = ? AND claimed_by IS NULL AND status = 'upcoming' AND requester_id <> ?`,
  )
    .bind(ctx.member.id, now, id, ctx.group.id, ctx.member.id)
    .run();
  const w = await getJoined(env, ctx.group.id, id);
  if (!w) throw new UserError("That wake-up doesn't exist.");
  if (r.meta.changes !== 1) {
    if (w.requester_id === ctx.member.id) throw new UserError("You can't claim your own wake-up.");
    if (w.claimed_by) throw new UserError(`${w.claimer} already has it.`);
    throw new UserError("This wake-up is over.");
  }

  await logEvent(env, ctx.group.id, "wakeup.claimed", ctx.member.id, w.requester_id, `${ctx.member.nickname} is waking ${w.requester}`);
  defer(
    (async () => {
      // The requester always hears who's got them; everyone else per their preferences.
      const to = await recipients(env, ctx.group.id, ctx.member.id, { kind: "wakeups" }, audienceOf(w));
      await pushToMembers(
        env,
        [w.requester_id, ...to],
        { title: `${ctx.member.nickname} is waking ${w.requester}`, body: `${fmtTime(w.wake_at)} is covered.`, url: `/?wakeup=${id}`, tag: `wakeup-${id}` },
        NORMAL,
      );
    })(),
  );
  return wakeupView(w);
}

export async function markAwake(env: Env, ctx: AuthContext, id: string, defer: Defer) {
  const now = Date.now();
  const r = await env.DB.prepare(
    "UPDATE wakeups SET status = 'awake', awake_at = ? WHERE id = ? AND group_id = ? AND requester_id = ? AND status IN ('upcoming','claimed')",
  )
    .bind(now, id, ctx.group.id, ctx.member.id)
    .run();
  const w = await getJoined(env, ctx.group.id, id);
  if (!w) throw new UserError("That wake-up doesn't exist.");
  if (r.meta.changes !== 1) {
    if (w.requester_id !== ctx.member.id) throw new UserError("Only the person being woken can say they're awake.");
    throw new UserError("This wake-up is already finished.");
  }
  await logEvent(env, ctx.group.id, "wakeup.awake", ctx.member.id, null, `${ctx.member.nickname} is awake`);
  defer(
    (async () => {
      const to = await recipients(env, ctx.group.id, ctx.member.id, { kind: "wakeups" }, audienceOf(w));
      if (w.claimed_by) to.push(w.claimed_by); // whoever was doing the waking always gets told to stop
      await pushToMembers(
        env,
        to,
        { title: `${ctx.member.nickname} is awake`, body: w.claimer ? `Nice one, ${w.claimer}.` : "Made it.", url: "/", tag: `wakeup-${id}` },
        NORMAL,
      );
    })(),
  );
  return wakeupView(w);
}

export async function cancelWakeup(env: Env, ctx: AuthContext, id: string, defer: Defer) {
  const now = Date.now();
  const r = await env.DB.prepare(
    "UPDATE wakeups SET status = 'cancelled' WHERE id = ? AND group_id = ? AND requester_id = ? AND status IN ('upcoming','claimed') AND wake_at > ?",
  )
    .bind(id, ctx.group.id, ctx.member.id, now)
    .run();
  const w = await getJoined(env, ctx.group.id, id);
  if (!w) throw new UserError("That wake-up doesn't exist.");
  if (r.meta.changes !== 1) {
    if (w.requester_id !== ctx.member.id) throw new UserError("Only the person who asked can cancel it.");
    throw new UserError("Too late to cancel this one.");
  }
  await logEvent(env, ctx.group.id, "wakeup.cancelled", ctx.member.id, null, `${ctx.member.nickname} cancelled their ${fmtTime(w.wake_at)} wake-up`);
  if (w.claimed_by) {
    const claimer = w.claimed_by;
    defer(
      pushToMembers(
        env,
        [claimer],
        { title: `${ctx.member.nickname} cancelled`, body: `No need to wake them at ${fmtTime(w.wake_at)}.`, url: "/", tag: `wakeup-${id}` },
        NORMAL,
      ),
    );
  }
  return { ok: true };
}

/**
 * Runs every minute. Everything here is idempotent: reminder_sent_at is set with a conditional
 * UPDATE before any push goes out, and expiry is a status transition that can only happen once.
 */
export async function runWakeupCron(env: Env): Promise<void> {
  const now = Date.now();

  const due = await env.DB.prepare(
    `${SELECT_JOINED} WHERE w.status IN ('upcoming','claimed') AND w.reminder_sent_at IS NULL AND w.wake_at <= ? AND w.wake_at > ?`,
  )
    .bind(now + REMINDER_LEAD_MS, now - EXPIRE_AFTER_MS)
    .all<Joined>();

  for (const w of due.results) {
    const r = await env.DB.prepare("UPDATE wakeups SET reminder_sent_at = ? WHERE id = ? AND reminder_sent_at IS NULL").bind(now, w.id).run();
    if (r.meta.changes !== 1) continue; // another tick got here first
    const time = fmtTime(w.wake_at);
    const noteLine = w.note ? ` "${w.note}"` : "";

    if (w.claimed_by) {
      await pushToMembers(
        env,
        [w.claimed_by],
        { title: `Time to wake ${w.requester}`, body: `${time}.${noteLine}`, url: `/?wakeup=${w.id}`, tag: `wakeup-${w.id}` },
        URGENT,
      );
    } else {
      const to = await recipients(env, w.group_id, w.requester_id, { kind: "wakeups" }, audienceOf(w));
      await pushToMembers(
        env,
        to,
        {
          title: `${w.requester} wants to be woken at ${time}`,
          body: `Nobody's claimed it yet.${noteLine}`,
          url: `/?wakeup=${w.id}`,
          tag: `wakeup-${w.id}`,
          actions: [{ action: "claim", title: "I'll do it" }],
        },
        URGENT,
      );
    }

    await pushToMembers(
      env,
      [w.requester_id],
      {
        title: "Are you awake?",
        body: w.claimer ? `${w.claimer} is on it. Tap when you're up.` : `It's nearly ${time}. Tap when you're up.`,
        url: `/?wakeup=${w.id}`,
        tag: `wakeup-${w.id}-awake`,
        actions: [{ action: "awake", title: "Yes, I'm awake" }],
      },
      URGENT,
    );
  }

  const stale = await env.DB.prepare(
    `${SELECT_JOINED} WHERE w.status IN ('upcoming','claimed') AND w.wake_at + ? < ?`,
  )
    .bind(EXPIRE_AFTER_MS, now)
    .all<Joined>();
  for (const w of stale.results) {
    const r = await env.DB.prepare("UPDATE wakeups SET status = 'expired' WHERE id = ? AND status IN ('upcoming','claimed')").bind(w.id).run();
    if (r.meta.changes !== 1) continue;
    await logEvent(env, w.group_id, "wakeup.expired", null, w.requester_id, `No word from ${w.requester} after the ${fmtTime(w.wake_at)} wake-up`);
  }
}
