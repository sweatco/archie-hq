/**
 * findTaskBy* scanners — grep-based candidate scan.
 *
 * Regression tests for the needle trust boundary: webhook-controlled
 * inputs (branch names with quotes, semicolons, `$()`) must resolve correctly
 * and never reach a shell; JSON-encoded needles must also match values the
 * old fixed-string grep could not (escaped quotes).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdir, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

vi.mock('../../system/workdir.js', async () => {
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const dir = join(tmpdir(), `archie-findtask-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  return { SESSIONS_DIR: dir, WORKDIR: tmpdir() };
});

vi.mock('../../connectors/slack/client.js', () => ({
  isExternalUser: () => false,
  formatSlackChannelRef: vi.fn(),
  formatSlackChannelDisplay: vi.fn(),
}));

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn() },
}));

vi.mock('../../system/event-bus.js', () => ({
  emitEvent: vi.fn(),
  onEvent: vi.fn(),
}));

vi.mock('../task.js', () => ({
  activeTasks: new Map(),
  migrateRepositoriesShape: (m: unknown) => m,
}));

import { findTaskByBranch, findTaskByPRNumber, findTaskByThread, findTasksByStatus } from '../persistence.js';
import { SESSIONS_DIR } from '../../system/workdir.js';

async function writeTask(taskId: string, metadata: Record<string, unknown>): Promise<void> {
  const dir = join(SESSIONS_DIR, taskId, 'shared');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'metadata.json'), JSON.stringify({ task_id: taskId, channels: {}, ...metadata }, null, 2), 'utf-8');
}

function repoTask(branch: string, prNumber?: number): Record<string, unknown> {
  return {
    status: 'in_progress',
    repositories: {
      backend: [
        {
          github: 'sweatco/api',
          branch,
          branch_states: { [branch]: prNumber !== undefined ? { pr_number: prNumber } : {} },
        },
      ],
    },
  };
}

describe('findTaskBy* scanners', () => {
  beforeEach(async () => {
    await rm(SESSIONS_DIR, { recursive: true, force: true });
    await mkdir(SESSIONS_DIR, { recursive: true });
  });

  it('findTaskByBranch resolves branches containing shell metacharacters', async () => {
    const evil = "qa/it's; touch pwned; $(id) -- ok";
    await writeTask('task-20260703-0001-evil', repoTask(evil));
    await writeTask('task-20260703-0002-other', repoTask('feature/normal'));

    expect(await findTaskByBranch('sweatco/api', evil)).toBe('task-20260703-0001-evil');
  });

  // The scan runs grep under `sh`, so the property that matters is not just
  // "the lookup still works" but "the shell never evaluated the needle". A
  // branch name is webhook-controlled and git ref rules permit $(), backticks
  // and semicolons — 3190d00 removed the previous grep because those reached an
  // execSync string. Passing the needle as $1 is what makes a shell safe here,
  // and this fails loudly if anyone inlines it again.
  it('findTaskByBranch never lets a branch name execute (needle is data, not script)', async () => {
    const sentinel = join(SESSIONS_DIR, 'pwned');
    const evil = `qa/$(touch ${sentinel})\`touch ${sentinel}\`; touch ${sentinel}`;
    await writeTask('task-20260703-0011-inject', repoTask(evil));

    expect(await findTaskByBranch('sweatco/api', evil)).toBe('task-20260703-0011-inject');
    expect(existsSync(sentinel)).toBe(false);
  });

  it('findTaskByBranch resolves branches containing double quotes (old grep false-negative)', async () => {
    const branch = 'rel/say-"hello"';
    await writeTask('task-20260703-0003-quote', repoTask(branch));

    expect(await findTaskByBranch('sweatco/api', branch)).toBe('task-20260703-0003-quote');
  });

  it('findTaskByBranch verifies structurally: repo must match and branch must key branch_states', async () => {
    await writeTask('task-20260703-0004-repo', repoTask('feature/x'));

    expect(await findTaskByBranch('other/repo', 'feature/x')).toBeNull();
    expect(await findTaskByBranch('sweatco/api', 'feature/y')).toBeNull();
  });

  it('findTaskByPRNumber matches repo + pr_number in branch states', async () => {
    await writeTask('task-20260703-0005-pr', repoTask('feature/pr', 41));

    expect(await findTaskByPRNumber('sweatco/api', 41)).toBe('task-20260703-0005-pr');
    expect(await findTaskByPRNumber('sweatco/api', 42)).toBeNull();
    expect(await findTaskByPRNumber('other/repo', 41)).toBeNull();
  });

  it('findTaskByThread finds the task by serialized thread id', async () => {
    await writeTask('task-20260703-0006-thread', {
      status: 'completed',
      channels: { C1: { type: 'slack', channel_id: 'C1', thread_id: '1234567890.123456' } },
    });

    expect(await findTaskByThread('1234567890.123456')).toBe('task-20260703-0006-thread');
    expect(await findTaskByThread('0000000000.000000')).toBeNull();
  });

  it('findTasksByStatus returns only tasks with the exact status', async () => {
    await writeTask('task-20260703-0007-a', { status: 'in_progress' });
    await writeTask('task-20260703-0008-b', { status: 'completed' });

    const inProgress = await findTasksByStatus('in_progress');
    expect(inProgress.map((t) => t.task_id)).toEqual(['task-20260703-0007-a']);
  });

  // Needles are JSON-encoded fragments of the serialized metadata, so their form
  // is known: one line, no control characters. The pattern reaches grep on stdin
  // as a `-f -` pattern file where one line is one pattern, so a needle carrying
  // a newline would quietly become an OR of two patterns instead of the
  // substring test callers rely on — and a caller reading that would route a
  // webhook to the wrong task.
  it('a newline in the input cannot split the pattern — encoding keeps the needle one line', async () => {
    await writeTask('task-20260703-0012-form', {
      status: 'completed',
      channels: { C1: { type: 'slack', channel_id: 'C1', thread_id: '111.0' } },
    });

    // JSON.stringify turns the newline into the two characters \ and n, so the
    // needle stays one pattern and matches neither half. A call site that
    // stopped encoding would find the task via the first line instead — and
    // assertNeedleForm throws before it gets that far.
    expect(await findTaskByThread('111.0\n222.0')).toBeNull();
    expect(await findTaskByBranch('sweatco/api', 'feature/a\nfeature/b')).toBeNull();

    // The encoded form still resolves normally.
    expect(await findTaskByThread('111.0')).toBe('task-20260703-0012-form');
  });

  // The glob has to cover the whole fleet, not just whatever the first few
  // entries happen to be — a match at either end must resolve.
  it('resolves tasks anywhere in a multi-task fleet', async () => {
    for (let i = 0; i < 40; i++) {
      await writeTask(`task-20260703-1${String(i).padStart(3, '0')}-bulk`, repoTask(`feature/bulk-${i}`));
    }
    await writeTask('task-20260703-0013-last', repoTask('feature/needle-at-the-end'));

    expect(await findTaskByBranch('sweatco/api', 'feature/needle-at-the-end')).toBe('task-20260703-0013-last');
    expect(await findTaskByBranch('sweatco/api', 'feature/bulk-0')).toBe('task-20260703-1000-bulk');
  });

  it('tolerates session dirs without metadata.json', async () => {
    await mkdir(join(SESSIONS_DIR, 'task-20260703-0009-empty'), { recursive: true });
    await writeTask('task-20260703-0010-real', repoTask('feature/z'));

    expect(await findTaskByBranch('sweatco/api', 'feature/z')).toBe('task-20260703-0010-real');
  });
});
