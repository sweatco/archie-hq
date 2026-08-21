import { describe, expect, it, vi } from 'vitest';

const { appendSlackMessageMock, fetchChannelIsPrivateMock } = vi.hoisted(() => ({
  appendSlackMessageMock: vi.fn(),
  fetchChannelIsPrivateMock: vi.fn(),
}));

vi.mock('../persistence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../persistence.js')>();
  return { ...actual, appendSlackMessage: appendSlackMessageMock, downloadMessageFiles: vi.fn() };
});

// The Slack client is never initialised here, so the real predicate has no home
// team and would redact every author — stand in for a verified home workspace.
vi.mock('../../connectors/slack/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../connectors/slack/client.js')>();
  return {
    ...actual,
    isTrustedIngestAuthor: (user: { teamId?: string; unclassified?: boolean }) =>
      !user.unclassified && user.teamId === 'T_HOME',
    fetchChannelIsPrivate: fetchChannelIsPrivateMock,
  };
});

import { Task } from '../task.js';
import { withTaskDataLock } from '../data-lock.js';
import { REDACTION_PLACEHOLDER } from '../../connectors/slack/message-body.js';
import type { AgentDef } from '../../types/agent.js';
import type { SlackThread, TaskMetadata } from '../../types/task.js';

const TASK_ID = 'task-20260820-1200-datalock';

const TaskCtor = Task as unknown as new (
  taskId: string,
  metadata: TaskMetadata,
  team: AgentDef[],
) => Task;

function makeTask(): Task {
  const task = new TaskCtor(TASK_ID, {
    task_id: TASK_ID,
    visibility: 'public',
    task_owner: null,
    participants: [],
    channels: {
      'slack:C1:100.000': {
        type: 'slack',
        thread_id: '100.000',
        channel_id: 'C1',
        channel_name: 'ops',
        last_processed_ts: '100.000',
      },
    },
    default_channel: 'slack:C1:100.000',
    agent_sessions: {},
    repositories: {},
    status: 'in_progress',
    created_at: '2026-08-20T00:00:00.000Z',
    updated_at: '2026-08-20T00:00:00.000Z',
  }, []);
  (task as unknown as { debouncedSave: () => void }).debouncedSave = vi.fn();
  (task as unknown as { save: (flush?: boolean) => Promise<void> }).save = vi.fn().mockResolvedValue(undefined);
  return task;
}

const thread: SlackThread = {
  threadId: '100.000',
  channel: { id: 'C1', name: 'ops' },
  shared: false,
  taskVisibility: 'public',
  currentMessageTs: '101.000',
  rootAuthorWasBot: false,
  messages: [{
    user: { id: 'U1', username: 'dev', realName: 'Dev', teamId: 'T_HOME' },
    ownText: 'hello',
    ts: '101.000',
  }],
};

describe('task data lock', () => {
  it('serializes append behind a held data lock — the snapshot pattern memory relies on', async () => {
    const order: string[] = [];
    appendSlackMessageMock.mockImplementation(async () => { order.push('append'); });
    const task = makeTask();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = withTaskDataLock(TASK_ID, async () => {
      order.push('snapshot');
      await gate;
    });

    const appending = task.append(thread);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['snapshot']);

    release();
    await holder;
    await appending;
    expect(order).toEqual(['snapshot', 'append']);
  });

  it('persists a public→private downgrade before writing content from a converted channel', async () => {
    const writes: string[] = [];
    appendSlackMessageMock.mockImplementation(async (
      _taskId: string, _channel: unknown, _threadId: string, _author: unknown, body: string,
    ) => { writes.push(body); });
    const task = makeTask();
    const saved: string[] = [];
    (task as unknown as { save: (flush?: boolean) => Promise<void> }).save = async () => {
      saved.push(task.metadata.visibility);
    };

    await task.append({ ...thread, taskVisibility: 'private' });

    expect(task.metadata.visibility).toBe('private');
    // The downgrade is durable before the first content write, not after it.
    expect(saved[0]).toBe('private');
    expect(writes).toHaveLength(1);
  });

  it('skips the mid-life downgrade when the privacy lookup was unverified', async () => {
    appendSlackMessageMock.mockResolvedValue(undefined);
    const task = makeTask();

    await task.append({ ...thread, taskVisibility: 'private', taskVisibilityUnverified: true });

    // A transient lookup failure is not a channel conversion — the monotonic
    // field must not be irreversibly stripped on it.
    expect(task.metadata.visibility).toBe('public');
  });

  it('downgrades at completion when a linked channel became private', async () => {
    fetchChannelIsPrivateMock.mockResolvedValue(true);
    const task = makeTask();
    task.isActive = true;

    await task.complete();

    expect(task.metadata.visibility).toBe('private');
  });

  it('leaves visibility alone at completion when the privacy lookup fails', async () => {
    fetchChannelIsPrivateMock.mockRejectedValue(new Error('channel_not_found'));
    const task = makeTask();
    task.isActive = true;

    await task.complete();

    // Unknown is not a verdict — the task keeps its class rather than being
    // silently pulled from (or pushed into) memory by an infrastructure error.
    expect(task.metadata.visibility).toBe('public');
  });

  it('writes a verified author verbatim and redacts one it cannot verify', async () => {
    const writes: string[] = [];
    appendSlackMessageMock.mockImplementation(async (
      _taskId: string, _channel: unknown, _threadId: string, _author: unknown, body: string,
    ) => { writes.push(body); });
    const task = makeTask();

    await task.append({
      ...thread,
      currentMessageTs: '102.000',
      messages: [
        thread.messages[0],
        {
          user: { id: 'U2', username: 'ext', realName: 'Ext', unclassified: true },
          ownText: 'secret from an unknown party',
          ts: '102.000',
        },
      ],
    });

    expect(writes).toEqual(['hello', REDACTION_PLACEHOLDER]);
  });
});
