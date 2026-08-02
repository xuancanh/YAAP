/**
 * secretbox — tiny AES-256-GCM sealing for tokens at rest.
 *
 * The key comes from TOKEN_ENCRYPTION_KEY (any string; hashed to 256 bits),
 * mirrored into typed config as `tokenEncryptionKey`. Without one we fall
 * back to marked plaintext so local dev works with zero setup (AppModule
 * logs a loud boot warning), matching the agent-types apiKey precedent; hosted deployments must
 * set the key. Sealed values are self-describing ("sealed:<iv>:<tag>:<data>",
 * base64url), so rotating from plaintext to sealed just works on next write.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const PLAIN_PREFIX = 'plain:';
const SEALED_PREFIX = 'sealed:';

function key(): Buffer | null {
  const raw = process.env.TOKEN_ENCRYPTION_KEY || '';
  return raw ? createHash('sha256').update(raw).digest() : null;
}

export function seal(value: string): string {
  const k = key();
  if (!k) return PLAIN_PREFIX + value;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${SEALED_PREFIX}${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${data.toString('base64url')}`;
}

export function open(stored: string): string {
  if (stored.startsWith(PLAIN_PREFIX)) return stored.slice(PLAIN_PREFIX.length);
  if (!stored.startsWith(SEALED_PREFIX)) return stored; // pre-secretbox rows
  const k = key();
  if (!k) throw new Error('TOKEN_ENCRYPTION_KEY is not set but the stored token is sealed');
  const [iv, tag, data] = stored.slice(SEALED_PREFIX.length).split(':');
  const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
