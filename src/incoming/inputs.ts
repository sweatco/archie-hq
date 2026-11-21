// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import type { InputSecrets } from './secrets.js';
import type { IncomingStore } from './store.js';
import { inputFilterSchema, type Input, type InputAuth, type PointerCheck } from './types.js';

export interface InputServices {
  store: IncomingStore;
  secrets: InputSecrets;
}

export interface NewInput {
  auth: InputAuth;
  filter?: PointerCheck[];
}

/** Seals the secret before the input row exists, so every reachable input has a readable secret. */
export async function createInput(
  services: InputServices,
  spec: NewInput,
): Promise<{ input: Input; secret: string }> {
  const filter = inputFilterSchema.parse(spec.filter ?? []);
  const { ref, secret } = await services.secrets.create(spec.auth);
  const input: Input = {
    id: `inp-${randomBytes(16).toString('base64url')}`,
    state: 'enabled',
    auth: spec.auth,
    secretRefs: [ref],
    filter,
    revision: 1,
  };
  try {
    services.store.insertInput(input, Date.now());
  } catch (error) {
    await services.secrets.remove(ref);
    throw error;
  }
  return { input, secret };
}

/** Marks the input deleted before removing its secrets; a repeated call finishes an interrupted cleanup. */
export async function deleteInput(services: InputServices, id: string): Promise<Input | null> {
  const input = services.store.markInputDeleted(id);
  if (!input) return null;
  for (const ref of input.secretRefs) await services.secrets.remove(ref);
  return input;
}
