/**
 * A `message_changed` edit used to be logged from Slack's flat `text` fallback
 * with only mentions resolved, while the identical message posted fresh went
 * through the full block/attachment extraction. Observed live: editing a message
 * to add a Jira link logged the raw `<url|label>` mrkdwn, where posting the same
 * link fresh logged `label (url)` — and anything carried in `blocks` or
 * `attachments` was lost on the edit path entirely.
 *
 * `extractMessageContent` is the shared entry point that closes that gap: one
 * raw payload in, the same rendering as every other inbound message out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const slackApi = {
  auth: { test: vi.fn() },
  conversations: { info: vi.fn(), replies: vi.fn(), history: vi.fn() },
  users: { info: vi.fn(), conversations: vi.fn(), list: vi.fn() },
  usergroups: { list: vi.fn() },
};

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn(function (this: unknown) { return slackApi; }),
}));
vi.mock('../../../system/logger.js', () => ({
  logger: { slack: vi.fn(), warn: vi.fn(), system: vi.fn(), error: vi.fn(), plain: vi.fn() },
}));

type ClientModule = typeof import('../client.js');
let client: ClientModule;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  slackApi.auth.test.mockResolvedValue({
    user_id: 'UBOT', bot_id: 'BBOT', team_id: 'THOME', url: 'https://acme.slack.com',
  });
  slackApi.usergroups.list.mockResolvedValue({ usergroups: [] });
  slackApi.users.list.mockResolvedValue({ members: [] });
  slackApi.users.info.mockImplementation(async ({ user }: { user: string }) => ({
    ok: true, user: { id: user, name: user.toLowerCase(), real_name: `Real ${user}`, team_id: 'THOME', profile: {} },
  }));
  slackApi.conversations.info.mockResolvedValue({
    ok: true, channel: { id: 'C1', name: 'bot-test', is_private: false, is_im: false, is_mpim: false },
  });
  client = await import('../client.js');
  await client.initSlackClient('xoxb-test');
});

describe('extractMessageContent — the edit path renders like every other path', () => {
  it('renders a Jira chip added by an edit as `title (url)`, not raw mrkdwn', async () => {
    // The payload from the live edit that exposed this.
    const edited = {
      type: 'message',
      ts: '1786225194.525969',
      user: 'UHUMAN',
      text: 'I am just testing some changes. <https://acme.atlassian.net/browse/IO-3021?a=1&amp;b=2|[BE][CoreExp] Support failed flow for joinable offer>',
      blocks: [{
        type: 'rich_text',
        elements: [{
          type: 'rich_text_section',
          elements: [
            { type: 'text', text: 'I am just testing some changes. ' },
            {
              type: 'attachment_mention',
              url: 'https://acme.atlassian.net/browse/IO-3021?a=1&b=2',
              text: '[BE][CoreExp] Support failed flow for joinable offer',
              product_name: 'Jira Cloud',
            },
          ],
        }],
      }],
    };

    const { text } = await client.extractMessageContent(edited, 'C1');

    expect(text).toBe(
      'I am just testing some changes. [BE][CoreExp] Support failed flow for joinable offer '
      + '(https://acme.atlassian.net/browse/IO-3021?a=1&b=2)',
    );
    expect(text).not.toContain('|');      // no raw <url|label> mrkdwn
    expect(text).not.toContain('&amp;');  // entity decoded
  });

  it('surfaces attachment cards on an edited message', async () => {
    const edited = {
      type: 'message', ts: '2.0', user: 'UHUMAN', text: '',
      attachments: [{ title: '[FIRING:2] DiskFull', title_link: 'https://g.example.com/a', text: 'Value: 1' }],
    };

    const { text, attachments } = await client.extractMessageContent(edited, 'C1');

    expect(text).toBe('');
    expect(attachments?.[0].text).toContain('[FIRING:2] DiskFull');
    expect(attachments?.[0].text).toContain('https://g.example.com/a');
  });

  it('still resolves mentions, as the old cleanSlackText path did', async () => {
    const edited = {
      type: 'message', ts: '3.0', user: 'UHUMAN',
      text: 'ping <@UOTHER> about this',
    };

    const { text } = await client.extractMessageContent(edited, 'C1');

    expect(text).toBe('ping <@UOTHER:Real UOTHER> about this');
  });

  it('returns empty text rather than throwing on a payload it cannot read', async () => {
    const { text } = await client.extractMessageContent({ type: 'message', ts: '4.0', blocks: null }, 'C1');
    expect(typeof text).toBe('string');
  });
});
