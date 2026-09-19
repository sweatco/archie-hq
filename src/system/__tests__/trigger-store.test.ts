/**
 * Tests for the trigger-id validator that guards every store filesystem path
 * against traversal (CodeQL: uncontrolled data in path expression), and for the
 * persistent per-trigger data directory lifecycle.
 *
 * `TRIGGERS_DIR` / `TRIGGERS_DATA_DIR` are computed at module-import time from
 * `WORKDIR`, which itself reads `process.env.ARCHIE_WORKDIR` at import time — so the
 * env var is set to a temp dir BEFORE the store module is imported, and the module is
 * pulled in dynamically rather than with a static import.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, chmodSync } from 'fs';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Trigger } from '../../types/trigger.js';
import type { Task } from '../../tasks/task.js';

const WORK = mkdtempSync(join(tmpdir(), 'archie-trigger-store-'));
process.env.ARCHIE_WORKDIR = WORK;

const store = await import('../trigger-store.js');
const { isValidTriggerId, generateTriggerId, getTriggerPath } = store;
const { getTriggerDataPath, ensureTriggerDataDir, removeTriggerDataDir, saveTrigger, deleteTrigger } = store;
const { TRIGGERS_DATA_DIR } = await import('../workdir.js');

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
});

/** A minimal enabled trigger record, good enough to round-trip through the store. */
function sampleTrigger(id: string): Trigger {
  return {
    id,
    status: 'enabled',
    approved_by: 'UAPPROVER',
    created_at: '2026-08-17T09:00:00.000Z',
    binding: { type: 'user', user_id: 'UAPPROVER' },
    conditions: [{ type: 'schedule', tz: 'UTC', next_run_at: '2026-08-18T09:00:00.000Z', cron: '0 9 * * *' }],
    action: { prompt: 'do the thing' },
  };
}

describe('trigger approval identity', () => {
  it.each(['UAPPROVER', undefined])('drops the legacy identity and preserves only the recorded approval (%s)', async (approvedBy) => {
    const trigger = { ...sampleTrigger(`trg-legacy-${approvedBy ?? 'pending'}`), approved_by: approvedBy };
    await saveTrigger(trigger);
    await writeFile(getTriggerPath(trigger.id), JSON.stringify({ ...trigger, created_by: 'UOLD' }));

    const loaded = await store.loadTrigger(trigger.id);
    expect(loaded).toEqual(trigger);
    expect(loaded).not.toHaveProperty('created_by');
    await saveTrigger(loaded!);
    expect(JSON.parse(await readFile(getTriggerPath(trigger.id), 'utf-8'))).not.toHaveProperty('created_by');
  });

  it('checks the approving person’s cap, then records a different approver who has room', async () => {
    const { Task } = await import('../../tasks/task.js');
    const scheduler = await import('../trigger-scheduler.js');
    const persistence = await import('../../tasks/persistence.js');
    const announce = vi.spyOn(scheduler, 'announceTriggerChange').mockResolvedValue(undefined);
    const finding = vi.spyOn(persistence, 'appendAgentFinding').mockResolvedValue(undefined);
    const id = 'trg-approval-cap';
    const pending = { ...sampleTrigger(id), status: 'pending' as const, approved_by: undefined };
    const task = {
      taskId: 'task-trigger-approval',
      metadata: { pending_trigger_id: id },
      debouncedSave: vi.fn(),
    };
    try {
      for (let i = 0; i < scheduler.MAX_TRIGGERS_PER_USER; i++) {
        await saveTrigger({ ...sampleTrigger(`trg-cap-${i}`), approved_by: 'UFULL' });
      }
      await saveTrigger(pending);
      const approve = (userId: string) => Task.prototype.handleTriggerApproval.call(task as unknown as Task, userId, id);

      expect(await approve('UFULL')).toBeNull();
      expect(await store.loadTrigger(id)).toBeNull();
      expect(announce).not.toHaveBeenCalled();

      await saveTrigger(pending);
      expect(await approve('UFREE')).toMatchObject({ status: 'enabled', approved_by: 'UFREE' });
      expect(await store.loadTrigger(id)).toMatchObject({ status: 'enabled', approved_by: 'UFREE' });
      expect(announce).toHaveBeenCalledOnce();
    } finally {
      scheduler.deindexTrigger(id);
      announce.mockRestore();
      finding.mockRestore();
    }
  });
});

describe('isValidTriggerId', () => {
  it('accepts a freshly generated id', () => {
    expect(isValidTriggerId(generateTriggerId())).toBe(true);
  });

  it('accepts the canonical shape', () => {
    expect(isValidTriggerId('trg-20260710-1152-a3f9k2')).toBe(true);
  });

  it('rejects path-traversal attempts', () => {
    expect(isValidTriggerId('../../etc/passwd')).toBe(false);
    expect(isValidTriggerId('trg-../secret')).toBe(false);
    expect(isValidTriggerId('trg-/etc/passwd')).toBe(false);
    expect(isValidTriggerId('trg-..')).toBe(false);
  });

  it('rejects ids without the trg- prefix or with unsafe chars', () => {
    expect(isValidTriggerId('passwd')).toBe(false);
    expect(isValidTriggerId('trg-a.b')).toBe(false);
    expect(isValidTriggerId('trg_a')).toBe(false);
    expect(isValidTriggerId('')).toBe(false);
  });
});

