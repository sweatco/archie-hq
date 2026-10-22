// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InitiativeStore } from '../store.js';
import { SCHEMA_VERSION } from '../persistence/migrations.js';
import { runInitiativeOperator } from '../../cli/initiative.js';

let root: string;
let path: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'initiative-operator-')); path = join(root, 'state.sqlite');
  const store = new InitiativeStore(path, 'T1');
  store.set('delivery_enabled', 'true'); store.set('policy', 'old-guidance'); store.close();
  const db = new DatabaseSync(path); db.exec('PRAGMA user_version=8'); db.close();
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function state() {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return { version: db.prepare('PRAGMA user_version').get()!.user_version,
      delivery: db.prepare("SELECT value FROM settings WHERE key='delivery_enabled'").get()!.value,
      policy: db.prepare("SELECT value FROM settings WHERE key='policy'").get()!.value };
  } finally { db.close(); }
}

it.each([
  ['removed-command'], ['migrate', 'extra'], ['explain', 'matter'], ['proposals'], ['ack', 'proposal', 'https://github.com/owner/repo/issues/1', 'completed'],
  ['ack', 'proposal', 'not-an-issue-url', 'filed'], ['bind-provider'], ['reconcile-batch', 'one', 'two'], ['explain', '', 'output.json'],
])('rejects invalid operation arguments %j before writable opening', async (...args) => {
  await expect(runInitiativeOperator([path, 'T1', ...args])).rejects.toThrow();
  expect(state()).toEqual({ version: 8, delivery: 'true', policy: 'old-guidance' });
});

it('retains explicit migration as an intentional write', async () => {
  await runInitiativeOperator([path, 'T1', 'migrate']);
  expect(state()).toEqual({ version: SCHEMA_VERSION, delivery: 'false', policy: 'base' });
});

it('keeps valid external development acknowledgement while preserving proposal intent', async () => {
  await runInitiativeOperator([path, 'T1', 'migrate']);
  const store = new InitiativeStore(path, 'T1');
  try { store.proposeCapability('proposal', { repository: 'owner/repo', outcome: 'Prepare checklist', evidence: [1] }); }
  finally { store.close(); }
  await runInitiativeOperator([path, 'T1', 'ack', 'proposal', 'https://github.com/owner/repo/issues/1', 'filed', 'Triaged']);
  const read = new InitiativeStore(path, 'T1', Date.now(), { readOnly: true });
  try { expect(read.proposal('proposal')).toMatchObject({ outcome: 'Prepare checklist', status: 'filed' }); }
  finally { read.close(); }
});


it.each([
  ['export', 'policy', 'output.json'], ['cohort', 'policy', 'missing-labels.json'], ['evaluate', 'policy', 'missing-labels.json', 'output.json'],
])('rejects disabled learning command %j before database opening or input-file reading', async (...args) => {
  vi.stubEnv('ARCHIE_SELF_EVOLUTION', 'false');
  await expect(runInitiativeOperator([path, 'T1', ...args])).rejects.toThrow('Self-evolution is disabled');
  expect(state()).toEqual({ version: 8, delivery: 'true', policy: 'old-guidance' });
});

it.each(['cohort', 'evaluate'] as const)('validates %s label syntax and shape before writable opening', async command => {
  vi.stubEnv('ARCHIE_SELF_EVOLUTION', 'true');
  const labels = join(root, 'labels.json');
  for (const input of ['{', '{}']) {
    writeFileSync(labels, input);
    const args = [path, 'T1', command, 'policy', labels];
    if (command === 'evaluate') args.push(join(root, 'report.json'));
    await expect(runInitiativeOperator(args)).rejects.toThrow();
    expect(state()).toEqual({ version: 8, delivery: 'true', policy: 'old-guidance' });
  }
});
