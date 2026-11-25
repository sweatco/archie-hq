// SPDX-License-Identifier: AGPL-3.0-or-later
/** What Slack shows of inputs: the panel that lists them, the Settings button, and the window it opens for an owner. */
import type { ModalView } from '@slack/web-api';
import { z } from 'zod';
import type { ConnectionStatus } from '../incoming/inputs.js';
import type { Input } from '../incoming/types.js';
import { routineDestination, unnamedConsumers, type InputListing } from './input-inventory.js';
import { triggerWhat } from './trigger-scheduler.js';

export const INPUT_ACTIONS = {
  settings: 'input_settings',
  showKey: 'input_show_key',
  checkConnection: 'input_check_connection',
  delete: 'input_delete',
} as const;

/** A message holds 50 blocks; each input takes two. */
export const PANEL_LIMIT = 20;
const USES_SHOWN = 8;

const plainText = (text: string) => ({ type: 'plain_text' as const, text });
const markdown = (text: string) => ({ type: 'mrkdwn' as const, text });

/** The button carries an id only; who may use it is decided when it is clicked. */
const settingsButton = (inputId: string) => ({
  type: 'button' as const,
  text: plainText('Settings'),
  action_id: INPUT_ACTIONS.settings,
  value: inputId,
});

/** The line that replaces an approved routine's card, with its input's Settings button. */
export function inputControlBlocks(text: string, inputId: string): unknown[] {
  return [
    { type: 'section', text: markdown(text) },
    { type: 'actions', elements: [{ ...settingsButton(inputId), style: 'primary' }] },
  ];
}

/** Slack renders this in the reader's own time zone and shows the fallback where it cannot. */
function slackTime(at: number): string {
  const fallback = new Date(at).toISOString().slice(0, 16).replace('T', ' ');
  return `<!date^${Math.floor(at / 1000)}^{date_short_pretty} at {time}|${fallback} UTC>`;
}

const inputTitle = (input: Input) => input.purpose || 'Input without a purpose';

const STATE_WORD: Record<Input['state'], string> = {
  enabled: 'Enabled',
  paused: 'Paused',
  deleted: 'Deleted',
};

function usesLines({ routines, others, hidden }: InputListing): string[] {
  const lines = [
    ...routines.map(({ id, routine }) =>
      routine
        ? `• ${triggerWhat(routine)} → ${routineDestination(routine)}${
            routine.status === 'enabled' ? '' : ` _(${routine.status})_`
          }`
        : `• A routine that no longer exists (\`${id}\`)`,
    ),
    ...others.map((other) => `• ${other.label}`),
  ];
  const shown = lines.slice(0, USES_SHOWN);
  const unnamed = hidden + lines.length - shown.length;
  if (unnamed > 0)
    shown.push(
      shown.length > 0 ? `_and ${unnamedConsumers(unnamed)}_` : `_${unnamedConsumers(unnamed)}_`,
    );
  return shown.length > 0 ? shown : ['_Nothing takes its events yet_'];
}

function panelRow(listing: InputListing): unknown {
  const { input, latest } = listing;
  const facts = [
    STATE_WORD[input.state],
    input.owner ? `owned by <@${input.owner}>` : 'managed by the operator',
    latest ? `last delivery ${slackTime(latest.receivedAt)}` : 'no delivery yet',
  ];
  return {
    type: 'section',
    text: markdown([`*${inputTitle(input)}*`, facts.join(' · '), ...usesLines(listing)].join('\n')),
    // An input without an owner is the operator's alone, so Slack offers nothing to open.
    ...(input.owner ? { accessory: settingsButton(input.id) } : {}),
  };
}

export function inputsPanelBlocks(listings: InputListing[]): unknown[] {
  const shown = listings.slice(0, PANEL_LIMIT);
  const blocks: unknown[] = [
    {
      type: 'section',
      text: markdown(`*Incoming-event inputs visible here (${listings.length})*`),
    },
  ];
  for (const listing of shown) blocks.push({ type: 'divider' }, panelRow(listing));
  if (shown.length < listings.length)
    blocks.push({
      type: 'context',
      elements: [
        markdown(
          `Showing ${shown.length} of ${listings.length}. Ask for one input by name to see it alone.`,
        ),
      ],
    });
  return blocks;
}

function describeReceipt(receipt: NonNullable<ConnectionStatus['lastReceipt']>): string {
  const what =
    receipt.outcome === 'ignored'
      ? `not acted on: ${receipt.ignoredReason === 'paused' ? 'input paused' : 'filtered out or no routine'}`
      : receipt.outcome === 'open'
        ? 'starting its routine'
        : 'handed to its routine';
  return `Last received ${slackTime(receipt.receivedAt)} · ${what}`;
}

function describeDeliveries(status: ConnectionStatus): string {
  const lines: string[] = [];
  if (!status.keyReadable) lines.push('⚠️ Key unreadable on the server');
  lines.push(status.lastReceipt ? describeReceipt(status.lastReceipt) : 'None received yet');
  if (status.lastRefusedAt !== null)
    lines.push(`Last refused ${slackTime(status.lastRefusedAt)} · bad signature or key`);
  return lines.join('\n');
}

