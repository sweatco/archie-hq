// SPDX-License-Identifier: AGPL-3.0-or-later
import { statSync } from 'node:fs';
import { z } from 'zod';
import type { Trigger } from '../types/trigger.js';
import { createInput, deleteInput, linkRoutine, rotateKey, type InputServices } from './inputs.js';
import { inputCallback } from './receiver.js';
import {
  inputFilterSchema,
  type Input,
  type InputActor,
  type InputAuth,
  type PointerCheck,
} from './types.js';

export interface OperatorServices extends InputServices {
  loadTrigger(id: string): Promise<Trigger | null>;
  /** Null when the Task has no folder. */
  taskStatus(taskId: string): Promise<string | null>;
}

const OPERATOR: InputActor = { kind: 'operator' };

export const USAGE = `archie incoming — manage inputs that receive webhooks

Usage:
  npm run incoming -- create [--auth signed|bearer] [--filter '<json>']
  npm run incoming -- list
  npm run incoming -- pause <input-id>
  npm run incoming -- resume <input-id>
  npm run incoming -- delete <input-id>
  npm run incoming -- rotate <input-id>
  npm run incoming -- link <input-id> <trigger-id>
  npm run incoming -- unlink <input-id> <trigger-id>
  npm run incoming -- history [<input-id>]

  --auth    signed (default): Standard Webhooks signature. bearer: Authorization header.
  --filter  JSON list of conditions an event must meet, for example
            '[{"pointer":"/type","op":"equals","value":"meeting.ended"}]'
  link      Lets a trigger with a condition for the input receive its events. An input takes one.
            A trigger receives nothing until it is linked.
  unlink    Stops the trigger receiving the input's events.
  rotate    Replaces the input's key and prints the new one. The old key stops working at once.
  history   The newest events handed to triggers: how each ended, why, and its Task.

Environment:
  ARCHIE_SECRETS_KEY       32-byte master key (base64)                  (required)
  ARCHIE_PUBLIC_URL        Public URL of this Archie deployment         (for the callback URL)
  ARCHIE_INCOMING_EVENTS   on, or the daemon does not mount the route
`;

const AUTH_BY_FLAG = new Map<string, InputAuth>([
  ['signed', 'standard_webhooks'],
  ['bearer', 'bearer'],
]);
const COMMANDS: readonly string[] = [
  'create',
  'list',
  'pause',
  'resume',
  'delete',
  'rotate',
  'link',
  'unlink',
  'history',
];

export function isIncomingCommand(name: string | undefined): boolean {
  return name !== undefined && COMMANDS.includes(name);
}

/** Files created as root are readable only by root, while the container's daemon runs as another user. */
export function assertNotRootBesideDaemon(
  uid: number | undefined,
  directories: readonly string[],
  ownerOf: (path: string) => number | undefined = (path) =>
    statSync(path, { throwIfNoEntry: false })?.uid,
): void {
  if (uid !== 0) return;
  for (const directory of directories) {
    const owner = ownerOf(directory);
    if (owner !== undefined && owner !== 0)
      throw new Error(
        `Run this as the user the daemon runs as, not as root: ${directory} belongs to uid ${owner}, ` +
          'and files created as root would be unreadable to the daemon. ' +
          'In a container, use `docker exec -u <daemon user>`.',
      );
  }
}

/** Errors thrown here carry a message written for the operator. */
export async function runIncomingCommand(
  args: readonly string[],
  services: OperatorServices,
  print: (line: string) => void,
): Promise<void> {
  const [command, ...rest] = args;
  switch (command) {
    case 'create':
      return create(rest, services, print);
    case 'list':
      return list(services, print);
    case 'pause':
    case 'resume':
    case 'delete':
      return changeState(command, rest, services, print);
    case 'rotate':
      return rotate(rest, services, print);
    case 'link':
      return link(rest, services, print);
    case 'unlink':
      return unlink(rest, services, print);
    case 'history':
      return history(rest, services, print);
    default:
      throw new Error(`Unknown command: ${command ?? '(none)'}\n\n${USAGE}`);
  }
}

async function create(
  args: readonly string[],
  services: InputServices,
  print: (line: string) => void,
): Promise<void> {
  const flags = parseFlags(args, ['--auth', '--filter']);
  const auth = AUTH_BY_FLAG.get(flags['--auth'] ?? 'signed');
  if (!auth) throw new Error('--auth must be signed or bearer');
  const { input, secret } = await createInput(services, {
    auth,
    filter: parseFilter(flags['--filter']),
  });

  const callback = inputCallback(input.id);
  print(`Created input ${input.id}`);
  print(
    'url' in callback
      ? `Callback URL:  ${callback.url}`
      : `Callback path: ${callback.path}  (set ARCHIE_PUBLIC_URL to print the full URL)`,
  );
  print(
    auth === 'bearer'
      ? 'Send:          Authorization: Bearer <secret>, and Idempotency-Key to make retries safe'
      : 'Send:          Standard Webhooks headers webhook-id, webhook-timestamp, webhook-signature',
  );
  print(`Secret:        ${secret}`);
  print('The secret is shown this once. Store it with the sender now.');
}

