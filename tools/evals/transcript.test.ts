import { cp, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeByTime, readTaskToolCalls, type CallSource } from './transcript.js';

const TASK_ID = 'task-20260101-0900-evalfx';
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', TASK_ID);
const PROJECT = 'claude/pm/session/projects/-workdir-sessions-task-20260101-0900-evalfx-agents-pm';
const WORKER_TRANSCRIPT = join(
  PROJECT,
  '11111111-1111-4111-8111-111111111111',
  'subagents',
  'agent-afx0000000000001.jsonl',
);
const RECORDED = [
  { agentKey: 'pm', sessionId: '11111111-1111-4111-8111-111111111111' },
  { agentKey: 'pm', sessionId: '22222222-2222-4222-8222-222222222222' },
];

const copies: string[] = [];

afterEach(async () => {
  for (const root of copies.splice(0)) await rm(root, { recursive: true, force: true });
});

function source(key: string, agent: string, calls: [id: string, name: string][]): CallSource {
  return { key, calls: calls.map(([id, name]) => ({ id, call: { agent, name, failed: false } })) };
}

const names = (calls: { name: string }[]) => calls.map((call) => call.name);

describe('mergeByTime', () => {
  // A fork copies its original's history, so both start at the same moment.
  const original = source('pm/1111', 'pm', [
    ['t1', 'Skill'],
    ['t2', 'Agent'],
    ['t4', 'report_completion'],
  ]);
  const fork = source('pm/2222', 'pm', [
    ['t1', 'Skill'],
    ['t2', 'Agent'],
    ['t4', 'report_completion'],
    ['t6', 'propose_trigger'],
  ]);
  // A background worker keeps working after the PM's next call.
  const worker = source('pm/1111/afx1', 'helper:assistant', [
    ['t3', 'Read'],
    ['t5', 'Bash'],
  ]);
  const madeAtMs = new Map([
    ['t1', 1000],
    ['t2', 2000],
    ['t3', 3000],
    ['t4', 4000],
    ['t5', 5000],
    ['t6', 6000],
  ]);

  it('orders calls across sessions and workers by when they were made, each once', () => {
    expect(names(mergeByTime([original, fork, worker], madeAtMs))).toEqual([
      'Skill',
      'Agent',
      'Read',
      'report_completion',
      'Bash',
      'propose_trigger',
    ]);
  });

  it('does not depend on the order the sources are listed in', () => {
    const forward = mergeByTime([original, fork, worker], madeAtMs);
    expect(mergeByTime([worker, fork, original], madeAtMs)).toEqual(forward);
    expect(mergeByTime([fork, worker, original], madeAtMs)).toEqual(forward);
  });

  it('breaks a same-millisecond tie by source key and keeps a source in its own order', () => {
    const pm = source('pm/1111', 'pm', [
      ['a', 'First'],
      ['b', 'NoStamp'],
    ]);
    const other = source('pm/1111/afx1', 'helper:assistant', [['c', 'Tied']]);
    const stamps = new Map([
      ['a', 1000],
      ['c', 1000],
    ]);

    // `b` has no timestamp, so it keeps `a`'s and stays right after it.
    expect(names(mergeByTime([other, pm], stamps))).toEqual(['First', 'NoStamp', 'Tied']);
  });
});

describe('readTaskToolCalls', () => {
  it('places a background worker call between the PM calls around it in time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evals-transcript-'));
    copies.push(root);
    const taskDir = join(root, TASK_ID);
    await cp(FIXTURE, taskDir, { recursive: true });
    // Move the worker's Bash call after the PM's list_available_repos call (09:00:09).
    const workerPath = join(taskDir, WORKER_TRANSCRIPT);
    const worker = await readFile(workerPath, 'utf8');
    await writeFile(
      workerPath,
      worker.replace(
        /"timestamp":"2026-01-01T09:00:0[5-7]\.000Z"/g,
        '"timestamp":"2026-01-01T09:00:09.500Z"',
      ),
    );

    const { toolCalls, gaps } = await readTaskToolCalls(taskDir, RECORDED);

    expect(gaps).toEqual([]);
    expect(toolCalls.map((call) => `${call.agent}:${call.name}`)).toEqual([
      'pm:Skill',
      'pm:Agent',
      'pm:mcp__orchestration-tools__list_available_repos',
      'helper:assistant:Bash',
      'pm:mcp__orchestration-tools__report_completion',
      'pm:mcp__orchestration-tools__propose_trigger',
      'pm:mcp__orchestration-tools__report_completion',
    ]);
  });
});
