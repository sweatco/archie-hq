// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  connectionStatus,
  createInput,
  deleteInput,
  linkRoutine,
  mayManageInput,
  revealKey,
  rotateKey,
} from '../inputs.js';
import { noteRefusedDelivery } from '../refusals.js';
import { vaultInputSecrets, type InputSecrets } from '../secrets.js';
import { IncomingStore } from '../store.js';
import type { InputActor } from '../types.js';

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

const OPERATOR: InputActor = { kind: 'operator' };
const DANA: InputActor = { kind: 'slack_user', userId: 'U0DANA' };
const EVE: InputActor = { kind: 'slack_user', userId: 'U0EVE' };
const ROUTINE_ID = 'trg-20261124-0900-notes1';

it('keeps the owner, the purpose and a reserved id it was given', async () => {
  const { input } = await createInput(
    { store, secrets },
    { auth: 'bearer', id: 'inp-RESERVEDRESERVEDRESERV', owner: 'U0DANA', purpose: 'Deploys' },
  );

  expect(input).toMatchObject({ id: 'inp-RESERVEDRESERVEDRESERV', owner: 'U0DANA' });
  expect(store.input(input.id)).toMatchObject({ owner: 'U0DANA', purpose: 'Deploys' });
});

it('gives an input made without an owner to the operator alone', async () => {
  const { input } = await createInput({ store, secrets }, { auth: 'bearer' });

  expect(store.input(input.id)).toMatchObject({ owner: null, purpose: '' });
  expect(mayManageInput(input, OPERATOR)).toBe(true);
  expect(mayManageInput(input, DANA)).toBe(false);
});

it('lets the owner and the operator link a routine, and nobody else', async () => {
  const { input } = await createInput({ store, secrets }, { auth: 'bearer', owner: 'U0DANA' });

  expect(linkRoutine(store, EVE, input.id, ROUTINE_ID)).toEqual({
    status: 'refused',
    reason: 'not_owner',
  });
  expect(store.input(input.id)?.routines).toEqual([]);

  expect(linkRoutine(store, DANA, input.id, ROUTINE_ID).status).toBe('changed');
  expect(linkRoutine(store, OPERATOR, input.id, ROUTINE_ID).status).toBe('unchanged');
  expect(store.input(input.id)?.routines).toEqual([ROUTINE_ID]);
});

it('gives an input to one routine, even for those who manage it', async () => {
  const { input } = await createInput({ store, secrets }, { auth: 'bearer', owner: 'U0DANA' });
  linkRoutine(store, DANA, input.id, ROUTINE_ID);

  for (const actor of [DANA, OPERATOR])
    expect(linkRoutine(store, actor, input.id, 'trg-20261124-0900-other1')).toEqual({
      status: 'refused',
      reason: 'input_taken',
    });
  expect(store.input(input.id)?.routines).toEqual([ROUTINE_ID]);
});

it('refuses a link to an input that is unknown or deleted', async () => {
  const { input } = await createInput({ store, secrets }, { auth: 'bearer', owner: 'U0DANA' });
  await deleteInput({ store, secrets }, input.id);

  expect(linkRoutine(store, DANA, input.id, ROUTINE_ID)).toEqual({
    status: 'refused',
    reason: 'input_deleted',
  });
  expect(linkRoutine(store, OPERATOR, 'inp-missing', ROUTINE_ID)).toEqual({
    status: 'refused',
    reason: 'unknown_input',
  });
});

it('shows a key to the owner and to nobody else', async () => {
  const { input, secret } = await createInput(
    { store, secrets },
    { auth: 'bearer', owner: 'U0DANA' },
  );

  await expect(revealKey({ store, secrets }, DANA, input.id)).resolves.toEqual({
    status: 'revealed',
    secret,
  });
  await expect(revealKey({ store, secrets }, EVE, input.id)).resolves.toEqual({
    status: 'refused',
    reason: 'not_owner',
  });
  await expect(revealKey({ store, secrets }, OPERATOR, input.id)).resolves.toEqual({
    status: 'refused',
    reason: 'not_owner',
  });
});

