import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

  it('serializes independent instances against one cap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memory-eval-budget-')); dirs.push(dir);
    const path = join(dir, 'ledger.json');
    const first = new Budget(path, 0.1), second = new Budget(path, 0.1);
    await Promise.all([first.open(), second.open()]);
    const outcomes = await Promise.allSettled([first.reserve('first', 0.08), second.reserve('second', 0.08)]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const ledger = JSON.parse(await readFile(path, 'utf8'));
    expect(ledger.committedUsd).toBe(0.08);
    expect(ledger.reservations).toHaveLength(1);
  });

  it('fails closed on corruption and preserves existing spend', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memory-eval-budget-')); dirs.push(dir);
    const path = join(dir, 'ledger.json');
    const budget = new Budget(path, 0.1); await budget.open();
    await budget.reserve('uncertain', 0.08);
    await writeFile(path, '{broken');
    const second = new Budget(path, 0.1);
    await expect(second.open()).rejects.toThrow();
    await expect(budget.reserve('later', 0.01)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('{broken');
  });
});
