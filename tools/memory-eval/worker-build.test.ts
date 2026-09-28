import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { syntheticCorpus } from './corpus.js';

describe('offline replay worker', () => {
  it('rejects an unknown completion before reserving money or calling a model', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'memory-eval-denied-'));
    try {
      const history = structuredClone(syntheticCorpus().histories.find((h) => h.id === 'synthetic-decision-correction-v1')!);
      history.completions = [{ ...history.completions[0], audience: { kind: 'public', channelId: 'CTESTCHAN01', authorization: 'unknown' } }];
      const ledger = join(temp, 'ledger.json');
      await mkdir(join(temp, 'state'));
      const input = JSON.stringify({ mode: 'build', history, cutoff: history.completions[0].at,
        workdir: join(temp, 'state', 'workdir'), ledger, capUsd: 100 });
      expect(() => execFileSync(process.execPath, ['--import', 'tsx', 'tools/memory-eval/worker.ts'], {
        cwd: join(import.meta.dirname, '../..'), input, encoding: 'utf8',
        env: { ...process.env, ANTHROPIC_API_KEY: 'offline-test-only', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })).toThrow('completion authorization denied or unknown before model call');
      const budget = JSON.parse(await readFile(ledger, 'utf8')) as { committedUsd: number; reservations: unknown[] };
      expect(budget.committedUsd).toBe(0);
      expect(budget.reservations).toEqual([]);
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
});
