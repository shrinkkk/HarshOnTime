// Push plumbing: who should receive a push (preferences and mutes, enforced here and nowhere else),
// fan-out to their subscriptions, receipts, and dead-subscription cleanup.

import { type Env, UserError } from "./identity";
import { sendPush, type PushOptions, type VapidConfig, vapidAuthorization } from "./webpush";

export const ACTIVITY_KINDS = ["breakfast", "lunch", "snacks", "dinner", "sutta", "campus"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export function isActivityKind(v: unknown): v is ActivityKind {
  return typeof v === "string" && (ACTIVITY_KINDS as readonly string[]).includes(v);
}

/** What a push is about, so the recipient's preferences can be applied. "custom" plans have no per-kind switch; only mutes apply. */
export type PushScope = { kind: "wakeups" } | { kind: "activities"; activity: ActivityKind | "custom" };

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  actions?: { action: string; title: string }[];
}

export interface SubscriptionRow {
  id: string;
  member_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  platform: string;
  created_at: number;
  last_ok_at: number | null;
  last_error: string | null;
}

export interface PrefsRow {
  member_id: string;
  wakeups_enabled: number;
  wakeups_muted_until: number | null;
  activities_muted_until: number | null;
  breakfast: number;
  lunch: number;
  snacks: number;
  dinner: number;
  sutta: number;
  campus: number;
}

export const DEFAULT_PREFS: Omit<PrefsRow, "member_id"> = {
  wakeups_enabled: 1,
  wakeups_muted_until: null,
  activities_muted_until: null,
  breakfast: 1,
  lunch: 1,
  snacks: 1,
  dinner: 1,
  sutta: 1,
  campus: 1,
};

// Reminders must arrive now or not at all; everything else can wait a little.
export const URGENT: PushOptions = { ttlSeconds: 20 * 60, urgency: "high" };
export const NORMAL: PushOptions = { ttlSeconds: 60 * 60, urgency: "normal" };

let vapidCache: VapidConfig | null = null;
export function vapid(env: Env): VapidConfig {
  if (!vapidCache) {
    vapidCache = { publicKey: env.VAPID_PUBLIC_KEY, privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK), subject: env.VAPID_SUBJECT };
  }
  return vapidCache;
}

/**
 * The members of a group who should hear about something `actorId` did, after applying each
 * member's own preferences and per-person mutes. The actor never receives their own push.
 * A member with no prefs row gets the defaults (everything on).
 */
export async function recipients(env: Env, groupId: string, actorId: string, scope: PushScope, only?: string[] | null): Promise<string[]> {
  const allow = only ? new Set(only) : null;
  const rows = await env.DB.prepare(
    `SELECT m.id AS id, p.member_id AS pm, p.wakeups_enabled, p.wakeups_muted_until, p.activities_muted_until,
            p.breakfast, p.lunch, p.snacks, p.dinner, p.sutta, p.campus
       FROM members m LEFT JOIN prefs p ON p.member_id = m.id
      WHERE m.group_id = ? AND m.removed_at IS NULL AND m.id <> ?`,
  )
    .bind(groupId, actorId)
    .all<{ id: string; pm: string | null } & Omit<PrefsRow, "member_id">>();
  const mutes = await env.DB.prepare("SELECT member_id FROM mutes WHERE muted_member_id = ? AND scope = ?")
    .bind(actorId, scope.kind)
    .all<{ member_id: string }>();
  const mutedBy = new Set(mutes.results.map((r) => r.member_id));
  const now = Date.now();
  return rows.results
    .filter((r) => {
      if (allow && !allow.has(r.id)) return false;
      if (mutedBy.has(r.id)) return false;
      if (r.pm === null) return true;
      if (scope.kind === "wakeups") return r.wakeups_enabled === 1 && !(r.wakeups_muted_until && r.wakeups_muted_until > now);
      if (r.activities_muted_until && r.activities_muted_until > now) return false;
      return scope.activity === "custom" || r[scope.activity] === 1;
    })
    .map((r) => r.id);
}

export interface SendSummary {
  subscriptions: number;
  delivered: number; // accepted by the push service (2xx); not the same as shown on a phone
  results: { subId: string; platform: string; status: number; detail?: string }[];
}

