/**
 * Encrypted secrets vault primitives.
 *
 * AES-256-GCM via Node `crypto`. The master key comes from
 * `ARCHIE_SECRETS_KEY` (32-byte value, base64-encoded). Records persisted
 * via this module store ciphertext + iv + auth tag alongside any plaintext
 * fields the caller wants visible (e.g. for `oauth:list`).
 *
 * No automatic JSON-shaping is imposed: callers structure records however
 * they like and use `encryptJson` / `decryptJson` to seal/unseal the
 * sensitive subset.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { mkdir, rename, writeFile, readFile, unlink, stat } from 'fs/promises';
import { dirname, join } from 'path';

export interface EncryptedEnvelope {
  ciphertext: string; // base64
  iv: string;         // base64 (12 bytes)
  tag: string;        // base64 (16 bytes)
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Decode the master key from `ARCHIE_SECRETS_KEY`. Throws with a clear
 * message if the env var is missing or the wrong length.
 */
export function loadMasterKey(): Buffer {
  const raw = process.env.ARCHIE_SECRETS_KEY;
  if (!raw) {
    throw new Error(
      'ARCHIE_SECRETS_KEY is not set. Generate one with: ' +
      'openssl rand -base64 32'
    );
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    throw new Error('ARCHIE_SECRETS_KEY must be base64-encoded');
  }
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `ARCHIE_SECRETS_KEY must decode to ${KEY_BYTES} bytes; got ${buf.length}. ` +
      'Use 32 random bytes encoded as base64.'
    );
  }
  return buf;
}

/** Validate `ARCHIE_SECRETS_KEY` is present and well-formed. */
export function validateMasterKey(): void {
  loadMasterKey();
}

/**
 * Encrypt a JSON-serializable object. Fresh random IV per call.
 */
export function encryptJson(plaintext: unknown, key: Buffer = loadMasterKey()): EncryptedEnvelope {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const json = Buffer.from(JSON.stringify(plaintext), 'utf-8');
  const ciphertext = Buffer.concat([cipher.update(json), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_BYTES) {
    throw new Error(`Unexpected GCM tag length: ${tag.length}`);
  }
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

/**
 * Decrypt an envelope. Throws if the master key is wrong, the data is
 * tampered, or the envelope is malformed.
 */
export function decryptJson<T = unknown>(envelope: EncryptedEnvelope, key: Buffer = loadMasterKey()): T {
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  if (iv.length !== IV_BYTES) throw new Error(`Invalid IV length: ${iv.length}`);
  if (tag.length !== TAG_BYTES) throw new Error(`Invalid tag length: ${tag.length}`);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf-8')) as T;
}

/**
 * Atomically write JSON to a file. Writes to `<path>.tmp-<rand>` then
 * renames over `path`. The temp file is created with `mode` so the
 * destination never has more permissive bits than intended.
 */
export async function writeJsonAtomic(path: string, data: unknown, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode });
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function readJson<T = unknown>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function deleteFileIfExists(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (err: any) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err: any) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

// =============================================================================
// Per-key mutex — serialises read-modify-write cycles within this process.
// =============================================================================

const locks = new Map<string, Promise<unknown>>();

export function withKeyMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  // Store a swallowed copy so the chain never rejects (avoids breaking the
  // queue) and never triggers an unhandled-rejection event.
  const chain = next.then(
    () => undefined,
    () => undefined,
  ).finally(() => {
    if (locks.get(key) === chain) locks.delete(key);
  });
  locks.set(key, chain);
  return next;
}

// Re-export for callers that build absolute paths from a directory.
export { join as joinPath };
