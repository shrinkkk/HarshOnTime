import { sendPush, type PushSubscriptionRecord, type VapidConfig } from "./webpush";

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  VAPID_PUBLIC_KEY: string;
  VAPID_SUBJECT: string;
  VAPID_PRIVATE_JWK: string;
  SPIKE_KEY: string;
}

interface SubRow extends PushSubscriptionRecord {
  id: string;
  label: string;
  platform: string;
}

interface PushRow {
  id: string;
  title: string;
  body: string;
  target_sub: string | null;
  due_at: number;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compares digests rather than raw strings so timing does not leak the passphrase. */
async function keyOk(req: Request, env: Env): Promise<boolean> {
  const given = req.headers.get("x-spike-key") ?? "";
  if (!env.SPIKE_KEY || !given) return false;
  return (await sha256(given)) === (await sha256(env.SPIKE_KEY));
}

function vapid(env: Env): VapidConfig {
  return { publicKey: env.VAPID_PUBLIC_KEY, privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK), subject: env.VAPID_SUBJECT };
}

const clean = (v: unknown, max: number, fallback: string) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : fallback);

/** Sends one queued push to its recipients and records what each push service said. */
async function deliver(env: Env, push: PushRow): Promise<void> {
  const now = Date.now();
  // Claim the row first. If two cron ticks ever overlap, only one of them gets changes = 1.
  const claim = await env.DB.prepare("UPDATE spike_pushes SET sent_at = ? WHERE id = ? AND sent_at IS NULL").bind(now, push.id).run();
  if (claim.meta.changes !== 1) return;

  const subs = push.target_sub
    ? await env.DB.prepare("SELECT * FROM spike_subs WHERE id = ?").bind(push.target_sub).all<SubRow>()
    : await env.DB.prepare("SELECT * FROM spike_subs").all<SubRow>();

  const authCache = new Map<string, string>();
  const v = vapid(env);
  const lateBy = Math.max(0, Math.round((now - push.due_at) / 1000));

  const results = await Promise.all(
    subs.results.map(async (s) => {
      const payload = {
        title: push.title,
        body: push.body,
        url: `/?push=${push.id}`,
        tag: push.id,
        pushId: push.id,
        subId: s.id,
        // Chrome on Android shows these; Safari ignores them. The client only attaches them when supported.
        actions: [{ action: "claim", title: "I'll do it" }],
      };
      const r = await sendPush(s, payload, v, { ttlSeconds: 20 * 60, urgency: "high" }, authCache);
      return { s, r };
    }),
  );

  const stmts = results.map(({ s, r }) =>
    env.DB.prepare(
      "INSERT OR REPLACE INTO spike_deliveries (push_id, sub_id, label, platform, sent_at, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(push.id, s.id, s.label, s.platform, now, r.status, r.detail ?? (lateBy > 90 ? `cron ran ${lateBy}s late` : null)),
  );
  for (const { s, r } of results) if (r.gone) stmts.push(env.DB.prepare("DELETE FROM spike_subs WHERE id = ?").bind(s.id));
  if (stmts.length) await env.DB.batch(stmts);
}

async function handleApi(req: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  if (path === "/api/config" && req.method === "GET") return json({ vapidPublicKey: env.VAPID_PUBLIC_KEY });

  // Called by the phone's service worker when a push actually arrives. No passphrase: the service
  // worker cannot read app storage. It can only mark a delivery that already exists, once.
  if (path === "/api/receipt" && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { pushId?: string; subId?: string };
    if (typeof b.pushId !== "string" || typeof b.subId !== "string") return json({ error: "bad request" }, 400);
    await env.DB.prepare("UPDATE spike_deliveries SET received_at = ? WHERE push_id = ? AND sub_id = ? AND received_at IS NULL")
      .bind(Date.now(), b.pushId, b.subId)
      .run();
    return json({ ok: true });
  }

  if (!(await keyOk(req, env))) return json({ error: "Wrong or missing passphrase" }, 401);

  if (path === "/api/check" && req.method === "GET") return json({ ok: true });

  if (path === "/api/subscribe" && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as {
      label?: string;
      platform?: string;
      subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    };
    const ep = b.subscription?.endpoint;
    const p256dh = b.subscription?.keys?.p256dh;
    const auth = b.subscription?.keys?.auth;
    if (!ep || !p256dh || !auth || !ep.startsWith("https://")) return json({ error: "Subscription is incomplete" }, 400);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM spike_subs").first<{ n: number }>();
    const existing = await env.DB.prepare("SELECT id FROM spike_subs WHERE endpoint = ?").bind(ep).first<{ id: string }>();
    if (!existing && (count?.n ?? 0) >= 20) return json({ error: "Device limit reached for the spike" }, 409);
    const id = existing?.id ?? crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO spike_subs (id, label, endpoint, p256dh, auth, platform, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET label = excluded.label, p256dh = excluded.p256dh, auth = excluded.auth, platform = excluded.platform`,
    )
      .bind(id, clean(b.label, 30, "Unnamed"), ep, p256dh, auth, clean(b.platform, 40, "unknown"), Date.now())
      .run();
    return json({ id });
  }

  if (path === "/api/unsubscribe" && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { id?: string };
    if (typeof b.id !== "string") return json({ error: "bad request" }, 400);
    await env.DB.prepare("DELETE FROM spike_subs WHERE id = ?").bind(b.id).run();
    return json({ ok: true });
  }

  if (path === "/api/send" && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { title?: string; body?: string; targetSub?: string; delayMinutes?: number };
    const delay = Number.isFinite(b.delayMinutes) ? Math.min(Math.max(Number(b.delayMinutes), 0), 24 * 60) : 0;
    const now = Date.now();
    const push: PushRow = {
      id: crypto.randomUUID(),
      title: clean(b.title, 80, "Test push"),
      body: clean(b.body, 200, "If you can read this, push works on this phone."),
      target_sub: typeof b.targetSub === "string" ? b.targetSub : null,
      due_at: now + delay * 60_000,
    };
    await env.DB.prepare("INSERT INTO spike_pushes (id, title, body, target_sub, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(push.id, push.title, push.body, push.target_sub, push.due_at, now)
      .run();
    if (delay === 0) ctx.waitUntil(deliver(env, push)); // immediate; otherwise the cron tick sends it
    return json({ id: push.id, dueAt: push.due_at });
  }

  if (path === "/api/status" && req.method === "GET") {
    const [subs, deliveries, pending] = await env.DB.batch([
      env.DB.prepare("SELECT id, label, platform, created_at FROM spike_subs ORDER BY created_at"),
      env.DB.prepare(
        `SELECT d.push_id, d.label, d.platform, d.sent_at, d.status, d.detail, d.received_at, p.title, p.due_at
         FROM spike_deliveries d JOIN spike_pushes p ON p.id = d.push_id ORDER BY d.sent_at DESC LIMIT 60`,
      ),
      env.DB.prepare("SELECT id, title, due_at FROM spike_pushes WHERE sent_at IS NULL ORDER BY due_at"),
    ]);
    return json({ now: Date.now(), subs: subs.results, deliveries: deliveries.results, pending: pending.results });
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(req, env, ctx, url.pathname);
      } catch (err) {
        console.error(err);
        return json({ error: "Server error" }, 500);
      }
    }
    return env.ASSETS.fetch(req);
  },

  // Runs every minute. "Send whatever is due and unsent" means a skipped tick is caught by the next one.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const due = await env.DB.prepare("SELECT id, title, body, target_sub, due_at FROM spike_pushes WHERE sent_at IS NULL AND due_at <= ? LIMIT 10")
      .bind(Date.now())
      .all<PushRow>();
    for (const p of due.results) ctx.waitUntil(deliver(env, p));
  },
} satisfies ExportedHandler<Env>;
