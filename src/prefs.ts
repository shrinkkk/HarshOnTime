// Notification preferences and per-person mutes. Stored here, enforced in push.ts recipients().

import { type AuthContext, type Env, UserError } from "./identity";
import { ACTIVITY_KINDS, DEFAULT_PREFS, type PrefsRow } from "./push";

export interface PrefsView {
  wakeupsEnabled: boolean;
  wakeupsMutedUntil: number | null;
  activitiesMutedUntil: number | null;
  kinds: Record<(typeof ACTIVITY_KINDS)[number], boolean>;
  mutes: { memberId: string; scope: "wakeups" | "activities" }[];
}

export async function getPrefs(env: Env, ctx: AuthContext): Promise<PrefsView> {
  const row = (await env.DB.prepare("SELECT * FROM prefs WHERE member_id = ?").bind(ctx.member.id).first<PrefsRow>()) ?? {
    member_id: ctx.member.id,
    ...DEFAULT_PREFS,
  };
  const mutes = await env.DB.prepare("SELECT muted_member_id, scope FROM mutes WHERE member_id = ?")
    .bind(ctx.member.id)
    .all<{ muted_member_id: string; scope: "wakeups" | "activities" }>();
  const now = Date.now();
  const live = (t: number | null) => (t && t > now ? t : null);
  return {
    wakeupsEnabled: row.wakeups_enabled === 1,
    wakeupsMutedUntil: live(row.wakeups_muted_until),
    activitiesMutedUntil: live(row.activities_muted_until),
    kinds: { breakfast: row.breakfast === 1, lunch: row.lunch === 1, snacks: row.snacks === 1, sutta: row.sutta === 1, campus: row.campus === 1 },
    mutes: mutes.results.map((m) => ({ memberId: m.muted_member_id, scope: m.scope })),
  };
}

function optionalTime(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new UserError("Bad mute time.");
  return Math.round(v);
}

export async function savePrefs(env: Env, ctx: AuthContext, b: Record<string, unknown>): Promise<PrefsView> {
  const kindsIn = (b.kinds ?? {}) as Record<string, unknown>;
  const flag = (v: unknown, dflt: boolean) => (typeof v === "boolean" ? v : dflt) ? 1 : 0;
  const wakeupsMutedUntil = optionalTime(b.wakeupsMutedUntil);
  const activitiesMutedUntil = optionalTime(b.activitiesMutedUntil);

  const mutesIn = Array.isArray(b.mutes) ? (b.mutes as unknown[]) : [];
  const members = await env.DB.prepare("SELECT id FROM members WHERE group_id = ? AND removed_at IS NULL").bind(ctx.group.id).all<{ id: string }>();
  const valid = new Set(members.results.map((m) => m.id));
  const mutes: { memberId: string; scope: "wakeups" | "activities" }[] = [];
  for (const m of mutesIn) {
    const mm = m as { memberId?: unknown; scope?: unknown };
    if (typeof mm.memberId !== "string" || !valid.has(mm.memberId) || mm.memberId === ctx.member.id) continue;
    if (mm.scope !== "wakeups" && mm.scope !== "activities") continue;
    mutes.push({ memberId: mm.memberId, scope: mm.scope });
  }

  const stmts = [
    env.DB.prepare(
      `INSERT INTO prefs (member_id, wakeups_enabled, wakeups_muted_until, activities_muted_until, breakfast, lunch, snacks, sutta, campus)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(member_id) DO UPDATE SET wakeups_enabled = excluded.wakeups_enabled, wakeups_muted_until = excluded.wakeups_muted_until,
         activities_muted_until = excluded.activities_muted_until, breakfast = excluded.breakfast, lunch = excluded.lunch,
         snacks = excluded.snacks, sutta = excluded.sutta, campus = excluded.campus`,
    ).bind(
      ctx.member.id,
      flag(b.wakeupsEnabled, true),
      wakeupsMutedUntil,
      activitiesMutedUntil,
      flag(kindsIn.breakfast, true),
      flag(kindsIn.lunch, true),
      flag(kindsIn.snacks, true),
      flag(kindsIn.sutta, true),
      flag(kindsIn.campus, true),
    ),
    env.DB.prepare("DELETE FROM mutes WHERE member_id = ?").bind(ctx.member.id),
    ...mutes.map((m) =>
      env.DB.prepare("INSERT OR IGNORE INTO mutes (member_id, muted_member_id, scope) VALUES (?, ?, ?)").bind(ctx.member.id, m.memberId, m.scope),
    ),
  ];
  await env.DB.batch(stmts);
  return getPrefs(env, ctx);
}
