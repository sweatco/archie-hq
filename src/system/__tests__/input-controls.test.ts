// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Slack controls of an input, through the handlers Bolt would call.
 * The inbox file and the vault are real; Slack is stubbed.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { App } from '@slack/bolt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { system: vi.fn(), error: vi.fn(), warn: vi.fn(), plain: vi.fn() },
}));

const slack = vi.hoisted(() => ({
  open: vi.fn(),
  update: vi.fn(),
  postEphemeral: vi.fn(),
  members: new Set<string>(),
}));
vi.mock('../../connectors/slack/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../connectors/slack/client.js')>();
  return {
    ...actual,
    getSlackClient: () => ({ views: { open: slack.open, update: slack.update } }),
    getUserInfo: vi.fn((userId: string) => Promise.resolve({ id: userId })),
    isInternalMemoryUser: vi.fn((user: { id: string }) => slack.members.has(user.id)),
    postEphemeral: slack.postEphemeral,
  };
});

import { setInputServices } from '../../incoming/access.js';
import { createInput } from '../../incoming/inputs.js';
import { noteRefusedDelivery } from '../../incoming/refusals.js';
import { vaultInputSecrets, type InputSecrets } from '../../incoming/secrets.js';
import { IncomingStore } from '../../incoming/store.js';
import type { Input } from '../../incoming/types.js';
import { registerInputControlHandlers } from '../input-controls.js';
import { logger } from '../logger.js';

type Handler = (args: Record<string, unknown>) => Promise<void>;
const actions = new Map<string, Handler>();

let root: string;
let store: IncomingStore;
let secrets: InputSecrets;
let input: Input;
let secret: string;

/** A click on a button under the approved card, in the routine's thread. */
function clickCard(actionId: string, value: string, userId: string): Promise<void> {
  const handler = actions.get(actionId);
  if (!handler) throw new Error(`${actionId} was never registered`);
  return handler({
    ack: vi.fn().mockResolvedValue(undefined),
    action: { action_id: actionId, value },
    body: {
      user: { id: userId },
      trigger_id: 'trigger-1',
      channel: { id: 'C0NOTES' },
      message: { ts: '1795530322.348299', thread_ts: '1795530309.733459' },
    },
  });
}

/** A click on a button inside the Connect window. */
function clickWindow(actionId: string, value: string, userId: string): Promise<void> {
  const handler = actions.get(actionId);
  if (!handler) throw new Error(`${actionId} was never registered`);
  return handler({
    ack: vi.fn().mockResolvedValue(undefined),
    action: { action_id: actionId, value },
    body: { user: { id: userId }, trigger_id: 'trigger-2', view: { id: 'V0CONNECT', hash: 'h1' } },
  });
}

const shown = (call: unknown) => JSON.stringify(call);

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('ARCHIE_SECRETS_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('ARCHIE_PUBLIC_URL', 'https://archie.example.test');
  slack.open.mockResolvedValue({ ok: true });
  slack.update.mockResolvedValue({ ok: true });
  slack.postEphemeral.mockResolvedValue(undefined);
  slack.members = new Set(['U0DANA', 'U0EVE']);
  actions.clear();
  registerInputControlHandlers({
    action: (id: string, handler: Handler) => actions.set(id, handler),
  } as unknown as Pick<App, 'action'>);

  root = mkdtempSync(join(tmpdir(), 'archie-input-controls-'));
  store = new IncomingStore(join(root, 'state.sqlite'));
  secrets = vaultInputSecrets(join(root, 'secrets'));
  setInputServices({ store, secrets });
  ({ input, secret } = await createInput(
    { store, secrets },
    { auth: 'standard_webhooks', owner: 'U0DANA', purpose: 'Meetings' },
  ));
});
afterEach(() => {
  setInputServices(null);
  store.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('Connect a sender', () => {
  it('opens the window for the owner, with the callback URL and without the key', async () => {
    await clickCard('input_connect', input.id, 'U0DANA');

    expect(slack.open).toHaveBeenCalledOnce();
    const [opened] = slack.open.mock.calls[0] as [{ trigger_id: string; view: unknown }];
    expect(opened.trigger_id).toBe('trigger-1');
    expect(shown(opened.view)).toContain(
      `https://archie.example.test/webhooks/incoming/${input.id}`,
    );
    expect(shown(opened.view)).not.toContain(secret);
    expect(slack.postEphemeral).not.toHaveBeenCalled();
  });

  it('tells anyone else who owns the input, only them, and opens nothing', async () => {
    await clickCard('input_connect', input.id, 'U0EVE');

    expect(slack.open).not.toHaveBeenCalled();
    expect(slack.postEphemeral).toHaveBeenCalledWith(
      'C0NOTES',
      'U0EVE',
      'Only <@U0DANA>, who owns this input, can do that.',
      '1795530309.733459',
    );
  });

  it('leaves an operator-made input to the operator', async () => {
    const { input: operators } = await createInput({ store, secrets }, { auth: 'bearer' });

    await clickCard('input_connect', operators.id, 'U0DANA');

    expect(slack.open).not.toHaveBeenCalled();
    expect(slack.postEphemeral.mock.calls[0]?.[2]).toMatch(/managed by the operator/);
  });

  it('says so when the window cannot be opened', async () => {
    slack.open.mockRejectedValue(new Error('expired_trigger_id'));

    await clickCard('input_connect', input.id, 'U0DANA');

    expect(logger.error).toHaveBeenCalled();
    expect(slack.postEphemeral.mock.calls[0]?.[2]).toBe(
      'That could not be done. Please try again.',
    );
  });
});

describe('Show key', () => {
  it('redraws the window with the key for the owner', async () => {
    await clickWindow('input_show_key', input.id, 'U0DANA');

    expect(slack.update).toHaveBeenCalledOnce();
    const [updated] = slack.update.mock.calls[0] as [
      { view_id: string; hash: string; view: unknown },
    ];
    expect(updated).toMatchObject({ view_id: 'V0CONNECT', hash: 'h1' });
    expect(shown(updated.view)).toContain(secret);
  });

  it('keeps the key from an owner who is no longer a member of the workspace', async () => {
    slack.members.delete('U0DANA');

    await clickWindow('input_show_key', input.id, 'U0DANA');

    expect(shown(slack.update.mock.calls)).not.toContain(secret);
    expect(shown(slack.update.mock.calls)).toContain('can be shown only to the owner');
  });

  it('answers a click from anyone else with nothing at all', async () => {
    await clickWindow('input_show_key', input.id, 'U0EVE');

    expect(slack.update).not.toHaveBeenCalled();
    expect(slack.open).not.toHaveBeenCalled();
  });

  it('never puts the key in a log line', async () => {
    await clickWindow('input_show_key', input.id, 'U0DANA');

    expect(shown(vi.mocked(logger.system).mock.calls)).not.toContain(secret);
    expect(shown(vi.mocked(logger.system).mock.calls)).toContain('showed its key to its owner');
  });
});

describe('Check again', () => {
  it('redraws the window with what Archie holds now, and the key masked', async () => {
    noteRefusedDelivery(input.id, 1_800_000_060_000);

    await clickWindow('input_check_connection', input.id, 'U0DANA');

    const [updated] = slack.update.mock.calls[0] as [{ view: unknown }];
    expect(shown(updated.view)).toContain('Last delivery refused');
    expect(shown(updated.view)).not.toContain(secret);
  });
});
