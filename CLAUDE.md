# HarshOnTime

Private wake-up and quick-plans app for a friend group of exactly 9 people. Installable web app (PWA)
on a single Cloudflare Worker with D1 and Web Push. Total running cost must stay $0 and Apple must be
paid nothing. Full requirements, approved decisions and the build plan are in `docs/SPEC.md` — read it
before starting any phase.

## Current state
- Phases 1-5 are built and smoke-tested locally: identity, invites, push plumbing (subscribe on open,
  test push, health row, receipts, dead-subscription cleanup), wake-ups (create/claim/awake/cancel,
  cron reminders and expiry), activities, and preferences/mutes (enforced in `src/push.ts recipients()`).
- Migration 0004 adds `rsvps` (in/out per plan), `activities.audience`, `events.ref_id`, `prefs.dinner`.
- Migration 0003 adds `wakeups.audience` and `activities.text` (targeted sends and custom plans).
- Not yet done: Phase 6 polish and the real-device test matrix. Push fan-out CPU has not been measured
  on the deployed Worker. iOS is untested.
- Module map: `src/identity.ts` (auth, groups, invites), `src/push.ts` (recipients, fan-out, subscriptions),
  `src/wakeups.ts`, `src/activities.ts`, `src/prefs.ts`, `src/common.ts` (feed events, IST time formatting),
  `src/index.ts` (routes + cron). Client is `public/app.js` + `public/index.html` + `public/sw.js`; `public/_headers` sets the CSP.

## Commands
- `npm test` — encryption/VAPID checks (must stay green; Node 22.6+)
- `npm run typecheck` — `tsc --noEmit`
- `npm run dev` — local Worker with local D1 (`npm run db:local` first; needs `.dev.vars` with `CREATE_GROUP_ANSWERS` and a `VAPID_PRIVATE_JWK` — a throwaway pair is fine locally). Add `--test-scheduled` and hit `/__scheduled?cron=*+*+*+*+*` to run the cron by hand.
- `npm run db:remote` / `npm run deploy` — migrate and deploy to Cloudflare
- `npx wrangler tail` — live logs from the deployed Worker

## Hard rules
- Never commit secrets. `.dev.vars` and `.wrangler` are git-ignored; VAPID private key and passphrases (including `CREATE_GROUP_ANSWERS`) go in only via `wrangler secret put`.
- Do not change `name` in `wrangler.toml` or the workers.dev subdomain: push subscriptions are tied to the URL.
- Do not change the VAPID key pair once real phones are subscribed.
- No accounts, logins, emails, phone numbers, analytics or third-party scripts. Identity is a per-device secret (see SPEC).
- Every authorisation check is server-side and scoped by group. Claiming a wake-up is a single conditional `UPDATE` checked by `changes === 1`.
- Every push handler must call `showNotification` unconditionally (iOS revokes subscriptions otherwise).
- Stay within Cloudflare free-plan limits (10 ms CPU per invocation, 5 cron triggers per account). Measure push fan-out CPU on the real Worker; split per recipient only if needed.
- Keep it small: one Worker, one D1 database, plain HTML/CSS/JS in `public/`, no build step unless the SPEC's Phase 1 decides otherwise. Nine users; do not add scale features.
- Mobile-first UI, few taps, friendly tone. Group vocabulary: the six activity buttons are exactly Breakfast, Lunch, Snacks, Dinner, Sutta, Campus, plus a free-text custom plan.

## Workflow
- Work one phase at a time as listed in `docs/SPEC.md`; run tests + typecheck + a local smoke run before each commit.
- Commit with a short message per completed step. The user pushes to GitHub.
- The user can test alone on one Android phone plus desktop Chrome; iPhone testing is not available yet, so keep iOS-specific code defensive and feature-detected.
