// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { assertNotRootBesideDaemon, runIncomingCommand } from '../operator.js';
import { vaultInputSecrets, type InputSecrets } from '../secrets.js';
import { IncomingStore } from '../store.js';

let root: string;
let secretsDir: string;
let store: IncomingStore;
let secrets: InputSecrets;
let printed: string[];

function run(...args: string[]): Promise<void> {
  return runIncomingCommand(args, { store, secrets }, (line) => printed.push(line));
}

/** Creates an input through the command and returns what it printed about it. */
async function created(...args: string[]): Promise<{ id: string; secret: string; output: string }> {
  printed = [];
  await run('create', ...args);
  const output = printed.join('\n');
  const id = /Created input (\S+)/.exec(output)?.[1];
  const secret = /Secret:\s+(\S+)/.exec(output)?.[1];
  if (!id || !secret) throw new Error(`Unexpected create output: ${output}`);
  return { id, secret, output };
}

beforeEach(() => {
  vi.stubEnv('ARCHIE_SECRETS_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('ARCHIE_PUBLIC_URL', 'https://archie.example.test/');
  root = mkdtempSync(join(tmpdir(), 'archie-incoming-operator-'));
  secretsDir = join(root, 'secrets');
  store = new IncomingStore(join(root, 'state.sqlite'));
  secrets = vaultInputSecrets(secretsDir);
  printed = [];
});
afterEach(() => {
  store.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it('creates a signed input and prints its callback URL and its secret', async () => {
  const { id, secret, output } = await created();

  expect(output).toContain(`https://archie.example.test/webhooks/incoming/${id}`);
  expect(secret).toMatch(/^whsec_/);
  expect(output.split(secret)).toHaveLength(2);
  const input = store.input(id);
  expect(input).toMatchObject({ state: 'enabled', auth: 'standard_webhooks', filter: [] });
  expect(await secrets.read(input?.secretRefs[0] ?? '')).toBe(secret);
});

it('creates a bearer input with a filter', async () => {
  const filter = [{ pointer: '/type', op: 'equals', value: 'meeting.ended' }];

  const { id, secret, output } = await created(
    '--auth',
    'bearer',
    '--filter',
    JSON.stringify(filter),
  );

  expect(secret).not.toMatch(/^whsec_/);
  expect(output).toContain('Authorization: Bearer');
  expect(store.input(id)).toMatchObject({ auth: 'bearer', filter });
});

it('prints the path alone when the public URL is not configured', async () => {
  vi.stubEnv('ARCHIE_PUBLIC_URL', '');

  const { id, output } = await created();

  expect(output).toContain(`Callback path: /webhooks/incoming/${id}`);
  expect(output).not.toContain('Callback URL');
});

it.each([
  [['create', '--auth', 'basic'], /signed or bearer/],
  [['create', '--auth', 'constructor'], /signed or bearer/],
  [['create', '--filter', '{'], /not valid JSON/],
  [['create', '--filter', '[{"pointer":"type","op":"present"}]'], /not a valid filter/],
  [['create', '--label', 'x'], /Unknown option/],
  [['create', '--auth'], /needs a value/],
  [['pause'], /Usage/],
  [['pause', 'inp-missing'], /No input inp-missing/],
  [['delete', 'inp-missing'], /No input inp-missing/],
  [['frobnicate'], /Unknown command/],
  [[], /Unknown command/],
])('rejects %j and creates nothing', async (args, message) => {
  await expect(run(...args)).rejects.toThrow(message);

  expect(store.inputSummaries()).toEqual([]);
  expect(existsSync(secretsDir) ? readdirSync(secretsDir) : []).toEqual([]);
});

it('lists inputs with their state and what they have received', async () => {
  const signed = await created();
  const bearer = await created('--auth', 'bearer');
  const delivery = {
    inputId: signed.id,
    binding: 'generic',
    digest: 'unused',
    body: new Uint8Array(),
    receivedAt: Date.now(),
  };
  store.receive({ ...delivery, eventKey: 'msg_ignored' }, []);
  store.receive({ ...delivery, eventKey: 'msg_waiting' }, [
    { kind: 'routine', consumerId: 'trg-1', snapshot: '{}' },
  ]);
  await run('pause', bearer.id);
  printed = [];

  await run('list');

  expect(printed).toHaveLength(3);
  expect(printed[0]).toMatch(/^Input\s+State\s+Auth\s+Created\s+Receipts\s+Ignored\s+Waiting$/);
  expect(printed[0]).toHaveLength(printed[1]?.length ?? 0);
  expect(printed[1]).toMatch(
    new RegExp(`^${signed.id}\\s+enabled\\s+signed\\s+\\S+\\s+2\\s+1\\s+1$`),
  );
  expect(printed[2]).toMatch(
    new RegExp(`^${bearer.id}\\s+paused\\s+bearer\\s+\\S+\\s+0\\s+0\\s+0$`),
  );
  expect(printed.join('\n')).not.toContain(signed.secret);
});

it('says so when there is no input', async () => {
  await run('list');

  expect(printed.join('\n')).toContain('No inputs yet');
});

it('pauses, resumes and deletes an input, and removes its secret on delete', async () => {
  const { id } = await created();

  await run('pause', id);
  expect(store.input(id)?.state).toBe('paused');
  await run('resume', id);
  expect(store.input(id)?.state).toBe('enabled');

  await run('delete', id);
  expect(store.input(id)?.state).toBe('deleted');
  expect(readdirSync(secretsDir)).toEqual([]);
  expect(printed.at(-1)).toBe(`Input ${id} is deleted.`);

  await expect(run('resume', id)).rejects.toThrow(/cannot be resumed/);
  await expect(run('pause', id)).rejects.toThrow(/was deleted/);
  expect(store.input(id)?.state).toBe('deleted');
});

it('says the input is already deleted when only the secret cleanup failed', async () => {
  const { id } = await created();
  vi.spyOn(secrets, 'remove').mockRejectedValueOnce(new Error('file is busy'));

  await expect(run('delete', id)).rejects.toThrow(/is deleted .* file is busy\. Run delete again/);
  expect(store.input(id)?.state).toBe('deleted');

  await run('delete', id);
  expect(readdirSync(secretsDir)).toEqual([]);
});

it.each([
  ['root beside a workdir that another user owns', 0, 1001, true],
  ['root beside directories root owns', 0, 0, false],
  ['root where the directory does not exist yet', 0, undefined, false],
  ['the daemon user', 1001, 1001, false],
  ['a platform without user ids', undefined, 1001, false],
])('the root check: %s', (_name, uid, owner, refused) => {
  const check = () => assertNotRootBesideDaemon(uid, ['/workdir'], () => owner);

  if (refused) expect(check).toThrow(/not as root: \/workdir belongs to uid 1001/);
  else expect(check).not.toThrow();
});
