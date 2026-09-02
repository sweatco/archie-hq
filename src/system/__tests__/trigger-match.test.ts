/**
 * The pure channel-message match predicate. Dispatch-level behaviour (an app post's `contains` matching the
 * rendered body, the `B…` author regression end to end) lives in connectors/slack/__tests__/trigger-dispatch.test.ts;
 * what is pinned here is the decision itself, including the cases that are awkward to reach through Bolt.
 */
import { describe, it, expect } from 'vitest';
import type { Trigger } from '../../types/trigger.js';
import { authorFilterMatches, isSlackAuthorId, isAppAuthorId, messageMatchesTrigger } from '../trigger-match.js';

const CHANNEL = 'C0WATCHED';

function watcher(match?: { contains?: string; from_user?: string }): Trigger {
  return {
    id: 'trg-1', status: 'enabled', created_by: 'U_DEV', created_at: '2026-08-20T00:00:00.000Z',
    binding: { type: 'channel', channel_id: CHANNEL, channel_name: 'watched' },
    conditions: [{ type: 'channel_message', channel_id: CHANNEL, ...(match ? { match } : {}) }],
    action: { prompt: 'look into it' },
  };
}

describe('authorFilterMatches', () => {
  it('matches either id the payload carries', () => {
    expect(authorFilterMatches('U_DEV', { userId: 'U_DEV' })).toBe(true);
    expect(authorFilterMatches('B_APP', { botId: 'B_APP' })).toBe(true);
  });

  // An app calling chat.postMessage with a bot token emits BOTH — its bot user id and its bot id — so
  // either form of the filter has to name it. Whichever id the person setting the trigger read off the
  // author line is the one they will use.
  it('matches both ids when the payload carries both', () => {
    const author = { userId: 'U_APPUSER', botId: 'B_APP' };
    expect(authorFilterMatches('U_APPUSER', author)).toBe(true);
    expect(authorFilterMatches('B_APP', author)).toBe(true);
    expect(authorFilterMatches('U_SOMEONE', author)).toBe(false);
  });

  // `handleSlackEvent` normalizes a missing `user` to `''`. If an empty id could match an empty filter the
  // predicate would fire on every authorless post — the exact population these filters exist to narrow.
  it('never matches on an empty id, on either side', () => {
    expect(authorFilterMatches('', { userId: '', botId: 'B_APP' })).toBe(false);
    expect(authorFilterMatches('U_DEV', { userId: '' })).toBe(false);
    expect(authorFilterMatches('', {})).toBe(false);
  });
});

describe('isSlackAuthorId', () => {
  it.each(['U08JNK1A6', 'W03RQQTE1EF', 'B0A9ZRW2TS9'])('accepts %s', (id) => {
    expect(isSlackAuthorId(id)).toBe(true);
  });

  // A channel id is the near-miss worth refusing explicitly: it is the other id in the same tool call.
  it.each(['flagbot', '@flagbot', 'C05MFQCEN0N', 'u08jnk1a6', 'U', ''])('refuses %j', (id) => {
    expect(isSlackAuthorId(id)).toBe(false);
  });

  it('tells an app id apart from a person', () => {
    expect(isAppAuthorId('B0A9ZRW2TS9')).toBe(true);
    expect(isAppAuthorId('U08JNK1A6')).toBe(false);
  });
});

describe('messageMatchesTrigger', () => {
  const base = { channelId: CHANNEL, body: 'Expired Feature Flags Report — 200 flags', author: { botId: 'B_APP' } };

  it('matches `contains` case-insensitively', () => {
    expect(messageMatchesTrigger(watcher({ contains: 'expired feature flags' }), base)).toBe(true);
  });

  it('requires every filter on the condition, not just one', () => {
    const t = watcher({ contains: 'Expired Feature Flags Report', from_user: 'B_APP' });
    expect(messageMatchesTrigger(t, base)).toBe(true);
    expect(messageMatchesTrigger(t, { ...base, author: { botId: 'B_OTHER' } })).toBe(false);
    expect(messageMatchesTrigger(t, { ...base, body: 'something else entirely' })).toBe(false);
  });

  it('ignores a condition watching a different channel', () => {
    expect(messageMatchesTrigger(watcher(), { ...base, channelId: 'C0ELSEWHERE' })).toBe(false);
  });

  it('ignores a schedule condition entirely', () => {
    const t: Trigger = {
      ...watcher(),
      conditions: [{ type: 'schedule', tz: 'UTC', cron: '0 9 * * *', next_run_at: '2026-09-03T09:00:00.000Z' }],
    };
    expect(messageMatchesTrigger(t, base)).toBe(false);
  });

  // Any condition firing is enough — the stored model is a disjunction.
  it('fires when any one of several conditions matches', () => {
    const t: Trigger = {
      ...watcher(),
      conditions: [
        { type: 'channel_message', channel_id: CHANNEL, match: { contains: 'never appears' } },
        { type: 'channel_message', channel_id: CHANNEL, match: { from_user: 'B_APP' } },
      ],
    };
    expect(messageMatchesTrigger(t, base)).toBe(true);
  });

  it('matches an unfiltered condition on any message in the channel', () => {
    expect(messageMatchesTrigger(watcher(), { ...base, body: '' })).toBe(true);
  });
});
