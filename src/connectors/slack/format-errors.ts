/**
 * Slack error → agent-facing guidance string formatters.
 *
 * Extracted from tools.ts so the bespoke error→message mapping (membership,
 * archived, bad thread, private-channel refusal, markdown limit) can be
 * unit-tested without the whole agent tool surface.
 */
import { SlackMarkdownLimitError, SLACK_MARKDOWN_LIMIT, PrivateChannelError } from './client.js';

/** Pull Slack's error code (e.g. "not_in_channel") off a WebAPI error. */
export function slackErrorCode(err: unknown): string | undefined {
  return (err as { data?: { error?: string } })?.data?.error;
}

/** Generic outbound-post failure → guidance (markdown-limit aware). */
export function formatSlackSendError(err: unknown): string {
  if (err instanceof SlackMarkdownLimitError) {
    return (
      `Slack rejected the message: ${err.actualLength} chars exceeds the ${SLACK_MARKDOWN_LIMIT}-char per-message limit. ` +
      `Nothing was delivered or logged. Split the content into multiple messages under the limit, ` +
      `breaking on paragraphs and keeping code blocks/tables whole.`
    );
  }
  const reason = err instanceof Error ? err.message : String(err);
  return `Failed to post message: ${reason}`;
}

/** `post_to_channel` failure → guidance (membership / archived / bad thread / limit). */
export function formatSlackPostError(err: unknown, channel: string): string {
  if (err instanceof SlackMarkdownLimitError) return formatSlackSendError(err);
  const code = slackErrorCode(err);
  if (code === 'not_in_channel' || code === 'channel_not_found') {
    return `Couldn't post to ${channel}: Archie isn't in that channel. Someone needs to invite it (\`/invite @Archie\`) — Archie can only write where it's been added.`;
  }
  if (code === 'is_archived') return `Couldn't post to ${channel}: the channel is archived.`;
  if (code === 'thread_not_found') return `Couldn't post to ${channel}: that thread (thread_ts) doesn't exist. Omit thread_ts to start a new top-level message.`;
  return formatSlackSendError(err);
}

/** Explore-read failure → guidance (private refused / not a member). */
export function formatSlackReadError(err: unknown, channel: string): string {
  if (err instanceof PrivateChannelError) {
    return `Couldn't read ${channel}: it's a private channel or DM. Archie only explores PUBLIC channels.`;
  }
  const code = slackErrorCode(err);
  if (code === 'not_in_channel' || code === 'channel_not_found') {
    return `Couldn't read ${channel}: Archie isn't a member of that public channel (or it doesn't exist). Invite it (\`/invite @Archie\`) — Archie can only read public channels it's been added to.`;
  }
  const reason = err instanceof Error ? err.message : String(err);
  return `Couldn't read ${channel}: ${reason}`;
}
