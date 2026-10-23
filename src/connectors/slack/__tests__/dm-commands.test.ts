import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getUserInfo, isInternalMemoryUser, postSlackMessage, beginConnect, publicRedirectUri, deletePersonalRecord, listPersonalRecords, log } = vi.hoisted(() => ({
  getUserInfo: vi.fn(),
  isInternalMemoryUser: vi.fn(),
  postSlackMessage: vi.fn(),
  beginConnect: vi.fn(),
  publicRedirectUri: vi.fn(),
  deletePersonalRecord: vi.fn(),
  listPersonalRecords: vi.fn(),
  log: { system: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../client.js', () => ({ getUserInfo, isInternalMemoryUser, postSlackMessage }));
vi.mock('../../../system/oauth/connect.js', () => ({ beginConnect, publicRedirectUri }));
vi.mock('../../../system/oauth/storage.js', () => ({ deletePersonalRecord, listPersonalRecords }));
vi.mock('../../../system/logger.js', () => ({ logger: log }));

import { handleDmCommand, typedText } from '../dm-commands.js';

const USER = 'U0OWNER1';
const DM = 'D0OWNERDM';
const REDIRECT = 'https://archie.example.com/oauth/callback';

function dm(text: string, extra: Partial<Parameters<typeof handleDmCommand>[0]> = {}) {
  return { channel: DM, user: USER, ts: '1700000000.000100', raw: { text }, ...extra };
}

function richText(...lines: string[]) {
  return {
    blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: lines.map((text) => ({ type: 'text', text })) }] }],
  };
}

function posted(): string[] {
  return postSlackMessage.mock.calls.map(([args]) => (args as { text: string }).text);
}

beforeEach(() => {
  vi.clearAllMocks();
  getUserInfo.mockResolvedValue({ name: 'owner', realName: 'Owner' });
  isInternalMemoryUser.mockReturnValue(true);
  postSlackMessage.mockResolvedValue('1700000000.000200');
  publicRedirectUri.mockReturnValue(REDIRECT);
  beginConnect.mockResolvedValue({ authorizeUrl: 'https://auth.example.com/authorize?state=abc', state: 'abc', scopes: [], authServer: {} });
  deletePersonalRecord.mockResolvedValue(true);
  listPersonalRecords.mockResolvedValue([]);
});

describe('typedText', () => {
  it('prefers a rich_text block over a text that carries extra attribution', () => {
    const raw = { text: 'connect notion\n_Sent using Some Client_', ...richText('connect notion') };
    expect(typedText(raw)).toBe('connect notion');
  });

  it('joins rich_text blocks with a newline and flattens nested elements', () => {
    const raw = {
      blocks: [
        { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] },
        { type: 'rich_text', elements: [{ type: 'rich_text_list', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'c' }] }] }] },
      ],
    };
    expect(typedText(raw)).toBe('ab\nc');
  });

  it('falls back to text when there is no rich_text block', () => {
    expect(typedText({ text: 'connections', blocks: [{ type: 'section' }] })).toBe('connections');
  });

  it('never throws on odd input', () => {
    expect(typedText(undefined)).toBe('');
    expect(typedText(null)).toBe('');
    expect(typedText('connect notion')).toBe('');
    expect(typedText({})).toBe('');
    expect(typedText({ text: 42 })).toBe('');
    expect(typedText({ blocks: 'nope', text: 'hi' })).toBe('hi');
    expect(typedText({ blocks: [null, 7, { type: 'rich_text', elements: 'nope' }, { type: 'rich_text', elements: [null, { type: 'text' }] }] })).toBe('\n');
  });
});