describe('getTriggerPath', () => {
  it('throws on a malformed id rather than building a traversal path', () => {
    expect(() => getTriggerPath('../../evil')).toThrow(/Invalid trigger id/);
  });

  it('builds a path inside the triggers dir for a valid id', () => {
    const p = getTriggerPath('trg-20260710-1152-a3f9k2');
    expect(p.endsWith('/trg-20260710-1152-a3f9k2.json')).toBe(true);
    expect(p).not.toContain('..');
  });
});

describe('getTriggerDataPath', () => {
  it('throws on ids that are malformed or would escape the data dir', () => {
    expect(() => getTriggerDataPath('../escape')).toThrow(/Invalid trigger id/);
    expect(() => getTriggerDataPath('trg-../x')).toThrow(/Invalid trigger id/);
    expect(() => getTriggerDataPath('not-a-trigger')).toThrow(/Invalid trigger id/);
    expect(() => getTriggerDataPath('')).toThrow(/Invalid trigger id/);
  });

  it('builds a suffix-less directory path inside the trigger data dir', () => {
    const p = getTriggerDataPath('trg-20260817-1200-abc123');
    expect(p).toBe(join(TRIGGERS_DATA_DIR, 'trg-20260817-1200-abc123'));
    expect(p.endsWith('.json')).toBe(false);
    expect(p).not.toContain('..');
  });
});

describe('ensureTriggerDataDir', () => {
  it('is idempotent and preserves what an earlier fire wrote', async () => {
    const id = 'trg-20260817-1201-idem01';
    await saveTrigger(sampleTrigger(id));

    const first = await ensureTriggerDataDir(id);
    expect(first).not.toBeNull();
    await writeFile(join(first!, 'notes.md'), 'previous fire wrote this');

    const second = await ensureTriggerDataDir(id);

    expect(second).toBe(first);
    expect(await readFile(join(first!, 'notes.md'), 'utf-8')).toBe('previous fire wrote this');
  });

  it('creates nothing and returns null once the trigger record is gone', async () => {
    // Spawn re-runs after deletion — a user reply, a delegation, a restart — and
    // re-creating the directory would orphan resurrected content for good.
    const id = 'trg-20260817-1205-deleted';
    await saveTrigger(sampleTrigger(id));
    const path = await ensureTriggerDataDir(id);
    await writeFile(join(path!, 'notes.md'), 'carry-over');

    await deleteTrigger(id);
    expect(existsSync(path!)).toBe(false);

    expect(await ensureTriggerDataDir(id)).toBeNull();
    expect(existsSync(path!)).toBe(false);
  });

  it('returns null for a trigger that never existed', async () => {
    expect(await ensureTriggerDataDir('trg-20260817-1206-nosuch')).toBeNull();
    expect(existsSync(getTriggerDataPath('trg-20260817-1206-nosuch'))).toBe(false);
  });
});

describe('removeTriggerDataDir', () => {
  it('removes a populated directory, nested subdirectories included', async () => {
    const id = 'trg-20260817-1202-rmtree';
    await saveTrigger(sampleTrigger(id));
    const path = (await ensureTriggerDataDir(id))!;
    await writeFile(join(path, 'state.json'), '{"seen":1}');
    await mkdir(join(path, 'nested', 'deeper'), { recursive: true });
    await writeFile(join(path, 'nested', 'deeper', 'log.txt'), 'entry');

    await removeTriggerDataDir(id);

    expect(existsSync(path)).toBe(false);
  });

  it('resolves for a well-formed id whose directory was never created', async () => {
    // The common case: a trigger that never fired never got a directory.
    await expect(removeTriggerDataDir('trg-20260817-1203-neverwas')).resolves.toBeUndefined();
  });

  // `force: true` swallows only a missing directory; a real refusal propagates, so no
  // caller reports a deletion while the data is still on disk.
  // Skipped as root, which ignores directory permissions, so the chmod would not
  // bite and the test would pass vacuously.
  it.skipIf(process.getuid?.() === 0)('rejects rather than reporting success when the filesystem refuses', async () => {
    const id = 'trg-20260817-1207-eacces';
    await saveTrigger(sampleTrigger(id));
    const path = (await ensureTriggerDataDir(id))!;
    await writeFile(join(path, 'state.json'), '{"seen":1}');

    // Strip write permission from the PARENT, so removing `path` itself fails.
    chmodSync(TRIGGERS_DATA_DIR, 0o500);
    try {
      await expect(removeTriggerDataDir(id)).rejects.toThrow();
      expect(existsSync(path)).toBe(true); // the refusal was real, so the rejection is meaningful
    } finally {
      chmodSync(TRIGGERS_DATA_DIR, 0o700);
    }
  });
});

describe('deleteTrigger', () => {
  it('removes both the record file and the data directory', async () => {
    const id = 'trg-20260817-1204-both01';
    await saveTrigger(sampleTrigger(id));
    const dataPath = (await ensureTriggerDataDir(id))!;
    await writeFile(join(dataPath, 'notes.md'), 'carry-over');

    await deleteTrigger(id);

    expect(existsSync(getTriggerPath(id))).toBe(false);
    expect(existsSync(dataPath)).toBe(false);
  });

  it('still resolves for a trigger with a record but no data directory', async () => {
    // Already a no-op for a missing record thanks to the existsSync guard — this
    // asserts the added `rm` did not break that, it does not add the property.
    const id = 'trg-20260817-1205-nodir01';
    await saveTrigger(sampleTrigger(id));

    await expect(deleteTrigger(id)).resolves.toBeUndefined();
    expect(existsSync(getTriggerPath(id))).toBe(false);
  });
});
