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
vi.mock('../../../system/workdir.js', () => ({ SESSIONS_DIR: '/tmp/sessions' }));

vi.mock('../../../tasks/task.js', () => ({
  Task: { get: vi.fn(), create: vi.fn() },
  activeTasks: new Map(),
}));

vi.mock('../../../tasks/persistence.js', () => ({
  findTaskByThread: vi.fn(),
  readKnowledgeLog: vi.fn(),
  loadMetadata: vi.fn(),
  appendCliMessage: vi.fn(),
  readEvents: vi.fn(),
  renderMessageForContext: vi.fn((msg: { text: string }) => msg.text),
}));

vi.mock('../../../system/logger.js', () => ({
  logger: {
    system: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn(),
    plain: vi.fn(), server: vi.fn(), slack: vi.fn(),
  },
}));

import { handleSlackEdit, handleSlackEvent } from '../events.js';
import { Task } from '../../../tasks/task.js';
import { getUserInfo, classifySlackIdentity, addReaction, fetchSlackThread, fetchChannelIsPrivate } from '../client.js';
import { findTaskByThread } from '../../../tasks/persistence.js';

// Both id shapes Slack issues for an mpim. `G…` is the documented classic shape;
// `C…` is what a live group DM in the Sweatcoin workspace actually resolves to
// (is_mpim: true, name `mpdm-…`), which is indistinguishable from a channel by
// prefix. The guard keys off `event.user`, so neither shape may change the
// outcome — parametrizing here keeps a future prefix-based shortcut from passing.
const GROUP_DM_IDS = ['G0GROUPDM1', 'C0BM7QRSVS4'];

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
            text: 'hey archie',
            ts: '1700000000.000100',
          });

          // The author was resolved and classified as external...
          expect(vi.mocked(getUserInfo)).toHaveBeenCalledWith('U_EXTERNAL');
          expect(vi.mocked(classifySlackIdentity)).toHaveReturnedWith('external');

          // ...so the handler bailed before any side effect: no ack reaction,
          // no thread fetch, no task lookup, no task creation.
          expect(vi.mocked(addReaction)).not.toHaveBeenCalled();
          expect(vi.mocked(fetchSlackThread)).not.toHaveBeenCalled();
          expect(vi.mocked(findTaskByThread)).not.toHaveBeenCalled();
          expect(vi.mocked(Task.create)).not.toHaveBeenCalled();
        });
      }
    }
  }

  it('fails closed when a normal-channel author lookup fails', async () => {
    vi.mocked(getUserInfo).mockRejectedValue(new Error('rate limited'));

    await handleSlackEvent({
      type: 'app_mention',
      channel: 'C_PUBLIC',
      user: 'U_UNKNOWN',
      text: '<@UBOT> help',
      ts: '1700000000.000200',
    });

    expect(vi.mocked(addReaction)).not.toHaveBeenCalled();
    expect(vi.mocked(fetchSlackThread)).not.toHaveBeenCalled();
    expect(vi.mocked(Task.create)).not.toHaveBeenCalled();
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

  it('passes private source visibility to the task edit boundary', async () => {
    const task = {
      metadata: {
        channels: {
          'slack:C_EDIT:1.0': { type: 'slack', channel_id: 'C_EDIT', channel_name: 'private', thread_id: '1.0' },
        },
      },
      appendSlackEdit: vi.fn().mockResolvedValue(true),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
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
