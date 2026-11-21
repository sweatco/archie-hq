// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import {
  decryptJson,
  deleteFileIfExists,
  encryptJson,
  readJson,
  writeJsonAtomic,
} from '../system/secrets-vault.js';
import type { InputAuth } from './types.js';

/** Stores callback secrets; the inbox database refers to them by reference. */
export interface InputSecrets {
  create(auth: InputAuth): Promise<{ ref: string; secret: string }>;
  read(ref: string): Promise<string | null>;
  remove(ref: string): Promise<void>;
}

const REF_PATTERN = /^sec-[a-f0-9]{32}$/;
const SECRET_BYTES = 32;

const recordSchema = z.object({
  envelope: z.object({ ciphertext: z.string(), iv: z.string(), tag: z.string() }),
});
const sealedSchema = z.object({ secret: z.string().min(1) });

/** One sealed file per secret under `dir`, encrypted with the vault master key. */
export function vaultInputSecrets(dir: string): InputSecrets {
  // References are generated here; the shape check keeps a corrupted one inside `dir`.
  const pathFor = (ref: string): string => {
    if (!REF_PATTERN.test(ref)) throw new Error('Invalid input secret reference');
    return join(dir, `${ref}.json`);
  };

  return {
    async create(auth) {
      const ref = `sec-${randomBytes(16).toString('hex')}`;
      const key = randomBytes(SECRET_BYTES);
      const secret =
        auth === 'standard_webhooks'
          ? `whsec_${key.toString('base64')}`
          : key.toString('base64url');
      const record = {
        ref,
        created_at: new Date().toISOString(),
        envelope: encryptJson({ secret }),
      };
      await writeJsonAtomic(pathFor(ref), record, 0o600);
      return { ref, secret };
    },

    async read(ref) {
      const record = await readJson(pathFor(ref));
      if (record === null) return null;
      const { envelope } = recordSchema.parse(record);
      return sealedSchema.parse(decryptJson(envelope)).secret;
    },

    async remove(ref) {
      await deleteFileIfExists(pathFor(ref));
    },
  };
}
