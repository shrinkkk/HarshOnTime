# HarshOnTime — specification and build plan

This file carries everything decided so far. It is the source of truth for the remaining phases.

## 1. Purpose and constraints

- Exactly 9 trusted friends (4 on iPhone, iOS 16.4+; 5 on Android), one time zone (India).
- Two features: **wake-up requests** (others are asked to wake you) and **quick activities**
  ("Arjun wants to go for lunch").
- $0 hosting, database, backend, notifications, Apple, Google. No paid Apple Developer Program.
- No traditional accounts or login. No phone numbers, emails, analytics, tracking.
- Optimise for reliability, simplicity, privacy and mobile UX. Not for scale.
- Future features to leave room for but NOT build: recurring wake-ups, escalation, multiple groups,
  chat, calendars, profiles, feeds, payments.

## 2. Approved architecture (do not re-litigate)

| Layer | Choice | Notes |
|---|---|---|
| Client | PWA, plain HTML/CSS/JS in `public/`, hand-written service worker | Android: Chrome install or tab. iPhone: Safari → Share → Add to Home Screen; push only works from the installed icon. |
| Backend | One Cloudflare Worker (`src/index.ts`) serving `public/` via the ASSETS binding plus a JSON API under `/api/` | Free plan: 100k req/day, 10 ms CPU/invocation, 50 subrequests/request. |
| Database | Cloudflare D1 (SQLite), migrations in `migrations/` | Free plan: 5 GB, 5M rows read/day, 100k rows written/day. |
| Scheduler | One cron trigger `* * * * *` | Sends anything due and unsent; a missed tick is caught by the next. No retries/alerts on the platform, so logic must be idempotent. |
| Push | Standard Web Push, VAPID, `src/webpush.ts` (WebCrypto only, verified by `npm test`) | Direct to Apple's and Google's push services. No Firebase, no vendors. |
| Live UI | Refetch on open, on visibility change, on push arrival, and every ~15 s while visible | No WebSockets. |
| URL | `https://harshontime.<subdomain>.workers.dev` | Fixed; subscriptions are bound to it. |

Accepted limitations (already agreed with the user):
1. iOS shows no action buttons on notifications; iPhone users tap the notification, the app opens on
   the request, and they tap a big Claim button. Android gets up to 2 buttons.
2. A push is not an alarm: it cannot override silent/DND/Sleep Focus. Mitigation: an extra push at
   creation time ("Rahul needs a 6:00 AM wake-up. Who's got it?") so someone can claim the night before.
3. iOS web push is less dependable than native. Mitigation: re-check the subscription on every open,
   a "send me a test push" button, and a group health row showing when each member's push last worked.

