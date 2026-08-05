/**
 * findTaskBy* scanners — fs-based candidate scan.
 *
 * Regression tests for the execSync-grep replacement: webhook-controlled
 * inputs (branch names with quotes, semicolons, `$()`) must resolve correctly
 * and never reach a shell; JSON-encoded needles must also match values the
 * old fixed-string grep could not (escaped quotes).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdir, rm, writeFile } from 'fs/promises';
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

import { findTaskByBranch, findTaskByPRNumber, findTaskByThread, findTasksByStatus, isThreadMuted } from '../persistence.js';
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

describe('findTaskBy* fs scanners', () => {
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

  it('tolerates session dirs without metadata.json', async () => {
    await mkdir(join(SESSIONS_DIR, 'task-20260703-0009-empty'), { recursive: true });
    await writeTask('task-20260703-0010-real', repoTask('feature/z'));

    expect(await findTaskByBranch('sweatco/api', 'feature/z')).toBe('task-20260703-0010-real');
  });

  // Reads a mute out of a task that is NOT the one about to post — the case a
  // per-task check structurally cannot see.
  describe('isThreadMuted', () => {
    const threadTask = (channelId: string, threadId: string, muted: boolean) => ({
      status: 'completed',
      channels: {
        [`slack:${channelId}:${threadId}`]: {
          type: 'slack', channel_id: channelId, thread_id: threadId,
          channel_name: 'backend-dev', ...(muted ? { muted: true } : {}),
        },
      },
    });

    it('finds a mute recorded on another task', async () => {
      await writeTask('task-20260703-0100-muted', threadTask('C_BD', '999.0', true));

      expect(await isThreadMuted('C_BD', '999.0')).toBe(true);
    });

    it('is false for an unmuted thread, another thread, and an unknown channel', async () => {
      await writeTask('task-20260703-0101-open', threadTask('C_OPEN', '1.0', false));
      await writeTask('task-20260703-0102-other', threadTask('C_OTHER', '2.0', true));

      expect(await isThreadMuted('C_OPEN', '1.0')).toBe(false);
      expect(await isThreadMuted('C_OTHER', '3.0')).toBe(false);
      expect(await isThreadMuted('C_NONE', '1.0')).toBe(false);
    });

    // Muting is routine — ~100 of 2575 prod tasks have muted something, #bugs 16
    // times — so one muted thread must not close its whole channel.
    it('leaves other threads in the same channel open', async () => {
      await writeTask('task-20260703-0103-mixed', {
        status: 'completed',
        channels: {
          'slack:C_BUGS:1.0': { type: 'slack', channel_id: 'C_BUGS', thread_id: '1.0', channel_name: 'bugs', muted: true },
          'slack:C_BUGS:2.0': { type: 'slack', channel_id: 'C_BUGS', thread_id: '2.0', channel_name: 'bugs' },
        },
      });

      expect(await isThreadMuted('C_BUGS', '1.0')).toBe(true);
      expect(await isThreadMuted('C_BUGS', '2.0')).toBe(false);
    });
  });
});
