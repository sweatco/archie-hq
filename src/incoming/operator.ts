// SPDX-License-Identifier: AGPL-3.0-or-later
/** Operator commands for incoming event inputs. The CLI is their only caller until #403. */
import { statSync } from 'node:fs';
import { createInput, deleteInput, type InputServices } from './inputs.js';
import { INCOMING_ROUTE } from './receiver.js';
import { inputFilterSchema, type InputAuth, type PointerCheck } from './types.js';

export const USAGE = `archie incoming — manage inputs that receive webhooks

Usage:
  npm run incoming -- create [--auth signed|bearer] [--filter '<json>']
  npm run incoming -- list
  npm run incoming -- pause <input-id>
  npm run incoming -- resume <input-id>
  npm run incoming -- delete <input-id>

  --auth    signed (default): Standard Webhooks signature. bearer: Authorization header.
  --filter  JSON list of conditions an event must meet, for example
            '[{"pointer":"/type","op":"equals","value":"meeting.ended"}]'

Environment:
  ARCHIE_SECRETS_KEY       32-byte master key (base64)                  (required)
  ARCHIE_PUBLIC_URL        Public URL of this Archie deployment         (for the callback URL)
  ARCHIE_INCOMING_EVENTS   on, or the daemon does not mount the route
`;

const AUTH_BY_FLAG = new Map<string, InputAuth>([
  ['signed', 'standard_webhooks'],
  ['bearer', 'bearer'],
]);
const COMMANDS: readonly string[] = ['create', 'list', 'pause', 'resume', 'delete'];

export function isIncomingCommand(name: string | undefined): boolean {
  return name !== undefined && COMMANDS.includes(name);
}

/**
 * Throws when this process is root and a directory it writes into belongs to another user.
 * The container images run the daemon as a non-root user while `docker exec` defaults to root,
 * and a secret or database file created as root there is unreadable to the daemon.
 */
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

/** Runs one operator command. Throws an Error whose message is meant for the operator. */
export async function runIncomingCommand(
  args: readonly string[],
  services: InputServices,
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

  const path = INCOMING_ROUTE.replace(':inputId', input.id);
  const publicUrl = process.env.ARCHIE_PUBLIC_URL?.replace(/\/+$/, '');
  print(`Created input ${input.id}`);
  print(
    publicUrl
      ? `Callback URL:  ${publicUrl}${path}`
      : `Callback path: ${path}  (set ARCHIE_PUBLIC_URL to print the full URL)`,
  );
  print(
    auth === 'bearer'
      ? 'Send:          Authorization: Bearer <secret>, and Idempotency-Key to make retries safe'
      : 'Send:          Standard Webhooks headers webhook-id, webhook-timestamp, webhook-signature',
  );
  print(`Secret:        ${secret}`);
  print('The secret is shown this once. Store it with the sender now.');
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

function list(services: InputServices, print: (line: string) => void): void {
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
  }
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

/** Deletion is final once the row is marked; only removing secret files can still fail. */
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
