/**
 * Tests for the Slack client behaviours added in the v32 permissions rework:
 *  - fetchSlackThread.rootAuthorWasBot detection + keeping the bot's root message
 *  - searchSlackMessages excludes private channels / DMs / group DMs
 *  - fetchChannelHistory refuses private channels (assertPublicChannel) and
 *    returns history chronologically
 *
 * The whole Slack WebClient is faked via @slack/web-api. The module is reset
 * before each test so the client's internal caches (channel info, shared status,
 * user info) never leak across cases.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// One shared fake WebClient; methods are reconfigured per test.
const slackApi = {
  auth: { test: vi.fn() },
  conversations: { info: vi.fn(), replies: vi.fn(), history: vi.fn() },
  users: { info: vi.fn() },
  usergroups: { list: vi.fn() },
  search: { messages: vi.fn() },
};

// WebClient is used with `new`, so the mock implementation must be a regular
// (constructable) function that returns our shared fake.
vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn(function (this: unknown) { return slackApi; }),
}));
vi.mock('../../../system/logger.js', () => ({
  logger: { slack: vi.fn(), warn: vi.fn(), system: vi.fn(), error: vi.fn(), plain: vi.fn() },
}));

type ClientModule = typeof import('../client.js');
let client: ClientModule;

/** Build a raw Slack message; `text` falls back through blocks to the text field. */
function rawMsg(over: Record<string, unknown>): Record<string, unknown> {
  return { type: 'message', ts: '1.0', text: 'hi', ...over };
}

/** A search match in the shape search.messages returns. */
function match(over: Record<string, unknown>): Record<string, unknown> {
  return { ts: '1.0', text: 'hit', username: 'someone', ...over };
}

const BOT_USER = 'UBOT';
const BOT_ID = 'BBOT';

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();

  slackApi.auth.test.mockResolvedValue({
    user_id: BOT_USER, bot_id: BOT_ID, team_id: 'THOME', url: 'https://acme.slack.com',
  });
  slackApi.usergroups.list.mockResolvedValue({ usergroups: [] });
  slackApi.users.info.mockImplementation(async ({ user }: { user: string }) => ({
    ok: true,
    user: { id: user, name: user.toLowerCase(), real_name: `Real ${user}`, team_id: 'THOME', profile: {} },
  }));
  // Default: a public, non-shared channel.
  slackApi.conversations.info.mockResolvedValue({
    ok: true, channel: { id: 'C1', name: 'general', is_private: false, is_im: false, is_mpim: false },
  });

  client = await import('../client.js');
  await client.initSlackClient('xoxb-test');
});

describe('fetchSlackThread — rootAuthorWasBot', () => {
  it('is true when the root is our bot (by user id) and keeps the root message', async () => {
    slackApi.conversations.replies.mockResolvedValue({
      messages: [
        rawMsg({ ts: '100.0', user: BOT_USER, text: 'anyone seen the deploy fail?' }),
        rawMsg({ ts: '101.0', user: 'UHUMAN', text: 'yes, looking now' }),
      ],
    });

    const thread = await client.fetchSlackThread('C_botuser', '100.0', '101.0');

    expect(thread.rootAuthorWasBot).toBe(true);
    const texts = thread.messages.map((m) => m.text);
    expect(texts).toContain('anyone seen the deploy fail?'); // bot root preserved
    expect(texts).toContain('yes, looking now');
  });

  it('is true when the root is our bot (by bot_id, no user)', async () => {
    slackApi.conversations.replies.mockResolvedValue({
      messages: [
        rawMsg({ ts: '200.0', user: undefined, bot_id: BOT_ID, bot_profile: { name: 'Archie' }, text: 'posted via app' }),
        rawMsg({ ts: '201.0', user: 'UHUMAN', text: 'on it' }),
      ],
    });

    const thread = await client.fetchSlackThread('C_botid', '200.0', '201.0');

    expect(thread.rootAuthorWasBot).toBe(true);
  });

  it('is false for a human-started thread, and filters out the bot\'s non-root replies', async () => {
    slackApi.conversations.replies.mockResolvedValue({
      messages: [
        rawMsg({ ts: '300.0', user: 'UHUMAN', text: 'human starts the thread' }),
        rawMsg({ ts: '301.0', user: BOT_USER, text: 'archie chimed in' }), // non-root bot → filtered
        rawMsg({ ts: '302.0', user: 'UHUMAN2', text: 'another human' }),
      ],
    });

    const thread = await client.fetchSlackThread('C_human', '300.0', '302.0');

    expect(thread.rootAuthorWasBot).toBe(false);
    const texts = thread.messages.map((m) => m.text);
    expect(texts).toContain('human starts the thread');
    expect(texts).toContain('another human');
    expect(texts).not.toContain('archie chimed in'); // bot non-root message filtered out
  });
});