/** Sends one payload to every subscription of the given members. Cleans up dead subscriptions. */
export async function pushToMembers(env: Env, memberIds: string[], payload: PushPayload, opts: PushOptions): Promise<SendSummary> {
  const ids = [...new Set(memberIds)];
  if (ids.length === 0) return { subscriptions: 0, delivered: 0, results: [] };
  const subs = await env.DB.prepare(`SELECT * FROM subscriptions WHERE member_id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all<SubscriptionRow>();
  if (subs.results.length === 0) return { subscriptions: 0, delivered: 0, results: [] };

  // One VAPID signature per push-service origin (Google, Apple), computed up front so the parallel
  // sends below don't each sign their own.
  const v = vapid(env);
  const authCache = new Map<string, string>();
  for (const s of subs.results) {
    const origin = new URL(s.endpoint).origin;
    if (!authCache.has(origin)) authCache.set(origin, await vapidAuthorization(s.endpoint, v));
  }

  const pushId = crypto.randomUUID();
  const sent = await Promise.all(
    subs.results.map(async (s) => ({
      s,
      r: await sendPush({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, { ...payload, pushId, subId: s.id }, v, opts, authCache),
    })),
  );

  const stmts: D1PreparedStatement[] = [];
  const results: SendSummary["results"] = [];
  let delivered = 0;
  for (const { s, r } of sent) {
    results.push({ subId: s.id, platform: s.platform, status: r.status, detail: r.detail });
    if (r.gone) {
      stmts.push(env.DB.prepare("DELETE FROM subscriptions WHERE id = ?").bind(s.id));
    } else if (r.status >= 200 && r.status < 300) {
      delivered++;
      stmts.push(env.DB.prepare("UPDATE subscriptions SET last_error = NULL WHERE id = ?").bind(s.id));
    } else {
      stmts.push(env.DB.prepare("UPDATE subscriptions SET last_error = ? WHERE id = ?").bind(`${r.status} ${r.detail ?? ""}`.trim().slice(0, 200), s.id));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { subscriptions: subs.results.length, delivered, results };
}

/** Records that a device actually received and showed a push. subId is the only credential: only a device that got the push knows it. */
export async function recordReceipt(env: Env, subId: string): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE subscriptions SET last_ok_at = ?, last_error = NULL WHERE id = ?").bind(now, subId),
    env.DB.prepare("UPDATE members SET push_ok_at = ? WHERE id = (SELECT member_id FROM subscriptions WHERE id = ?)").bind(now, subId),
  ]);
}

export interface SubscribeInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  platform: string;
}

export function parseSubscribeInput(b: Record<string, unknown>): SubscribeInput | null {
  const endpoint = typeof b.endpoint === "string" ? b.endpoint : "";
  const p256dh = typeof b.p256dh === "string" ? b.p256dh : "";
  const auth = typeof b.auth === "string" ? b.auth : "";
  const platform = typeof b.platform === "string" ? b.platform.slice(0, 40) : "unknown";
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 2000 || !p256dh || !auth) return null;
  return { endpoint, p256dh, auth, platform };
}

/** Upserts by endpoint: the same browser re-subscribing (or a device handed to another member) just updates the row. */
export async function upsertSubscription(env: Env, memberId: string, sub: SubscribeInput): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO subscriptions (id, member_id, endpoint, p256dh, auth, platform, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET member_id = excluded.member_id, p256dh = excluded.p256dh, auth = excluded.auth,
       platform = excluded.platform, last_error = NULL`,
  )
    .bind(id, memberId, sub.endpoint, sub.p256dh, sub.auth, sub.platform, Date.now())
    .run();
  const row = await env.DB.prepare("SELECT id FROM subscriptions WHERE endpoint = ?").bind(sub.endpoint).first<{ id: string }>();
  return row?.id ?? id;
}

/** The browser replaced a subscription behind our back (pushsubscriptionchange). Knowing the old endpoint is the credential. */
export async function rotateSubscription(env: Env, oldEndpoint: string, sub: SubscribeInput): Promise<boolean> {
  const r = await env.DB.prepare(
    "UPDATE subscriptions SET endpoint = ?, p256dh = ?, auth = ?, last_error = NULL WHERE endpoint = ?",
  )
    .bind(sub.endpoint, sub.p256dh, sub.auth, oldEndpoint)
    .run();
  return r.meta.changes === 1;
}

export interface Audience {
  ids: string[];
  names: string[];
}

/**
 * Parses an optional "send only to these people" list: member ids that are current members of the
 * group and not the sender. Returns null for "everyone". Throws if a list was given but nobody valid was on it.
 */
export async function parseAudience(env: Env, groupId: string, senderId: string, raw: unknown): Promise<Audience | null> {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) throw new UserError("Bad recipient list.");
  const members = await env.DB.prepare("SELECT id, nickname FROM members WHERE group_id = ? AND removed_at IS NULL ORDER BY joined_at")
    .bind(groupId)
    .all<{ id: string; nickname: string }>();
  const wanted = new Set(raw.filter((v): v is string => typeof v === "string"));
  const chosen = members.results.filter((m) => wanted.has(m.id) && m.id !== senderId);
  if (chosen.length === 0) throw new UserError("Pick at least one person.");
  return { ids: chosen.map((m) => m.id), names: chosen.map((m) => m.nickname) };
}

export function listNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}
