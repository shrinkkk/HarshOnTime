// Groups, invites, join/leave, and the device-secret auth middleware.
// See docs/SPEC.md section 3 for the identity and security model this implements.

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  VAPID_PUBLIC_KEY: string;
  VAPID_SUBJECT: string;
  VAPID_PRIVATE_JWK: string;
  /** Comma-separated accepted answers to the "are you Shri?" question that gates group creation. Secret. */
  CREATE_GROUP_ANSWERS?: string;
}

export interface GroupRow {
  id: string;
  name: string;
  created_at: number;
}

export interface MemberRow {
  id: string;
  group_id: string;
  nickname: string;
  secret_hash: string | null;
  joined_at: number;
  last_seen_at: number;
  push_ok_at: number | null;
  removed_at: number | null;
}

export interface AuthContext {
  member: MemberRow;
  group: GroupRow;
}

const MAX_MEMBERS = 9;
const INVITE_LIFETIME_MS = 48 * 60 * 60 * 1000;
// Crockford's alphabet: no I, L, O, U, so a misread or mis-typed character can't be confused for
// another letter or a digit. The token is used both as the /join#<token> link and a hand-typed code.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

/** A 256-bit bearer secret the device stores in localStorage; the server keeps only its hash. */
export function newDeviceSecret(): string {
  return randomToken(32);
}

/** A ~128-bit invite token, usable as a link fragment or (with dashes stripped) a typed code. */
export function newInviteToken(): string {
  return randomToken(16);
}

/** Strips the display dashes and normalises case so a hand-typed code matches what was hashed. */
export function normalizeToken(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export function formatTokenForDisplay(token: string): string {
  return token.match(/.{1,4}/g)?.join("-") ?? token;
}

/**
 * Only Shri creates groups for now. The accepted answers live in a Worker secret, never in the repo,
 * and are compared by digest so timing doesn't leak them. Missing secret = nobody can create.
 */
export async function creatorAnswerOk(env: Env, answer: unknown): Promise<boolean> {
  if (typeof answer !== "string" || !env.CREATE_GROUP_ANSWERS) return false;
  const given = await sha256Hex(answer.trim().toLowerCase());
  let ok = false;
  for (const accepted of env.CREATE_GROUP_ANSWERS.split(",")) {
    const want = await sha256Hex(accepted.trim().toLowerCase());
    if (want === given) ok = true; // no early return: same work regardless of which entry matches
  }
  return ok;
}

export function validNickname(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed.length < 2 || trimmed.length > 20) return null;
  return trimmed;
}

export function memberView(m: MemberRow) {
  return {
    id: m.id,
    nickname: m.nickname,
    joinedAt: m.joined_at,
    lastSeenAt: m.last_seen_at,
    active: m.removed_at === null,
  };
}

/** Resolves the Authorization: Bearer <secret> header to a live (member, group) pair. */
export async function authenticate(req: Request, env: Env): Promise<AuthContext | null> {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return null;
  const hash = await sha256Hex(match[1]);
  const member = await env.DB.prepare("SELECT * FROM members WHERE secret_hash = ? AND removed_at IS NULL")
    .bind(hash)
    .first<MemberRow>();
  if (!member) return null;
  const group = await env.DB.prepare("SELECT * FROM groups WHERE id = ?").bind(member.group_id).first<GroupRow>();
  if (!group) return null;
  await env.DB.prepare("UPDATE members SET last_seen_at = ? WHERE id = ?").bind(Date.now(), member.id).run();
  return { member, group };
}

export async function createGroup(env: Env, groupName: string, nickname: string) {
  const now = Date.now();
  const groupId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const secret = newDeviceSecret();
  const secretHash = await sha256Hex(secret);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)").bind(groupId, groupName, now),
    env.DB.prepare(
      "INSERT INTO members (id, group_id, nickname, secret_hash, joined_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(memberId, groupId, nickname, secretHash, now, now),
  ]);
  return { deviceSecret: secret, groupId, memberId };
}

export type InvitePreview =
  | { valid: true; groupName: string; memberCount: number }
  | { valid: false; reason: string };