describe('handleDmCommand: what is not a command', () => {
  it.each([
    ['a channel', { channel: 'C0CHANNEL1' }],
    ['a group', { channel: 'G0GROUP001' }],
    ['an empty user', { user: '' }],
  ])('returns false without any lookup for %s', async (_label, extra) => {
    expect(await handleDmCommand(dm('connect notion', extra))).toBe(false);
    expect(getUserInfo).not.toHaveBeenCalled();
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it.each(['hello', 'please connect notion', 'connect', 'connect a b', 'connections please', ''])(
    'returns false without any lookup for the DM %j',
    async (text) => {
      expect(await handleDmCommand(dm(text))).toBe(false);
      expect(getUserInfo).not.toHaveBeenCalled();
      expect(isInternalMemoryUser).not.toHaveBeenCalled();
      expect(postSlackMessage).not.toHaveBeenCalled();
      expect(beginConnect).not.toHaveBeenCalled();
      expect(listPersonalRecords).not.toHaveBeenCalled();
      expect(deletePersonalRecord).not.toHaveBeenCalled();
    },
  );

  it('returns false for a DM with no text at all', async () => {
    expect(await handleDmCommand({ channel: DM, user: USER, ts: '1', raw: undefined })).toBe(false);
    expect(getUserInfo).not.toHaveBeenCalled();
  });
});

describe('handleDmCommand: connect', () => {
  it('starts a personal connection and replies with the link', async () => {
    const result = await handleDmCommand(dm('  Connect Notion ', { thread_ts: '1699999999.000100' }));
    expect(result).toBe(true);
    expect(getUserInfo).toHaveBeenCalledWith(USER);
    expect(beginConnect).toHaveBeenCalledWith({
      serverName: 'notion',
      redirectUri: REDIRECT,
      person: { slackUserId: USER, channelId: DM, threadTs: '1699999999.000100' },
    });
    expect(postSlackMessage).toHaveBeenCalledWith({
      channel: DM,
      threadTs: '1699999999.000100',
      text: 'Open this link to connect `notion` with your own account. It works once and expires in an hour.\n[Connect notion](https://auth.example.com/authorize?state=abc)',
    });
  });

  it('reads the command from rich_text when text carries attribution', async () => {
    const raw = { text: 'connect notion\n_Sent using Some Client_', ...richText('connect notion') };
    expect(await handleDmCommand(dm('', { raw }))).toBe(true);
    expect(beginConnect).toHaveBeenCalledWith(expect.objectContaining({ serverName: 'notion' }));
  });

  it('answers a connect failure with the reason', async () => {
    beginConnect.mockRejectedValue(new Error('no such server: nope'));
    expect(await handleDmCommand(dm('connect nope'))).toBe(true);
    expect(posted()).toEqual(["That didn't work: no such server: nope"]);
    expect(log.error).toHaveBeenCalled();
  });

  it('answers an unset public URL the same way', async () => {
    publicRedirectUri.mockImplementation(() => {
      throw new Error('ARCHIE_PUBLIC_URL is not set');
    });
    expect(await handleDmCommand(dm('connect notion'))).toBe(true);
    expect(beginConnect).not.toHaveBeenCalled();
    expect(posted()).toEqual(["That didn't work: ARCHIE_PUBLIC_URL is not set"]);
  });
});

describe('handleDmCommand: disconnect', () => {
  it('reports a removed connection', async () => {
    expect(await handleDmCommand(dm('disconnect Notion'))).toBe(true);
    expect(deletePersonalRecord).toHaveBeenCalledWith(USER, 'notion');
    expect(posted()).toEqual(['Disconnected `notion`.']);
  });

  it('reports a connection that was not there', async () => {
    deletePersonalRecord.mockResolvedValue(false);
    expect(await handleDmCommand(dm('disconnect notion'))).toBe(true);
    expect(posted()).toEqual(["`notion` wasn't connected."]);
  });

  it('answers an unsafe name the store rejects', async () => {
    deletePersonalRecord.mockRejectedValue(new Error('unsafe server name'));
    expect(await handleDmCommand(dm('disconnect ../etc'))).toBe(true);
    expect(posted()).toEqual(["That didn't work: unsafe server name"]);
  });
});

describe('handleDmCommand: connections', () => {
  it('says so when nothing is connected', async () => {
    expect(await handleDmCommand(dm('connections'))).toBe(true);
    expect(listPersonalRecords).toHaveBeenCalledWith(USER);
    expect(posted()).toEqual(["You haven't connected anything yet. Say `connect <name>` to use one of my tools with your own account."]);
  });

  it('lists connections with their dates', async () => {
    listPersonalRecords.mockResolvedValue([
      { server_name: 'notion', created_at: Date.UTC(2026, 9, 20, 12) / 1000 },
      { server_name: 'linear', created_at: Date.UTC(2026, 8, 1, 23, 59) / 1000 },
    ]);
    expect(await handleDmCommand(dm('Connections'))).toBe(true);
    expect(posted()).toEqual([
      'Your connections:\n• `notion`, connected 2026-10-20\n• `linear`, connected 2026-09-01\nSay `disconnect <name>` to remove one.',
    ]);
  });
});

describe('handleDmCommand: who may use it', () => {
  it('ignores a non-internal author without replying or touching anything', async () => {
    isInternalMemoryUser.mockReturnValue(false);
    expect(await handleDmCommand(dm('connect notion'))).toBe(true);
    expect(postSlackMessage).not.toHaveBeenCalled();
    expect(beginConnect).not.toHaveBeenCalled();
    expect(deletePersonalRecord).not.toHaveBeenCalled();
    expect(listPersonalRecords).not.toHaveBeenCalled();
    expect(log.system).toHaveBeenCalledWith(`Ignoring a DM command from ${USER}, who is not an internal member`);
  });

  it('says the account could not be confirmed when the lookup fails, and does nothing else', async () => {
    getUserInfo.mockRejectedValue(new Error('ratelimited'));
    expect(await handleDmCommand(dm('disconnect notion'))).toBe(true);
    expect(posted()).toEqual(["I couldn't confirm your Slack account just now, so I can't change connections. Try again in a minute."]);
    expect(beginConnect).not.toHaveBeenCalled();
    expect(deletePersonalRecord).not.toHaveBeenCalled();
    expect(listPersonalRecords).not.toHaveBeenCalled();
  });
});

describe('handleDmCommand: Slack failures', () => {
  it('still resolves true when the reply cannot be posted', async () => {
    postSlackMessage.mockRejectedValue(new Error('channel_not_found'));
    await expect(handleDmCommand(dm('connections'))).resolves.toBe(true);
  });

  it('still resolves true when the lookup-failure reply cannot be posted', async () => {
    getUserInfo.mockRejectedValue(new Error('ratelimited'));
    postSlackMessage.mockRejectedValue(new Error('channel_not_found'));
    await expect(handleDmCommand(dm('connections'))).resolves.toBe(true);
  });
});
