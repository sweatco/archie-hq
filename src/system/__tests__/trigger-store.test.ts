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

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Trigger } from '../../types/trigger.js';

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
    created_by: 'UCREATOR',
    created_at: '2026-08-17T09:00:00.000Z',
    binding: { type: 'user', user_id: 'UCREATOR' },
    conditions: [{ type: 'schedule', tz: 'UTC', next_run_at: '2026-08-18T09:00:00.000Z', cron: '0 9 * * *' }],
    action: { prompt: 'do the thing' },
  };
}

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

    const first = await ensureTriggerDataDir(id);
    await writeFile(join(first, 'notes.md'), 'previous fire wrote this');

    const second = await ensureTriggerDataDir(id);

    expect(second).toBe(first);
    expect(await readFile(join(first, 'notes.md'), 'utf-8')).toBe('previous fire wrote this');
  });
});

describe('removeTriggerDataDir', () => {
  it('removes a populated directory, nested subdirectories included', async () => {
    const id = 'trg-20260817-1202-rmtree';
    const path = await ensureTriggerDataDir(id);
    await writeFile(join(path, 'state.json'), '{"seen":1}');
    await mkdir(join(path, 'nested', 'deeper'), { recursive: true });
    await writeFile(join(path, 'nested', 'deeper', 'log.txt'), 'entry');

    await removeTriggerDataDir(id);

    expect(existsSync(path)).toBe(false);
  });

  it('resolves for a well-formed id whose directory was never created', async () => {
    // The common case: a pending trigger that was denied, cap-refused or GC'd
    // never fired, so it never got a directory.
    await expect(removeTriggerDataDir('trg-20260817-1203-neverwas')).resolves.toBeUndefined();
  });
});

describe('deleteTrigger', () => {
  it('removes both the record file and the data directory', async () => {
    const id = 'trg-20260817-1204-both01';
    await saveTrigger(sampleTrigger(id));
    const dataPath = await ensureTriggerDataDir(id);
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
