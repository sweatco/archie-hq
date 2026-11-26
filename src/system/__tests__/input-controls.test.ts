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
  fetchMessage: vi.fn(),
  updateMessage: vi.fn(),
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
    fetchMessage: slack.fetchMessage,
    updateMessage: slack.updateMessage,
  };
});

import { setInputServices } from '../../incoming/access.js';
import { createInput, deleteInput } from '../../incoming/inputs.js';
import { noteRefusedDelivery } from '../../incoming/refusals.js';
import { vaultInputSecrets, type InputSecrets } from '../../incoming/secrets.js';
import { IncomingStore } from '../../incoming/store.js';
import type { Input } from '../../incoming/types.js';
import { registerInputControlHandlers } from '../input-controls.js';
import { inputsPanelBlocks } from '../input-panels.js';
import { logger } from '../logger.js';

type Handler = (args: Record<string, unknown>) => Promise<void>;
const actions = new Map<string, Handler>();

let root: string;
let store: IncomingStore;
let secrets: InputSecrets;
let input: Input;
let secret: string;

const PANEL = { channel_id: 'C0NOTES', ts: '1795530322.348299', thread_ts: '1795530309.733459' };

/** A click on a button under the approved card, in the routine's thread. */
function clickCard(
  actionId: string,
  value: string,
  userId: string,
  blocks: unknown[] = [],
): Promise<void> {
  const handler = actions.get(actionId);
  if (!handler) throw new Error(`${actionId} was never registered`);
  return handler({
    ack: vi.fn().mockResolvedValue(undefined),
    action: { action_id: actionId, value },
    body: {
      user: { id: userId },
      trigger_id: 'trigger-1',
      channel: { id: PANEL.channel_id },
      message: { ts: PANEL.ts, thread_ts: PANEL.thread_ts, text: 'Inputs', blocks },
    },
  });
}

const panel = () => inputsPanelBlocks([{ input, routines: [], hidden: 0, latest: null }]);

