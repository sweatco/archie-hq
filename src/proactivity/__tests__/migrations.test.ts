// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InitiativeStore } from '../store.js';
import { SCHEMA_VERSION } from '../persistence/migrations.js';

const NOW = Date.parse('2026-10-20T10:00:00Z');
let root: string;
let path: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'archie-migration-')); path = join(root, 'state.sqlite');
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec(readFileSync(new URL('./fixtures/v4.sql', import.meta.url), 'utf8'));
    legacy.exec(`INSERT INTO settings VALUES ('team','T1'),('owner','U_OWNER'),('policy','base'),('watermark','1792490000');
      INSERT INTO channels VALUES ('C1',1,0,'1792490000',NULL,NULL);
      INSERT INTO threads VALUES ('C1','1792490400.000001',2,2,${NOW},NULL);
      INSERT INTO revisions VALUES (7,'C1','1792490400.000001','1792490400.000001','1792490400.000001','U_AUTHOR','Original evidence','Original evidence',0,0,${NOW},'hash',0);
      INSERT INTO messages VALUES ('C1','1792490400.000001',7);
      INSERT INTO observations VALUES ('o1','C1','1792490400.000001','Commitment','[7]','commitment',1);
      INSERT INTO observation_search VALUES ('o1','Commitment');
      INSERT INTO jobs VALUES ('investigate','m1','{}',${NOW},${NOW + 300000},'lease',2,4);
      INSERT INTO charges VALUES ('charge',50000,${NOW},NULL,NULL);
      INSERT INTO charge_scopes VALUES ('charge','background');
      INSERT INTO deliveries VALUES ('delivery','D_OWNER',NULL,'Pending help','["m1"]','[7]','base',0,'pending',NULL,${NOW},NULL);
      INSERT INTO feedback VALUES (1,'m1','later',${NOW});
      INSERT INTO policies VALUES ('policy1','{}','base','[7]',NULL,'proposed');
      INSERT INTO proposals VALUES ('proposal','{"repository":"owner/repo","outcome":"Checklist","evidence":[7]}','pending filing',NULL);
      INSERT INTO batches VALUES ('batch','remote','charge','{"model":"claude-haiku-5-5"}','{}','pending',NULL,${NOW});`);
  } finally { legacy.close(); }
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('initiative schema ownership', () => {
  it('upgrades v7 activated handoffs into the indexed card-repair queue without changing approved work', () => {
    new InitiativeStore(path, 'T1', NOW).close();
    const legacy = new DatabaseSync(path);
    legacy.exec(`DROP INDEX pending_handoff_cards;
      ALTER TABLE handoffs DROP COLUMN card_state; ALTER TABLE handoffs DROP COLUMN card_retry;
      INSERT INTO handoffs(proposal,version,actor,approved,task,state,budget,delivery) VALUES ('proposal','v1','U_OWNER',${NOW},'task-1','activated','task','delivery');
      PRAGMA user_version=7`);
    legacy.close();
    const store = new InitiativeStore(path, 'T1', NOW);
    try {
      expect(store.handoff('proposal')).toMatchObject({ state: 'activated', task: 'task-1', actor: 'U_OWNER', card_state: null, card_retry: 0 });
      expect(store.pendingHandoffCards(NOW).map(row => row.proposal)).toEqual(['proposal']);
      expect(store.budget(NOW)).toBe(50000);
      const plan = store['rows'](`EXPLAIN QUERY PLAN SELECT * FROM handoffs WHERE card_retry<=?
        AND card_state IS NOT CASE WHEN state IN ('approved','prepared') THEN 'pending' ELSE state END
        ORDER BY card_retry,approved LIMIT 10`, NOW);
      expect(JSON.stringify(plan)).toContain('pending_handoff_cards');
      store.finishHandoffCard('proposal', 'activated', store.claimHandoffCard('proposal', NOW)!);
      expect(store.pendingHandoffCards(NOW)).toEqual([]);
    } finally { store.close(); }
  });

  it('upgrades v4 evidence and in-flight state without changing their identities, then reopens idempotently', () => {
    let first: string;
    const store = new InitiativeStore(path, 'T1', NOW, { owner: 'U_OWNER' });
    try {
      expect(store['row']('PRAGMA user_version')?.user_version).toBe(SCHEMA_VERSION);
      expect(store.setting('watermark')).toBe('1792490000');
      expect(store.snapshot('C1', '1792490400.000001')?.evidence[0]).toMatchObject({ id: 7, text: 'Original evidence' });
      expect(store['row']('SELECT * FROM jobs')).toMatchObject({ token: 'lease', generation: 4, attempts: 2 });
      expect(store.budget(NOW)).toBe(50000);
      expect(store.delivery('delivery')?.state).toBe('pending');
      expect(store.proposal('proposal')?.evidence).toEqual([7]);
      expect(store.search('Commitment', ['C1']).map(hit => hit.id)).toEqual(['o1']);
      expect(store['row']('SELECT action,created FROM feedback')).toMatchObject({ action: 'later', created: NOW });
      expect(store.learning.policy('policy1')).toMatchObject({ state: 'proposed', evidence: '[7]' });
      first = JSON.stringify(store['rows']("SELECT name,sql FROM sqlite_master ORDER BY name"));
    } finally { store.close(); }
    const reopened = new InitiativeStore(path, 'T1', NOW + 60000, { owner: 'U_OWNER' });
    try {
      expect(JSON.stringify(reopened['rows']('SELECT name,sql FROM sqlite_master ORDER BY name'))).toBe(first!);
      expect(reopened['row']('SELECT settled FROM charges')?.settled).toBeNull();
      expect(reopened['row']('SELECT remote,state FROM batches')).toMatchObject({ remote: 'remote', state: 'pending' });
    } finally { reopened.close(); }
  });

  it('does not migrate on read-only open and does not create schema during reads', () => {
    expect(() => new InitiativeStore(path, 'T1', NOW, { readOnly: true })).toThrow('explicit startup or migrate');
    const raw = new DatabaseSync(path);
    expect(raw.prepare('PRAGMA user_version').get()?.user_version).toBe(4); raw.close();
    new InitiativeStore(path, 'T1', NOW).close();
    const reader = new InitiativeStore(path, 'T1', NOW, { readOnly: true });
    try {
      const before = reader['row']('PRAGMA schema_version')?.schema_version;
      reader.search('commitment', ['C1']); reader.explain('m1'); reader.listProposals();
      expect(reader['row']('PRAGMA schema_version')?.schema_version).toBe(before);
      expect(reader['row']('SELECT total_changes() AS n')?.n).toBe(0);
      expect(() => reader.set('mutation', 'denied')).toThrow();
    } finally { reader.close(); }
  });

  it('rolls back an interrupted or incompatible upgrade without partial new tables or source loss', () => {
    const raw = new DatabaseSync(path);
    raw.exec('CREATE TABLE coverage_gaps (wrong_column TEXT)'); raw.close();
    expect(() => new InitiativeStore(path, 'T1', NOW)).toThrow();
    const check = new DatabaseSync(path);
    try {
      expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(4);
      expect(check.prepare("SELECT name FROM sqlite_master WHERE name='handoffs'").get()).toBeUndefined();
      expect(check.prepare('SELECT text FROM revisions WHERE id=7').get()?.text).toBe('Original evidence');
      expect(check.prepare('SELECT maximum,settled FROM charges').get()).toMatchObject({ maximum: 50000, settled: null });
    } finally { check.close(); }
  });

  it('rejects another workspace, owner or unsupported future schema without upgrading it', () => {
    expect(() => new InitiativeStore(path, 'T_OTHER', NOW)).toThrow('workspace mismatch');
    expect(() => new InitiativeStore(path, 'T1', NOW, { owner: 'U_OTHER' })).toThrow('owner mismatch');
    const raw = new DatabaseSync(path);
    expect(raw.prepare('PRAGMA user_version').get()?.user_version).toBe(4);
    raw.exec(`PRAGMA user_version=${SCHEMA_VERSION + 1}`); raw.close();
    expect(() => new InitiativeStore(path, 'T1', NOW)).toThrow('newer than this binary');
  });

  it('keeps policy, attention and outbox state together when activation is interrupted', () => {
    const store = new InitiativeStore(path, 'T1', NOW);
    try {
      store['run']("CREATE TRIGGER interrupt_activation BEFORE INSERT ON settings WHEN NEW.key='rollout_approved' BEGIN SELECT RAISE(ABORT,'interrupted activation'); END");
      expect(() => store.learning.activatePolicy('policy1', true)).toThrow('interrupted activation');
      expect(store.learning.policy('policy1')?.state).toBe('proposed');
      expect(store.setting('policy')).toBe('base');
      expect(store.setting('rollout_approved')).toBeUndefined();
      expect(store.delivery('delivery')?.state).toBe('pending');
    } finally { store.close(); }
  });
});
