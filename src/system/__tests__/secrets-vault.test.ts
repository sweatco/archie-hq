import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import {
  encryptJson,
  decryptJson,
  loadMasterKey,
  validateMasterKey,
  writeJsonAtomic,
  readJson,
  withKeyMutex,
} from '../secrets-vault.js';

describe('secrets-vault', () => {
  let dir: string;
  const originalKey = process.env.ARCHIE_SECRETS_KEY;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vault-test-'));
    process.env.ARCHIE_SECRETS_KEY = randomBytes(32).toString('base64');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    if (originalKey === undefined) delete process.env.ARCHIE_SECRETS_KEY;
    else process.env.ARCHIE_SECRETS_KEY = originalKey;
  });

  describe('master key', () => {
    it('rejects missing key', () => {
      delete process.env.ARCHIE_SECRETS_KEY;
      expect(() => loadMasterKey()).toThrow(/ARCHIE_SECRETS_KEY is not set/);
    });

    it('rejects wrong-length key', () => {
      process.env.ARCHIE_SECRETS_KEY = Buffer.alloc(16).toString('base64');
      expect(() => loadMasterKey()).toThrow(/32 bytes/);
    });

    it('accepts a valid 32-byte base64 key', () => {
      expect(() => validateMasterKey()).not.toThrow();
    });
  });

  describe('encryptJson / decryptJson', () => {
    it('round-trips an arbitrary JSON object', () => {
      const original = { token: 'abc', refresh: 'xyz', meta: { count: 3 } };
      const env = encryptJson(original);
      const decoded = decryptJson<typeof original>(env);
      expect(decoded).toEqual(original);
    });

    it('produces fresh IVs on each encrypt', () => {
      const a = encryptJson({ x: 1 });
      const b = encryptJson({ x: 1 });
      expect(a.iv).not.toEqual(b.iv);
      expect(a.ciphertext).not.toEqual(b.ciphertext);
    });

    it('detects tampered ciphertext', () => {
      const env = encryptJson({ secret: 'value' });
      const tamperedBytes = Buffer.from(env.ciphertext, 'base64');
      tamperedBytes[0] ^= 0xff;
      const tampered = { ...env, ciphertext: tamperedBytes.toString('base64') };
      expect(() => decryptJson(tampered)).toThrow();
    });

    it('detects tampered auth tag', () => {
      const env = encryptJson({ secret: 'value' });
      const tagBytes = Buffer.from(env.tag, 'base64');
      tagBytes[0] ^= 0xff;
      expect(() => decryptJson({ ...env, tag: tagBytes.toString('base64') })).toThrow();
    });

    it('fails decryption with a different master key', () => {
      const env = encryptJson({ secret: 'value' });
      process.env.ARCHIE_SECRETS_KEY = randomBytes(32).toString('base64');
      expect(() => decryptJson(env)).toThrow();
    });
  });

  describe('writeJsonAtomic / readJson', () => {
    it('writes a file with the requested mode', async () => {
      const path = join(dir, 'sub', 'record.json');
      await writeJsonAtomic(path, { a: 1 }, 0o600);
      const s = await stat(path);
      // Mask off file-type bits so we only compare permission bits.
      expect(s.mode & 0o777).toBe(0o600);
    });

    it('round-trips JSON content', async () => {
      const path = join(dir, 'r.json');
      const data = { a: 1, b: [1, 2], c: { d: 'x' } };
      await writeJsonAtomic(path, data);
      const back = await readJson(path);
      expect(back).toEqual(data);
    });

    it('readJson returns null for missing files', async () => {
      const result = await readJson(join(dir, 'nope.json'));
      expect(result).toBeNull();
    });

    it('does not leave temp files after a successful write', async () => {
      const path = join(dir, 'final.json');
      await writeJsonAtomic(path, { x: 1 });
      const { readdirSync } = await import('fs');
      const entries = readdirSync(dir);
      expect(entries).toEqual(['final.json']);
    });
  });

  describe('withKeyMutex', () => {
    it('serialises overlapping operations on the same key', async () => {
      const order: string[] = [];
      const slow = withKeyMutex('k', async () => {
        order.push('a-start');
        await new Promise((r) => setTimeout(r, 25));
        order.push('a-end');
      });
      const fast = withKeyMutex('k', async () => {
        order.push('b-start');
        order.push('b-end');
      });
      await Promise.all([slow, fast]);
      expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
    });

    it('does not block different keys', async () => {
      const order: string[] = [];
      const a = withKeyMutex('k1', async () => {
        order.push('a-start');
        await new Promise((r) => setTimeout(r, 25));
        order.push('a-end');
      });
      const b = withKeyMutex('k2', async () => {
        order.push('b-start');
        order.push('b-end');
      });
      await Promise.all([a, b]);
      // b should fully complete while a is still sleeping
      expect(order.indexOf('b-end')).toBeLessThan(order.indexOf('a-end'));
    });

    it('continues serialising after a thrown error', async () => {
      const order: string[] = [];
      const failing = withKeyMutex('k', async () => {
        order.push('fail-start');
        throw new Error('boom');
      });
      await expect(failing).rejects.toThrow('boom');
      await withKeyMutex('k', async () => {
        order.push('next');
      });
      expect(order).toEqual(['fail-start', 'next']);
    });
  });
});
