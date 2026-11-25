// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What a conversation may learn about incoming events inputs: which exist, what takes their events, and what became of each delivery.
 * Scope follows trigger listings. The owner's own DM and the operator see an input whole. Any other conversation sees the routines
 * visible from it, and everything else as a count.
 */
import type { DaemonInputs } from '../incoming/access.js';
import { DEFAULT_DISPATCH_POLICY } from '../incoming/dispatcher.js';
import type { DeliveryRecord } from '../incoming/store.js';
import type { ConsumerUse, Input, Receipt } from '../incoming/types.js';
import type { TaskMetadata } from '../types/task.js';
import type { Trigger } from '../types/trigger.js';
import { reservedTaskId, ROUTINE_CONSUMER_KIND } from './routine-handoff.js';
import { triggerWhat } from './trigger-scheduler.js';
import type { TriggerOrigin } from './trigger-visibility.js';

export const HISTORY_LIMIT = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface InventoryLookups {
  loadTrigger(id: string): Promise<Trigger | null>;
  /** Whether a routine may be shown in the asking conversation. */
  visible(routine: Trigger): Promise<boolean>;
  task(
    taskId: string,
  ): Promise<Pick<TaskMetadata, 'status' | 'default_channel' | 'channels'> | null>;
}

/** A routine's record when it may be shown here: null for one that no longer exists, undefined for one that stays hidden. */
type RoutineLookup = (id: string) => Promise<Trigger | null | undefined>;

/** The owner's own DM and the operator are told everything about an input. */
function seesWhole(input: Input, origin: TriggerOrigin): boolean {
  if (origin.kind === 'operator') return true;
  return origin.kind === 'dm' && input.owner !== null && origin.userId === input.owner;
}

function routineLookup(whole: boolean, lookups: InventoryLookups): RoutineLookup {
  const known = new Map<string, Promise<Trigger | null | undefined>>();
  return (id) => {
    let found = known.get(id);
    if (!found) {
      found = lookups.loadTrigger(id).then(async (routine) => {
        if (whole) return routine;
        return routine && (await lookups.visible(routine)) ? routine : undefined;
      });
      known.set(id, found);
    }
    return found;
  };
}

/** What takes an input's events, as far as one conversation may see. */
export interface InputUses {
  /** The linked routines that may be shown. A null routine no longer exists. */
  routines: Array<{ id: string; routine: Trigger | null }>;
  /** Consumers of other kinds, named only where the input is seen whole. */
  others: ConsumerUse[];
  /** Linked routines and other consumers that stay unnamed here. */
  hidden: number;
}

interface InputScope extends InputUses {
  whole: boolean;
  shows: RoutineLookup;
}

export interface InputListing extends InputUses {
  input: Input;
  latest: Receipt | null;
}

/** Null when nothing about the input may be shown in the asking conversation. */
async function scopeOf(
  input: Input,
  origin: TriggerOrigin,
  services: DaemonInputs,
  lookups: InventoryLookups,
): Promise<InputScope | null> {
  const whole = seesWhole(input, origin);
  const shows = routineLookup(whole, lookups);
  const routines: InputScope['routines'] = [];
  let hidden = 0;
  for (const id of input.routines) {
    const routine = await shows(id);
    if (routine === undefined) hidden += 1;
    else routines.push({ id, routine });
  }
  if (!whole && routines.length === 0) return null;

  const others = (services.consumers ?? [])
    .filter((consumer) => consumer.kind !== ROUTINE_CONSUMER_KIND)
    .flatMap((consumer) => consumer.uses?.(input) ?? []);
  return whole
    ? { whole, routines, others, hidden, shows }
    : { whole, routines, others: [], hidden: hidden + others.length, shows };
}

const utc = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export const unnamedConsumers = (count: number) =>
  `${count} other consumer${count === 1 ? '' : 's'} not visible from here`;

