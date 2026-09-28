import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Budget, reserveEstimate } from './budget.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

describe('cost ledger', () => {
  it('reserves before dispatch and retains full charge on uncertain failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memory-eval-budget-')); dirs.push(dir);
    const path = join(dir, 'ledger.json');
    const budget = new Budget(path, 0.1); await budget.open();
    const index = await budget.reserve('first', 0.08);
    await expect(budget.reserve('second', 0.03)).rejects.toThrow('budget stop');
    await budget.settle(index, null, 'error');
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    expect(persisted.committedUsd).toBe(0.08);
    expect(reserveEstimate('claude-sonnet-5', 1000, 1024)).toBeGreaterThan(0);
  });
});
