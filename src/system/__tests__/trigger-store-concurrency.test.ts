/**
 * The store under concurrent writers on ONE trigger id.
 *
 * A pending proposal is editable while its Approve/Deny card is live, and cards
 * are never retracted, so "the user clicks Approve while the agent is revising
 * the proposal" is an ordinary event, not a rare one. Before the store
 * serialized these, that produced two distinct failures, both measured here
 * against the REAL filesystem rather than a mock — a mocked store cannot
 * reproduce a torn write, which is exactly why this defect survived a full
 * suite that stubbed `saveTrigger` everywhere:
 *
 *  1. A torn record. Two truncate-and-write calls interleaving left invalid
 *     JSON, and `loadTrigger` reports an unparseable record as MISSING — so the
 *     trigger silently vanished from every listing and stopped counting toward
 *     any cap, while the scheduler kept firing it from the in-memory index.
 *  2. A ghost. The edit's write landed after the approval's, stamping the file
 *     back to `pending` with the new content, leaving a trigger that fires from
 *     memory while every listing calls it "awaiting approval".
 *
 * `ARCHIE_WORKDIR` is read at module-import time, so it is set before the
 * dynamic import, matching trigger-store.test.ts.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Trigger } from '../../types/trigger.js';

const WORK = mkdtempSync(join(tmpdir(), 'archie-trigger-race-'));
process.env.ARCHIE_WORKDIR = WORK;

const store = await import('../trigger-store.js');
const { saveTrigger, loadTrigger, deleteTrigger, enableProposedTrigger, updatePendingTrigger, withdrawPendingTrigger, getTriggerPath } = store;
const { TRIGGERS_DIR } = await import('../workdir.js');

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
});

const ID = 'trg-20260824-1030-race01';

function pending(): Trigger {
  return {
    id: ID,
    status: 'pending',
    summary: 'the standup digest',
    created_by: 'U_REQ',
    created_at: '2026-08-24T10:30:00.000Z',
    proposed_in_task: 'task-1',
    binding: { type: 'channel', channel_id: 'C_STANDUP', channel_name: 'standup' },
    conditions: [{ type: 'schedule', cron: '0 9 * * 1-5', tz: 'Europe/London', next_run_at: '2026-08-25T08:00:00.000Z' }],
    action: { prompt: 'post the digest' },
  } as Trigger;
}

/** Deliberately long, so a torn write is detectable rather than fitting one atom. */
const LONG_PROMPT = `REVISED: ${'post the digest with the longer preamble that makes this record big enough to tear. '.repeat(6)}`;

const ITERATIONS = 120;

describe('a pending edit racing the user’s Approve', () => {
  /**
   * Both orderings are exercised deliberately, because each one is a different
   * failure. Edit-then-Approve is the lost-update case: the approval must enable
   * the EDITED content, not the content the edit was about to replace.
   * Approve-then-Edit is the ghost case: the edit must refuse rather than stamp
   * a live trigger back to `pending`.
   */
  it('enables the edited content when the edit is queued first — no lost update', async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      await saveTrigger(pending());

      const edit = updatePendingTrigger(ID, (t) => { t.action.prompt = LONG_PROMPT; t.summary = 'the revised digest'; });
      const approve = enableProposedTrigger(ID, 'U_CLICKER');
      const [editResult, approved] = await Promise.all([edit, approve]);

      const onDisk = await loadTrigger(ID);
      expect(onDisk, `iteration ${i}: record was unparseable or missing`).not.toBeNull();
      expect(editResult.outcome, `iteration ${i}`).toBe('updated');
      expect(approved, `iteration ${i}: serializing must not stop the approval landing`).not.toBeNull();

      // The whole point: the approval enabled what the edit wrote.
      expect(onDisk!.status).toBe('enabled');
      expect(onDisk!.action.prompt, `iteration ${i}: the edit was lost`).toBe(LONG_PROMPT);
      expect(onDisk!.summary).toBe('the revised digest');
      expect(approved!.action.prompt, `iteration ${i}: the scheduler indexed pre-edit content`).toBe(LONG_PROMPT);
      expect(onDisk!.updated_at, 'an edit must renew the GC clock').toBeTruthy();
    }
  });

  it('refuses the edit when the approval is queued first — no ghost', async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      await saveTrigger(pending());

      const approve = enableProposedTrigger(ID, 'U_CLICKER');
      const edit = updatePendingTrigger(ID, (t) => { t.action.prompt = LONG_PROMPT; });
      const [approved, editResult] = await Promise.all([approve, edit]);

      const onDisk = await loadTrigger(ID);
      expect(onDisk, `iteration ${i}: record was unparseable or missing`).not.toBeNull();
      expect(approved, `iteration ${i}`).not.toBeNull();

      // The edit must abandon rather than write the trigger back to pending.
      expect(editResult.outcome, `iteration ${i}`).toBe('resolved');
      if (editResult.outcome === 'resolved') expect(editResult.status).toBe('enabled');
      expect(onDisk!.status, `iteration ${i}: ghost — disk says pending, scheduler holds it enabled`).toBe('enabled');
      expect(onDisk!.action.prompt, `iteration ${i}: a refused edit must change nothing`).toBe('post the digest');
    }
  });

  it('leaves no temp files behind, and none that listTriggers would read as a trigger', async () => {
    await saveTrigger(pending());
    await Promise.all([
      updatePendingTrigger(ID, (t) => { t.summary = 'a'; }),
      updatePendingTrigger(ID, (t) => { t.summary = 'b'; }),
      enableProposedTrigger(ID, 'U'),
    ]);
    const names = readdirSync(TRIGGERS_DIR);
    expect(names.filter((n) => n.endsWith('.tmp')), 'temp files must be renamed away').toEqual([]);
    expect(names.filter((n) => n.endsWith('.json'))).toEqual([`${ID}.json`]);
  });
});

