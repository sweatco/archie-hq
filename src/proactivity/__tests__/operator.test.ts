// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InitiativeStore } from '../store.js';
import { runInitiativeOperator } from '../../cli/initiative.js';

let root: string;
let path: string;
let proposal: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'initiative-operator-')); path = join(root, 'state.sqlite');
  const store = new InitiativeStore(path, 'T1');
  store.set('delivery_enabled', 'true');
  const now = Date.now(); const ts = (now / 1000).toFixed(6);
  store.channel('C1', true, false);
  const evidence = store.record({ channel: 'C1', thread: ts, ts, version: ts, author: 'U1', text: 'Review the release' }, now)!;
  store.apply([store.snapshot('C1', ts)!], [], [{ id: 'matter', channel: 'C1', thread: ts, title: 'Release', detail: 'Review release', evidence: [evidence], state: 'open', owner: 'U1', deadline: null, explicit: true, nextCheck: now, valid: true }]);
  proposal = store.proposeCapability({ repository: 'owner/repo', outcome: 'Review the release', evidence: [evidence], matter: 'matter' });
  store.close();
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

it.each([
  ['removed-command'], ['migrate'], ['explain', 'matter'], ['proposals'], ['ack', 'proposal', 'https://github.com/owner/repo/issues/1', 'filed'],
  ['bind-provider', 'local-batch'], ['reconcile-batch', 'remote-batch'], ['explain', '', 'output.json'], ['proposals', 'one', 'two'],
])('rejects invalid or retired operation %j without changing the database', async (...args) => {
  const before = readFileSync(path);
  await expect(runInitiativeOperator([path, 'T1', ...args])).rejects.toThrow();
  expect(readFileSync(path)).toEqual(before);
});

it.each(['explain', 'proposals'])('exports %s read-only to a private file', async command => {
  const before = readFileSync(path);
  const output = join(root, 'output.json');
  await runInitiativeOperator([path, 'T1', command, ...(command === 'explain' ? ['matter'] : []), output]);
  const result = JSON.parse(readFileSync(output, 'utf8'));
  if (command === 'proposals') expect(result[0]).toMatchObject({ id: proposal, body: { outcome: 'Review the release' } });
  else expect(result).toMatchObject({ decisions: [], deliveries: [] });
  expect(statSync(output).mode & 0o777).toBe(0o600);
  expect(readFileSync(path)).toEqual(before);
});
