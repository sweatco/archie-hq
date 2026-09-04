/**
 * `Task.postToUser`'s `recall` branch: how a targeted post to a voice meeting is relayed and logged.
 *
 * The connector's own decision — is that meeting still there, is anything outstanding — is covered in src/connectors/recall/__tests__/channel-delivery.test.ts. Here the deliverer is a stub, so what is pinned is only `postToUser`'s half: which arguments it hands over, that `delivered` alone gates the `knowledge.log` append, that the note comes back verbatim as the return value, and that none of it touches `default_channel`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../system/logger.js', () => ({
  logger: {
    warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), agent: vi.fn(), slack: vi.fn(),
    agentToSlack: vi.fn(),
  },
}));

vi.mock('../../agents/spawn.js', () => ({ spawnAgent: vi.fn() }));

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('../../connectors/slack/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../connectors/slack/client.js')>();
  return { ...actual, postSlackMessage: postMock };
});

const { deliverMock } = vi.hoisted(() => ({ deliverMock: vi.fn() }));

vi.mock('../../connectors/recall/channel-delivery.js', () => ({
  deliverToRecallChannel: deliverMock,
}));

vi.mock('../persistence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../persistence.js')>();
  return { ...actual, appendMessageToUser: vi.fn().mockResolvedValue(undefined) };
});

import { Task } from '../task.js';
import { appendMessageToUser } from '../persistence.js';
import { deliverToRecallChannel } from '../../connectors/recall/channel-delivery.js';
import type { Channel, GitHubChannel, RecallChannel, TaskMetadata } from '../../types/task.js';
import type { AgentDef } from '../../types/agent.js';

function recallChannel(over: Partial<RecallChannel> = {}): RecallChannel {
  return { type: 'recall', session_id: 'sess-1', url: 'https://zoom.us/j/1', ended: false, ...over };
}

const TaskCtor = Task as unknown as new (
  taskId: string,
  metadata: TaskMetadata,
  team: AgentDef[],
) => Task;

function metadata(over: Partial<TaskMetadata> = {}): TaskMetadata {
  return {
    task_id: 't1',
    task_owner: null,
    participants: [],
    channels: {},
    default_channel: null,
    agent_sessions: {},
    repositories: {},
    ...over,
  } as unknown as TaskMetadata;
}

function newTask(meta: TaskMetadata): Task {
  const task = new TaskCtor('t1', meta, []);
  (task as unknown as { debouncedSave: () => void }).debouncedSave = () => {};
  (task as unknown as { save: (flush?: boolean) => Promise<void> }).save = async () => {};
  return task;
}

describe('Task.postToUser posting to a targeted recall channel', () => {
  beforeEach(() => {
    postMock.mockReset();
    vi.mocked(deliverToRecallChannel).mockReset();
    vi.mocked(appendMessageToUser).mockClear();
  });

  it('relays the connector\'s note back as postToUser\'s return value, and logs the delivered message to the knowledge log', async () => {
    vi.mocked(deliverToRecallChannel).mockResolvedValue({ delivered: true, note: 'delivered — spoken aloud' });

    const key = 'recall:sess-1';
    const channel = recallChannel();
    const meta = metadata({ channels: { [key]: channel } });
    const task = newTask(meta);

    const result = await task.postToUser('an answer', 'pm-agent', { channel: key });

    expect(deliverToRecallChannel).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deliverToRecallChannel).mock.calls[0][0]).toEqual({
      task,
      channel,
      message: 'an answer',
    });
    expect(result).toBe('delivered — spoken aloud');
    expect(postMock).not.toHaveBeenCalled();

    // Logs the channel's key, not a display string — stable across every meeting the task has ever had, unlike the live/ended status the PM's context block renders.
    expect(vi.mocked(appendMessageToUser)).toHaveBeenCalledWith('t1', 'pm-agent', 'an answer', key);
  });

  it('relays a failed delivery\'s note back, but does not log it — the message never reached anyone', async () => {
    vi.mocked(deliverToRecallChannel).mockResolvedValue({
      delivered: false,
      note: 'That meeting has ended — the room has already dispersed. Post to the thread instead.',
    });

    const key = 'recall:sess-1b';
    const meta = metadata({ channels: { [key]: recallChannel({ session_id: 'sess-1b' }) } });
    const task = newTask(meta);

    const result = await task.postToUser('an answer', 'pm-agent', { channel: key });

    expect(result).toBe('That meeting has ended — the room has already dispersed. Post to the thread instead.');
    expect(vi.mocked(appendMessageToUser)).not.toHaveBeenCalled();
  });

  it('is a silent no-op — same shape as an unresolved target — for a linked kind with no branch of its own, and logs nothing either', async () => {
    const key = 'github:owner/repo#7';
    const channel: GitHubChannel = { type: 'github', repo: 'owner/repo', pr_number: 7 } as GitHubChannel;
    const meta = metadata({ channels: { [key]: channel as Channel } });
    const task = newTask(meta);

    const result = await task.postToUser('an answer', 'pm-agent', { channel: key });

    expect(result).toBeNull();
    expect(deliverToRecallChannel).not.toHaveBeenCalled();
    expect(vi.mocked(appendMessageToUser)).not.toHaveBeenCalled();
  });

  it('is a silent no-op for a target naming a channel key that is not linked at all', async () => {
    const meta = metadata({ channels: {} });
    const task = newTask(meta);

    const result = await task.postToUser('an answer', 'pm-agent', { channel: 'recall:missing' });

    expect(result).toBeNull();
    expect(deliverToRecallChannel).not.toHaveBeenCalled();
  });

  it('never assigns default_channel while delivering to a meeting', async () => {
    vi.mocked(deliverToRecallChannel).mockResolvedValue({ delivered: true, note: 'note' });
    const key = 'recall:sess-3';
    const meta = metadata({
      channels: { [key]: recallChannel({ session_id: 'sess-3' }) },
      default_channel: 'slack:C1:100',
    });
    const task = newTask(meta);

    await task.postToUser('an answer', 'pm-agent', { channel: key });

    expect(meta.default_channel).toBe('slack:C1:100');
  });

  // `default_channel` only ever gets a Slack/CLI key (task.ts's `??=` sites), so a `recall` channel
  // there is unreachable today — pins the branch targeted-only, should that ever change.
  it('does not deliver to a meeting via the default channel, even if a recall key ended up there', async () => {
    vi.mocked(deliverToRecallChannel).mockResolvedValue({ delivered: true, note: 'should not be called' });
    const key = 'recall:sess-4';
    const meta = metadata({
      channels: { [key]: recallChannel({ session_id: 'sess-4' }) },
      default_channel: key,
    });
    const task = newTask(meta);

    const result = await task.postToUser('an answer', 'pm-agent');

    expect(deliverToRecallChannel).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});
