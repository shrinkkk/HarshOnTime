// Verifies our encryption against an independent implementation (http_ece) and checks the VAPID signature.
// Run: npm test
import crypto from "node:crypto";
import ece from "http_ece";
import { encryptPayload, vapidAuthorization, b64urlEncode, b64urlDecode } from "../src/webpush.ts";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
let failures = 0;
const check = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };

// 1. Round trip: a fake "browser" key pair, encrypt with our code, decrypt with http_ece.
const ua = crypto.createECDH("prime256v1");
ua.generateKeys();
const auth = crypto.randomBytes(16);
const sub = { endpoint: "https://web.push.apple.com/abc", p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) };

for (const msg of ["hi", JSON.stringify({ title: "Arjun is waking Rahul ☀️", body: "नमस्ते", url: "/?w=1" }), "x".repeat(3900)]) {
  const body = await encryptPayload(sub, new TextEncoder().encode(msg));
  const out = ece.decrypt(Buffer.from(body), { version: "aes128gcm", privateKey: ua, authSecret: b64u(auth) });
  check(`round trip (${msg.length} chars)`, out.toString("utf8") === msg);
}

// 2. Two encryptions of the same message must differ (fresh salt + ephemeral key each time).
const a = await encryptPayload(sub, new TextEncoder().encode("same"));
const b = await encryptPayload(sub, new TextEncoder().encode("same"));
check("ciphertexts are unique per send", b64u(a) !== b64u(b));

// 3. Oversized payloads are rejected rather than silently truncated.
let threw = false;
try { await encryptPayload(sub, new Uint8Array(5000)); } catch { threw = true; }
check("oversized payload rejected", threw);

// 4. VAPID: sign, then verify with Node's own verifier.
const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
const publicKey = b64urlEncode(await crypto.subtle.exportKey("raw", kp.publicKey));
const header = await vapidAuthorization(sub.endpoint, { publicKey, privateJwk, subject: "mailto:test@example.com" }, 1_800_000_000);
const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
check("VAPID header format", !!m);
const claims = JSON.parse(Buffer.from(m[2], "base64url").toString());
check("aud is the push service origin", claims.aud === "https://web.push.apple.com");
check("exp is 12h ahead", claims.exp === 1_800_000_000 + 43200);
check("sub passed through", claims.sub === "mailto:test@example.com");
const pubKeyObj = crypto.createPublicKey({ key: await crypto.subtle.exportKey("jwk", kp.publicKey), format: "jwk" });
const sigOk = crypto.verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key: pubKeyObj, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3], "base64url"));
check("VAPID signature verifies", sigOk);
check("k= is the 65-byte public key", b64urlDecode(m[4]).length === 65);

// 5. Rough cost per recipient (Node on this machine; NOT a Workers CPU measurement).
const N = 200; const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) await encryptPayload(sub, new TextEncoder().encode("timing"));
const perEncrypt = Number(process.hrtime.bigint() - t0) / 1e6 / N;
const t1 = process.hrtime.bigint();
for (let i = 0; i < N; i++) await vapidAuthorization(sub.endpoint, { publicKey, privateJwk, subject: "mailto:t@example.com" });
const perSign = Number(process.hrtime.bigint() - t1) / 1e6 / N;
console.log(`\nindicative wall time here: encrypt ${perEncrypt.toFixed(2)} ms/recipient, VAPID sign ${perSign.toFixed(2)} ms/origin`);

process.exit(failures ? 1 : 0);
