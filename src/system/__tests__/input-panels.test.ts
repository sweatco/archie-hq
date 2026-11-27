// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { ConnectionStatus } from '../../incoming/inputs.js';
import type { Input } from '../../incoming/types.js';
import { expectDefined } from '../../test-support/assertions.js';
import type { Trigger } from '../../types/trigger.js';
import type { InputListing } from '../input-inventory.js';
import {
  deletedNotice,
  inputControlBlocks,
  inputsPanelBlocks,
  PANEL_LIMIT,
  settingsNoticeView,
  settingsOrigin,
  settingsView,
  withInputDeleted,
  withInputState,
} from '../input-panels.js';

const INPUT: Input = {
  id: 'inp-AAAAAAAAAAAAAAAAAAAAAA',
  state: 'enabled',
  auth: 'standard_webhooks',
  secretRefs: ['sec-1'],
  filter: [],
  routines: ['trg-20261124-0900-notes1'],
  revision: 2,
  owner: 'U0DANA',
  purpose: 'Meeting recordings',
};
const QUIET: ConnectionStatus = { keyReadable: true, lastReceipt: null, lastRefusedAt: null };
const CALLBACK = {
  url: 'https://archie.example.test/webhooks/incoming/inp-AAAAAAAAAAAAAAAAAAAAAA',
};
const KEY = 'whsec_c2VjcmV0LWtleS1mb3ItYS10ZXN0LW9ubHk=';

const text = (value: unknown) => JSON.stringify(value);

describe('the button under an approved routine', () => {
  it('carries an id only', () => {
    const blocks = inputControlBlocks('Approved.', INPUT.id);

    const actions = blocks.at(-1) as { elements: Array<{ action_id: string; value: string }> };
    expect(actions.elements.map((button) => [button.action_id, button.value])).toEqual([
      ['input_settings', INPUT.id],
    ]);
    expect(text(blocks)).toContain('Approved.');
  });
});

