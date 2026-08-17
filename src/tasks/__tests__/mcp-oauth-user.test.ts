import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../../types/task.js';
import type { OAuthPendingRecord, OAuthUserRecord } from '../../system/oauth/types.js';

const oauth = vi.hoisted(() => ({
  beginUserConnect: vi.fn(),
  readMcpServerUrl: vi.fn(),
  ensureFreshUserToken: vi.fn(),
  deletePendingIfIncomplete: vi.fn(),
  findPendingUserAttempt: vi.fn(),
  readUserOAuthRecord: vi.fn(),
}));

vi.mock('../../system/oauth/connect.js', () => ({
  beginUserConnect: oauth.beginUserConnect,
  readMcpServerUrl: oauth.readMcpServerUrl,
}));

vi.mock('../../system/oauth/refresh.js', () => ({
  ensureFreshUserToken: oauth.ensureFreshUserToken,
}));

vi.mock('../../system/oauth/storage.js', () => ({
  deletePendingIfIncomplete: oauth.deletePendingIfIncomplete,
  findPendingUserAttempt: oauth.findPendingUserAttempt,
  readUserOAuthRecord: oauth.readUserOAuthRecord,
}));

vi.mock('../persistence.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../persistence.js')>()),
  appendAgentFinding: vi.fn(async () => {}),
}));

import { Task } from '../task.js';

function resolve(defaultChannel: string | null, channels: Record<string, Channel>): string | null {
  return Task.prototype.getMcpOAuthUser.call({
    metadata: { default_channel: defaultChannel, channels },
  } as Task);
}

const dm: Channel = {
  type: 'slack',
  channel_id: 'D1',
  channel_name: 'DM with Alice',
  thread_id: '1.0',
  last_processed_ts: '1.0',
  dm_user_id: 'U1',
};

const userRecord = (scopes: string[]): OAuthUserRecord => ({
  server_name: 'notion', slack_user_id: 'U1', expires_at: 9_999_999_999,
  created_at: 1, updated_at: 1, issuer: 'https://auth.example.com',
  token_endpoint: 'https://auth.example.com/token', scopes,
  resource: 'https://mcp.example.com/mcp',
  redirect_uri: 'https://archie.example.com/oauth/callback',
  envelope: { ciphertext: 'x', iv: 'x', tag: 'x' },
});

function makeTask(personal: string[] = []) {
  return {
    taskId: 'task-1',
    metadata: {
      default_channel: 'dm',
      channels: { dm },
      mcp_personal_oauth: personal,
    },
    getMcpOAuthUser: () => 'U1',
    save: vi.fn(async () => {}),
    postToUser: vi.fn(async () => null),
  } as unknown as Task;
}

