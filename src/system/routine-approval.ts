// SPDX-License-Identifier: AGPL-3.0-or-later
/** Approving an event routine: who may approve it, and the inputs it gets created and linked before it is enabled. */
import {
  fetchChannelIsPrivate,
  getUserInfo,
  isChannelShared,
  isInternalMemoryUser,
} from '../connectors/slack/client.js';
import { formatConversationLabel } from '../connectors/slack/channel-ids.js';
import { inputServices } from '../incoming/access.js';
import { createInput, discardInput, goneRoutines, linkRoutine } from '../incoming/inputs.js';
import type { Input, InputActor } from '../incoming/types.js';
import type { Trigger, TriggerBinding, TriggerCondition } from '../types/trigger.js';
import {
  buildRoutineReviewBlocks,
  isEventCondition,
  type RoutineSource,
} from './routine-review.js';
import { logger } from './logger.js';
import { triggerExists } from './trigger-store.js';

export type RoutineRefusalReason =
  /** The card that was clicked no longer shows what the proposal says. */
  | 'stale_card'
  | 'not_internal'
  | 'shared_channel'
  | 'inbox_closed'
  | 'input_gone'
  | 'input_taken'
  | 'several_inputs'
  | 'destination'
  | 'cap';

/** A refusal leaves the proposal pending. `not_pending` means it was approved or withdrawn meanwhile. */
export type RoutineRefusal =
  { status: 'refused'; reason: RoutineRefusalReason } | { status: 'not_pending' };

export type RoutineApproval =
  ({ status: 'approved'; trigger: Trigger } & RoutineInputs) | RoutineRefusal;

export interface RoutineInputs {
  /** Inputs the routine now receives events from. */
  linked: string[];
  /** Operator-made inputs the approver may not link; the operator links them from the CLI. */
  awaitingOperator: string[];
  /** Inputs this approval created. */
  created: string[];
}

/** Why an event routine may not be set up in this conversation, or null. Asked at proposal and again at approval. */
export async function routineDestinationRefusal(binding: TriggerBinding): Promise<string | null> {
  if (binding.type !== 'channel' || !(await isChannelShared(binding.channel_id))) return null;
  return 'an event routine cannot run in a channel shared with another organisation';
}

/** An input takes one routine, so a routine can name only an operator-made input nothing uses yet, or the input it is linked to already. */
export function routineInputRefusal(
  conditions: TriggerCondition[],
  triggerId?: string,
): string | null {
  const store = inputServices()?.store;
  for (const condition of conditions) {
    if (condition.type !== 'incoming_event') continue;
    const input = store?.input(condition.input_id);
    if (!input || (triggerId && input.routines.includes(triggerId))) continue;
    if (input.owner || input.routines.length > goneRoutines(input, triggerExists).length)
      return 'that input already belongs to a routine; set this one up with `new_input`, which gives it its own input';
  }
  return null;
}

/**
 * Checks the approver against the input the proposal names and links the routine to it, or creates the input a new-input condition asks for.
 * A created input exists before the routine is enabled, so the caller removes it when the routine is not enabled after all: `discardInputs`.
 */
export async function prepareRoutineInputs(
  pending: Trigger,
  approver: InputActor,
): Promise<({ status: 'ready' } & RoutineInputs) | RoutineRefusal> {
  const services = inputServices();
  if (!services) return { status: 'refused', reason: 'inbox_closed' };
  if (approver.kind === 'slack_user' && !isInternalMemoryUser(await getUserInfo(approver.userId)))
    return { status: 'refused', reason: 'not_internal' };
  if (await routineDestinationRefusal(pending.binding))
    return { status: 'refused', reason: 'shared_channel' };
  // The card shows one source, so more would be approved unseen.
  if (pending.conditions.filter(isEventCondition).length > 1)
    return { status: 'refused', reason: 'several_inputs' };

  // Every existing input is checked before anything is created.
  const inputs: Input[] = [];
  for (const condition of pending.conditions) {
    if (condition.type !== 'incoming_event') continue;
    const input = services.store.input(condition.input_id);
    if (!input || input.state === 'deleted') return { status: 'refused', reason: 'input_gone' };
    const gone = goneRoutines(input, triggerExists);
    if (
      input.owner !== null ||
      input.routines.some((id) => id !== pending.id && !gone.includes(id))
    )
      return { status: 'refused', reason: 'input_taken' };
    inputs.push(input);
  }

  const linked: string[] = [];
  const awaitingOperator: string[] = [];
  for (const input of inputs) {
    const gone = goneRoutines(input, triggerExists);
    const change = linkRoutine(services.store, approver, input.id, pending.id, gone);
    if (change.status !== 'refused') linked.push(input.id);
    else if (change.reason === 'not_owner') awaitingOperator.push(input.id);
    else
      return {
        status: 'refused',
        reason: change.reason === 'input_taken' ? 'input_taken' : 'input_gone',
      };
  }

  const created: string[] = [];
  for (const condition of pending.conditions) {
    if (condition.type !== 'new_input_event') continue;
    const { input } = await createInput(services, {
      auth: condition.auth,
      purpose: condition.purpose,
      owner: approver.kind === 'slack_user' ? approver.userId : null,
      routine: pending.id,
    });
    created.push(input.id);
  }
  return { status: 'ready', linked: [...linked, ...created], awaitingOperator, created };
}