describe('the Settings window', () => {
  it('shows the callback URL and the kind of key, and keeps the key masked', () => {
    const shown = text(settingsView({ input: INPUT, callback: CALLBACK, status: QUIET }));

    expect(shown).toContain(CALLBACK.url);
    expect(shown).toContain('*Key* · Standard Webhooks');
    expect(shown).toContain('input_show_key');
    expect(shown).not.toContain(KEY);
  });

  it('shows the key once the owner asked for it, and offers no second reveal', () => {
    const shown = text(settingsView({ input: INPUT, callback: CALLBACK, status: QUIET, key: KEY }));

    expect(shown).toContain(KEY);
    expect(shown).not.toContain('input_show_key');
  });

  it('keeps the key out of what Slack sends back with a click', () => {
    const view = settingsView({ input: INPUT, callback: CALLBACK, status: QUIET, key: KEY });

    expect(view.private_metadata).toBe(JSON.stringify({ input_id: INPUT.id }));
    expect(text(view.blocks.filter((block) => block.type === 'actions'))).not.toContain(KEY);
  });

  it('names a bearer key as a token', () => {
    const shown = text(
      settingsView({ input: { ...INPUT, auth: 'bearer' }, callback: CALLBACK, status: QUIET }),
    );

    expect(shown).toContain('*Key* · Bearer token');
  });

  it('gives the path when the deployment has no public URL configured', () => {
    const shown = text(
      settingsView({
        input: INPUT,
        callback: { path: '/webhooks/incoming/inp-AAAAAAAAAAAAAAAAAAAAAA' },
        status: QUIET,
      }),
    );

    expect(shown).toContain('`/webhooks/incoming/inp-AAAAAAAAAAAAAAAAAAAAAA`');
  });

  it.each<[string, ConnectionStatus, RegExp]>([
    ['nothing yet', QUIET, /\*Deliveries\*\\nNone received yet"/],
    [
      'an accepted delivery',
      {
        ...QUIET,
        lastReceipt: {
          receivedAt: 1_800_000_000_000,
          outcome: 'closed',
          ignoredReason: null,
        },
      },
      /Last received <!date\^1800000000\^.* · handed to its routine/,
    ],
    [
      'a delivery that authenticated while the routine was paused',
      {
        ...QUIET,
        lastReceipt: {
          receivedAt: 1_800_000_000_000,
          outcome: 'ignored',
          ignoredReason: 'filtered',
        },
      },
      /not acted on: filtered out or no routine/,
    ],
    [
      'a refused delivery',
      { ...QUIET, lastRefusedAt: 1_800_000_060_000 },
      /Last refused <!date\^1800000060\^.* · bad signature or key/,
    ],
    ['an unreadable key', { ...QUIET, keyReadable: false }, /Key unreadable on the server/],
  ])('reports %s', (_name, status, expected) => {
    expect(text(settingsView({ input: INPUT, callback: CALLBACK, status }))).toMatch(expected);
  });

  it('holds the name, the callback URL, the key, the deliveries and Delete, and nothing else', () => {
    const view = settingsView({ input: INPUT, callback: CALLBACK, status: QUIET });

    expect(view.blocks.map((block) => block.type)).toEqual([
      'section',
      'section',
      'section',
      'section',
      'actions',
    ]);
    expect(text(view.blocks[0])).toContain('"*Meeting recordings*"');
  });

  it('says so in the name line when the input is paused', () => {
    const view = settingsView({
      input: { ...INPUT, state: 'paused' },
      callback: CALLBACK,
      status: QUIET,
    });

    expect(text(view.blocks[0])).toContain('*Meeting recordings* · ⏸️ Paused');
    expect(text(view.blocks.at(-1))).toContain('input_resume');
    expect(text(view.blocks.at(-1))).not.toContain('input_pause');
  });

  it('offers Delete behind a confirmation that says what stops', () => {
    const view = settingsView({ input: INPUT, callback: CALLBACK, status: QUIET });

    const last = view.blocks.at(-1);
    const [pause, rotate, remove] = last && 'elements' in last ? last.elements : [];
    expect(pause).toMatchObject({ action_id: 'input_pause', value: INPUT.id });
    expect(rotate).toMatchObject({ action_id: 'input_rotate_key', value: INPUT.id });
    expect(text(rotate)).toContain('The current key stops working at once.');
    expect(remove).toMatchObject({ action_id: 'input_delete', value: INPUT.id, style: 'danger' });
    expect(text(remove)).toContain('Delete this input?');
    expect(text(remove)).toContain(
      '“Meeting recordings” stops accepting deliveries. Its routine receives nothing more. This cannot be undone.',
    );
  });

  it('becomes a plain notice once the input is deleted', () => {
    const view = settingsNoticeView(deletedNotice({ ...INPUT, routines: [] }));

    expect(text(view.blocks)).toContain('*Meeting recordings* was deleted.');
    expect(text(view)).not.toContain('action_id');
  });
});

describe('the inputs panel', () => {
  const NOTES: Trigger = {
    id: 'trg-20261124-0900-notes1',
    status: 'enabled',
    created_by: 'U0DANA',
    created_at: '2026-11-24T09:00:00.000Z',
    binding: { type: 'channel', channel_id: 'C0NOTES', channel_name: 'notes' },
    conditions: [{ type: 'incoming_event', input_id: INPUT.id }],
    action: { prompt: 'Summarize the meeting.' },
    summary: 'Meeting notes',
  };
  const listing = (changes: Partial<InputListing> = {}): InputListing => ({
    input: INPUT,
    routines: [{ id: NOTES.id, routine: NOTES }],
    hidden: 0,
    latest: null,
    ...changes,
  });
  const rows = (blocks: unknown[]) =>
    blocks.filter(
      (block): block is { type: 'section'; text: { text: string }; accessory?: unknown } =>
        (block as { type: string }).type === 'section',
    );

  it('gives each input a row with its state, owner, routines and a Settings button', () => {
    const [, row] = rows(inputsPanelBlocks([listing()]));

    expect(row?.text.text).toBe(
      '*Meeting recordings*\nEnabled · owned by <@U0DANA> · no delivery yet\n• Meeting notes → #notes',
    );
    expect(row?.accessory).toMatchObject({ action_id: 'input_settings', value: INPUT.id });
  });

  it('marks a routine that is not enabled and counts what stays unnamed', () => {
    const [, row] = rows(
      inputsPanelBlocks([
        listing({
          routines: [{ id: NOTES.id, routine: { ...NOTES, status: 'paused' } }],
          hidden: 2,
        }),
      ]),
    );

    expect(row?.text.text).toContain('• Meeting notes → #notes _(paused)_');
    expect(row?.text.text).toContain('_and 2 other routines not visible from here_');
  });

  it("says so when nothing takes an input's events", () => {
    const [, row] = rows(inputsPanelBlocks([listing({ routines: [] })]));

    expect(row?.text.text).toContain('_Nothing takes its events yet_');
  });

  it('offers no Settings button on an input the operator manages', () => {
    const [, row] = rows(inputsPanelBlocks([listing({ input: { ...INPUT, owner: null } })]));

    expect(row?.text.text).toContain('managed by the operator');
    expect(row?.accessory).toBeUndefined();
  });

  it("shows the last delivery in the reader's time zone", () => {
    const latest = { receivedAt: 1_800_000_000_000 } as InputListing['latest'];

    const [, row] = rows(inputsPanelBlocks([listing({ latest })]));

    expect(row?.text.text).toMatch(/last delivery <!date\^1800000000\^/);
  });

  it('never shows a key, an address or an input id outside a button', () => {
    const shown = text(inputsPanelBlocks([listing()]));

    expect(shown).not.toContain('/webhooks/');
    expect(shown.split(INPUT.id)).toHaveLength(2);
  });

  it('stays within what one Slack message holds and says how many are left out', () => {
    const many = Array.from({ length: PANEL_LIMIT + 5 }, () => listing());

    const blocks = inputsPanelBlocks(many);

    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(rows(blocks)).toHaveLength(PANEL_LIMIT + 1);
    expect(text(blocks.at(-1))).toContain(`Showing ${PANEL_LIMIT} of ${PANEL_LIMIT + 5}`);
  });

  it('turns the row of a deleted input into a note and keeps the other rows', () => {
    const other = { ...INPUT, id: 'inp-BBBBBBBBBBBBBBBBBBBBBB', purpose: 'Lead forms' };
    const blocks = inputsPanelBlocks([listing(), listing({ input: other })]);

    const after = rows(expectDefined(withInputDeleted(blocks, INPUT.id)));

    expect(after).toHaveLength(3);
    expect(after[1]).toEqual({
      type: 'section',
      text: { type: 'mrkdwn', text: '🗑️ ~Meeting recordings~ · deleted' },
    });
    expect(after[2]?.accessory).toMatchObject({ action_id: 'input_settings', value: other.id });
  });
});

describe('a panel row after its input is paused', () => {
  it('shows the new state and keeps the rest of the row', () => {
    const listing = { input: INPUT, routines: [], hidden: 0, latest: null };
    const blocks = inputsPanelBlocks([listing]);

    const after = text(withInputState(blocks, { ...INPUT, state: 'paused' }));

    expect(after).toContain(
      '*Meeting recordings*\\n⏸️ Paused · owned by <@U0DANA> · no delivery yet',
    );
    expect(after).toContain('input_settings');
    expect(withInputState(blocks, { ...INPUT, id: 'inp-other' })).toBeNull();
  });

  it('shows Enabled again after a resume, though Slack names the emoji', () => {
    const row = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Meeting recordings*\n:double_vertical_bar: Paused · owned by <@U0DANA>',
      },
      accessory: { type: 'button', action_id: 'input_settings', value: INPUT.id },
    };

    expect(text(withInputState([row], INPUT))).toContain(
      '*Meeting recordings*\\nEnabled · owned by <@U0DANA>',
    );
  });
});

