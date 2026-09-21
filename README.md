# HarshOnTime – Phase 0 (phone check)

A throwaway test app. Its only job is to prove that web push reaches all nine phones,
locked and overnight, before we build the real thing.

## What you need
- A free Cloudflare account (no card required)
- Node.js 22.6 or newer on your computer (the test script relies on it; check with `node -v`)
- Git

## Deploy (about 15 minutes, once)

1. Install dependencies
   ```
   npm install
   npm test            # optional: re-runs the encryption checks
   ```
2. **Decide the app's name now.** Open `wrangler.toml` and set `name`. It becomes part of the URL
   (`https://<name>.<your-subdomain>.workers.dev`). Notification links are tied to that URL, so
   renaming later means everyone has to turn notifications on again.
3. Log in and create the database
   ```
   npx wrangler login
   npx wrangler d1 create harshontime
   ```
   Copy the `database_id` it prints into `wrangler.toml`.
4. Create the notification keys
   ```
   npm run vapid
   ```
   Paste the public key into `VAPID_PUBLIC_KEY` in `wrangler.toml`.
   Set `VAPID_SUBJECT` to `mailto:` plus a real email address of yours (Apple rejects malformed values).
5. Create the tables, store the secrets, deploy
   ```
   npm run db:remote
   npx wrangler secret put VAPID_PRIVATE_JWK     # paste the JSON from step 4
   npx wrangler secret put SPIKE_KEY             # any passphrase; you'll share it with the group
   npm run deploy
   ```
   If `secret put` complains the Worker doesn't exist yet, run `npm run deploy` once first, then set the secrets.
6. Open the URL that `deploy` prints. Send it and the passphrase to the group.

## Run locally instead
Create `.dev.vars` with two lines, `VAPID_PRIVATE_JWK=...` and `SPIKE_KEY=...`, then:
```
npm run db:local
npm run dev
```
Push from a phone needs HTTPS, so real phone testing has to happen on the deployed URL.

## What to test, and what to tell me

| # | Test | What we learn |
|---|------|---------------|
| 1 | Every phone completes steps 1–3 | Install + permission flow works on all 9 |
| 2 | "Everyone / Right now" with phones unlocked | Basic delivery, and delay in seconds |
| 3 | "Everyone / In 10 minutes", phones locked and face down | Locked-phone delivery + cron timing |
| 4 | "Everyone / In 8 hours" before bed | The overnight case that actually matters for wake-ups |
| 5 | Android: expand the notification, tap "I'll do it" | Notification buttons (expected: Android yes, iPhone no) |
| 6 | iPhones: look at "Storage first created" under *This phone* | If it says "home-screen app" even though Safari was opened first, Safari and the app keep separate storage (affects the join flow) |
| 7 | Cloudflare dashboard > Workers > your Worker > Metrics > CPU time, after test 2 | Whether pushing to 9 phones fits the free plan's 10 ms CPU limit |

Live logs while testing: `npx wrangler tail`

On Xiaomi / Oppo / Vivo / realme / OnePlus phones, if test 3 or 4 fails, exempt Chrome from
battery optimisation (Settings > Apps > Chrome > Battery > Unrestricted, wording varies) and retry.

## Layout
- `src/webpush.ts` – Web Push encryption (RFC 8291) and VAPID (RFC 8292) on plain WebCrypto. Carries into the real app.
- `src/index.ts` – API, cron handler, delivery log. Spike-only; replaced in Phase 1.
- `public/` – the test page, service worker, manifest, icons.
- `migrations/` – D1 schema.
- `test/` – checks our encryption against an independent decryptor.