/** Removes the inputs an approval created for a routine that was not enabled after all. */
export async function discardInputs(ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    try {
      const services = inputServices();
      if (!services) throw new Error('the inbox is not open');
      await discardInput(services, id);
    } catch (error) {
      logger.error('routine-approval', `Could not remove input ${id}, left by an approval`, error);
    }
  }
}

/** The review card of an event routine, with its input read from the inbox and its audience from Slack as they are now. */
export async function routineReviewBlocks(trigger: Trigger): Promise<unknown[]> {
  const condition = trigger.conditions.find(isEventCondition);
  if (!condition) throw new Error(`Trigger ${trigger.id} is not an event routine`);
  return buildRoutineReviewBlocks(trigger, {
    source: reviewSource(condition),
    audience: await reviewAudience(trigger.binding),
  });
}

function reviewSource(
  condition: Extract<TriggerCondition, { type: 'incoming_event' | 'new_input_event' }>,
): RoutineSource {
  const routineFilter = condition.filter ?? [];
  if (condition.type === 'new_input_event')
    return {
      label: `New input “${condition.purpose}”`,
      scheme: condition.auth,
      owner: { kind: 'approver' },
      inputFilter: [],
      routineFilter,
    };

  const input = inputServices()?.store.input(condition.input_id);
  if (!input || input.state === 'deleted')
    return {
      label: `Input \`${condition.input_id}\`, which could not be found`,
      scheme: null,
      owner: { kind: 'unknown' },
      inputFilter: [],
      routineFilter,
    };
  return {
    label: input.purpose ? `Input “${input.purpose}” (\`${input.id}\`)` : `Input \`${input.id}\``,
    scheme: input.auth,
    owner: input.owner ? { kind: 'user', userId: input.owner } : { kind: 'operator' },
    inputFilter: input.filter,
    routineFilter,
  };
}

async function reviewAudience(binding: TriggerBinding): Promise<string> {
  const label = formatConversationLabel(binding.channel_name);
  if (binding.type === 'user') return `${label}, a direct message`;
  // A channel Slack cannot be asked about is called private, the narrower claim.
  const isPrivate = await fetchChannelIsPrivate(binding.channel_id).catch(() => true);
  return `${label}, a ${isPrivate ? 'private' : 'public'} channel`;
}

/** What to tell the person whose approval was refused. */
export function routineRefusalText(
  refusal: Extract<RoutineRefusal, { status: 'refused' }>,
): string {
  switch (refusal.reason) {
    case 'stale_card':
      return 'This card is out of date: the proposal changed after it was posted. Use the newest card in this thread.';
    case 'not_internal':
      return 'Only a member of this workspace can approve an event routine.';
    case 'shared_channel':
      return 'An event routine cannot run in a channel shared with another organisation, so nothing was set up.';
    case 'inbox_closed':
      return 'Incoming events are not available right now, so nothing was set up. Try again later.';
    case 'input_gone':
      return 'The input this routine listens to no longer exists, so nothing was set up.';
    case 'input_taken':
      return 'This routine names an input that already belongs to another routine, so nothing was set up. Ask me to set it up with its own input.';
    case 'several_inputs':
      return 'This proposal takes events from more than one input, which a routine cannot do. Ask me to propose it again with one input.';
    case 'destination':
      return 'This routine can no longer deliver to its conversation, so it was not enabled.';
    case 'cap':
      return 'The active-trigger limit was reached. Remove or pause another automation, then approve again.';
  }
}
