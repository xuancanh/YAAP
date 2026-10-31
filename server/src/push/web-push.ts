/**
 * web-push.ts — Web Push without a dependency: VAPID (RFC 8292) request
 * signing and `aes128gcm` payload encryption (RFC 8291 over RFC 8188), all
 * on node:crypto.
 *
 * Keys are the web-push convention: the public key is the uncompressed
 * P-256 point (65 bytes, base64url — what the browser's
 * `applicationServerKey` wants), the private key the raw 32-byte scalar
 * (base64url). `generateVapidKeys` prints such a pair (scripts/push-keys.mjs).
 *
 * Encryption, per RFC 8291 §3:
 *   ecdh_secret = ECDH(as_private, ua_public)
 *   IKM   = HKDF(salt=auth_secret, ikm=ecdh_secret, info="WebPush: info\0"||ua_public||as_public, 32)
 *   CEK   = HKDF(salt, IKM, "Content-Encoding: aes128gcm\0", 16)
 *   NONCE = HKDF(salt, IKM, "Content-Encoding: nonce\0", 12)
 *   body  = salt(16) || rs(4) || idlen(1)=65 || as_public(65) || AES-128-GCM(plaintext || 0x02)
 * One record: our payloads are a few hundred bytes, far under rs = 4096.
 */
import {
  createCipheriv, createDecipheriv, createECDH, createPrivateKey, createPublicKey, createSign,
  generateKeyPairSync, hkdfSync, randomBytes, type KeyObject,
} from 'node:crypto';

const b64u = (b: Buffer | Uint8Array): string => Buffer.from(b).toString('base64url');
const fromB64u = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export interface VapidKeys { publicKey: string; privateKey: string }

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; y: string; d: string };
  const point = Buffer.concat([Buffer.from([0x04]), fromB64u(jwk.x), fromB64u(jwk.y)]);
  return { publicKey: b64u(point), privateKey: jwk.d };
}

/** Rebuild the signing key from the stored pair (JWK needs x, y and d). */
export function vapidPrivateKeyObject(keys: VapidKeys): KeyObject {
  const point = fromB64u(keys.publicKey);
  if (point.length !== 65 || point[0] !== 0x04) throw new Error('VAPID public key must be an uncompressed P-256 point (65 bytes)');
  const d = fromB64u(keys.privateKey);
  if (d.length !== 32) throw new Error('VAPID private key must be a 32-byte scalar');
  return createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33, 65)), d: b64u(d) },
  });
}

/** `Authorization: vapid t=<jwt>, k=<publicKey>` for a push endpoint. The
 *  JWT audience is the endpoint's origin; expiry ≤ 24h per RFC 8292 (12h
 *  here). ES256 signatures are raw r||s (ieee-p1363), not DER. */
export function vapidAuthorization(endpoint: string, subject: string, keys: VapidKeys, now: Date = new Date()): string {
  const aud = new URL(endpoint).origin;
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(now.getTime() / 1000) + 12 * 3600, sub: subject })));
  const signingInput = `${header}.${payload}`;
  const sig = createSign('SHA256').update(signingInput).sign({ key: vapidPrivateKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${signingInput}.${b64u(sig)}, k=${keys.publicKey}`;
}

/** Derive the content-encryption key and nonce shared by encrypt and (in
 *  tests) decrypt. `asPublic` is the sender's ephemeral point. */
function deriveKeys(ecdhSecret: Buffer, authSecret: Buffer, uaPublic: Buffer, asPublic: Buffer, salt: Buffer) {
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  return { cek, nonce };
}

/** Encrypt `plaintext` for a subscription (`p256dh`, `auth` as the browser
 *  hands them out, base64url). Returns the aes128gcm body ready to POST. */
export function encryptPayload(plaintext: string | Buffer, p256dh: string, auth: string): Buffer {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('p256dh must be an uncompressed P-256 point');
  if (authSecret.length !== 16) throw new Error('auth must be 16 bytes');
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = randomBytes(16);
  const { cek, nonce } = deriveKeys(ecdhSecret, authSecret, uaPublic, asPublic, salt);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const record = Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])]);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ciphertext]);
}

/** The receiving side, as a browser would do it — used by tests to prove
 *  the round trip; `uaPrivate` is the subscriber's raw scalar. */
export function decryptPayload(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, authSecret: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const ecdhSecret = ecdh.computeSecret(asPublic);
  const { cek, nonce } = deriveKeys(ecdhSecret, authSecret, uaPublic, asPublic, salt);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  // strip the delimiter (0x02 for the last record) and any zero padding after it
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 0x02) throw new Error('bad record delimiter');
  return padded.subarray(0, end);
}

export interface PushSubscriptionKeys { endpoint: string; p256dh: string; auth: string }

export interface PushSendResult { status: number; ok: boolean; gone: boolean }

/** POST one encrypted message to a push service. 404/410 → `gone`: the
 *  subscription is dead and the caller should delete it. */
export async function sendWebPush(
  sub: PushSubscriptionKeys,
  payload: string,
  vapid: VapidKeys & { subject: string },
  fetchFn: typeof fetch = fetch,
  opts: { ttl?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high' } = {},
): Promise<PushSendResult> {
  const body = encryptPayload(payload, sub.p256dh, sub.auth);
  const res = await fetchFn(sub.endpoint, {
    method: 'POST',
    headers: {
      authorization: vapidAuthorization(sub.endpoint, vapid.subject, vapid),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
      ttl: String(opts.ttl ?? 24 * 3600),
      urgency: opts.urgency ?? 'normal',
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, ok: res.ok, gone: res.status === 404 || res.status === 410 };
}

/** Sanity check a public key string (Settings shows "misconfigured" early). */
export function isValidVapidPublicKey(key: string): boolean {
  try {
    const point = fromB64u(key);
    if (point.length !== 65 || point[0] !== 0x04) return false;
    createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33, 65)) } });
    return true;
  } catch {
    return false;
  }
}
