/**
 * AC4 integration test: the external-author bail-out fires on the group-DM path
 * exactly as it does for every other channel type.
 *
 * `handleSlackEvent` is the single processor for both the `app_mention` and the
 * `message.mpim` events a group DM produces. Its external-author guard
 * (events.ts, the `isExternalUser(authorInfo)` check) keys only off `event.user`
 * and sits ahead of the ack, the thread fetch, and task creation — so an event
 * from an external/guest author in a group DM must be dropped with no reaction,
 * no thread fetch, and no task, regardless of whether it arrived as an
 * `app_mention` or a `message`, and regardless of whether Slack issued the
 * conversation a `G…` or a `C…` id.
 *
 * This mirrors merge-approval-surfaces.test.ts: it drives the exported
 * `handleSlackEvent` against mocked module boundaries (Slack client + Task).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const HOME_TEAM = 'T_HOME';

vi.mock('../client.js', () => ({
  initSlackClient: vi.fn(),
  updateMessage: vi.fn().mockResolvedValue(undefined),
  getBotUserId: vi.fn(),
  fetchSlackThread: vi.fn(),
  getBotId: vi.fn(),
  addReaction: vi.fn(),
  setSlackDryRun: vi.fn(),
  getUserInfo: vi.fn(),
  classifySlackIdentity: vi.fn(
    (u: { teamId?: string; isRestricted?: boolean; isUltraRestricted?: boolean }) => {
      if (!u?.teamId) return 'unknown';
      if (u.isRestricted || u.isUltraRestricted || u.teamId !== HOME_TEAM) return 'external';
      return 'internal';
    },
  ),
  isExternalUser: vi.fn(
    (u: { teamId?: string; isRestricted?: boolean; isUltraRestricted?: boolean }) =>
      Boolean(u?.isRestricted) ||
      Boolean(u?.isUltraRestricted) ||
      Boolean(u?.teamId && u.teamId !== HOME_TEAM),
  ),
  isChannelShared: vi.fn().mockResolvedValue(false),
  postEphemeral: vi.fn(),
  getSlackClient: vi.fn(),
  fetchChannelIsPrivate: vi.fn().mockResolvedValue(false),
  cleanSlackText: vi.fn((s: string) => s),
  extractMessageContent: vi.fn().mockResolvedValue({ text: 'edited text' }),
  SlackIngressTargetError: class SlackIngressTargetError extends Error {
    constructor(readonly reason: string) {
      super(reason);
    }
  },
}));

vi.mock('../channel-canvas.js', () => ({ ensureChannelCanvas: vi.fn() }));
vi.mock('../channel-pins.js', () => ({ ensureChannelPins: vi.fn() }));
vi.mock('../title.js', () => ({ setAssistantThreadTitle: vi.fn() }));
vi.mock('../../../tasks/title-generator.js', () => ({ generateTaskTitle: vi.fn() }));
vi.mock('../../../system/shutdown.js', () => ({ getIsShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('../../../system/event-bus.js', () => ({
  onEvent: vi.fn(),
  offEvent: vi.fn(),
  emitEvent: vi.fn(),
}));
vi.mock('../../../system/workdir.js', () => ({ SESSIONS_DIR: '/tmp/sessions', WORKDIR: '/tmp' }));

vi.mock('../../../tasks/task.js', () => ({
  Task: { get: vi.fn(), create: vi.fn(), createForSlack: vi.fn() },
  activeTasks: new Map(),
}));

vi.mock('../../../tasks/persistence.js', () => ({
  findTaskByThread: vi.fn(),
  readKnowledgeLog: vi.fn(),
  loadMetadata: vi.fn(),
  appendCliMessage: vi.fn(),
  readEvents: vi.fn(),
}));

vi.mock('../../../system/logger.js', () => ({
  logger: {
    system: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn(),
    plain: vi.fn(), server: vi.fn(), slack: vi.fn(),
  },
}));

import { handleSlackEdit, handleSlackEvent } from '../events.js';
import { Task } from '../../../tasks/task.js';
import {
  getUserInfo,
  classifySlackIdentity,
  addReaction,
  fetchSlackThread,
  fetchChannelIsPrivate,
  postEphemeral,
} from '../client.js';
import { findTaskByThread } from '../../../tasks/persistence.js';
import { AGENT_PROMPTS } from '../../../agents/prompts.js';
import type { SlackChannel } from '../../../types/task.js';

// Both id shapes Slack issues for an mpim. `G…` is the documented classic shape;
// `C…` is what a live group DM in the Sweatcoin workspace actually resolves to
// (is_mpim: true, name `mpdm-…`), which is indistinguishable from a channel by
// prefix. The guard keys off `event.user`, so neither shape may change the
// outcome — parametrizing here keeps a future prefix-based shortcut from passing.
const GROUP_DM_IDS = ['G0GROUPDM1', 'C0BM7QRSVS4'];

function makeExistingTask(
  lastProcessedTs: string,
  sendMessage = vi.fn().mockResolvedValue(undefined),
) {
  const channel: SlackChannel = {
    type: 'slack', channel_id: 'C_PUBLIC', channel_name: 'public',
    thread_id: '1.0', last_processed_ts: lastProcessedTs,
  };
  const task = {
    metadata: { title: 'Existing task', channels: { 'slack:C_PUBLIC:1.0': channel } },
    append: vi.fn().mockResolvedValue(true),
    ackMessage: vi.fn(),
    debouncedSave: vi.fn(),
    sendMessage,
    save: vi.fn().mockResolvedValue(undefined),
    claimSlackIngress: vi.fn(),
    reconcileLoggedSlackIngress: vi.fn().mockResolvedValue(false),
  };
  task.claimSlackIngress.mockResolvedValue(task);
  return { task, channel };
}

function mockExistingRoute(task: unknown, actor = {
  name: 'internal', realName: 'Internal', teamId: HOME_TEAM,
}): void {
  vi.mocked(getUserInfo).mockResolvedValue(actor as never);
  vi.mocked(fetchSlackThread).mockResolvedValue({
    threadId: '1.0', channel: { id: 'C_PUBLIC', name: 'public' }, shared: false,
    taskVisibility: 'public', messages: [], currentMessageTs: '2.0', rootAuthorWasBot: false,
  });
  vi.mocked(findTaskByThread).mockResolvedValue('task-existing');
  vi.mocked(Task.get).mockResolvedValue(task as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('mpim external-author bail-out (AC4)', () => {
  // Two shapes of external author on a `G…` conversation: a different-team
  // Slack Connect user, and a single-channel guest. Both classify as external.
  const externalAuthors = [
    { label: 'different-team user', info: { name: 'ext', realName: 'Ext Ernal', teamId: 'T_OTHER' } },
    { label: 'single-channel guest', info: { name: 'guest', realName: 'A Guest', teamId: HOME_TEAM, isUltraRestricted: true } },
  ];

  // Both events a `G…` conversation produces resolve to the same handleSlackEvent.
  const eventTypes: Array<'app_mention' | 'message'> = ['app_mention', 'message'];

  for (const type of eventTypes) {
    for (const { label, info } of externalAuthors) {
      for (const groupDm of GROUP_DM_IDS) {
        it(`${type} from an external author (${label}) on a group DM (${groupDm}) → no task, no reaction, no fetch`, async () => {
          vi.mocked(getUserInfo).mockResolvedValue(info as never);

          await handleSlackEvent({
            type,
            channel: groupDm,
            user: 'U_EXTERNAL',
            raw: { type, channel: groupDm, user: 'U_EXTERNAL', text: 'hey archie', ts: '1700000000.000100' },
            ts: '1700000000.000100',
          });

          // The author was resolved and classified as external...
          expect(vi.mocked(getUserInfo)).toHaveBeenCalledWith('U_EXTERNAL');
          expect(vi.mocked(classifySlackIdentity)).toHaveReturnedWith('external');

          // ...so the handler bailed before any side effect: no ack reaction,
          // no thread fetch, no task lookup, and no task creation.
          expect(vi.mocked(addReaction)).not.toHaveBeenCalled();
          expect(vi.mocked(fetchSlackThread)).not.toHaveBeenCalled();
          expect(vi.mocked(findTaskByThread)).not.toHaveBeenCalled();
          expect(vi.mocked(Task.create)).not.toHaveBeenCalled();
        });
      }
    }
  }

  it('surfaces a transient author lookup failure for durable retry', async () => {
    vi.mocked(getUserInfo).mockRejectedValue(new Error('rate limited'));

    await expect(handleSlackEvent({
      type: 'app_mention',
      channel: 'C_PUBLIC',
      user: 'U_UNKNOWN',
      text: '<@UBOT> help',
      ts: '1700000000.000200',
    })).rejects.toThrow('rate limited');

    expect(vi.mocked(addReaction)).not.toHaveBeenCalled();
    expect(vi.mocked(fetchSlackThread)).not.toHaveBeenCalled();
    expect(vi.mocked(Task.create)).not.toHaveBeenCalled();
  });

  it('reuses the freshly verified current actor while fetching the thread', async () => {
    const actor = { name: 'internal', realName: 'Internal', teamId: HOME_TEAM };
    const { task } = makeExistingTask('1.0');
    mockExistingRoute(task, actor);

    await handleSlackEvent({
      type: 'message', channel: 'C_PUBLIC', user: 'U_INTERNAL', text: 'follow-up',
      ts: '2.0', thread_ts: '1.0',
    });

    expect(vi.mocked(fetchSlackThread)).toHaveBeenCalledWith(
      'C_PUBLIC', '1.0', '2.0',
      expect.objectContaining({ id: 'U_INTERNAL', teamId: HOME_TEAM }),
      '1.0',
    );
  });

  it('does not append or wake for an already consumed Slack message', async () => {
    const { task } = makeExistingTask('2.0');
    mockExistingRoute(task);

    await handleSlackEvent({
      type: 'message', channel: 'C_PUBLIC', user: 'U_INTERNAL', text: 'duplicate',
      ts: '2.0', thread_ts: '1.0',
    });

    expect(task.append).not.toHaveBeenCalled();
    expect(task.sendMessage).not.toHaveBeenCalled();
    expect(vi.mocked(fetchSlackThread)).not.toHaveBeenCalled();
    expect(vi.mocked(addReaction)).not.toHaveBeenCalled();
  });

  it('replays the first wake from task state without refetching Slack', async () => {
    const { task } = makeExistingTask('2.0');
    mockExistingRoute(task);

    const checkpoint = vi.fn().mockResolvedValue(undefined);
    await handleSlackEvent({
      type: 'message', channel: 'C_PUBLIC', user: 'U_INTERNAL', text: '',
      ts: '2.0', thread_ts: '1.0',
    }, { wake: 'new', checkpoint });

    expect(task.append).not.toHaveBeenCalled();
    expect(task.sendMessage).toHaveBeenCalledWith(AGENT_PROMPTS.newTask);
    expect(task.save).toHaveBeenCalledWith(true);
    expect(checkpoint).toHaveBeenCalledWith('new');
    expect(vi.mocked(fetchSlackThread)).not.toHaveBeenCalled();
    expect(vi.mocked(getUserInfo)).not.toHaveBeenCalled();
  });

  it('recovers a checkpointed log-ahead message without refetching Slack', async () => {
    const { task } = makeExistingTask('1.0');
    task.reconcileLoggedSlackIngress.mockResolvedValue(true);
    mockExistingRoute(task);
    vi.mocked(fetchSlackThread).mockRejectedValue(new Error('target deleted'));

    const checkpoint = vi.fn().mockResolvedValue(undefined);
    await handleSlackEvent({
      type: 'message', channel: 'C_PUBLIC', user: 'U_INTERNAL', text: '',
      ts: '2.0', thread_ts: '1.0',
    }, { wake: 'existing', checkpoint });

    expect(task.reconcileLoggedSlackIngress).toHaveBeenCalledWith('slack:C_PUBLIC:1.0', '2.0');
    expect(task.sendMessage).toHaveBeenCalledWith(AGENT_PROMPTS.existingTask);
    expect(vi.mocked(getUserInfo)).not.toHaveBeenCalled();
    expect(vi.mocked(fetchSlackThread)).not.toHaveBeenCalled();
  });

  it('persists shared-channel safety state before advancing the watermark', async () => {
    const { task, channel } = makeExistingTask('1.0');
    mockExistingRoute(task);
    vi.mocked(fetchSlackThread).mockResolvedValue({
      threadId: '1.0', channel: { id: 'C_PUBLIC', name: 'public' }, shared: true,
      taskVisibility: 'public', currentMessageTs: '2.0', rootAuthorWasBot: false,
      messages: [{
        user: { id: 'U_INTERNAL', username: 'internal', realName: 'Internal', teamId: HOME_TEAM },
        ownText: 'follow-up', ts: '2.0',
      }],
    });
    task.append.mockImplementation(async () => {
      expect(channel.isShared).toBe(true);
      expect(task.save).toHaveBeenCalledWith(true);
      return true;
    });

    await handleSlackEvent({
      type: 'message', channel: 'C_PUBLIC', user: 'U_INTERNAL', text: 'follow-up',
      ts: '2.0', thread_ts: '1.0',
    });

    expect(vi.mocked(postEphemeral)).toHaveBeenCalled();
    expect(task.append).toHaveBeenCalledOnce();
  });

  it('retains and retries a failed wake for an existing task', async () => {
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error('spawn failed'))
      .mockResolvedValueOnce(undefined);
    const { task } = makeExistingTask('2.0', sendMessage);
    mockExistingRoute(task);
    const event = {
      type: 'message', channel: 'C_PUBLIC', user: 'U_INTERNAL', text: '',
      ts: '2.0', thread_ts: '1.0',
    };
    const checkpoint = vi.fn().mockResolvedValue(undefined);
    const recovery = { wake: 'existing' as const, checkpoint };

    await expect(handleSlackEvent(event, recovery)).rejects.toThrow('spawn failed');

    await expect(handleSlackEvent(event, recovery)).resolves.toEqual({ status: 'complete' });
    expect(task.sendMessage).toHaveBeenCalledTimes(2);
    expect(task.sendMessage).toHaveBeenNthCalledWith(1, AGENT_PROMPTS.existingTask);
    expect(task.sendMessage).toHaveBeenNthCalledWith(2, AGENT_PROMPTS.existingTask);
    expect(task.save).toHaveBeenCalledTimes(1);
    expect(task.save).toHaveBeenCalledWith(true);
    expect(checkpoint).toHaveBeenCalledTimes(2);
  });

  it('retries when the active task state cannot be flushed after waking', async () => {
    const { task } = makeExistingTask('2.0');
    task.save.mockRejectedValue(new Error('disk unavailable'));
    mockExistingRoute(task);

    await expect(handleSlackEvent({
      type: 'message', channel: 'C_PUBLIC', user: 'U_INTERNAL', text: '',
      ts: '2.0', thread_ts: '1.0',
    }, { wake: 'existing', checkpoint: vi.fn() })).rejects.toThrow('disk unavailable');

    expect(task.sendMessage).toHaveBeenCalledWith(AGENT_PROMPTS.existingTask);
    expect(task.save).toHaveBeenCalledWith(true);
  });

  it('rejects a guest in a normal channel', async () => {
    vi.mocked(getUserInfo).mockResolvedValue({
      name: 'guest', realName: 'Guest', teamId: HOME_TEAM, isRestricted: true,
    } as never);

    await handleSlackEvent({
      type: 'app_mention',
      channel: 'C_PUBLIC',
      user: 'U_GUEST',
      text: '<@UBOT> help',
      ts: '1700000000.000300',
    });

    expect(vi.mocked(classifySlackIdentity)).toHaveReturnedWith('external');
    expect(vi.mocked(fetchSlackThread)).not.toHaveBeenCalled();
    expect(vi.mocked(Task.create)).not.toHaveBeenCalled();
  });

  it('returns a terminal outcome for a verified external actor', async () => {
    vi.mocked(getUserInfo).mockResolvedValue({
      name: 'external', realName: 'External', teamId: 'T_OTHER',
    } as never);

    await expect(handleSlackEvent({
      type: 'app_mention', channel: 'C_PUBLIC', user: 'U_EXTERNAL',
      text: '<@UBOT> help', ts: '1700000000.000350',
    })).resolves.toEqual({ status: 'terminal', reason: 'external_author' });

    expect(vi.mocked(fetchSlackThread)).not.toHaveBeenCalled();
  });

  it('aborts before acknowledging when channel confidentiality cannot be verified', async () => {
    vi.mocked(getUserInfo).mockResolvedValue({
      name: 'internal', realName: 'Internal', teamId: HOME_TEAM,
    } as never);
    vi.mocked(fetchSlackThread).mockRejectedValue(new Error('Slack unavailable'));

    await expect(handleSlackEvent({
      type: 'app_mention',
      channel: 'C_PUBLIC',
      user: 'U_INTERNAL',
      text: '<@UBOT> help',
      ts: '1700000000.000400',
    })).rejects.toThrow('Slack unavailable');

    expect(vi.mocked(addReaction)).not.toHaveBeenCalled();
    expect(vi.mocked(Task.create)).not.toHaveBeenCalled();
  });
});

describe('message edit author and visibility policy', () => {
  const editEvent = {
    channel: 'C_EDIT',
    message: { ts: '2.0', thread_ts: '1.0', user: 'U_EDITOR', text: 'edited text' },
    previous_message: { ts: '2.0', user: 'U_EDITOR', text: 'old text' },
  };

  beforeEach(() => {
    vi.mocked(findTaskByThread).mockResolvedValue('task-edit');
  });

  it('skips an edit when author lookup fails', async () => {
    vi.mocked(getUserInfo).mockRejectedValue(new Error('rate limited'));

    await handleSlackEdit(editEvent);

    expect(vi.mocked(Task.get)).not.toHaveBeenCalled();
  });

  it('skips an edit from a normal-channel guest', async () => {
    vi.mocked(getUserInfo).mockResolvedValue({
      name: 'guest', realName: 'Guest', teamId: HOME_TEAM, isRestricted: true,
    } as never);

    await handleSlackEdit(editEvent);

    expect(vi.mocked(Task.get)).not.toHaveBeenCalled();
  });

  it('passes private source visibility and wakes the canonical edit task', async () => {
    const target = {
      metadata: {
        channels: {
          'slack:C_EDIT:1.0': { type: 'slack', channel_id: 'C_EDIT', channel_name: 'private', thread_id: '1.0' },
        },
      },
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    const task = {
      metadata: {
        channels: {
          'slack:C_EDIT:1.0': { type: 'slack', channel_id: 'C_EDIT', channel_name: 'private', thread_id: '1.0' },
        },
      },
      appendSlackEdit: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    task.appendSlackEdit.mockResolvedValue(target);
    vi.mocked(getUserInfo).mockResolvedValue({
      name: 'editor', realName: 'Editor', teamId: HOME_TEAM,
    } as never);
    vi.mocked(fetchChannelIsPrivate).mockResolvedValue(true);
    vi.mocked(Task.get).mockResolvedValue(task as never);

    await handleSlackEdit(editEvent);

    expect(task.appendSlackEdit).toHaveBeenCalledWith(
      'slack:C_EDIT:1.0',
      expect.objectContaining({ id: 'U_EDITOR', teamId: HOME_TEAM }),
      '2.0',
      'edited text',
      'private',
    );
    expect(task.sendMessage).not.toHaveBeenCalled();
    expect(target.sendMessage).toHaveBeenCalledWith(AGENT_PROMPTS.existingTask);
  });

  it('delegates pre-ingress edit eligibility to the locked task boundary', async () => {
    const task = {
      metadata: {
        channels: {
          'slack:C_EDIT:1.0': {
            type: 'slack', channel_id: 'C_EDIT', channel_name: 'private',
            thread_id: '1.0', last_processed_ts: '0',
          },
        },
      },
      appendSlackEdit: vi.fn(),
      sendMessage: vi.fn(),
    };
    vi.mocked(getUserInfo).mockResolvedValue({
      name: 'editor', realName: 'Editor', teamId: HOME_TEAM,
    } as never);
    vi.mocked(fetchChannelIsPrivate).mockResolvedValue(true);
    vi.mocked(Task.get).mockResolvedValue(task as never);

    await handleSlackEdit(editEvent);

    expect(task.appendSlackEdit).toHaveBeenCalled();
    expect(task.sendMessage).not.toHaveBeenCalled();
  });

  it('skips an edit when channel privacy cannot be verified', async () => {
    const task = {
      metadata: {
        channels: {
          'slack:C_EDIT:1.0': { type: 'slack', channel_id: 'C_EDIT', channel_name: 'channel', thread_id: '1.0' },
        },
      },
      appendSlackEdit: vi.fn(),
      sendMessage: vi.fn(),
    };
    vi.mocked(getUserInfo).mockResolvedValue({
      name: 'editor', realName: 'Editor', teamId: HOME_TEAM,
    } as never);
    vi.mocked(fetchChannelIsPrivate).mockRejectedValue(new Error('Slack unavailable'));
    vi.mocked(Task.get).mockResolvedValue(task as never);

    await handleSlackEdit(editEvent);

    expect(task.appendSlackEdit).not.toHaveBeenCalled();
    expect(task.sendMessage).not.toHaveBeenCalled();
    expect(vi.mocked(Task.get)).not.toHaveBeenCalled();
  });
});
