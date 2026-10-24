import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getChannelInfo, getUserInfo, isInternalMemoryUser, beginConnect, publicRedirectUri, deletePersonalRecord, listPersonalRecords, log } = vi.hoisted(() => ({
  getChannelInfo: vi.fn(),
  getUserInfo: vi.fn(),
  isInternalMemoryUser: vi.fn(),
  beginConnect: vi.fn(),
  publicRedirectUri: vi.fn(),
  deletePersonalRecord: vi.fn(),
  listPersonalRecords: vi.fn(),
  log: { plain: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../client.js', () => ({ getChannelInfo, getUserInfo, isInternalMemoryUser }));
vi.mock('../../../system/oauth/connect.js', () => ({ beginConnect, publicRedirectUri }));
vi.mock('../../../system/oauth/storage.js', () => ({ deletePersonalRecord, listPersonalRecords }));
vi.mock('../../../system/logger.js', () => ({ logger: log }));

import { connectCommandReply, registerConnectCommand } from '../connect-command.js';

const USER = 'U0OWNER1';
const DM = 'D0OWNER1';
const REDIRECT = 'https://archie.example.com/oauth/callback';
const DM_ONLY = 'Use this in your DM with Archie.';

function say(text: string, channel_id = DM) {
  return connectCommandReply({ user_id: USER, channel_id, text });
}

function expectNothingChanged() {
  expect(beginConnect).not.toHaveBeenCalled();
  expect(deletePersonalRecord).not.toHaveBeenCalled();
  expect(listPersonalRecords).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  getChannelInfo.mockResolvedValue({ id: DM, name: 'DM with Owner', isPrivate: true, isIm: true, imUserId: USER });
  getUserInfo.mockResolvedValue({ name: 'owner', realName: 'Owner' });
  isInternalMemoryUser.mockReturnValue(true);
  publicRedirectUri.mockReturnValue(REDIRECT);
  beginConnect.mockResolvedValue({ authorizeUrl: 'https://auth.example.com/authorize?state=abc', state: 'abc', scopes: [], authServer: {} });
  deletePersonalRecord.mockResolvedValue(true);
  listPersonalRecords.mockResolvedValue([]);
});

describe('connectCommandReply', () => {
  it.each(['C0CHANNEL1', 'G0GROUP001'])('refuses %s without looking anything up', async (channel) => {
    expect(await say('connections', channel)).toBe(DM_ONLY);
    expect(getChannelInfo).not.toHaveBeenCalled();
    expect(getUserInfo).not.toHaveBeenCalled();
    expectNothingChanged();
  });

  it('refuses a D channel that is not the app\'s own IM', async () => {
    getChannelInfo.mockResolvedValue({ id: DM, name: DM, isPrivate: false, isIm: false });
    expect(await say('connections')).toBe(DM_ONLY);
    expect(getUserInfo).not.toHaveBeenCalled();
    expectNothingChanged();
  });

  it('refuses an IM that belongs to someone else', async () => {
    getChannelInfo.mockResolvedValue({ id: DM, name: 'DM with Other', isPrivate: true, isIm: true, imUserId: 'U0OTHER01' });
    expect(await say('connections')).toBe(DM_ONLY);
    expect(getUserInfo).not.toHaveBeenCalled();
    expectNothingChanged();
  });

  it('fails closed when the identity lookup throws', async () => {
    getUserInfo.mockRejectedValue(new Error('ratelimited'));
    expect(await say('connect notion')).toBe(
      "I couldn't confirm your Slack account just now, so I can't change connections. Try again in a minute.",
    );
    expect(log.warn).toHaveBeenCalledWith('Slack', `Could not look up ${USER} for a connect command`, expect.any(Error));
    expectNothingChanged();
  });

  it('tells a person who is not internal that only members can connect', async () => {
    isInternalMemoryUser.mockReturnValue(false);
    expect(await say('connect notion')).toBe('Only members of this workspace can connect their own accounts.');
    expectNothingChanged();
  });

  it('replies with the usage line for text it does not know', async () => {
    const reply = await say('hello there');
    expect(reply).toBe('Say `connect <server>`, `disconnect <server>` or `connections`.');
    expectNothingChanged();
  });

  it('starts a connect for a trimmed, case-insensitive command and answers with the link', async () => {
    const reply = await say('  Connect Notion ');
    expect(beginConnect).toHaveBeenCalledWith({
      serverName: 'notion',
      redirectUri: REDIRECT,
      person: { slackUserId: USER, channelId: DM },
    });
    expect(reply).toBe(
      'Open this link to connect `notion` with your own account. It works once and expires in an hour.\n<https://auth.example.com/authorize?state=abc|Connect notion>',
    );
  });

  it('reports a failure instead of throwing', async () => {
    beginConnect.mockRejectedValue(new Error('no such server'));
    expect(await say('connect nope')).toBe("That didn't work: no such server");
    expect(log.error).toHaveBeenCalledWith('Slack', `Connect command failed for ${USER}`, expect.any(Error));
  });

  it('disconnects a connected server', async () => {
    expect(await say('disconnect notion')).toBe('Disconnected `notion`.');
    expect(deletePersonalRecord).toHaveBeenCalledWith(USER, 'notion');
  });

  it('says so when the server was not connected', async () => {
    deletePersonalRecord.mockResolvedValue(false);
    expect(await say('disconnect notion')).toBe("`notion` wasn't connected.");
  });

  it('tells a person with no connections how to make one', async () => {
    expect(await say('connections')).toBe(
      "You haven't connected anything yet. Use `connect <name>` to use one of my tools with your own account.",
    );
    expect(listPersonalRecords).toHaveBeenCalledWith(USER);
  });

  it('lists the connections with the day each was made', async () => {
    listPersonalRecords.mockResolvedValue([
      { server_name: 'notion', created_at: Date.UTC(2026, 9, 1, 12) / 1000 },
      { server_name: 'linear', created_at: Date.UTC(2026, 9, 20, 23) / 1000 },
    ]);
    expect(await say('Connections')).toBe(
      'Your connections:\n• `notion`, connected 2026-10-01\n• `linear`, connected 2026-10-20\nUse `disconnect <name>` to remove one.',
    );
  });
});

describe('registerConnectCommand', () => {
  const saved = process.env.ARCHIE_SLASH_COMMAND;

  afterEach(() => {
    if (saved === undefined) delete process.env.ARCHIE_SLASH_COMMAND;
    else process.env.ARCHIE_SLASH_COMMAND = saved;
  });

  function register() {
    const command = vi.fn();
    registerConnectCommand({ command } as never);
    return command;
  }

  it('registers /archie by default', () => {
    delete process.env.ARCHIE_SLASH_COMMAND;
    const command = register();
    expect(command).toHaveBeenCalledTimes(1);
    expect(command.mock.calls[0][0]).toBe('/archie');
  });

  it('registers the trimmed ARCHIE_SLASH_COMMAND when set', () => {
    process.env.ARCHIE_SLASH_COMMAND = '  /archie-test ';
    expect(register().mock.calls[0][0]).toBe('/archie-test');
  });

  it('acks before it responds, and responds ephemerally', async () => {
    const handler = register().mock.calls[0][1] as (arg: unknown) => Promise<void>;
    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);

    await handler({ command: { user_id: USER, channel_id: DM, text: 'connections' }, ack, respond });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(1);
    // Slack's 3 s ack limit: the ack must not wait for any Slack lookup or OAuth discovery.
    expect(ack.mock.invocationCallOrder[0]).toBeLessThan(getChannelInfo.mock.invocationCallOrder[0]);
    expect(ack.mock.invocationCallOrder[0]).toBeLessThan(respond.mock.invocationCallOrder[0]);
    expect(respond).toHaveBeenCalledWith({
      response_type: 'ephemeral',
      text: "You haven't connected anything yet. Use `connect <name>` to use one of my tools with your own account.",
    });
  });

  it('does not throw when respond rejects, and logs it', async () => {
    delete process.env.ARCHIE_SLASH_COMMAND;
    const handler = register().mock.calls[0][1] as (arg: unknown) => Promise<void>;
    const respond = vi.fn().mockRejectedValue(new Error('expired response_url'));

    await expect(
      handler({ command: { user_id: USER, channel_id: DM, text: 'connections' }, ack: vi.fn().mockResolvedValue(undefined), respond }),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith('Slack', 'Could not answer /archie', expect.any(Error));
  });
});
