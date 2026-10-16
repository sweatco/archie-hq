import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), agent: vi.fn(), plain: vi.fn() },
}));

vi.mock('../../slack/client.js', () => ({
  getChannelInfo: vi.fn().mockResolvedValue({ id: 'D1', name: 'DM with Dana', isPrivate: true, isIm: true, imUserId: 'U1' }),
  postSlackMessage: vi.fn(),
  getUserInfo: vi.fn().mockResolvedValue({ realName: 'Dana', name: 'dana' }),
  isExternalUser: vi.fn(() => false),
}));

vi.mock('../connections.js', () => ({
  issueCode: vi.fn().mockResolvedValue('ABCD-EFGH'),
  revokeUser: vi.fn().mockResolvedValue(1),
}));

import { handleClaudeCommand } from '../dm-commands.js';
import { getUserInfo, isExternalUser, postSlackMessage } from '../../slack/client.js';
import { issueCode, revokeUser } from '../connections.js';

function posted(): { channel: string; text: string; threadTs?: string } {
  return vi.mocked(postSlackMessage).mock.calls[0][0];
}

describe('handleClaudeCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('issues a connect code in the DM', async () => {
    expect(await handleClaudeCommand({ channel: 'D1', user: 'U1', raw: { text: 'connect claude' } })).toBe(true);
    expect(issueCode).toHaveBeenCalledWith({ user_id: 'U1', channel_id: 'D1', channel_name: 'DM with Dana' });
    expect(posted().channel).toBe('D1');
    expect(posted().text).toContain('ABCD-EFGH');
    expect(posted().threadTs).toBeUndefined();
  });

  it('reads what the person typed, not the attribution a client adds to text', async () => {
    const raw = {
      text: 'connect claude *Sent using* <@U0ABDVDSGPN>',
      app_id: 'A08SF47R6P4',
      user: 'U1',
      thread_ts: '1792152041.935369',
      blocks: [
        { type: 'rich_text', block_id: 'wfFXbf', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'connect claude' }] }] },
        { type: 'context', block_id: 'KWZTs', elements: [{ type: 'mrkdwn', text: '*Sent using* <@U0ABDVDSGPN>', verbatim: false }] },
      ],
    };
    expect(await handleClaudeCommand({ channel: 'D1', user: 'U1', thread_ts: '1792152041.935369', raw })).toBe(true);
    expect(issueCode).toHaveBeenCalledTimes(1);
    expect(posted().threadTs).toBe('1792152041.935369');
  });

  it('does not treat more typed text as the command', async () => {
    const raw = {
      text: 'connect claude to the repo',
      blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'connect claude to the repo' }] }] }],
    };
    expect(await handleClaudeCommand({ channel: 'D1', user: 'U1', raw })).toBe(false);
    expect(issueCode).not.toHaveBeenCalled();
  });

  it('issues no code to an external user', async () => {
    vi.mocked(isExternalUser).mockReturnValueOnce(true);
    expect(await handleClaudeCommand({ channel: 'D1', user: 'U9', raw: { text: 'connect claude' } })).toBe(true);
    expect(issueCode).not.toHaveBeenCalled();
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it('issues no code when the person cannot be looked up', async () => {
    vi.mocked(getUserInfo).mockRejectedValueOnce(new Error('slack down'));
    await expect(handleClaudeCommand({ channel: 'D1', user: 'U1', raw: { text: 'connect claude' } })).rejects.toThrow('slack down');
    expect(issueCode).not.toHaveBeenCalled();
  });

  it('ignores case, surrounding space and a trailing exclamation mark', async () => {
    expect(await handleClaudeCommand({ channel: 'D1', user: 'U1', raw: { text: ' Connect Claude! ' } })).toBe(true);
  });

  it('replies in the thread the person typed in', async () => {
    expect(await handleClaudeCommand({ channel: 'D1', user: 'U1', thread_ts: '111.222', raw: { text: ' Connect Claude! ' } })).toBe(true);
    expect(posted().threadTs).toBe('111.222');
  });

  it.each([
    ['a channel', { channel: 'C1', user: 'U1', raw: { text: 'connect claude' } }],
    ['extra words', { channel: 'D1', user: 'U1', raw: { text: 'connect claude please' } }],
    ['no raw message', { channel: 'D1', user: 'U1', raw: undefined }],
  ])('leaves %s to the PM', async (_label, event) => {
    expect(await handleClaudeCommand(event)).toBe(false);
    expect(postSlackMessage).not.toHaveBeenCalled();
    expect(issueCode).not.toHaveBeenCalled();
    expect(revokeUser).not.toHaveBeenCalled();
  });

  it('disconnects Claude', async () => {
    expect(await handleClaudeCommand({ channel: 'D1', user: 'U1', raw: { text: 'disconnect claude' } })).toBe(true);
    expect(revokeUser).toHaveBeenCalledWith('U1');
    expect(posted().text).toMatch(/^Claude is disconnected/);
  });

  it('says so when nothing was connected', async () => {
    vi.mocked(revokeUser).mockResolvedValueOnce(0);
    expect(await handleClaudeCommand({ channel: 'D1', user: 'U1', raw: { text: 'disconnect claude' } })).toBe(true);
    expect(posted().text).toBe('No Claude was connected.');
  });
});