Unknowns still unverified (design so the answer doesn't matter):
- Whether Safari and the installed app share storage on iOS → force join to happen inside the installed
  app (detect iOS + not standalone and show install instructions instead of the join form).
- Workers CPU per fan-out → measure in the dashboard after Phase 2; if 8 recipients exceed ~10 ms,
  fan out one recipient per invocation (e.g. a `deliveries` queue table drained by the cron/waitUntil).
- Real iOS delivery latency → health row + test push cover it operationally.

## 3. Identity and security model

- **Create group**: server creates the group and the creator's member row. For now only Shri may create
  one: the client asks "what's the name of the love of your life?" and the server accepts the answer
  only if it matches (case-insensitively) an entry in the `CREATE_GROUP_ANSWERS` secret. Checked on
  both the pre-check call and the create call; with the secret unset, nobody can create.
- **Invite**: random ≥128-bit token, expires after 48 h, revocable, rejected once the group has 9
  members. Shared as a link (`/join#<token>`), short code, or QR. Any member can create an invite.
- **Join**: person enters a nickname (unique within group, 2–20 chars). Server issues a member id and a
  256-bit random **device secret**; the device stores it in localStorage, the server stores only its
  SHA-256 hash. On iOS the join form is only shown when running standalone.
- **Every API call** sends the secret in an `Authorization: Bearer` header. The Worker resolves it to
  (member, group) and scopes every query by group id. Record ids are random UUIDs but authorisation
  never relies on id secrecy.
- **Leave**: revokes the secret and deletes the member's push subscriptions. Rejoin needs a fresh
  invite. Any member may remove another member (trusted group; needed for lost phones).
- **Secrets**: VAPID private key only in the Worker (via `wrangler secret put`). Strict
  Content-Security-Policy, no third-party scripts, no inline event handlers.
- Tradeoffs to keep in mind: the device secret is a bearer credential; clearing site data loses the
  identity; XSS would leak it (hence the CSP).

## 4. Data model (Phase 1 replaces the spike schema)

```
groups        id, name, created_at
members       id, group_id, nickname, secret_hash, joined_at, last_seen_at, push_ok_at
invites       token_hash, group_id, created_by, expires_at, used_by (nullable), revoked_at
subscriptions id, member_id, endpoint (unique), p256dh, auth, platform, created_at, last_ok_at, last_error
wakeups       id, group_id, requester_id, wake_at, note, status
              (upcoming | claimed | awake | expired), claimed_by, claimed_at, awake_at,
              reminder_sent_at, created_at
activities    id, group_id, member_id, kind (breakfast|lunch|snacks|dinner|sutta|campus|custom), text, audience, created_at
rsvps         activity_id, member_id, status (in|out), at
prefs         member_id, wakeups_enabled, wakeups_muted_until, activities_muted_until,
              breakfast, lunch, snacks, dinner, sutta, campus (booleans)
mutes         member_id, muted_member_id, scope (wakeups | activities)
events        id, group_id, kind, actor_id, subject_id, text, created_at   -- "recent activity" feed
```
Statuses shown in UI: Upcoming / 🔴 Unclaimed (upcoming with no claimer, once the reminder is out) /
🟢 Claimed ("Arjun is waking Rahul") / Awake / Expired (wake_at + 30 min passed without "awake").

## 5. Behaviour

### Wake-ups
- Create: time (today or tomorrow, 5-minute steps), optional note ≤200 chars.
- On create: push to others "Rahul needs a 6:00 AM wake-up. Who's got it?" (normal urgency, TTL until wake_at).
- Cron at wake_at − 5 min (idempotent via `reminder_sent_at`):
  - if unclaimed: push others "Rahul wants to be woken at 6:00" with Claim action; status shows Unclaimed.
  - if claimed: push only the claimer "Time to wake Rahul" + note.
  - always push the requester "Are you awake?" with "Yes, I'm awake" action.
- Claim: `UPDATE wakeups SET claimed_by=?, claimed_at=?, status='claimed' WHERE id=? AND group_id=? AND claimed_by IS NULL AND status='upcoming'`; require `changes === 1`, else respond "X already has it". Push everyone else "Arjun is waking Rahul".
- Awake: requester only; sets status awake; push everyone "Rahul is awake".
- Nobody claims: leave it Unclaimed, no escalation, no auto-assign.
- Cancel: requester may cancel before wake_at (status becomes `cancelled`, hidden from the list); push the claimer if any.
- One pending wake-up per requester at a time.
- Expiry: cron marks expired 30 min after wake_at if not awake.

### Activities
- Six buttons: Breakfast, Lunch, Snacks, Dinner, Sutta, Campus. Tap → confirm sheet → push others
  "Arjun wants to go for lunch" (exact wording: "X wants to go for <kind>"). Rate limit: one per kind per member per 10 min.
- A free-text "custom plan" box sends anything the person types ("Shri: Rooftop in 10"), ≤120 chars, one per 2 min. Custom plans ignore the per-kind switches but respect mute-until and per-person mutes.
- Both wake-ups and plans offer "send to everyone" or "send to specific people" (a checklist of members). A targeted send stores its audience (`wakeups.audience`, JSON ids); all follow-up pushes for that wake-up (reminder, claim, awake) go only to that audience plus the requester/claimer. The feed shows that a targeted plan was sent and to whom, not its text.
- A "Send a message" box at the top of Home (≤200 chars) works like a custom plan (everyone / specific people) but has no In/Out and is not a plan. Feed kind `message`.
- The feed shows the last 24 h only (7 entries, "Show more" for the rest); the cron deletes events, activities and rsvps older than a day.
- A plan's creator sees a "Cancel plan" button (inline confirm). Cancelled plans lose In/Out and show "Plan cancelled"; people who had said In get a push.
- When someone new says In, the creator gets "X is in for lunch" / "X is in for “text”".
- Every plan in the feed has In / Out buttons (for the people it was sent to; the sender is In automatically). Under the plan: "In: a, b, c · Out: d". Tapping your current answer clears it. No pushes for replies.

### Notification preferences (all enforced server-side when computing recipients)
- Wake-ups: on/off; mute until (1 h, until tomorrow 8 AM, custom); mute specific people.
- Activities: per-kind on/off; mute until; mute specific people.
- Prefs affect only the recipient; the request/activity still exists for everyone else.

### Push payload rules
- Always include title, body, url (deep link), tag (dedupe), pushId/subId (receipts), optional actions
  (client attaches only up to `Notification.maxActions`).
- Reminders: urgency high, TTL 20 min. Creation/claim/awake/activity: urgency normal, TTL 1 h.
- 404/410 from the push service → delete that subscription and flag the member in the health row.

### Main screen
Sections in this order: Upcoming Wake-Ups (large, with status line), Quick Group Actions
(five buttons, two rows), Recent Activity (last ~20 events), then a small footer with group health and
a link to Settings. Empty states invite action ("No wake-ups yet. Ask for one.").

## 6. Phases (build in this order, one commit per completed step) — 1 to 5 done, 6 remaining

1. **Foundation**: new schema + migration 0002 (drop spike tables), identity middleware, create group,
   invite (link + code + QR via a small inline generator or plain text fallback), join (iOS standalone
   gate), leave/remove, home screen shell, settings shell. Keep the spike's install instructions.
2. **Push plumbing**: subscribe/refresh on every open, test-push button, health row, receipts, dead-subscription cleanup. Measure CPU on the deployed Worker.
3. **Wake-ups**: create → list → cron reminder → claim (atomic) → "X is waking Y" → "Are you awake?" → "Y is awake" → cancel → expiry.
4. **Activities**: five buttons, notifications, feed.
5. **Preferences**: wake-up and activity settings, per-person and timed mutes, enforced server-side.
6. **Polish and test**: notification click deep-links open the right request; Android action buttons; offline/reconnect refresh; denied-permission messaging; the full test matrix from the original brief (the user can run Android→Android and Android→desktop now; iOS cases wait for the group).

## 7. Testing alone (what the user can do without the group)
- One Android phone (Chrome tab and installed PWA share one subscription) + a second browser on the
  same phone (Firefox/Edge/Samsung Internet, separate subscription) + desktop Chrome = three "members".
- Simultaneous-claim test: two members tap Claim within a second; exactly one must win.
- Cron test: create a wake-up 6 minutes ahead, lock the phone.

## 8. Deployment facts
- Cloudflare account already has D1 database `harshontime`; ids and the VAPID public key are in `wrangler.toml`.
- Secrets set: `VAPID_PRIVATE_JWK`, `SPIKE_KEY` (spike only; can be deleted after Phase 1 replaces the passphrase with real identity).
- Deploy: `npm run db:remote && npm run deploy`.
