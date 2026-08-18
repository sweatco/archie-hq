import { describe, it, expect } from 'vitest';
import {
  shouldCreateNewTask,
  isAckableEvent,
  shouldForwardMessageEvent,
  isContentBearingSubtype,
  mayWakeTask,
  mayReachTriggers,
} from '../task-routing.js';

describe('shouldCreateNewTask', () => {
  it('creates a task on @mention (anywhere)', () => {
    expect(shouldCreateNewTask('app_mention', 'C123', false)).toBe(true);
  });

  it('creates a task for a DM message', () => {
    expect(shouldCreateNewTask('message', 'D123', false)).toBe(true);
  });

  it('creates a task when a human replies to a thread the bot started', () => {
    expect(shouldCreateNewTask('message', 'C123', true)).toBe(true);
  });

  it('does NOT create a task for a plain reply in a human-started channel thread', () => {
    expect(shouldCreateNewTask('message', 'C123', false)).toBe(false);
  });

  it('@mention still wins even if the root is not the bot', () => {
    expect(shouldCreateNewTask('app_mention', 'C123', false)).toBe(true);
  });
});

describe('group-DM (G…) routing parity', () => {
  // A group DM has a `G…` channel id. It is handled channel-like everywhere:
  // ackable/task-creating only via the app_mention arm, forwardable only via the
  // thread-reply or watched-trigger arms — never via the `D`-prefix DM arm.

  it('AC1: an @mention in a group DM creates a task and is ackable', () => {
    expect(shouldCreateNewTask('app_mention', 'G0ABC', false)).toBe(true);
    expect(isAckableEvent('app_mention', 'G0ABC')).toBe(true);
  });

  it('AC2: a thread reply in a group DM is forwarded', () => {
    expect(
      shouldForwardMessageEvent(
        { type: 'message', channel: 'G0ABC', ts: '2', thread_ts: '1' },
        () => false,
      ),
    ).toBe(true);
  });

  it('AC3: an ambient top-level group-DM message with no trigger is not forwarded, nor ackable', () => {
    expect(
      shouldForwardMessageEvent({ type: 'message', channel: 'G0ABC', ts: '1' }, () => false),
    ).toBe(false);
    expect(isAckableEvent('message', 'G0ABC')).toBe(false);
  });

  it('regression: an ambient top-level channel message still forwards when a trigger is watching', () => {
    expect(
      shouldForwardMessageEvent({ type: 'message', channel: 'C0XYZ', ts: '1' }, () => true),
    ).toBe(true);
  });
});

// The three arms a `message` event can be forwarded through. Each helper builds
// the same logical event on a different arm so a subtype can be checked against
// all of them at once.
const asThreadReply = (subtype?: string) => ({ type: 'message', subtype, channel: 'C0XYZ', ts: '2', thread_ts: '1' });
const asDm = (subtype?: string) => ({ type: 'message', subtype, channel: 'D0USER', ts: '1' });
const asWatchedTopLevel = (subtype?: string) => ({ type: 'message', subtype, channel: 'C0XYZ', ts: '1' });

const DENIED_SUBTYPES = [
  'message_changed',
  'message_deleted',
  'message_replied',
  'channel_join',
  'channel_leave',
  'group_join',
  'group_leave',
  'channel_archive',
  'channel_unarchive',
  'group_archive',
  'group_unarchive',
  'channel_convert_to_private',
  'channel_convert_to_public',
  'channel_posting_permissions',
  'pinned_item',
  'unpinned_item',
  'ekm_access_denied',
];

