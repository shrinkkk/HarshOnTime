// Web Push sender built on WebCrypto only (no Node APIs), so it runs on Cloudflare Workers.
// Implements RFC 8291 (message encryption, aes128gcm) and RFC 8292 (VAPID).

export interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string; // base64url, 65-byte uncompressed P-256 point
  auth: string; // base64url, 16 bytes
}

export interface VapidConfig {
  publicKey: string; // base64url, 65-byte uncompressed P-256 point
  privateJwk: JsonWebKey; // P-256 private key as JWK
  subject: string; // "mailto:you@example.com" or an https URL
}

export interface PushOptions {
  ttlSeconds: number;
  urgency?: "very-low" | "low" | "normal" | "high";
  topic?: string; // max 32 chars, base64url alphabet; a newer push with the same topic replaces an undelivered older one
}

const enc = new TextEncoder();

export function b64urlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, lengthBytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, lengthBytes * 8);
  return new Uint8Array(bits);
}

/** Encrypts a payload for one subscription. Returns the full aes128gcm request body. */
export async function encryptPayload(sub: PushSubscriptionRecord, plaintext: Uint8Array): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(sub.p256dh);
  const authSecret = b64urlDecode(sub.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error("bad p256dh key");
  if (authSecret.length !== 16) throw new Error("bad auth secret");
  // One record only. 4096-byte record size leaves ~3990 bytes of payload; push services cap around 4 KB anyway.
  if (plaintext.length > 3900) throw new Error("payload too large");

  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const asKeys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", asKeys.publicKey)) as ArrayBuffer);
  // Workers' types name this field "$public"; the standard WebCrypto name is "public". Cast to keep both happy.
  const ecdhParams = { name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdhParams, asKeys.privateKey, 256));

  // RFC 8291 section 3.4
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  // RFC 8188 section 2.2 / 2.3
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const padded = concat(plaintext, new Uint8Array([0x02])); // 0x02 = final-record delimiter
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, padded));

  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = 65;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

/** Builds the VAPID Authorization header value for a given endpoint. */
export async function vapidAuthorization(endpoint: string, vapid: VapidConfig, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  // 12 hours. The spec allows up to 24; shorter is kinder to clock skew.
  const claims = b64urlEncode(enc.encode(JSON.stringify({ aud, exp: nowSeconds + 12 * 3600, sub: vapid.subject })));
  const signingInput = `${header}.${claims}`;
  const key = await crypto.subtle.importKey("jwk", vapid.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // WebCrypto returns the raw r||s form, which is exactly what JWS ES256 wants.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput));
  return `vapid t=${signingInput}.${b64urlEncode(sig)}, k=${vapid.publicKey}`;
}

export interface PushResult {
  status: number; // HTTP status from the push service; 0 = network error
  gone: boolean; // true when the subscription is dead and should be deleted
  detail?: string;
}

/**
 * authCache lets one invocation reuse a VAPID token per push-service origin
 * (in practice two: Google's and Apple's), which saves an ECDSA sign per recipient.
 */
export async function sendPush(
  sub: PushSubscriptionRecord,
  payload: unknown,
  vapid: VapidConfig,
  opts: PushOptions,
  authCache?: Map<string, string>,
): Promise<PushResult> {
  try {
    const origin = new URL(sub.endpoint).origin;
    let authorization = authCache?.get(origin);
    if (!authorization) {
      authorization = await vapidAuthorization(sub.endpoint, vapid);
      authCache?.set(origin, authorization);
    }
    const body = await encryptPayload(sub, enc.encode(JSON.stringify(payload)));
    const headers: Record<string, string> = {
      Authorization: authorization,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(opts.ttlSeconds),
      Urgency: opts.urgency ?? "normal",
    };
    if (opts.topic) headers.Topic = opts.topic;
    const res = await fetch(sub.endpoint, { method: "POST", headers, body });
    const ok = res.status >= 200 && res.status < 300;
    const detail = ok ? undefined : (await res.text()).slice(0, 300);
    return { status: res.status, gone: res.status === 404 || res.status === 410, detail };
  } catch (err) {
    return { status: 0, gone: false, detail: String(err) };
  }
}
