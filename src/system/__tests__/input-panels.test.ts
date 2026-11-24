// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { ConnectionStatus } from '../../incoming/inputs.js';
import type { Input } from '../../incoming/types.js';
import { connectView, inputControlBlocks } from '../input-panels.js';

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
      ['input_connect', INPUT.id],
    ]);
    expect(text(blocks)).toContain('Approved.');
  });
});

describe('the Connect window', () => {
  it('shows the callback URL and how to sign, and keeps the key masked', () => {
    const shown = text(connectView({ input: INPUT, callback: CALLBACK, status: QUIET }));

    expect(shown).toContain(CALLBACK.url);
    expect(shown).toContain('webhook-signature');
    expect(shown).toContain('input_show_key');
    expect(shown).not.toContain(KEY);
  });

  it('shows the key once the owner asked for it, and offers no second reveal', () => {
    const shown = text(connectView({ input: INPUT, callback: CALLBACK, status: QUIET, key: KEY }));

    expect(shown).toContain(KEY);
    expect(shown).toContain('Shown only to you');
    expect(shown).not.toContain('input_show_key');
  });

  it('keeps the key out of what Slack sends back with a click', () => {
    const view = connectView({ input: INPUT, callback: CALLBACK, status: QUIET, key: KEY });

    expect(view.private_metadata).toBe(JSON.stringify({ input_id: INPUT.id }));
    expect(text(view.blocks.filter((block) => block.type === 'actions'))).not.toContain(KEY);
  });

  it('tells a bearer sender to send the key as a token', () => {
    const shown = text(
      connectView({ input: { ...INPUT, auth: 'bearer' }, callback: CALLBACK, status: QUIET }),
    );

    expect(shown).toContain('Authorization: Bearer');
  });

  it('gives the path when the deployment has no public URL configured', () => {
    const shown = text(
      connectView({
        input: INPUT,
        callback: { path: '/webhooks/incoming/inp-AAAAAAAAAAAAAAAAAAAAAA' },
        status: QUIET,
      }),
    );

    expect(shown).toContain('`/webhooks/incoming/inp-AAAAAAAAAAAAAAAAAAAAAA`');
  });

  it.each<[string, ConnectionStatus, RegExp]>([
    ['nothing yet', QUIET, /No delivery has been received yet/],
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
      /Last delivery received: <!date\^1800000000\^.*handed to its routine/,
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
      /authenticated and was not acted on: a filter excluded it, or no routine was taking events/,
    ],
    [
      'a refused delivery',
      { ...QUIET, lastRefusedAt: 1_800_000_060_000 },
      /Last delivery refused: <!date\^1800000060\^.*did not verify/,
    ],
    ['an unreadable key', { ...QUIET, keyReadable: false }, /key cannot be read on the server/],
  ])('reports %s', (_name, status, expected) => {
    expect(text(connectView({ input: INPUT, callback: CALLBACK, status }))).toMatch(expected);
  });
});
