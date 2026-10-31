#!/usr/bin/env node
/**
 * push-keys — print a fresh VAPID key pair for web push (docs/channels.md).
 *
 *   npm run push:keys
 *
 * Paste the lines into .env. The public key is the uncompressed P-256 point
 * the browser receives as applicationServerKey; the private key is the raw
 * scalar. Rotating the pair invalidates every existing subscription.
 */
import { generateKeyPairSync } from 'node:crypto';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = privateKey.export({ format: 'jwk' });
const b64u = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const point = Buffer.concat([Buffer.from([0x04]), b64u(jwk.x), b64u(jwk.y)]);

console.log(`VAPID_PUBLIC_KEY=${point.toString('base64url')}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
console.log('VAPID_SUBJECT=mailto:you@example.com');
