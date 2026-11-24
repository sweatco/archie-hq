// SPDX-License-Identifier: AGPL-3.0-or-later
/** What the owner of an input sees in Slack: the button under an approved routine, and the window it opens. */
import type { ModalView } from '@slack/web-api';
import type { ConnectionStatus } from '../incoming/inputs.js';
import type { Input } from '../incoming/types.js';

export const INPUT_ACTIONS = {
  connect: 'input_connect',
  showKey: 'input_show_key',
  checkConnection: 'input_check_connection',
} as const;

const plainText = (text: string) => ({ type: 'plain_text' as const, text });
const markdown = (text: string) => ({ type: 'mrkdwn' as const, text });

/**
 * The line that replaces an approved routine's card, with the owner's next step as a button.
 * The button carries an id only; who may use it is decided when it is clicked.
 */
export function inputControlBlocks(text: string, inputId: string): unknown[] {
  return [
    { type: 'section', text: markdown(text) },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: plainText('Connect a sender'),
          action_id: INPUT_ACTIONS.connect,
          value: inputId,
          style: 'primary',
        },
      ],
    },
  ];
}

/** Slack renders this in the reader's own time zone and shows the fallback where it cannot. */
function slackTime(at: number): string {
  const fallback = new Date(at).toISOString().slice(0, 16).replace('T', ' ');
  return `<!date^${Math.floor(at / 1000)}^{date_short_pretty} at {time}|${fallback} UTC>`;
}

function describeReceipt(receipt: NonNullable<ConnectionStatus['lastReceipt']>): string {
  const received = `Last delivery received: ${slackTime(receipt.receivedAt)}.`;
  if (receipt.outcome === 'ignored')
    return `${received} It authenticated and was not acted on: ${
      receipt.ignoredReason === 'paused'
        ? 'the input was paused'
        : 'a filter excluded it, or no routine was taking events'
    }.`;
  return `${received} It authenticated and was ${
    receipt.outcome === 'open' ? 'accepted; its routine is starting' : 'handed to its routine'
  }.`;
}

function describeConnection(status: ConnectionStatus): string {
  const lines: string[] = [];
  if (!status.keyReadable)
    lines.push('⚠️ The key cannot be read on the server, so no delivery can authenticate.');
  lines.push(
    status.lastReceipt ? describeReceipt(status.lastReceipt) : 'No delivery has been received yet.',
  );
  lines.push(
    status.lastRefusedAt === null
      ? 'No delivery has been refused since Archie last started.'
      : `Last delivery refused: ${slackTime(status.lastRefusedAt)}. Its signature or key did not verify.`,
  );
  return lines.join('\n');
}

const HOW_TO_SEND: Record<Input['auth'], string> = {
  standard_webhooks:
    'Sign each delivery with the Standard Webhooks headers `webhook-id`, `webhook-timestamp` and `webhook-signature`, using the key below.',
  bearer:
    'Send the key below as `Authorization: Bearer <key>`. Add an `Idempotency-Key` header to make retries safe.',
};

export interface ConnectPanel {
  input: Input;
  callback: { url: string } | { path: string };
  status: ConnectionStatus;
  /** Present only after the owner asked to see it. */
  key?: string;
  /** Shown in place of the key when it could not be shown. */
  keyNotice?: string;
}

/**
 * The window that tells an owner how to connect a sender. Slack shows a modal only to the person who opened it,
 * which is what makes it the one place a key may appear.
 */
export function connectView(panel: ConnectPanel): ModalView {
  const { input, callback, status } = panel;
  const address = 'url' in callback ? callback.url : callback.path;
  const blocks: ModalView['blocks'] = [
    { type: 'section', text: markdown(`*Callback URL*\n\`${address}\``) },
    { type: 'section', text: markdown(`*How to send*\n${HOW_TO_SEND[input.auth]}`) },
  ];
  if (panel.key) {
    blocks.push(
      { type: 'section', text: markdown(`*Key*\n\`${panel.key}\``) },
      {
        type: 'context',
        elements: [markdown('Shown only to you, in this window. Put it into the sender now.')],
      },
    );
  } else {
    blocks.push({
      type: 'section',
      text: markdown(`*Key*\n${panel.keyNotice ?? '••••••••••••••••'}`),
      accessory: {
        type: 'button',
        text: plainText('Show key'),
        action_id: INPUT_ACTIONS.showKey,
        value: input.id,
      },
    });
  }
  blocks.push(
    { type: 'divider' },
    {
      type: 'section',
      text: markdown(`*Connection*\n${describeConnection(status)}`),
      accessory: {
        type: 'button',
        text: plainText('Check again'),
        action_id: INPUT_ACTIONS.checkConnection,
        value: input.id,
      },
    },
    {
      type: 'context',
      elements: [
        markdown(
          'To test a sender without starting a run, pause the routine first. Deliveries are still recorded here.',
        ),
      ],
    },
  );
  return {
    type: 'modal',
    title: plainText('Connect a sender'),
    close: plainText('Close'),
    private_metadata: JSON.stringify({ input_id: input.id }),
    blocks,
  };
}