it('says so when a key cannot be read', async () => {
  const { input } = await createInput({ store, secrets }, { auth: 'bearer', owner: 'U0DANA' });
  vi.spyOn(secrets, 'read').mockRejectedValue(new Error('bad key file'));

  await expect(revealKey({ store, secrets }, DANA, input.id)).resolves.toEqual({
    status: 'refused',
    reason: 'unreadable',
  });
  expect((await connectionStatus({ store, secrets }, input)).keyReadable).toBe(false);
});

it('reports the newest delivery and the last refusal of an input, and nothing for a new one', async () => {
  const { input } = await createInput({ store, secrets }, { auth: 'bearer', owner: 'U0DANA' });
  expect(await connectionStatus({ store, secrets }, input)).toEqual({
    keyReadable: true,
    lastReceipt: null,
    lastRefusedAt: null,
  });

  // No routine is linked, so an authenticated delivery is recorded and not acted on.
  const delivery = { inputId: input.id, binding: 'generic', digest: 'd1', body: Buffer.from('{}') };
  store.receive({ ...delivery, eventKey: 'msg_1', receivedAt: 1000 }, []);
  store.receive({ ...delivery, eventKey: 'msg_2', receivedAt: 2000 }, []);
  noteRefusedDelivery(input.id, 3000);

  expect(await connectionStatus({ store, secrets }, input)).toEqual({
    keyReadable: true,
    lastReceipt: {
      receivedAt: 2000,
      outcome: 'ignored',
      ignoredReason: 'filtered',
    },
    lastRefusedAt: 3000,
  });
});

it('replaces the key for the owner and for the operator, and removes the old one', async () => {
  const { input, secret } = await createInput(
    { store, secrets },
    { auth: 'standard_webhooks', owner: 'U0DANA' },
  );
  const [oldRef] = input.secretRefs;

  const byOwner = await rotateKey({ store, secrets }, DANA, input.id);
  const byOperator = await rotateKey({ store, secrets }, OPERATOR, input.id);

  if (!byOwner || !byOperator) throw new Error('expected both rotations to succeed');
  expect(byOwner.secret).toMatch(/^whsec_/);
  expect(new Set([secret, byOwner.secret, byOperator.secret]).size).toBe(3);
  expect(await secrets.read(oldRef ?? '')).toBeNull();
  expect(readdirSync(secretsDir)).toHaveLength(1);
  expect(store.input(input.id)).toMatchObject({ revision: input.revision + 2 });
  expect(await revealKey({ store, secrets }, DANA, input.id)).toEqual({
    status: 'revealed',
    secret: byOperator.secret,
  });
});

it('rotates nothing for anyone else, or for an input that is unknown or deleted', async () => {
  const { input, secret } = await createInput(
    { store, secrets },
    { auth: 'bearer', owner: 'U0DANA' },
  );

  expect(await rotateKey({ store, secrets }, EVE, input.id)).toBeNull();
  expect(await revealKey({ store, secrets }, DANA, input.id)).toEqual({
    status: 'revealed',
    secret,
  });
  expect(await rotateKey({ store, secrets }, DANA, 'inp-NOSUCHAAAAAAAAAAAAAAAA')).toBeNull();

  await deleteInput({ store, secrets }, input.id);
  expect(await rotateKey({ store, secrets }, DANA, input.id)).toBeNull();
  expect(readdirSync(secretsDir)).toEqual([]);
});

it('still hands over the new key when the old file cannot be removed', async () => {
  const { input } = await createInput({ store, secrets }, { auth: 'bearer', owner: 'U0DANA' });
  const [oldRef] = input.secretRefs;
  vi.spyOn(secrets, 'remove').mockRejectedValueOnce(new Error('file is busy'));

  const rotation = await rotateKey({ store, secrets }, DANA, input.id);

  expect(rotation).toMatchObject({ leftBehind: [oldRef] });
  expect(store.input(input.id)?.secretRefs).not.toContain(oldRef);
});
