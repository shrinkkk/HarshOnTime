# HarshOnTime

Private wake-up and quick-plans app for a friend group of exactly 9 people. Installable web app (PWA)
on a single Cloudflare Worker with D1 and Web Push. Total running cost must stay $0 and Apple must be
paid nothing. Full requirements, approved decisions and the build plan are in `docs/SPEC.md` — read it
before starting any phase.

## Current state
- Phase 0 (push spike) is deployed and verified on one Android phone. iOS and the group are untested.
- Phase 1 onward is not started. The spike code in `src/index.ts` and `migrations/0001_spike.sql`
  is throwaway and gets replaced; `src/webpush.ts`, `public/sw.js` patterns, icons and manifest carry forward.

## Commands
- `npm test` — encryption/VAPID checks (must stay green; Node 22.6+)
- `npm run typecheck` — `tsc --noEmit`
- `npm run dev` — local Worker with local D1 (`npm run db:local` first; needs `.dev.vars`)
- `npm run db:remote` / `npm run deploy` — migrate and deploy to Cloudflare
- `npx wrangler tail` — live logs from the deployed Worker

## Hard rules
- Never commit secrets. `.dev.vars` and `.wrangler` are git-ignored; VAPID private key and passphrases go in only via `wrangler secret put`.
- Do not change `name` in `wrangler.toml` or the workers.dev subdomain: push subscriptions are tied to the URL.
- Do not change the VAPID key pair once real phones are subscribed.
- No accounts, logins, emails, phone numbers, analytics or third-party scripts. Identity is a per-device secret (see SPEC).
- Every authorisation check is server-side and scoped by group. Claiming a wake-up is a single conditional `UPDATE` checked by `changes === 1`.
- Every push handler must call `showNotification` unconditionally (iOS revokes subscriptions otherwise).
- Stay within Cloudflare free-plan limits (10 ms CPU per invocation, 5 cron triggers per account). Measure push fan-out CPU on the real Worker; split per recipient only if needed.
- Keep it small: one Worker, one D1 database, plain HTML/CSS/JS in `public/`, no build step unless the SPEC's Phase 1 decides otherwise. Nine users; do not add scale features.
- Mobile-first UI, few taps, friendly tone. Group vocabulary: the five activities are exactly Breakfast, Lunch, Snacks, Sutta, Campus.

## Workflow
- Work one phase at a time as listed in `docs/SPEC.md`; run tests + typecheck + a local smoke run before each commit.
- Commit with a short message per completed step. The user pushes to GitHub.
- The user can test alone on one Android phone plus desktop Chrome; iPhone testing is not available yet, so keep iOS-specific code defensive and feature-detected.