describe('searchSlackMessages — public only', () => {
  it('keeps public-channel matches and drops private / DM / group-DM matches', async () => {
    slackApi.search.messages.mockResolvedValue({
      messages: {
        matches: [
          match({ text: 'public hit', channel: { id: 'C9', name: 'general', is_private: false } }),
          match({ text: 'private hit', channel: { id: 'C8', name: 'secret', is_private: true } }),
          match({ text: 'dm hit', channel: { id: 'D7', name: 'dm', is_im: true } }),
          match({ text: 'mpim hit', channel: { id: 'G6', name: 'mpdm', is_mpim: true } }),
        ],
      },
    });

    const results = await client.searchSlackMessages('hit');

    expect(results.map((r) => r.text)).toEqual(['public hit']);
    expect(results[0]).toMatchObject({ channelId: 'C9', channelName: 'general' });
  });
});

describe('fetchChannelHistory — public only, chronological', () => {
  it('refuses a private channel before reading any history', async () => {
    slackApi.conversations.info.mockResolvedValue({
      ok: true, channel: { id: 'C_priv', name: 'secret', is_private: true },
    });

    await expect(client.fetchChannelHistory('C_priv')).rejects.toBeInstanceOf(client.PrivateChannelError);
    expect(slackApi.conversations.history).not.toHaveBeenCalled();
  });

  it('refuses a DM / group DM', async () => {
    slackApi.conversations.info.mockResolvedValue({
      ok: true, channel: { id: 'D_dm', name: 'dm', is_im: true },
    });
    await expect(client.fetchChannelHistory('D_dm')).rejects.toBeInstanceOf(client.PrivateChannelError);
  });

  it('returns a public channel\'s history oldest-first (history API is newest-first)', async () => {
    slackApi.conversations.info.mockResolvedValue({
      ok: true, channel: { id: 'C_pub', name: 'general', is_private: false },
    });
    slackApi.conversations.history.mockResolvedValue({
      messages: [
        rawMsg({ ts: '3.0', user: 'U3', text: 'newest' }),
        rawMsg({ ts: '2.0', user: 'U2', text: 'middle' }),
        rawMsg({ ts: '1.0', user: 'U1', text: 'oldest' }),
      ],
    });

    const { channel, messages } = await client.fetchChannelHistory('C_pub');

    expect(channel).toMatchObject({ id: 'C_pub', name: 'general' });
    expect(messages.map((m) => m.text)).toEqual(['oldest', 'middle', 'newest']);
  });
});

describe('fetchExploreThread — public only, no bot filtering', () => {
  it('refuses a private channel before reading replies', async () => {
    slackApi.conversations.info.mockResolvedValue({
      ok: true, channel: { id: 'C_pt', name: 'secret', is_private: true },
    });
    await expect(client.fetchExploreThread('C_pt', '1.0')).rejects.toBeInstanceOf(client.PrivateChannelError);
    expect(slackApi.conversations.replies).not.toHaveBeenCalled();
  });

  it('keeps the bot\'s messages (explore is unfiltered) and preserves files & reactions', async () => {
    slackApi.conversations.info.mockResolvedValue({
      ok: true, channel: { id: 'C_pt', name: 'general', is_private: false },
    });
    slackApi.conversations.replies.mockResolvedValue({
      messages: [
        rawMsg({
          ts: '1.0', user: 'U1', text: 'see attached',
          files: [{ id: 'F1', name: 'log.txt', mimetype: 'text/plain', url_private: 'https://x/log.txt' }],
          reactions: [{ name: 'eyes', count: 2 }],
        }),
        rawMsg({ ts: '2.0', user: BOT_USER, text: 'archie reply (kept in explore reads)' }),
      ],
    });

    const { messages } = await client.fetchExploreThread('C_pt', '1.0');

    // Unlike task ingestion, explore reads do NOT filter the bot's messages.
    expect(messages.map((m) => m.text)).toContain('archie reply (kept in explore reads)');
    const withFile = messages.find((m) => m.files?.length);
    expect(withFile?.files?.[0]).toMatchObject({ id: 'F1', name: 'log.txt' });
    const withReaction = messages.find((m) => m.reactions?.length);
    expect(withReaction?.reactions?.[0]).toMatchObject({ name: 'eyes', count: 2 });
  });
});
