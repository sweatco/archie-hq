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
  it('omits person-specific buttons on public follow-ups', async () => {
    await new PublicSlack().send({ id: 'unowned', channel: 'C1', thread: '10.000001', text: 'Useful help',
      matters: ['release'], recipient: null, evidence: [1], digest: false, state: 'pending', ts: null, created: 0 });
    expect(f.post.mock.calls[0][0].actions).toBeUndefined();
  });

  it.each([{ deleted: true }, { is_bot: true }, { is_restricted: true }, { team_id: 'T_OTHER' }])('does not open a DM to an inactive, bot, guest or external user: %o', async override => {
    f.api.users.info.mockResolvedValue({ user: { team_id: 'T1', is_restricted: false, is_ultra_restricted: false, is_bot: false, is_app_user: false, deleted: false, ...override } });
    await expect(new PublicSlack().dm('U_OTHER')).rejects.toThrow('Unverified initiative recipient');
    expect(f.api.conversations.open).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'private nudge', channel: 'D_OWNER' },
    { name: 'task suggestion', channel: 'D_OWNER', proposal: { id: 'proposal', version: 'version' } },
  ])('restricts $name buttons to the responsible employee while retaining the message destination', async ({ channel, proposal }) => {
    const slack = new PublicSlack();
    await slack.send({ id: 'delivery', recipient: 'U_OWNER', channel, thread: '10.000001', text: 'Follow up on the release',
      matters: ['release'], evidence: [1], digest: false, state: 'pending', ts: null, created: 0, proposal });
    const message = f.post.mock.calls[0][0];
    expect(message).toMatchObject({ channel, threadTs: '10.000001', text: 'Follow up on the release' });
    expect(message.actions.map((button: { action_id: string }) => button.action_id)).toEqual(proposal
      ? ['initiative_start_task']
      : ['initiative_handled', 'initiative_later', 'initiative_not_useful', 'initiative_stop_following']);
    for (const button of message.actions) {
      expect(button.visible_to_user_ids).toEqual(['U_OWNER']);
    }
  });

  it('fails closed on private, missing-membership and incomplete source metadata', async () => {
    const slack = new PublicSlack();
    for (const override of [{ is_private: true }, { is_member: false }, { is_ext_shared: undefined }]) {
      f.api.conversations.info.mockResolvedValueOnce({ channel: { ...channel, ...override } });
      expect(await slack.inspect('C1')).toBeNull();
    }
    expect(await slack.inspect('D1')).toBeNull();
    expect(await slack.inspect('G1')).toBeNull();
    expect(f.api.conversations.history).not.toHaveBeenCalled();
  });

  it('keeps shared public evidence source-local and independently verifies owner membership', async () => {
    const slack = new PublicSlack();
    f.api.conversations.info.mockResolvedValue({ channel: { ...channel, is_ext_shared: true } });
    f.api.conversations.members.mockResolvedValue({ members: ['U_OTHER'] });
    expect(await slack.inspect('C1', 'U_OWNER')).toEqual({ shared: true, recipientCanRead: false });
  });

  it('rejects a page if source access changes during retrieval', async () => {
    const slack = new PublicSlack();
    f.api.conversations.info.mockResolvedValueOnce({ channel }).mockResolvedValueOnce({ channel: { ...channel, is_private: true } });
    f.api.conversations.history.mockResolvedValue({ messages: [{ ts: '10.000001', user: 'U1', text: 'Public before conversion' }] });
    await expect(slack.page('C1', '10', '11')).rejects.toThrow('changed audience');
  });

  it('preserves pagination and strips attachments/files before rendering evidence', async () => {
    const slack = new PublicSlack();
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
    const slack = new PublicSlack();
    f.api.conversations.info.mockResolvedValue({ channel: { is_im: true, user: 'U_OTHER' } });
    expect(await slack.verifyDm('D1', 'U_OWNER')).toBe(false);
    f.api.users.info.mockResolvedValue({ user: { team_id: 'OTHER' } });
    await expect(slack.verifyDm('D1', 'U_OWNER')).resolves.toBe(false);
    expect(f.api.conversations.history).not.toHaveBeenCalled();
  });
});