async function rotate(
  args: readonly string[],
  services: InputServices,
  print: (line: string) => void,
): Promise<void> {
  const [id] = args;
  if (!id || args.length !== 1) throw new Error('Usage: incoming rotate <input-id>');
  const rotation = await rotateKey(services, OPERATOR, liveInput(services, id).id);
  if (rotation.status === 'refused') throw new Error(`Input ${id} was deleted`);
  print(`Rotated the key of input ${id}. The old key no longer works.`);
  print(`Secret:        ${rotation.secret}`);
  print('The secret is shown this once. Store it with the sender now.');
  if (rotation.leftBehind.length > 0)
    print(
      `An old secret file could not be removed and is unused: ${rotation.leftBehind.join(', ')}`,
    );
}

type Row = readonly [string, string, string, string, string, string, string];

function formatRow([input, state, auth, created, receipts, ignored, waiting]: Row): string {
  return [
    input.padEnd(26),
    state.padEnd(7),
    auth.padEnd(6),
    created.padEnd(10),
    receipts.padStart(8),
    ignored.padStart(7),
    waiting.padStart(7),
  ].join('  ');
}

async function list(services: OperatorServices, print: (line: string) => void): Promise<void> {
  const summaries = services.store.inputSummaries();
  if (summaries.length === 0) {
    print('No inputs yet. Create one with `npm run incoming -- create`.');
    return;
  }
  print(formatRow(['Input', 'State', 'Auth', 'Created', 'Receipts', 'Ignored', 'Waiting']));
  for (const { input, createdAt, receipts, ignored, pendingHandoffs } of summaries) {
    print(
      formatRow([
        input.id,
        input.state,
        input.auth === 'bearer' ? 'bearer' : 'signed',
        new Date(createdAt).toISOString().slice(0, 10),
        String(receipts),
        String(ignored),
        String(pendingHandoffs),
      ]),
    );
    if (input.owner !== null || input.purpose !== '')
      print(`  owner: ${input.owner ?? '(operator)'}  purpose: ${input.purpose || '(none)'}`);
    if (input.routines.length > 0) {
      const links = await Promise.all(
        input.routines.map(async (id) =>
          (await services.loadTrigger(id)) ? id : `${id} (no longer exists)`,
        ),
      );
      print(`  linked: ${links.join(', ')}`);
    }
  }
}

const STATUS_NOTE: Record<Trigger['status'], string> = {
  enabled: '',
  pending: ' — it receives events once it is approved',
  paused: ' — it receives events once it is resumed',
};

async function link(
  args: readonly string[],
  services: OperatorServices,
  print: (line: string) => void,
): Promise<void> {
  const [inputId, triggerId] = args;
  if (!inputId || !triggerId || args.length !== 2)
    throw new Error('Usage: incoming link <input-id> <trigger-id>');
  const input = liveInput(services, inputId);
  const trigger = await services.loadTrigger(triggerId);
  if (!trigger) throw new Error(`No trigger ${triggerId}`);
  if (!trigger.conditions.some((c) => c.type === 'incoming_event' && c.input_id === inputId))
    throw new Error(
      `Trigger ${triggerId} has no condition for input ${inputId}, so a link would deliver nothing`,
    );

  const change = linkRoutine(services.store, OPERATOR, input.id, triggerId);
  if (change.status === 'refused')
    throw new Error(
      change.reason === 'input_taken'
        ? `Input ${inputId} already has a trigger, and an input takes one. Create another input for ${triggerId}`
        : `Input ${inputId} was deleted`,
    );
  print(
    change.status === 'unchanged'
      ? `Trigger ${triggerId} is already linked to input ${inputId}.`
      : `Linked trigger ${triggerId} to input ${inputId}.`,
  );
  const { binding } = trigger;
  print(
    binding.type === 'channel'
      ? `Delivers to: #${binding.channel_name} (${binding.channel_id})`
      : `Delivers to: a DM with ${binding.user_id} (${binding.channel_id})`,
  );
  print(`Does:        ${trigger.summary?.trim() || '(no summary)'}`);
  print(`Status:      ${trigger.status}${STATUS_NOTE[trigger.status]}`);
}