const KEY_LABEL: Record<Input['auth'], string> = {
  standard_webhooks: '*Key* · Standard Webhooks',
  bearer: '*Key* · Bearer token',
};

/** The message a Settings window was opened from, so a deletion can change that message. */
const settingsOriginSchema = z.object({
  channel_id: z.string(),
  ts: z.string(),
  thread_ts: z.string().optional(),
});
export type SettingsOrigin = z.infer<typeof settingsOriginSchema>;

const settingsMetadataSchema = z.object({ from: settingsOriginSchema.optional() });

export function settingsOrigin(privateMetadata: string): SettingsOrigin | undefined {
  try {
    return settingsMetadataSchema.parse(JSON.parse(privateMetadata)).from;
  } catch {
    return undefined;
  }
}

export interface SettingsPanel {
  input: Input;
  from?: SettingsOrigin;
  callback: { url: string } | { path: string };
  status: ConnectionStatus;
  /** Present only after the owner asked to see it. */
  key?: string;
  /** Shown in place of the key when it could not be shown. */
  keyNotice?: string;
}

const WINDOW_TITLE = plainText('Input settings');

function routinesLeft(count: number): string {
  if (count === 0) return '';
  return count === 1
    ? ' Its routine receives nothing more.'
    : ` Its ${count} routines receive nothing more.`;
}

/**
 * The window an owner manages an input in. Slack shows a modal only to the person who opened it,
 * which is what makes it the one place a key may appear.
 */
export function settingsView(panel: SettingsPanel): ModalView {
  const { input, callback, status } = panel;
  const address = 'url' in callback ? callback.url : callback.path;
  const title = `*${inputTitle(input)}*${input.state === 'enabled' ? '' : ` · ${STATE_WORD[input.state]}`}`;
  return {
    type: 'modal',
    title: WINDOW_TITLE,
    close: plainText('Close'),
    private_metadata: JSON.stringify({ input_id: input.id, from: panel.from }),
    blocks: [
      { type: 'section', text: markdown(title) },
      { type: 'section', text: markdown(`*Callback URL*\n\`${address}\``) },
      panel.key
        ? { type: 'section', text: markdown(`${KEY_LABEL[input.auth]}\n\`${panel.key}\``) }
        : {
            type: 'section',
            text: markdown(`${KEY_LABEL[input.auth]}\n${panel.keyNotice ?? '••••••••••••••••'}`),
            accessory: {
              type: 'button',
              text: plainText('Show key'),
              action_id: INPUT_ACTIONS.showKey,
              value: input.id,
            },
          },
      {
        type: 'section',
        text: markdown(`*Deliveries*\n${describeDeliveries(status)}`),
        accessory: {
          type: 'button',
          text: plainText('Check again'),
          action_id: INPUT_ACTIONS.checkConnection,
          value: input.id,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: plainText('Delete'),
            action_id: INPUT_ACTIONS.delete,
            value: input.id,
            style: 'danger',
            confirm: {
              title: plainText('Delete this input?'),
              text: plainText(
                `“${inputTitle(input)}” stops accepting deliveries.${routinesLeft(
                  input.routines.length,
                )} This cannot be undone.`,
              ),
              confirm: plainText('Delete'),
              deny: plainText('Cancel'),
              style: 'danger',
            },
          },
        ],
      },
    ],
  };
}

export function settingsNoticeView(notice: string): ModalView {
  return {
    type: 'modal',
    title: WINDOW_TITLE,
    close: plainText('Close'),
    blocks: [{ type: 'section', text: markdown(notice) }],
  };
}

export function deletedNotice(input: Input): string {
  return `🗑️ *${inputTitle(input)}* was deleted.`;
}

const settingsButtonSchema = z
  .object({ action_id: z.literal(INPUT_ACTIONS.settings), value: z.string() })
  .passthrough();
const panelRowSchema = z
  .object({
    type: z.literal('section'),
    text: z.object({ text: z.string() }).passthrough(),
    accessory: settingsButtonSchema,
  })
  .passthrough();
const buttonRowSchema = z
  .object({ type: z.literal('actions'), elements: z.array(z.unknown()) })
  .passthrough();

/** Null when the message offers nothing for that input. */
export function withInputDeleted(blocks: unknown[], inputId: string): unknown[] | null {
  const opensSettings = (element: unknown) => {
    const button = settingsButtonSchema.safeParse(element);
    return button.success && button.data.value === inputId;
  };
  let changed = false;
  const kept = blocks.flatMap((block): unknown[] => {
    const row = panelRowSchema.safeParse(block);
    if (row.success && row.data.accessory.value === inputId) {
      changed = true;
      const [title = ''] = row.data.text.text.split('\n');
      return [{ type: 'section', text: markdown(`🗑️ ~${title.replaceAll('*', '')}~ · deleted`) }];
    }
    const buttons = buttonRowSchema.safeParse(block);
    if (buttons.success && buttons.data.elements.some(opensSettings)) {
      changed = true;
      const elements = buttons.data.elements.filter((element) => !opensSettings(element));
      return elements.length > 0 ? [{ ...buttons.data, elements }] : [];
    }
    return [block];
  });
  return changed ? kept : null;
}