const inputName = (input: Input) =>
  `[${input.id}] ${input.purpose ? `“${input.purpose}”` : '(no purpose set)'}`;

const routineName = (id: string, routine: Trigger | null) =>
  routine ? `[${id}] “${triggerWhat(routine)}”` : `[${id}] (no longer exists)`;

export function routineDestination(routine: Trigger): string {
  return routine.binding.type === 'channel'
    ? `#${routine.binding.channel_name}`
    : `a DM with <@${routine.binding.user_id}>`;
}

function describeInput({ input, latest, ...uses }: InputListing): string {
  const lines = [
    `• ${inputName(input)} — ${input.state}, ${input.auth === 'bearer' ? 'bearer' : 'signed'}, ${
      input.owner ? `owned by <@${input.owner}>` : 'managed by the operator'
    }; ${latest ? `last delivery ${utc(latest.receivedAt)}` : 'no delivery on record'}`,
  ];
  for (const { id, routine } of uses.routines)
    lines.push(
      routine
        ? `    routine [${id}] (${routine.status}) “${triggerWhat(routine)}” — delivers to ${routineDestination(routine)}`
        : `    routine ${routineName(id, routine)}`,
    );
  for (const other of uses.others) lines.push(`    consumer: ${other.label}`);
  if (uses.hidden > 0) lines.push(`    and ${unnamedConsumers(uses.hidden)}`);
  if (lines.length === 1) lines.push('    nothing takes its events yet');
  return lines.join('\n');
}

export const NO_INPUTS_VISIBLE = 'There are no incoming events inputs visible from here.';

/** The inputs that may be shown in the asking conversation, each with what takes its events. */
export async function listInputs(
  services: DaemonInputs,
  origin: TriggerOrigin,
  lookups: InventoryLookups,
): Promise<InputListing[]> {
  const listings: InputListing[] = [];
  for (const { input } of services.store.inputSummaries()) {
    if (input.state === 'deleted') continue;
    const scope = await scopeOf(input, origin, services, lookups);
    if (!scope) continue;
    const { routines, others, hidden } = scope;
    listings.push({
      input,
      routines,
      others,
      hidden,
      latest: services.store.latestReceipt(input.id),
    });
  }
  return listings;
}

export function describeInputs(listings: InputListing[]): string {
  if (listings.length === 0) return NO_INPUTS_VISIBLE;
  return `Inputs visible here (${listings.length}):\n${listings.map(describeInput).join('\n')}`;
}

/** Why a handoff ended without a run, in words. A reason not listed here is shown as recorded. */
const ENDED_BECAUSE: Record<string, string> = {
  routine_paused: 'the routine was paused',
  routine_deleted: 'the routine was deleted',
  routine_unlinked: 'the routine was disconnected from the input',
  routine_changed: 'the routine no longer listens to this input',
  input_paused: 'the input was paused',
  input_deleted: 'the input was deleted',
  triggers_disabled: 'triggers are switched off on this instance',
  destination_unreachable: "the routine's conversation could not be reached",
  daily_cap: 'the daily limit of automated runs was reached',
  attempts_exhausted: 'starting it failed too many times',
  interrupted: 'Archie stopped during the last attempt to start it',
  expired: 'it waited too long to start',
  unreadable: 'its stored record could not be read',
};

type DeliveryHandoff = DeliveryRecord['handoffs'][number];