describe('a pending edit racing a withdrawal', () => {
  it('never resurrects a withdrawn proposal and never leaves a torn record', async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      await saveTrigger(pending());

      const edit = updatePendingTrigger(ID, (t) => { t.action.prompt = LONG_PROMPT; });
      const withdraw = deleteTrigger(ID);
      const [editResult] = await Promise.all([edit, withdraw]);

      const onDisk = await loadTrigger(ID);
      const fileThere = existsSync(getTriggerPath(ID));

      if (editResult.outcome === 'updated') {
        // The edit ran first; the withdrawal then removed it. Either way the
        // user's decision is final, so nothing may remain.
        expect(fileThere, `iteration ${i}: withdrawal must win over an earlier edit`).toBe(false);
      } else {
        expect(editResult.outcome).toBe('gone');
        expect(onDisk).toBeNull();
      }
      // The record must never survive a withdrawal in any form.
      expect(existsSync(getTriggerPath(ID)), `iteration ${i}: proposal resurrected`).toBe(false);
    }
  });
});

describe('a withdrawal racing the user’s Approve', () => {
  /**
   * Locking the DELETION alone was not enough, and this is the case that proves
   * it. Callers used to read the record, check `status === 'pending'` themselves,
   * and then call a locked `deleteTrigger` — so the decision came from a read
   * taken outside the lock, and the unlink queued *behind* a concurrent approval.
   * Measured that way, 40 of 40 races ended with the approval indexing the
   * trigger and the withdrawal then removing its file: the scheduler fires it
   * forever while `loadTrigger` returns null, so every listing, edit and
   * withdrawal reports it as nonexistent and only a restart clears it.
   *
   * Which is exactly the state the status gate on denial was introduced to
   * prevent, reintroduced one layer down.
   */
  it('never leaves the scheduler holding a trigger whose file was deleted', async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      await saveTrigger(pending());

      const withdraw = withdrawPendingTrigger(ID);
      const approve = enableProposedTrigger(ID, 'U_CLICKER');
      const [w, approved] = await Promise.all([withdraw, approve]);

      const onDisk = await loadTrigger(ID);
      // The ghost: the caller would have indexed `approved`, and the file is gone.
      expect(Boolean(approved && !onDisk), `iteration ${i}: enabled in the index with no record on disk`).toBe(false);
      // Exactly one of them may claim to have acted.
      expect(w.outcome === 'withdrawn' ? approved === null : approved !== null).toBe(true);
    }
  });

  it('refuses the withdrawal when the approval got there first', async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      await saveTrigger(pending());

      const approve = enableProposedTrigger(ID, 'U_CLICKER');
      const withdraw = withdrawPendingTrigger(ID);
      const [approved, w] = await Promise.all([approve, withdraw]);

      expect(approved, `iteration ${i}`).not.toBeNull();
      // Approval is the user's act; a racing withdrawal must not undo it.
      expect(w.outcome, `iteration ${i}`).toBe('resolved');
      if (w.outcome === 'resolved') expect(w.status).toBe('enabled');
      const onDisk = await loadTrigger(ID);
      expect(onDisk, `iteration ${i}: an approved trigger was deleted by a racing withdrawal`).not.toBeNull();
      expect(onDisk!.status).toBe('enabled');
    }
  });

  it('reports a proposal that was already gone', async () => {
    expect((await withdrawPendingTrigger('trg-20260824-1030-absent')).outcome).toBe('gone');
  });
});

describe('saveTrigger is atomic', () => {
  /**
   * The lock serializes the PENDING lifecycle, but not every writer takes it:
   * the scheduler writes a record straight through `saveTrigger` on the fire
   * path — `last_fired_at`, a consumed one-off condition, an auto-pause —
   * because those act on enabled triggers in the in-memory index, outside this
   * lifecycle. Two such writes can overlap, and then atomicity rather than the
   * lock is what keeps the record readable.
   *
   * Payload sizes differ by orders of magnitude on purpose. A truncate-and-write
   * pair tears precisely when the shorter write lands inside the longer one's
   * extent, leaving the short record followed by the tail of the long one —
   * which is invalid JSON, and `loadTrigger` reports invalid JSON as MISSING, so
   * a live trigger silently disappears from every listing while the scheduler
   * keeps firing it from memory. Equal-sized writes overwrite cleanly and prove
   * nothing, which is why this does not use them.
   */
  it('concurrent writes of very different sizes never leave a torn record', async () => {
    const big = { ...pending(), action: { prompt: 'x'.repeat(400_000) } } as Trigger;
    const small = { ...pending(), action: { prompt: 'y' } } as Trigger;

    for (let i = 0; i < 60; i++) {
      await saveTrigger(pending());

      // Started in the same tick, so the writes genuinely overlap.
      await Promise.all([saveTrigger(big), saveTrigger(small)]);

      const raw = await readFile(getTriggerPath(ID), 'utf-8');
      expect(() => JSON.parse(raw), `iteration ${i}: torn record on disk`).not.toThrow();
      expect(await loadTrigger(ID), `iteration ${i}: record read as missing`).not.toBeNull();
    }
  });
});
