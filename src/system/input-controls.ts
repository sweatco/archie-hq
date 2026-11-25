// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Slack controls of an input: the Settings window and what its owner does in it.
 * Every click is checked against the input as it is now. A button is drawn for everyone in the conversation, so being able to click one grants nothing.
 */
import type { App, BlockAction, ButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import {
  fetchMessage,
  getSlackClient,
  getUserInfo,
  isInternalMemoryUser,
  postEphemeral,
  updateMessage,
} from '../connectors/slack/client.js';
import { inputServices } from '../incoming/access.js';
import {
  connectionStatus,
  deleteInputAs,
  revealKey,
  type InputServices,
} from '../incoming/inputs.js';
import { inputCallback } from '../incoming/receiver.js';
import type { Input } from '../incoming/types.js';
import {
  deletedNotice,
  INPUT_ACTIONS,
  settingsNoticeView,
  settingsOrigin,
  settingsView,
  withInputDeleted,
  type SettingsOrigin,
} from './input-panels.js';
import { logger } from './logger.js';

type ButtonClick = SlackActionMiddlewareArgs<BlockAction<ButtonAction>>;

/** The input, when this person owns it; otherwise what to tell them. */
function ownedInput(
  userId: string,
  inputId: string,
): { services: InputServices; input: Input } | { refusal: string; gone?: true } {
  const services = inputServices();
  if (!services) return { refusal: 'Incoming events are not available right now.' };
  const input = services.store.input(inputId);
  if (!input || input.state === 'deleted')
    return { refusal: 'This input no longer exists.', gone: true };
  if (input.owner === userId) return { services, input };
  return {
    refusal: input.owner
      ? `Only <@${input.owner}>, who owns this input, can do that.`
      : 'This input is managed by the operator, not from Slack.',
  };
}

/** A person who stopped being a member of the workspace keeps nothing they owned. */
async function isMember(userId: string): Promise<boolean> {
  return isInternalMemoryUser(await getUserInfo(userId));
}

/** Tells the person who clicked, and nobody else, in the thread the card is in. */
async function tell(body: ButtonClick['body'], text: string): Promise<void> {
  const thread: unknown = body.message?.thread_ts;
  if (body.channel?.id)
    await postEphemeral(
      body.channel.id,
      body.user.id,
      text,
      typeof thread === 'string' ? thread : undefined,
    );
}

function clickedMessage(body: ButtonClick['body']): SettingsOrigin | undefined {
  if (!body.channel?.id || !body.message) return undefined;
  const thread: unknown = body.message.thread_ts;
  return {
    channel_id: body.channel.id,
    ts: body.message.ts,
    ...(typeof thread === 'string' ? { thread_ts: thread } : {}),
  };
}

async function retireInMessage(
  at: SettingsOrigin,
  message: { text: string; blocks: unknown[] },
  inputId: string,
): Promise<void> {
  const retired = withInputDeleted(message.blocks, inputId);
  if (retired) await updateMessage(at.channel_id, at.ts, message.text, retired);
}

async function openSettings({ body, action }: ButtonClick): Promise<void> {
  const inputId = action.value ?? '';
  const from = clickedMessage(body);
  const owned = ownedInput(body.user.id, inputId);
  if ('refusal' in owned) {
    const blocks: unknown = body.message?.blocks;
    if (owned.gone && from && Array.isArray(blocks))
      await retireInMessage(from, { text: body.message?.text ?? '', blocks }, inputId);
    return tell(body, owned.refusal);
  }
  const { services, input } = owned;
  // Only what is on this host is read before the window opens: Slack gives a click three seconds.
  await getSlackClient().views.open({
    trigger_id: body.trigger_id,
    view: settingsView({
      input,
      callback: inputCallback(input.id),
      status: await connectionStatus(services, input),
      from,
    }),
  });
}

/** Redraws the Settings window in place: with the key when the owner asked for it, masked again otherwise. */
async function redrawSettings(
  { body, action }: ButtonClick,
  show: 'key' | 'status',
): Promise<void> {
  const view = body.view;
  if (!view) return;
  const owned = ownedInput(body.user.id, action.value ?? '');
  if ('refusal' in owned) return;
  const { services, input } = owned;

  let key: string | undefined;
  let keyNotice: string | undefined;
  if (show === 'key') {
    const reveal = (await isMember(body.user.id))
      ? await revealKey(services, { kind: 'slack_user', userId: body.user.id }, input.id)
      : null;
    if (reveal?.status === 'revealed') {
      key = reveal.secret;
      logger.system(`Incoming events: input ${input.id} showed its key to its owner`);
    } else {
      keyNotice =
        reveal?.reason === 'unreadable'
          ? 'The key cannot be read on the server. Ask the operator.'
          : 'The key can be shown only to the owner of this input.';
    }
  }
  await getSlackClient().views.update({
    view_id: view.id,
    hash: view.hash,
    view: settingsView({
      input,
      callback: inputCallback(input.id),
      status: await connectionStatus(services, input),
      key,
      keyNotice,
      from: settingsOrigin(view.private_metadata),
    }),
  });
}

/** Slack's confirmation dialog ran before this click arrives. */
async function deleteFromSettings({ body, action }: ButtonClick): Promise<void> {
  const view = body.view;
  if (!view) return;
  const conclude = async (notice: string): Promise<void> => {
    await getSlackClient().views.update({ view_id: view.id, view: settingsNoticeView(notice) });
  };

  const owned = ownedInput(body.user.id, action.value ?? '');
  if ('refusal' in owned) return conclude(owned.refusal);
  const { services, input } = owned;
  if (!(await isMember(body.user.id)))
    return conclude('Only the owner of this input can delete it.');

  try {
    const removal = await deleteInputAs(
      services,
      { kind: 'slack_user', userId: body.user.id },
      input.id,
    );
    if (removal.status === 'refused')
      return conclude('This input could not be deleted. It may be gone already.');
  } catch (error) {
    // The input is marked deleted before its secrets go, so a failure after that leaves only a file behind.
    if (services.store.input(input.id)?.state !== 'deleted') throw error;
    logger.warn(
      'incoming',
      `Input ${input.id} is deleted, but a secret file could not be removed. Run \`incoming delete ${input.id}\` to finish`,
      error,
    );
  }
  logger.system(`Incoming events: input ${input.id} was deleted by its owner`);
  await conclude(deletedNotice(input));

  const from = settingsOrigin(view.private_metadata);
  if (!from) return;
  try {
    const message = await fetchMessage(from.channel_id, from.ts, from.thread_ts);
    if (message) await retireInMessage(from, message, input.id);
  } catch (error) {
    // The row then keeps its button, and the next click on it removes it.
    logger.warn('incoming', `Could not update the panel after deleting input ${input.id}`, error);
  }
}

/** Logs a failed control and, where there is a card to answer under, says so to the person who clicked. */
function reportFailure(args: ButtonClick): (error: unknown) => Promise<void> {
  return async (error) => {
    logger.error('incoming', `Input control ${args.action.action_id} failed`, error);
    await tell(args.body, 'That could not be done. Please try again.').catch((failure: unknown) =>
      logger.warn('incoming', 'Could not report a failed control', failure),
    );
  };
}

/** Registers the buttons. Mounted beside the other approval handlers. */
export function registerInputControlHandlers(boltApp: Pick<App, 'action'>): void {
  const onClick = (actionId: string, handle: (args: ButtonClick) => Promise<void>) => {
    boltApp.action<BlockAction<ButtonAction>>(actionId, async (args) => {
      await args.ack();
      await handle(args).catch(reportFailure(args));
    });
  };
  onClick(INPUT_ACTIONS.settings, openSettings);
  onClick(INPUT_ACTIONS.showKey, (args) => redrawSettings(args, 'key'));
  onClick(INPUT_ACTIONS.checkConnection, (args) => redrawSettings(args, 'status'));
  onClick(INPUT_ACTIONS.delete, deleteFromSettings);
}