/** One of: received, handed off, delivered, skipped, uncertain. A Task has delivered once it opened its thread. */
async function routineOutcome(
  handoff: DeliveryHandoff,
  name: string,
  lookups: InventoryLookups,
): Promise<string> {
  if (handoff.state === 'pending') return `received: ${name} has not started yet`;
  const taskId = handoff.reservation ? reservedTaskId(handoff.reservation) : undefined;
  const task = taskId ? await lookups.task(taskId) : null;

  if (handoff.state === 'accepted') {
    if (!taskId || !task)
      return `handed off: ${name} started ${taskId ?? 'a task'}, whose record is no longer kept`;
    const thread = task.default_channel ? task.channels[task.default_channel] : undefined;
    if (thread?.type !== 'slack')
      return `handed off: ${name} started ${taskId} (${task.status}); it has not posted yet`;
    return `delivered: ${name} ran as ${taskId} and posted in its conversation${
      thread.url ? ` — ${thread.url}` : ''
    }`;
  }

  const why = ENDED_BECAUSE[handoff.reason ?? ''] ?? handoff.reason ?? 'no reason was recorded';
  // A Task that outlived a cancelled or failed handoff started without the handoff recording it.
  return taskId && task && handoff.state !== 'skipped'
    ? `uncertain: ${name} was not recorded as started (${why}), yet ${taskId} exists (${task.status})`
    : `skipped: ${name} did not run — ${why}`;
}

function otherOutcome(handoff: DeliveryHandoff): string {
  const name = `consumer ${handoff.consumerKind}/${handoff.consumerId}`;
  if (handoff.state === 'pending') return `received: ${name} has not taken it yet`;
  if (handoff.state === 'accepted') return `handed off: ${name} took it`;
  return `skipped: ${name} did not take it — ${
    ENDED_BECAUSE[handoff.reason ?? ''] ?? handoff.reason ?? 'no reason was recorded'
  }`;
}

async function deliveryLines(
  delivery: DeliveryRecord,
  scope: InputScope,
  lookups: InventoryLookups,
): Promise<string[]> {
  const at = `• ${utc(delivery.receivedAt)} — `;
  if (delivery.outcome === 'ignored')
    return [
      `${at}skipped: ${
        delivery.ignoredReason === 'paused'
          ? 'the input was paused'
          : 'a filter excluded it, or no routine was taking events'
      }`,
    ];

  const lines: string[] = [];
  let hidden = 0;
  for (const handoff of delivery.handoffs) {
    if (handoff.consumerKind !== ROUTINE_CONSUMER_KIND) {
      if (scope.whole) lines.push(at + otherOutcome(handoff));
      else hidden += 1;
      continue;
    }
    const routine = await scope.shows(handoff.consumerId);
    if (routine === undefined) hidden += 1;
    else
      lines.push(
        at + (await routineOutcome(handoff, routineName(handoff.consumerId, routine), lookups)),
      );
  }
  if (lines.length === 0)
    return [`${at}received${hidden > 0 ? `: taken by ${unnamedConsumers(hidden)}` : ''}`];
  if (hidden > 0) lines.push(`    and ${unnamedConsumers(hidden)}`);
  return lines;
}

/** What became of an input's newest deliveries, as far as the asking conversation may see. */
export async function describeInputHistory(
  services: DaemonInputs,
  inputId: string,
  origin: TriggerOrigin,
  lookups: InventoryLookups,
): Promise<string> {
  const input = services.store.input(inputId);
  if (!input) return `No input ${inputId} found.`;
  const scope = await scopeOf(input, origin, services, lookups);
  if (!scope)
    return `Input ${inputId} isn't visible from here, so its history can't be read from this conversation.`;

  const days = Math.round(DEFAULT_DISPATCH_POLICY.receiptRetentionMs / DAY_MS);
  const kept = `Deliveries stay on record for ${days} days. No event content is kept.`;
  const deliveries = services.store.deliveryHistory(input.id, HISTORY_LIMIT);
  if (deliveries.length === 0)
    return `Input ${inputName(input)} has no delivery on record. ${kept}`;

  const lines: string[] = [];
  for (const delivery of deliveries) lines.push(...(await deliveryLines(delivery, scope, lookups)));
  return [
    `History of input ${inputName(input)}, newest first. ${kept}`,
    ...lines,
    ...(deliveries.length === HISTORY_LIMIT ? [`Showing the newest ${HISTORY_LIMIT}.`] : []),
  ].join('\n');
}
