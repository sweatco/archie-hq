/**
 * The author-trust rule that decides whether an ingested Slack message's text is
 * written verbatim into a task transcript.
 *
 * The transcript is the durable record a task is judged by, so the rule is a
 * property of the author alone — never of the channel it was captured in.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SlackAuthor } from '../../../types/task.js';

const { slackApi } = vi.hoisted(() => ({
  slackApi: {
    auth: { test: vi.fn() },
    users: { info: vi.fn(), list: vi.fn() },
    conversations: { info: vi.fn() },
  },
}));

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn(function (this: unknown) { return slackApi; }),
}));
vi.mock('../../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), slack: vi.fn() },
}));

type ClientModule = typeof import('../client.js');
let client: ClientModule;

const HOME = 'THOME';

function author(over: Partial<SlackAuthor> = {}): SlackAuthor {
  return { id: 'U_DEV', username: 'dev', realName: 'Dev', teamId: HOME, ...over };
}

beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env.SLACK_TRUSTED_AUTOMATION_IDS;
  slackApi.auth.test.mockResolvedValue({ user_id: 'UBOT', bot_id: 'BBOT', team_id: HOME, url: 'https://acme.slack.com' });
  vi.resetModules();
  client = await import('../client.js');
  await client.initSlackClient('xoxb-test');
});

afterEach(() => {
  delete process.env.SLACK_TRUSTED_AUTOMATION_IDS;
});

describe('initSlackClient', () => {
  it('refuses to boot when auth.test cannot establish an identity', async () => {
    slackApi.auth.test.mockRejectedValue(new Error('invalid_auth'));
    vi.resetModules();
    const fresh = await import('../client.js');

    await expect(fresh.initSlackClient('xoxb-test')).rejects.toThrow('Slack identity verification failed');
    expect(fresh.getHomeTeamId()).toBeNull();
  });
});

describe('isTrustedIngestAuthor', () => {
  it('trusts a verified home-workspace human', () => {
    expect(client.isTrustedIngestAuthor(author())).toBe(true);
  });

  it('distrusts a guest even in an ordinary, non-shared channel', () => {
    expect(client.isTrustedIngestAuthor(author({ isRestricted: true }))).toBe(false);
    expect(client.isTrustedIngestAuthor(author({ isUltraRestricted: true }))).toBe(false);
  });

  it('distrusts another workspace member', () => {
    expect(client.isTrustedIngestAuthor(author({ teamId: 'T_OTHER' }))).toBe(false);
  });

  it('distrusts an author carrying no team id at all', () => {
    expect(client.isTrustedIngestAuthor(author({ teamId: undefined }))).toBe(false);
  });

  it('distrusts an author whose identity lookup failed', () => {
    expect(client.isTrustedIngestAuthor(author({ unclassified: true }))).toBe(false);
  });

  it('distrusts a bot or app user that is not allowlisted', () => {
    expect(client.isTrustedIngestAuthor(author({ isBot: true }))).toBe(false);
    expect(client.isTrustedIngestAuthor(author({ isAppUser: true }))).toBe(false);
  });

  it('trusts an allowlisted automation, including a webhook post with no team id', () => {
    process.env.SLACK_TRUSTED_AUTOMATION_IDS = ' B_JANITOR , U_APP ';

    expect(client.isTrustedIngestAuthor(author({ id: 'B_JANITOR', isBot: true, teamId: undefined }))).toBe(true);
    expect(client.isTrustedIngestAuthor(author({ id: 'U_APP', isAppUser: true }))).toBe(true);
    expect(client.isTrustedIngestAuthor(author({ id: 'B_OTHER', isBot: true }))).toBe(false);
  });
});

describe('getChannelInfo', () => {
  it('reports an unreachable channel as private', async () => {
    slackApi.conversations.info.mockRejectedValue(new Error('channel_not_found'));

    expect((await client.getChannelInfo('C1')).isPrivate).toBe(true);
  });

  it('reports a group DM as private', async () => {
    slackApi.conversations.info.mockResolvedValue({
      ok: true, channel: { id: 'C1', name: 'mpdm', is_private: false, is_im: false, is_mpim: true },
    });

    expect((await client.getChannelInfo('C1')).isPrivate).toBe(true);
  });
});