/** A click on a button inside the Settings window. */
function clickWindow(
  actionId: string,
  value: string,
  userId: string,
  metadata: object = { input_id: value, from: PANEL },
): Promise<void> {
  const handler = actions.get(actionId);
  if (!handler) throw new Error(`${actionId} was never registered`);
  return handler({
    ack: vi.fn().mockResolvedValue(undefined),
    action: { action_id: actionId, value },
    body: {
      user: { id: userId },
      trigger_id: 'trigger-2',
      view: { id: 'V0SETTINGS', hash: 'h1', private_metadata: JSON.stringify(metadata) },
    },
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
  slack.fetchMessage.mockResolvedValue(null);
  slack.updateMessage.mockResolvedValue(undefined);
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

describe('Settings', () => {
  it('opens the window for the owner, with the callback URL and without the key', async () => {
    await clickCard('input_settings', input.id, 'U0DANA');

    expect(slack.open).toHaveBeenCalledOnce();
    const [opened] = slack.open.mock.calls[0] as [{ trigger_id: string; view: unknown }];
    expect(opened.trigger_id).toBe('trigger-1');
    expect(shown(opened.view)).toContain(
      `https://archie.example.test/webhooks/incoming/${input.id}`,
    );
    expect(shown(opened.view)).not.toContain(secret);
    expect(slack.postEphemeral).not.toHaveBeenCalled();
  });

  it('remembers the message it was opened from, through a redraw too', async () => {
    await clickCard('input_settings', input.id, 'U0DANA');
    await clickWindow('input_check_connection', input.id, 'U0DANA');

    const [opened] = slack.open.mock.calls[0] as [{ view: { private_metadata: string } }];
    const [redrawn] = slack.update.mock.calls[0] as [{ view: { private_metadata: string } }];
    expect(JSON.parse(opened.view.private_metadata)).toEqual({ input_id: input.id, from: PANEL });
    expect(redrawn.view.private_metadata).toBe(opened.view.private_metadata);
  });

  it('takes the button of a deleted input out of the message it was clicked in', async () => {
    const blocks = panel();
    await deleteInput({ store, secrets }, input.id);

    await clickCard('input_settings', input.id, 'U0DANA', blocks);

    expect(slack.open).not.toHaveBeenCalled();
    expect(slack.postEphemeral.mock.calls[0]?.[2]).toBe('This input no longer exists.');
    const [channel, ts, text, retired] = slack.updateMessage.mock.calls[0] as [
      string,
      string,
      string,
      unknown[],
    ];
    expect([channel, ts, text]).toEqual([PANEL.channel_id, PANEL.ts, 'Inputs']);
    expect(shown(retired)).toContain('~Meetings~ · deleted');
    expect(shown(retired)).not.toContain('input_settings');
  });

  it('leaves the message alone when the person clicking does not own the input', async () => {
    await clickCard('input_settings', input.id, 'U0EVE', panel());

    expect(slack.updateMessage).not.toHaveBeenCalled();
  });

  it('tells anyone else who owns the input, only them, and opens nothing', async () => {
    await clickCard('input_settings', input.id, 'U0EVE');

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

    await clickCard('input_settings', operators.id, 'U0DANA');

    expect(slack.open).not.toHaveBeenCalled();
    expect(slack.postEphemeral.mock.calls[0]?.[2]).toMatch(/managed by the operator/);
  });

  it('says so when the window cannot be opened', async () => {
    slack.open.mockRejectedValue(new Error('expired_trigger_id'));

    await clickCard('input_settings', input.id, 'U0DANA');

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
    expect(updated).toMatchObject({ view_id: 'V0SETTINGS', hash: 'h1' });
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

describe('Pause and Resume', () => {
  it('pauses the input for its owner and offers Resume, in the window and in the panel', async () => {
    slack.fetchMessage.mockResolvedValue({ text: 'Inputs', blocks: panel() });

    await clickWindow('input_pause', input.id, 'U0DANA');

    expect(store.input(input.id)?.state).toBe('paused');
    const [updated] = slack.update.mock.calls[0] as [{ view: unknown }];
    expect(shown(updated.view)).toContain('*Meetings* · ⏸️ Paused');
    expect(shown(updated.view)).toContain('input_resume');
    expect(shown(updated.view)).not.toContain('input_pause');
    const [, , , row] = slack.updateMessage.mock.calls[0] as [string, string, string, unknown[]];
    expect(shown(row)).toContain('*Meetings*\\n⏸️ Paused · owned by <@U0DANA>');
    expect(shown(vi.mocked(logger.system).mock.calls)).toContain('was paused by its owner');
  });

  it('resumes a paused input', async () => {
    store.pauseInput(input.id);

    await clickWindow('input_resume', input.id, 'U0DANA');

    expect(store.input(input.id)?.state).toBe('enabled');
    expect(shown(slack.update.mock.calls)).toContain('input_pause');
  });

  it('changes nothing for anyone else', async () => {
    await clickWindow('input_pause', input.id, 'U0EVE');

    expect(store.input(input.id)?.state).toBe('enabled');
    expect(shown(slack.update.mock.calls)).toContain('Only <@U0DANA>, who owns this input');
  });

  it('changes nothing for an owner who is no longer a member of the workspace', async () => {
    slack.members.delete('U0DANA');

    await clickWindow('input_pause', input.id, 'U0DANA');

    expect(store.input(input.id)?.state).toBe('enabled');
  });
});

describe('Delete', () => {
  const deliveryStatus = () => store.input(input.id)?.state;

  it('deletes the input for its owner, removes the key and says so in the window', async () => {
    const [ref] = input.secretRefs;

    await clickWindow('input_delete', input.id, 'U0DANA');

    expect(deliveryStatus()).toBe('deleted');
    expect(await secrets.read(ref ?? '')).toBeNull();
    const [updated] = slack.update.mock.calls[0] as [{ view_id: string; view: unknown }];
    expect(updated.view_id).toBe('V0SETTINGS');
    expect(shown(updated.view)).toContain('*Meetings* was deleted');
    expect(shown(updated.view)).not.toContain('input_delete');
    expect(shown(vi.mocked(logger.system).mock.calls)).toContain('was deleted by its owner');
  });

  it('changes the row of the panel the window was opened from', async () => {
    slack.fetchMessage.mockResolvedValue({ text: 'Inputs', blocks: panel() });

    await clickWindow('input_delete', input.id, 'U0DANA');

    expect(slack.fetchMessage).toHaveBeenCalledWith(PANEL.channel_id, PANEL.ts, PANEL.thread_ts);
    const [channel, ts, , retired] = slack.updateMessage.mock.calls[0] as [
      string,
      string,
      string,
      unknown[],
    ];
    expect([channel, ts]).toEqual([PANEL.channel_id, PANEL.ts]);
    expect(shown(retired)).toContain('~Meetings~ · deleted');
    expect(shown(retired)).not.toContain('input_settings');
  });

  it('still deletes when the panel cannot be updated', async () => {
    slack.fetchMessage.mockRejectedValue(new Error('missing_scope'));

    await clickWindow('input_delete', input.id, 'U0DANA');

    expect(deliveryStatus()).toBe('deleted');
    expect(shown(slack.update.mock.calls)).toContain('was deleted');
    expect(shown(vi.mocked(logger.warn).mock.calls)).toContain('Could not update the panel');
  });

  it('touches no message when the window was not opened from one', async () => {
    await clickWindow('input_delete', input.id, 'U0DANA', { input_id: input.id });

    expect(deliveryStatus()).toBe('deleted');
    expect(slack.fetchMessage).not.toHaveBeenCalled();
  });

  it('deletes nothing for anyone else', async () => {
    await clickWindow('input_delete', input.id, 'U0EVE');

    expect(deliveryStatus()).toBe('enabled');
    expect(shown(slack.update.mock.calls)).toContain('Only <@U0DANA>, who owns this input');
  });

  it('deletes nothing for an owner who is no longer a member of the workspace', async () => {
    slack.members.delete('U0DANA');

    await clickWindow('input_delete', input.id, 'U0DANA');

    expect(deliveryStatus()).toBe('enabled');
    expect(shown(slack.update.mock.calls)).toContain('Only the owner of this input can do that');
  });

  it('leaves an operator-made input to the operator', async () => {
    const { input: operators } = await createInput({ store, secrets }, { auth: 'bearer' });

    await clickWindow('input_delete', operators.id, 'U0DANA');

    expect(store.input(operators.id)?.state).toBe('enabled');
    expect(shown(slack.update.mock.calls)).toContain('managed by the operator');
  });

  it('says the input is gone when the window is older than the deletion', async () => {
    await clickWindow('input_delete', input.id, 'U0DANA');
    slack.update.mockClear();

    await clickWindow('input_delete', input.id, 'U0DANA');

    expect(shown(slack.update.mock.calls)).toContain('This input no longer exists.');
  });

  it('still reports the deletion when a secret file stays behind, and warns the operator', async () => {
    vi.spyOn(secrets, 'remove').mockRejectedValue(new Error('EACCES'));

    await clickWindow('input_delete', input.id, 'U0DANA');

    expect(deliveryStatus()).toBe('deleted');
    expect(shown(slack.update.mock.calls)).toContain('was deleted');
    expect(shown(vi.mocked(logger.warn).mock.calls)).toContain('secret file could not be removed');
  });
});

describe('Check again', () => {
  it('redraws the window with what Archie holds now, and the key masked', async () => {
    noteRefusedDelivery(input.id, 1_800_000_060_000);

    await clickWindow('input_check_connection', input.id, 'U0DANA');

    const [updated] = slack.update.mock.calls[0] as [{ view: unknown }];
    expect(shown(updated.view)).toContain('Last refused');
    expect(shown(updated.view)).not.toContain(secret);
  });
});