describe('Task per-user MCP OAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    oauth.readMcpServerUrl.mockReturnValue('https://mcp.example.com/mcp');
    oauth.findPendingUserAttempt.mockResolvedValue(null);
    oauth.readUserOAuthRecord.mockResolvedValue(null);
    oauth.ensureFreshUserToken.mockResolvedValue({ accessToken: 'AT', tokenType: 'Bearer', expiresAt: 9_999_999_999 });
    oauth.beginUserConnect.mockResolvedValue({ authorizeUrl: 'https://auth.example.com/authorize', state: 'new-state' });
    oauth.deletePendingIfIncomplete.mockResolvedValue(true);
  });

  it('resolves the participant only for the default 1:1 DM', () => {
    const channel: Channel = {
      type: 'slack', channel_id: 'C1', channel_name: 'general',
      thread_id: '1.0', last_processed_ts: '1.0',
    };
    expect(resolve('dm', { dm })).toBe('U1');
    expect(resolve('channel', { channel, dm })).toBeNull();
    expect(resolve('dm', { dm: { ...dm, dm_user_id: undefined } })).toBeNull();
  });

  it('rejects authorization outside a DM', async () => {
    await expect(Task.prototype.requestMcpAuth.call({
      getMcpOAuthUser: () => null,
    } as unknown as Task, 'notion')).rejects.toThrow('only in a 1:1 Slack DM');
  });

  it('returns the typed pending outcome without creating or posting another link', async () => {
    oauth.findPendingUserAttempt.mockResolvedValue({ state: 'existing' } as OAuthPendingRecord);
    const task = makeTask();

    await expect(Task.prototype.requestMcpAuth.call(task, 'notion')).resolves.toBe('authorization_pending');

    expect(oauth.beginUserConnect).not.toHaveBeenCalled();
    expect(task.postToUser).not.toHaveBeenCalled();
  });

  it('reuses fresh personal credentials only when they cover challenged scopes', async () => {
    oauth.readUserOAuthRecord.mockResolvedValue(userRecord(['read', 'write']));
    const task = makeTask();

    await expect(Task.prototype.requestMcpAuth.call(task, 'notion', undefined, ['write']))
      .resolves.toBe('ready');

    expect(oauth.ensureFreshUserToken).toHaveBeenCalledWith('U1', 'notion', 'https://mcp.example.com/mcp');
    expect(oauth.beginUserConnect).not.toHaveBeenCalled();
    expect(task.metadata.mcp_personal_oauth).toContain('notion');
  });

  it('reauthorizes with the union of prior and challenged scopes when coverage is missing', async () => {
    oauth.readUserOAuthRecord.mockResolvedValue(userRecord(['read']));
    const task = makeTask();

    await expect(Task.prototype.requestMcpAuth.call(task, 'notion', 'needs write', ['write', 'write']))
      .resolves.toBe('authorization_started');

    expect(oauth.beginUserConnect).toHaveBeenCalledWith({
      serverName: 'notion', slackUserId: 'U1', taskId: 'task-1', requestedScopes: ['read', 'write'],
    });
    expect(task.postToUser).toHaveBeenCalledOnce();
    expect(task.metadata.mcp_oauth_reauth_attempts).toEqual({ notion: 1 });
  });

  it('forces reauthorization when the selected personal token is the credential that failed', async () => {
    oauth.readUserOAuthRecord.mockResolvedValue(userRecord(['read']));
    const task = makeTask(['notion']);

    await expect(Task.prototype.requestMcpAuth.call(task, 'notion'))
      .resolves.toBe('authorization_started');

    expect(oauth.ensureFreshUserToken).not.toHaveBeenCalled();
    expect(oauth.beginUserConnect).toHaveBeenCalledOnce();
  });

  it('stops after two delivered forced reauthorization attempts', async () => {
    oauth.readUserOAuthRecord.mockResolvedValue(userRecord(['read']));
    const task = makeTask(['notion']);
    task.metadata.mcp_oauth_reauth_attempts = { notion: 2 };

    await expect(Task.prototype.requestMcpAuth.call(task, 'notion'))
      .rejects.toThrow(/permanent permission failure/);

    expect(oauth.beginUserConnect).not.toHaveBeenCalled();
    expect(task.postToUser).not.toHaveBeenCalled();
  });

  it('deletes only its new incomplete attempt when Slack link delivery fails', async () => {
    oauth.readUserOAuthRecord.mockResolvedValue(userRecord(['read']));
    const task = makeTask(['notion']);
    vi.mocked(task.postToUser).mockRejectedValue(new Error('Slack unavailable'));

    await expect(Task.prototype.requestMcpAuth.call(task, 'notion'))
      .rejects.toThrow('Slack unavailable');

    expect(oauth.deletePendingIfIncomplete).toHaveBeenCalledWith('new-state');
    expect(task.metadata.mcp_personal_oauth).toContain('notion');
    expect(task.metadata.mcp_oauth_reauth_attempts).toBeUndefined();
  });

  it('serializes concurrent requests through link delivery', async () => {
    let releasePost!: () => void;
    const postBlocked = new Promise<void>((resolve) => { releasePost = resolve; });
    const task = makeTask();
    vi.mocked(task.postToUser).mockImplementation(async () => {
      await postBlocked;
      return null;
    });
    oauth.findPendingUserAttempt
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ state: 'new-state' } as OAuthPendingRecord);

    const first = Task.prototype.requestMcpAuth.call(task, 'notion');
    const second = Task.prototype.requestMcpAuth.call(task, 'notion');
    await vi.waitFor(() => expect(task.postToUser).toHaveBeenCalledOnce());
    expect(oauth.findPendingUserAttempt).toHaveBeenCalledTimes(1);

    releasePost();
    await expect(Promise.all([first, second])).resolves.toEqual([
      'authorization_started',
      'authorization_pending',
    ]);
    expect(oauth.beginUserConnect).toHaveBeenCalledOnce();
    expect(task.postToUser).toHaveBeenCalledOnce();
  });
});
