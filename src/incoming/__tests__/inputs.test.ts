// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createInput, deleteInput } from '../inputs.js';
import { vaultInputSecrets, type InputSecrets } from '../secrets.js';
import { IncomingStore } from '../store.js';

let root: string;
let secretsDir: string;
let store: IncomingStore;
let secrets: InputSecrets;

beforeEach(() => {
  vi.stubEnv('ARCHIE_SECRETS_KEY', randomBytes(32).toString('base64'));
  root = mkdtempSync(join(tmpdir(), 'archie-incoming-inputs-'));
  secretsDir = join(root, 'secrets');
  store = new IncomingStore(join(root, 'state.sqlite'));
  secrets = vaultInputSecrets(secretsDir);
});
afterEach(() => {
  store.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it('removes the sealed secret when the input row cannot be saved', async () => {
  vi.spyOn(store, 'insertInput').mockImplementation(() => {
    throw new Error('disk is full');
  });

  await expect(createInput({ store, secrets }, { auth: 'bearer' })).rejects.toThrow('disk is full');

  expect(readdirSync(secretsDir)).toEqual([]);
});

it('finishes removing secrets when an interrupted deletion is repeated', async () => {
  const { input } = await createInput({ store, secrets }, { auth: 'standard_webhooks' });
  vi.spyOn(secrets, 'remove').mockRejectedValueOnce(new Error('file is busy'));

  await expect(deleteInput({ store, secrets }, input.id)).rejects.toThrow('file is busy');
  expect(store.input(input.id)?.state).toBe('deleted');
  expect(readdirSync(secretsDir)).toHaveLength(1);

  await deleteInput({ store, secrets }, input.id);
  expect(readdirSync(secretsDir)).toEqual([]);
});