export async function previewInvite(env: Env, rawToken: string): Promise<InvitePreview> {
  const hash = await sha256Hex(normalizeToken(rawToken));
  const invite = await env.DB.prepare("SELECT * FROM invites WHERE token_hash = ?").bind(hash).first<{
    group_id: string;
    expires_at: number;
    used_by: string | null;
    revoked_at: number | null;
  }>();
  if (!invite) return { valid: false, reason: "This invite doesn't exist. Check the link or code." };
  if (invite.revoked_at) return { valid: false, reason: "This invite was cancelled." };
  if (invite.used_by) return { valid: false, reason: "This invite was already used." };
  if (invite.expires_at < Date.now()) return { valid: false, reason: "This invite has expired." };
  const group = await env.DB.prepare("SELECT name FROM groups WHERE id = ?").bind(invite.group_id).first<{ name: string }>();
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE group_id = ? AND removed_at IS NULL")
    .bind(invite.group_id)
    .first<{ n: number }>();
  if (!group) return { valid: false, reason: "That group no longer exists." };
  if ((count?.n ?? 0) >= MAX_MEMBERS) return { valid: false, reason: "This group already has 9 members." };
  return { valid: true, groupName: group.name, memberCount: count?.n ?? 0 };
}

export async function createInvite(env: Env, ctx: AuthContext) {
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE group_id = ? AND removed_at IS NULL")
    .bind(ctx.group.id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_MEMBERS) throw new UserError("This group already has 9 members.");
  const token = newInviteToken();
  const hash = await sha256Hex(token);
  const now = Date.now();
  const expiresAt = now + INVITE_LIFETIME_MS;
  await env.DB.prepare(
    "INSERT INTO invites (token_hash, group_id, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(hash, ctx.group.id, ctx.member.id, expiresAt, now)
    .run();
  return { token, expiresAt };
}

export class UserError extends Error {}

export async function joinGroup(env: Env, rawToken: string, nickname: string) {
  const token = normalizeToken(rawToken);
  const hash = await sha256Hex(token);
  const preview = await previewInvite(env, token);
  if (!preview.valid) throw new UserError(preview.reason);

  const invite = await env.DB.prepare("SELECT group_id FROM invites WHERE token_hash = ?").bind(hash).first<{ group_id: string }>();
  if (!invite) throw new UserError("This invite doesn't exist. Check the link or code.");

  const dup = await env.DB.prepare(
    "SELECT id FROM members WHERE group_id = ? AND nickname = ? COLLATE NOCASE AND removed_at IS NULL",
  )
    .bind(invite.group_id, nickname)
    .first<{ id: string }>();
  if (dup) throw new UserError("Someone in the group already uses that nickname. Pick another.");

  const now = Date.now();
  const memberId = crypto.randomUUID();
  const secret = newDeviceSecret();
  const secretHash = await sha256Hex(secret);

  // Claim the invite (reserving memberId as its used_by) before the member row exists: the
  // conditional UPDATE is what makes two people racing the same link or code unable to both get
  // in, and what stops the same invite being used twice. used_by has no foreign key precisely so
  // this ordering is possible.
  const claim = await env.DB.prepare(
    "UPDATE invites SET used_by = ? WHERE token_hash = ? AND used_by IS NULL AND revoked_at IS NULL AND expires_at > ?",
  )
    .bind(memberId, hash, now)
    .run();
  if (claim.meta.changes !== 1) throw new UserError("This invite was just used or cancelled. Ask for a new one.");

  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE group_id = ? AND removed_at IS NULL")
    .bind(invite.group_id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_MEMBERS) throw new UserError("This group already has 9 members.");

  try {
    await env.DB.prepare(
      "INSERT INTO members (id, group_id, nickname, secret_hash, joined_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(memberId, invite.group_id, nickname, secretHash, now, now)
      .run();
  } catch (err) {
    // Someone else took the nickname in the instant between our pre-check and the insert (the
    // unique index is what actually prevents the collision). The invite is already spent; that's
    // an acceptable cost for a trusted 9-person group rather than a security concern.
    throw new UserError("Someone in the group already uses that nickname. Pick another.");
  }

  const group = await env.DB.prepare("SELECT * FROM groups WHERE id = ?").bind(invite.group_id).first<GroupRow>();
  return { deviceSecret: secret, groupId: invite.group_id, memberId, groupName: group?.name ?? "" };
}

/** A member may remove themself (leave) or any other member (trusted group; covers lost phones). */
export async function removeMember(env: Env, ctx: AuthContext, targetId: string) {
  const target = await env.DB.prepare("SELECT * FROM members WHERE id = ? AND group_id = ? AND removed_at IS NULL")
    .bind(targetId, ctx.group.id)
    .first<MemberRow>();
  if (!target) throw new UserError("That member is not in this group.");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE members SET secret_hash = NULL, removed_at = ? WHERE id = ?").bind(now, targetId),
    env.DB.prepare("DELETE FROM subscriptions WHERE member_id = ?").bind(targetId),
  ]);
}
