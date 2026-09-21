// Generates the VAPID key pair. Run once: npm run vapid
const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const raw = Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64url");
const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
console.log("\nVAPID_PUBLIC_KEY (paste into wrangler.toml [vars]):\n" + raw);
console.log("\nVAPID_PRIVATE_JWK (paste when `wrangler secret put VAPID_PRIVATE_JWK` prompts; keep it private):\n" + JSON.stringify(jwk));
console.log("\nLocal dev: put both secrets in a .dev.vars file (already git-ignored).\n");
