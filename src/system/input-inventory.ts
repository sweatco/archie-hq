// SPDX-License-Identifier: AGPL-3.0-or-later
/** Scope follows trigger listings. The owner's own DM and the operator see every input; any other conversation sees one whose routine is visible from it. */
import { DEFAULT_DISPATCH_POLICY } from '../incoming/dispatcher.js';
import type { InputServices } from '../incoming/inputs.js';
import type { DeliveryRecord } from '../incoming/store.js';
import type { Input, Receipt } from '../incoming/types.js';
import type { TaskMetadata } from '../types/task.js';
import type { Trigger } from '../types/trigger.js';
import { reservedTaskId, ROUTINE_CONSUMER_KIND, startedUnrecorded } from './routine-handoff.js';
import { triggerWhat } from './trigger-scheduler.js';
import type { TriggerOrigin } from './trigger-visibility.js';

export const HISTORY_LIMIT = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface InventoryLookups {
  loadTrigger(id: string): Promise<Trigger | null>;
  visible(routine: Trigger): Promise<boolean>;
  task(
    taskId: string,
  ): Promise<Pick<TaskMetadata, 'status' | 'default_channel' | 'channels'> | null>;
}

/** Null for a routine that no longer exists, undefined for one that stays hidden. */
type RoutineLookup = (id: string) => Promise<Trigger | null | undefined>;

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

/** An input takes one routine. A null routine no longer exists. */
type ShownRoutines = Array<{ id: string; routine: Trigger | null }>;

interface InputScope {
  routines: ShownRoutines;
  shows: RoutineLookup;
}

export interface InputListing {
  input: Input;
  routines: ShownRoutines;
  latest: Receipt | null;
}

/** Null when nothing about the input may be shown in the asking conversation. */
async function scopeOf(
  input: Input,
  origin: TriggerOrigin,
  lookups: InventoryLookups,
): Promise<InputScope | null> {
  const whole = seesWhole(input, origin);
  const shows = routineLookup(whole, lookups);
  const routines: ShownRoutines = [];
  for (const id of input.routines) {
    const routine = await shows(id);
    if (routine !== undefined) routines.push({ id, routine });
  }
  return whole || routines.length > 0 ? { routines, shows } : null;
}

const utc = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

const inputName = (input: Input) =>
  `[${input.id}] ${input.purpose ? `“${input.purpose}”` : '(no purpose set)'}`;

const routineName = (id: string, routine: Trigger | null) =>
  routine ? `[${id}] “${triggerWhat(routine)}”` : `[${id}] (no longer exists)`;

export function routineDestination(routine: Trigger): string {
  return routine.binding.type === 'channel'
    ? `#${routine.binding.channel_name}`
    : `a DM with <@${routine.binding.user_id}>`;
}

function describeInput({ input, latest, routines }: InputListing): string {
  const lines = [
    `• ${inputName(input)} — ${input.state}, ${input.auth === 'bearer' ? 'bearer' : 'signed'}, ${
      input.owner ? `owned by <@${input.owner}>` : 'managed by the operator'
    }; ${latest ? `last delivery ${utc(latest.receivedAt)}` : 'no delivery on record'}`,
  ];
  for (const { id, routine } of routines)
    lines.push(
      routine
        ? `    routine [${id}] (${routine.status}) “${triggerWhat(routine)}” — delivers to ${routineDestination(routine)}`
        : `    routine ${routineName(id, routine)}`,
    );
  if (lines.length === 1) lines.push('    nothing takes its events yet');
  return lines.join('\n');
}

export const NO_INPUTS_VISIBLE = 'There are no incoming events inputs visible from here.';

export async function listInputs(
  services: InputServices,
  origin: TriggerOrigin,
  lookups: InventoryLookups,
): Promise<InputListing[]> {
  const listings: InputListing[] = [];
  for (const { input } of services.store.inputSummaries()) {
    if (input.state === 'deleted') continue;
    const scope = await scopeOf(input, origin, lookups);
    if (!scope) continue;
    listings.push({
      input,
      routines: scope.routines,
      latest: services.store.latestReceipt(input.id),
    });
  }
  return listings;
}

export function describeInputs(listings: InputListing[]): string {
  if (listings.length === 0) return NO_INPUTS_VISIBLE;
  return `Inputs visible here (${listings.length}):\n${listings.map(describeInput).join('\n')}`;
}

/** A reason not listed here is shown as recorded. */
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

/** A Task has delivered once it opened its thread. */
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
  return taskId && task && startedUnrecorded(handoff.state)
    ? `uncertain: ${name} was not recorded as started (${why}), yet ${taskId} exists (${task.status})`
    : `skipped: ${name} did not run — ${why}`;
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
  for (const handoff of delivery.handoffs) {
    if (handoff.consumerKind !== ROUTINE_CONSUMER_KIND) continue;
    const routine = await scope.shows(handoff.consumerId);
    if (routine !== undefined)
      lines.push(
        at + (await routineOutcome(handoff, routineName(handoff.consumerId, routine), lookups)),
      );
  }
  return lines.length > 0 ? lines : [`${at}received`];
}

export async function describeInputHistory(
  services: InputServices,
  inputId: string,
  origin: TriggerOrigin,
  lookups: InventoryLookups,
): Promise<string> {
  const input = services.store.input(inputId);
  if (!input) return `No input ${inputId} found.`;
  const scope = await scopeOf(input, origin, lookups);
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
