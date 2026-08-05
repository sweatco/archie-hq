/**
 * Slack error → agent-facing guidance string formatters.
 *
 * Extracted from tools.ts so the bespoke error→message mapping (membership,
 * archived, bad thread, private-channel refusal, markdown limit) can be
 * unit-tested without the whole agent tool surface.
 */
import { SlackMarkdownLimitError, SLACK_MARKDOWN_LIMIT, PrivateChannelError, DmPostError } from './client.js';

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

/** `post_to_channel` failure → guidance (DM/group-DM refusal / membership / archived / bad thread / limit). */
export function formatSlackPostError(err: unknown, channel: string): string {
  if (err instanceof SlackMarkdownLimitError) return formatSlackSendError(err);
  if (err instanceof DmPostError) {
    return `Couldn't post to ${channel}: that's a DM or group DM. post_to_channel only posts to channels (public or private) Archie's a member of — never DMs. To message the user about this task, use post_to_user.`;
  }
  const code = slackErrorCode(err);
  if (code === 'not_in_channel' || code === 'channel_not_found') {
    return `Couldn't post to ${channel}: Archie isn't in that channel. Someone needs to invite it (\`/invite @Archie\`) — Archie can only write where it's been added.`;
  }
  if (code === 'is_archived') return `Couldn't post to ${channel}: the channel is archived.`;
  if (code === 'thread_not_found') return `Couldn't post to ${channel}: that thread (thread_ts) doesn't exist. Omit thread_ts to start a new top-level message.`;
  return formatSlackSendError(err);
}

/**
 * Outbound post blocked by a mute → guidance.
 *
 * The mute exists because someone in that channel asked Archie to step back, so
 * this has to shut the door on the workarounds too, not just the direct post:
 * a fresh thread in the same channel, the same content relayed into a different
 * channel, or a teammate asked to post it instead. It also has to void any
 * promise to report back, because that promise is exactly what pulls an agent
 * into posting again once a teammate returns with new information.
 */
export function formatMutedTargetRefusal(channelName: string, what: 'message' | 'files' = 'message'): string {
  const subject = what === 'files' ? 'Those files were not uploaded' : 'Nothing was posted';
  return (
    `Blocked: ${formatChannelLabel(channelName)} is muted — someone there asked you to step back. ${subject}. Only an @mention there lifts this.\n\n` +
    `Do not route around it: not a new thread in that channel, not the same content in another channel, not a teammate posting it for you, not "one last message" or a correction. New information does not reopen it, and any promise to report back there is void — being asked to stop supersedes it. Send it to your requester in this task's own thread instead, or not at all.`
  );
}

/** Reply blocked because a DIFFERENT task was told to leave that thread. */
export function formatCrossTaskMuteRefusal(channelName: string): string {
  return (
    `Blocked: someone in ${formatChannelLabel(channelName)} asked Archie to step out of that thread. Nothing was posted.\n\n` +
    `The request came in on another task, but the people reading that thread are the same people. Send what you have to your requester in this task's own thread instead. Only an @mention in that thread reopens it.`
  );
}

/** `#name` when a channel name is known, else the raw id. */
function formatChannelLabel(channelName: string): string {
  return channelName.startsWith('#') || /^[CGD][A-Z0-9]+$/.test(channelName) ? channelName : `#${channelName}`;
}

/** Explore-read failure → guidance (private refused / not a member). */
export function formatSlackReadError(err: unknown, channel: string): string {
  if (err instanceof PrivateChannelError) {
    return `Couldn't read ${channel}: it's a private channel or DM that isn't this task's own. Reading is limited to public channels (plus the channel this task lives in).`;
  }
  const code = slackErrorCode(err);
  if (code === 'not_in_channel' || code === 'channel_not_found') {
    return `Couldn't read ${channel}: Archie isn't a member of that public channel (or it doesn't exist). Invite it (\`/invite @Archie\`) — Archie can only read public channels it's been added to.`;
  }
  const reason = err instanceof Error ? err.message : String(err);
  return `Couldn't read ${channel}: ${reason}`;
}
