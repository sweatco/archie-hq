/**
 * Builds requests that carry a valid Slack signature, for synthetic interactions against a
 * test instance running the HTTP receiver.
 *
 * Whoever holds an instance's signing secret can make it believe any Slack event. That is why
 * the secret must belong to a test instance only, and why evidence labels these requests as
 * synthetic: they prove the handler's checks, not that Slack delivered anything.
 */

import { createHmac } from 'crypto';

export interface SignedSlackRequest {
  headers: Record<string, string>;
  body: string;
}

/** Slack's v0 scheme: HMAC-SHA256 over `v0:<timestamp>:<raw body>`. */
export function slackSignature(
  signingSecret: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  const digest = createHmac('sha256', signingSecret)
    .update(`v0:${timestampSeconds}:${rawBody}`)
    .digest('hex');
  return `v0=${digest}`;
}

function signedRequest(
  signingSecret: string,
  timestampSeconds: number,
  contentType: string,
  body: string,
): SignedSlackRequest {
  return {
    headers: {
      'content-type': contentType,
      'x-slack-request-timestamp': String(timestampSeconds),
      'x-slack-signature': slackSignature(signingSecret, timestampSeconds, body),
    },
    body,
  };
}

/** An Events API delivery, which Slack sends as JSON. */
export function signedEventRequest(
  signingSecret: string,
  timestampSeconds: number,
  event: unknown,
): SignedSlackRequest {
  return signedRequest(signingSecret, timestampSeconds, 'application/json', JSON.stringify(event));
}

/** An interactivity delivery, which Slack sends as a form with one `payload` field. */
export function signedInteractionRequest(
  signingSecret: string,
  timestampSeconds: number,
  interaction: unknown,
): SignedSlackRequest {
  const body = new URLSearchParams({ payload: JSON.stringify(interaction) }).toString();
  return signedRequest(signingSecret, timestampSeconds, 'application/x-www-form-urlencoded', body);
}

export interface ButtonClick {
  teamId: string;
  userId: string;
  channelId: string;
  messageTs: string;
  /** The thread the message sits in, which handlers use to place their own replies. */
  threadTs?: string;
  actionId: string;
  value?: string;
}

/** The `block_actions` payload Slack sends when a member presses a button on a message. */
export function buttonClickInteraction(click: ButtonClick, nowSeconds: number): unknown {
  return {
    type: 'block_actions',
    team: { id: click.teamId },
    user: { id: click.userId, team_id: click.teamId },
    channel: { id: click.channelId },
    container: { type: 'message', channel_id: click.channelId, message_ts: click.messageTs },
    message: {
      type: 'message',
      ts: click.messageTs,
      ...(click.threadTs ? { thread_ts: click.threadTs } : {}),
    },
    actions: [
      {
        type: 'button',
        action_id: click.actionId,
        block_id: 'persona-synthetic',
        value: click.value ?? '',
        action_ts: `${nowSeconds}.000000`,
      },
    ],
    trigger_id: `synthetic.${nowSeconds}`,
    response_url: '',
  };
}