function unlink(
  args: readonly string[],
  services: OperatorServices,
  print: (line: string) => void,
): void {
  const [inputId, triggerId] = args;
  if (!inputId || !triggerId || args.length !== 2)
    throw new Error('Usage: incoming unlink <input-id> <trigger-id>');
  const input = liveInput(services, inputId);
  if (!input.routines.includes(triggerId))
    throw new Error(`Trigger ${triggerId} is not linked to input ${inputId}`);
  const changed = services.store.unlinkRoutine(input.id, triggerId);
  if (!changed || changed.state === 'deleted') throw new Error(`Input ${inputId} was deleted`);
  print(`Unlinked trigger ${triggerId} from input ${inputId}.`);
}

const HISTORY_LIMIT = 50;
const HISTORY_WIDTHS = [16, 26, 24, 9, 22] as const;
const reservedTaskSchema = z.object({ task_id: z.string() });

async function history(
  args: readonly string[],
  services: OperatorServices,
  print: (line: string) => void,
): Promise<void> {
  const [inputId] = args;
  if (args.length > 1) throw new Error('Usage: incoming history [<input-id>]');
  if (inputId !== undefined && !services.store.input(inputId))
    throw new Error(`No input ${inputId}`);
  const records = services.store.handoffHistory(HISTORY_LIMIT, inputId);
  if (records.length === 0) {
    print('No event has been handed to a trigger yet.');
    return;
  }

  const row = (cells: readonly string[]) =>
    cells.map((cell, column) => cell.padEnd(HISTORY_WIDTHS[column] ?? 0)).join('  ');
  print(row(['Received (UTC)', 'Input', 'Trigger', 'State', 'Reason', 'Task']));
  for (const record of records) {
    print(
      row([
        new Date(record.receivedAt).toISOString().slice(0, 16).replace('T', ' '),
        record.inputId,
        record.consumerId,
        record.state,
        record.reason ?? '-',
        await reservedTask(services, record.state, record.reservation),
      ]),
    );
  }
  if (records.length === HISTORY_LIMIT) print(`Showing the newest ${HISTORY_LIMIT}.`);
}

/** A Task that outlived a cancelled or failed handoff started without the handoff recording it. */
async function reservedTask(
  services: OperatorServices,
  state: string,
  reservation: string | null,
): Promise<string> {
  const reserved = reservedTaskSchema.safeParse(parsedJson(reservation));
  if (!reserved.success) return '-';
  const status = await services.taskStatus(reserved.data.task_id);
  if (status === null) return '-';
  const uncertain = state === 'cancelled' || state === 'failed';
  return `${reserved.data.task_id} ${status}${uncertain ? ' (uncertain)' : ''}`;
}

function parsedJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function liveInput(services: InputServices, id: string): Input {
  const input = services.store.input(id);
  if (!input) throw new Error(`No input ${id}`);
  if (input.state === 'deleted') throw new Error(`Input ${id} was deleted`);
  return input;
}

async function changeState(
  command: 'pause' | 'resume' | 'delete',
  args: readonly string[],
  services: InputServices,
  print: (line: string) => void,
): Promise<void> {
  const [id] = args;
  if (!id || args.length !== 1) throw new Error(`Usage: incoming ${command} <input-id>`);
  let input;
  if (command === 'pause') input = services.store.pauseInput(id);
  else if (command === 'resume') input = services.store.resumeInput(id);
  else input = await deleteAndSayWhatIsLeft(services, id);

  if (!input) throw new Error(`No input ${id}`);
  if (command === 'resume' && input.state === 'deleted')
    throw new Error(`Input ${id} was deleted and cannot be resumed`);
  if (command === 'pause' && input.state === 'deleted') throw new Error(`Input ${id} was deleted`);
  print(`Input ${id} is ${input.state}.`);
}

/** Once the row is marked the deletion is final; what can still fail is removing secret files. */
async function deleteAndSayWhatIsLeft(services: InputServices, id: string) {
  try {
    return await deleteInput(services, id);
  } catch (error) {
    if (services.store.input(id)?.state !== 'deleted') throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Input ${id} is deleted and its callback answers 410, but a secret file could not be removed: ${reason}. Run delete again to finish.`,
    );
  }
}

function parseFlags(args: readonly string[], allowed: readonly string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || !allowed.includes(flag)) throw new Error(`Unknown option: ${flag}`);
    if (value === undefined) throw new Error(`Option ${flag} needs a value`);
    flags[flag] = value;
  }
  return flags;
}

function parseFilter(json: string | undefined): PointerCheck[] | undefined {
  if (json === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('--filter is not valid JSON');
  }
  const filter = inputFilterSchema.safeParse(parsed);
  if (!filter.success) throw new Error(`--filter is not a valid filter: ${filter.error.message}`);
  return filter.data;
}
