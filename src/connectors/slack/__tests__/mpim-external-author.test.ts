/**
 * AC4 integration test: the external-author bail-out fires on the group-DM
 * (`G…`) path exactly as it does for every other channel type.
 *
 * `handleSlackEvent` is the single processor for both the `app_mention` and the
 * `message.mpim` events a `G…` conversation produces. Its external-author guard
 * (events.ts, the `isExternalUser(authorInfo)` check) keys only off `event.user`
 * and sits ahead of the ack, the thread fetch, and task creation — so an event
 * from an external/guest author in a `G…` conversation must be dropped with no
 * reaction, no thread fetch, and no task, regardless of whether it arrived as an
 * `app_mention` or a `message`.
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
  // Faithful classification: external iff a guest or a different team_id than
  // home — the same rule as the real isExternalUser, so "getUserInfo returns a
  // user isExternalUser classifies as external" is exercised end-to-end.
  isExternalUser: vi.fn(
    (u: { teamId?: string; isRestricted?: boolean; isUltraRestricted?: boolean }) =>
      Boolean(u?.isRestricted) ||
      Boolean(u?.isUltraRestricted) ||
      Boolean(u?.teamId && u.teamId !== HOME_TEAM),
  ),
  isChannelShared: vi.fn().mockResolvedValue(false),
  postEphemeral: vi.fn(),
  getSlackClient: vi.fn(),
  cleanSlackText: vi.fn((s: string) => s),
}));

vi.mock('../channel-canvas.js', () => ({ ensureChannelCanvas: vi.fn() }));
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
}));

vi.mock('../../../system/logger.js', () => ({
  logger: {
    system: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn(),
    plain: vi.fn(), server: vi.fn(), slack: vi.fn(),
  },
}));

import { handleSlackEvent } from '../events.js';
import { Task } from '../../../tasks/task.js';
import { getUserInfo, isExternalUser, addReaction, fetchSlackThread } from '../client.js';
import { findTaskByThread } from '../../../tasks/persistence.js';

const GROUP_DM = 'G0GROUPDM1'; // is_mpim: true — group DM, not a `D…` 1:1 DM

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
      it(`${type} from an external author (${label}) on a G… channel → no task, no reaction, no fetch`, async () => {
        vi.mocked(getUserInfo).mockResolvedValue(info as never);

        await handleSlackEvent({
          type,
          channel: GROUP_DM,
          user: 'U_EXTERNAL',
          text: 'hey archie',
          ts: '1700000000.000100',
        });

        // The author was resolved and classified as external...
        expect(vi.mocked(getUserInfo)).toHaveBeenCalledWith('U_EXTERNAL');
        expect(vi.mocked(isExternalUser)).toHaveReturnedWith(true);

        // ...so the handler bailed before any side effect: no ack reaction,
        // no thread fetch, no task lookup, no task creation.
        expect(vi.mocked(addReaction)).not.toHaveBeenCalled();
        expect(vi.mocked(fetchSlackThread)).not.toHaveBeenCalled();
        expect(vi.mocked(findTaskByThread)).not.toHaveBeenCalled();
        expect(vi.mocked(Task.create)).not.toHaveBeenCalled();
      });
    }
  }
});