describe('a message that outlives its input', () => {
  it('loses the button under an approved routine and keeps its line', () => {
    const after = withInputDeleted(inputControlBlocks('Approved.', INPUT.id), INPUT.id);

    expect(after).toEqual([{ type: 'section', text: { type: 'mrkdwn', text: 'Approved.' } }]);
  });

  it('is left as it is when it offers nothing for that input', () => {
    expect(withInputDeleted(inputControlBlocks('Approved.', INPUT.id), 'inp-other')).toBeNull();
    expect(withInputDeleted([{ type: 'divider' }, 'not a block'], INPUT.id)).toBeNull();
  });
});

describe('where a Settings window was opened from', () => {
  const from = { channel_id: 'C0NOTES', ts: '1795530322.348299', thread_ts: '1795530309.733459' };

  it('travels in the window and is read back', () => {
    const view = settingsView({ input: INPUT, callback: CALLBACK, status: QUIET, from });

    expect(settingsOrigin(view.private_metadata ?? '')).toEqual(from);
  });

  it('is absent for a window opened from nowhere, or with metadata that is not ours', () => {
    const view = settingsView({ input: INPUT, callback: CALLBACK, status: QUIET });

    expect(settingsOrigin(view.private_metadata ?? '')).toBeUndefined();
    expect(settingsOrigin('not json')).toBeUndefined();
  });
});