describe('subtype denylist', () => {
  for (const subtype of DENIED_SUBTYPES) {
    it(`refuses \`${subtype}\` on all three arms`, () => {
      expect(isContentBearingSubtype(subtype)).toBe(false);
      expect(shouldForwardMessageEvent(asThreadReply(subtype), () => true)).toBe(false);
      expect(shouldForwardMessageEvent(asDm(subtype), () => true)).toBe(false);
      expect(shouldForwardMessageEvent(asWatchedTopLevel(subtype), () => true)).toBe(false);
    });
  }

  it('denies exactly these 17 subtypes and nothing else it was not asked about', () => {
    expect(DENIED_SUBTYPES).toHaveLength(17);
    expect(new Set(DENIED_SUBTYPES).size).toBe(17);
  });

  // The regression that matters most: the gate is a denylist, so a subtype
  // nobody enumerated — including one Slack ships after this code was written —
  // is forwarded rather than silently dropped.
  it('forwards an unknown future subtype on all three arms', () => {
    const future = 'some_future_slack_thing';
    expect(isContentBearingSubtype(future)).toBe(true);
    expect(shouldForwardMessageEvent(asThreadReply(future), () => false)).toBe(true);
    expect(shouldForwardMessageEvent(asDm(future), () => false)).toBe(true);
    expect(shouldForwardMessageEvent(asWatchedTopLevel(future), () => true)).toBe(true);
  });

  // These are forwarded purely by not being on the denylist — there is no special case for any of them, and this pins that.
  for (const subtype of ['me_message', 'huddle_thread', 'channel_topic']) {
    it(`forwards \`${subtype}\` on every arm`, () => {
      expect(isContentBearingSubtype(subtype)).toBe(true);
      expect(shouldForwardMessageEvent(asThreadReply(subtype), () => false)).toBe(true);
      expect(shouldForwardMessageEvent(asDm(subtype), () => false)).toBe(true);
      expect(shouldForwardMessageEvent(asWatchedTopLevel(subtype), () => true)).toBe(true);
    });
  }

  // `bot_message` is the one deliberate asymmetry between the two questions, and it is the reason they are two functions rather than one boolean. It is content-bearing and it reaches triggers — that is the defect this change fixes — but it must not WAKE a task, because waking one spends a PM model turn and app posts (CI, Jira, Datadog, GitHub) arrive in volumes no human sends.
  // App posts arrive in more than one shape and each must be blocked from waking a task. Slack sets
  // `subtype: 'bot_message'` only for incoming-webhook / as_user:false posts; an app calling
  // chat.postMessage with a bot token arrives with `bot_id` and NO subtype, and an app file upload or
  // reply-broadcast carries `bot_id` under its own subtype. Keying on the subtype alone missed most of them.
  for (const [name, extra] of [
    ['a webhook post (subtype, no bot_id)', { subtype: 'bot_message' }],
    ['a chat.postMessage app post (bot_id, no subtype)', { bot_id: 'B_GITHUB' }],
    ['a webhook post carrying both signals', { subtype: 'bot_message', bot_id: 'B_HOOK' }],
    ['an app file_share', { subtype: 'file_share', bot_id: 'B_GITHUB' }],
    ['an app thread_broadcast', { subtype: 'thread_broadcast', bot_id: 'B_GITHUB' }],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`never wakes a task for ${name}`, () => {
      expect(mayWakeTask({ ...asThreadReply(undefined), ...extra })).toBe(false);
      expect(mayWakeTask({ ...asDm(undefined), ...extra })).toBe(false);
    });
  }

  it('lets `bot_message` reach triggers but never wake a task', () => {
    expect(isContentBearingSubtype('bot_message')).toBe(true);

    expect(mayReachTriggers(asWatchedTopLevel('bot_message'), () => true)).toBe(true);
    expect(shouldForwardMessageEvent(asWatchedTopLevel('bot_message'), () => true)).toBe(true);

    expect(mayWakeTask(asThreadReply('bot_message'))).toBe(false);
    expect(mayWakeTask(asDm('bot_message'))).toBe(false);
    expect(shouldForwardMessageEvent(asThreadReply('bot_message'), () => false)).toBe(false);
    expect(shouldForwardMessageEvent(asDm('bot_message'), () => false)).toBe(false);
  });

  it('treats a missing subtype as content-bearing', () => {
    expect(isContentBearingSubtype()).toBe(true);
    expect(isContentBearingSubtype(undefined)).toBe(true);
  });

  it('still forwards the two subtypes the old allowlist named', () => {
    for (const subtype of ['file_share', 'thread_broadcast']) {
      expect(shouldForwardMessageEvent(asThreadReply(subtype), () => false)).toBe(true);
    }
  });

  it('never forwards a non-message event type', () => {
    expect(shouldForwardMessageEvent({ type: 'app_mention', channel: 'D0USER', ts: '1' }, () => true)).toBe(false);
  });
});

describe('hasWatchingTrigger laziness', () => {
  // A predicate that fails the test if it is consulted at all. The trigger index
  // must stay untouched for DMs and thread replies — ordering inside the
  // disjunction is what guarantees that, so it is pinned rather than assumed.
  const explode = (): boolean => {
    throw new Error('hasWatchingTrigger must not be consulted for this event');
  };

  it('is not consulted for a DM', () => {
    expect(shouldForwardMessageEvent(asDm(), explode)).toBe(true);
  });

  it('is not consulted for a thread reply', () => {
    expect(shouldForwardMessageEvent(asThreadReply(), explode)).toBe(true);
  });

  it('is not consulted by mayWakeTask, ever', () => {
    expect(mayWakeTask(asDm())).toBe(true);
  });

  it('is not consulted for a DM even when the subtype is denied', () => {
    expect(shouldForwardMessageEvent(asDm('channel_join'), explode)).toBe(false);
  });
});

describe('mayWakeTask', () => {
  it('is true for a content-bearing thread reply', () => {
    expect(mayWakeTask({ channel: 'C0XYZ', ts: '2', thread_ts: '1' })).toBe(true);
  });

  it('is true for a content-bearing DM', () => {
    expect(mayWakeTask({ channel: 'D0USER', ts: '1' })).toBe(true);
  });

  it('is false for a top-level channel post, however watched', () => {
    expect(mayWakeTask({ channel: 'C0XYZ', ts: '1' })).toBe(false);
  });

  it('is false for a denied subtype on an otherwise qualifying event', () => {
    expect(mayWakeTask({ subtype: 'channel_leave', channel: 'D0USER', ts: '1' })).toBe(false);
  });

  it('treats a thread root (thread_ts === ts) as not a reply', () => {
    expect(mayWakeTask({ channel: 'C0XYZ', ts: '1', thread_ts: '1' })).toBe(false);
  });
});

describe('mayReachTriggers', () => {
  it('is true for a watched top-level channel post', () => {
    expect(mayReachTriggers({ channel: 'C0XYZ', ts: '1' }, () => true)).toBe(true);
  });

  it('is false when nothing is watching that channel', () => {
    expect(mayReachTriggers({ channel: 'C0XYZ', ts: '1' }, () => false)).toBe(false);
  });

  it('is false for a DM and for a thread reply', () => {
    expect(mayReachTriggers({ channel: 'D0USER', ts: '1' }, () => true)).toBe(false);
    expect(mayReachTriggers({ channel: 'C0XYZ', ts: '2', thread_ts: '1' }, () => true)).toBe(false);
  });

  it('is false for a denied subtype in a watched channel', () => {
    expect(mayReachTriggers({ subtype: 'pinned_item', channel: 'C0XYZ', ts: '1' }, () => true)).toBe(false);
  });

  it('passes the event channel to the predicate', () => {
    const seen: string[] = [];
    mayReachTriggers({ channel: 'C0XYZ', ts: '1' }, (ch) => {
      seen.push(ch);
      return false;
    });
    expect(seen).toEqual(['C0XYZ']);
  });
});
