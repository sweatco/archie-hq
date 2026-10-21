// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  api: { conversations: { info: vi.fn(), members: vi.fn(), history: vi.fn(), replies: vi.fn(), open: vi.fn() }, users: { info: vi.fn(), conversations: vi.fn() } },
  extract: vi.fn(async (raw: Record<string, unknown>) => ({ text: raw.text as string })), post: vi.fn(),
}));
vi.mock('@slack/web-api', () => ({ WebClient: vi.fn(function () { return f.api; }) }));
vi.mock('../../connectors/slack/client.js', () => ({
  getSlackClient: () => ({ token: 'test-token' }), getHomeTeamId: () => 'T1', getBotId: () => 'B_ARCHIE', getBotUserId: () => 'U_ARCHIE',
  postSlackMessage: f.post, extractMessageContent: f.extract, isSlackDryRun: () => false, buildThreadUrl: () => 'https://slack.test/thread',
}));
vi.mock('../../tasks/task.js', () => ({ getActiveTaskIds: () => [], getTask: () => null }));
import { PublicSlack, normalizeSlackSource } from '../slack.js';

const channel = { id: 'C1', is_private: false, is_im: false, is_mpim: false, is_member: true, is_archived: false, is_shared: false, is_ext_shared: false, is_pending_ext_shared: false };
beforeEach(() => {
  vi.clearAllMocks();
  f.api.conversations.info.mockResolvedValue({ channel });
  f.api.conversations.members.mockResolvedValue({ members: ['U_OWNER'] });
  f.api.users.info.mockResolvedValue({ user: { team_id: 'T1', is_restricted: false, is_ultra_restricted: false, is_bot: false, is_app_user: false, deleted: false } });
});

describe('public-source Slack boundary', () => {
  it('fails closed on private, missing-membership and incomplete source metadata', async () => {
    const slack = new PublicSlack('U_OWNER');
    for (const override of [{ is_private: true }, { is_member: false }, { is_ext_shared: undefined }]) {
      f.api.conversations.info.mockResolvedValueOnce({ channel: { ...channel, ...override } });
      expect(await slack.inspect('C1')).toBeNull();
    }
    expect(await slack.inspect('D1')).toBeNull();
    expect(await slack.inspect('G1')).toBeNull();
    expect(f.api.conversations.history).not.toHaveBeenCalled();
  });

  it('keeps shared public evidence source-local and independently verifies owner membership', async () => {
    const slack = new PublicSlack('U_OWNER');
    f.api.conversations.info.mockResolvedValue({ channel: { ...channel, is_ext_shared: true } });
    f.api.conversations.members.mockResolvedValue({ members: ['U_OTHER'] });
    expect(await slack.inspect('C1', true)).toEqual({ shared: true, ownerCanRead: false });
  });

  it('rejects a page if source access changes during retrieval', async () => {
    const slack = new PublicSlack('U_OWNER');
    f.api.conversations.info.mockResolvedValueOnce({ channel }).mockResolvedValueOnce({ channel: { ...channel, is_private: true } });
    f.api.conversations.history.mockResolvedValue({ messages: [{ ts: '10.000001', user: 'U1', text: 'Public before conversion' }] });
    await expect(slack.page('C1', '10', '11')).rejects.toThrow('changed audience');
  });

  it('preserves pagination and strips attachments/files before rendering evidence', async () => {
    const slack = new PublicSlack('U_OWNER');
    f.api.conversations.replies.mockResolvedValue({ messages: [{ ts: '10.000001', user: 'U1', text: 'Public body', files: [{ secret: 'file' }], attachments: [{ text: 'Excluded body' }] }], response_metadata: { next_cursor: 'next' } });
    const page = await slack.page('C1', '10', '11', 'cursor', '10.000001');
    expect(page.cursor).toBe('next');
    expect(page.messages[0].text).toBe('Public body');
    expect(f.extract.mock.calls[0][0]).toEqual(expect.objectContaining({ files: [], attachments: [] }));
    expect(f.api.conversations.replies).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'cursor', ts: '10.000001' }));
  });

  it('distinguishes human, other-app and Archie provenance', async () => {
    expect(await normalizeSlackSource({ ts: '10.000001', user: 'U1', text: 'Human' }, 'C1')).toMatchObject({ own: false, bot: false });
    expect(await normalizeSlackSource({ ts: '10.000001', user: 'U_APP', bot_id: 'B_OTHER', text: 'Alert' }, 'C1')).toMatchObject({ own: false, bot: true });
    expect(await normalizeSlackSource({ ts: '10.000001', user: 'U_ARCHIE', bot_id: 'B_ARCHIE', text: 'My output' }, 'C1')).toMatchObject({ own: true, bot: true });
  });

  it('verifies the exact human owner before using a DM without reading its history', async () => {
    const slack = new PublicSlack('U_OWNER');
    f.api.conversations.info.mockResolvedValue({ channel: { is_im: true, user: 'U_OTHER' } });
    expect(await slack.verifyDm('D1')).toBe(false);
    f.api.users.info.mockResolvedValue({ user: { team_id: 'OTHER' } });
    await expect(slack.verifyDm('D1')).rejects.toThrow('Unverified initiative owner');
    expect(f.api.conversations.history).not.toHaveBeenCalled();
  });
});
