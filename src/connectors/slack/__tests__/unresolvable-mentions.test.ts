/**
 * An id Slack rejects must be asked about once, not once per thread read — but a
 * transient failure must not be cached as permanent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const slackApi = {
  auth: { test: vi.fn() },
  conversations: { info: vi.fn(), replies: vi.fn(), history: vi.fn() },
  users: { info: vi.fn(), conversations: vi.fn(), list: vi.fn() },
  usergroups: { list: vi.fn() },
  pins: { list: vi.fn() },
};

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn(function (this: unknown) { return slackApi; }),
}));

const loggerWarn = vi.fn();
const loggerDebug = vi.fn();
vi.mock('../../../system/logger.js', () => ({
  logger: {
    slack: vi.fn(), warn: loggerWarn, debug: loggerDebug,
    system: vi.fn(), error: vi.fn(), plain: vi.fn(),
  },
}));

/** Shape of a Slack Web API error: the code lives on `error.data.error`. */
function slackError(code: string): Error & { data: { error: string } } {
  return Object.assign(new Error(code), { data: { error: code } });
}

type ClientModule = typeof import('../client.js');
let client: ClientModule;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules(); // negative cache starts empty

  slackApi.auth.test.mockResolvedValue({
    user_id: 'UBOT', bot_id: 'BBOT', team_id: 'THOME', url: 'https://acme.slack.com',
  });
  slackApi.usergroups.list.mockResolvedValue({ usergroups: [] });
  slackApi.users.list.mockResolvedValue({ members: [] });

  client = await import('../client.js');
  await client.initSlackClient('xoxb-test');
});

describe('unresolvable mention ids', () => {
  it('resolves a real user to the agent-facing marker', async () => {
    slackApi.users.info.mockResolvedValue({
      ok: true,
      user: { id: 'U123', name: 'jane', real_name: 'Jane Roe', team_id: 'THOME', profile: {} },
    });

    expect(await client.cleanSlackText('hi <@U123>')).toBe('hi <@U123:Jane Roe>');
  });

  it('leaves an unknown id as written, without warning, and asks Slack only once', async () => {
    slackApi.users.info.mockRejectedValue(slackError('user_not_found'));

    expect(await client.cleanSlackText('ping <@UKROMANOV6898>')).toBe('ping <@UKROMANOV6898>');
    expect(await client.cleanSlackText('again <@UKROMANOV6898>')).toBe('again <@UKROMANOV6898>');

    expect(slackApi.users.info).toHaveBeenCalledTimes(1);
    expect(loggerWarn).not.toHaveBeenCalled();
    expect(loggerDebug).toHaveBeenCalledTimes(1);
  });

  it('does not cache a transient failure — it warns with the reason and retries', async () => {
    const err = slackError('ratelimited');
    slackApi.users.info.mockRejectedValue(err);

    expect(await client.cleanSlackText('ping <@U123>')).toBe('ping <@U123>');
    expect(await client.cleanSlackText('ping <@U123>')).toBe('ping <@U123>');

    expect(slackApi.users.info).toHaveBeenCalledTimes(2);
    expect(loggerWarn).toHaveBeenCalledTimes(2);
    expect(loggerWarn).toHaveBeenLastCalledWith('Slack', expect.stringContaining('U123'), err);
  });

  it('recovers a real user after a transient failure', async () => {
    slackApi.users.info.mockRejectedValueOnce(slackError('ratelimited'));
    slackApi.users.info.mockResolvedValue({
      ok: true,
      user: { id: 'U123', name: 'jane', real_name: 'Jane Roe', team_id: 'THOME', profile: {} },
    });

    expect(await client.cleanSlackText('hi <@U123>')).toBe('hi <@U123>');
    expect(await client.cleanSlackText('hi <@U123>')).toBe('hi <@U123:Jane Roe>');
  });
});
