/**
 * Resolves and stores the secrets a persona config refers to.
 *
 * Secrets stay in 1Password or the macOS Keychain (or the environment, for machines with
 * neither) and are handed to the caller in memory only. Nothing here prints or logs a secret.
 */

import { spawn } from 'child_process';
import { z } from 'zod';
import { parseSecretReference, type EnvLike, type SecretReference } from './config.js';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command, optionally feeding it stdin. Never rejects: a spawn failure is code 127. */
export type RunCommand = (cmd: string, args: string[], stdin?: string) => Promise<CommandResult>;

export const runCommand: RunCommand = (cmd, args, stdin) =>
  new Promise<CommandResult>((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (error) =>
      resolve({ code: 127, stdout, stderr: `failed to spawn ${cmd}: ${error.message}` }),
    );
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    // A command that failed to start, or exited early, breaks the pipe. That outcome is already
    // reported through `error` and `close`, so the stream's own error must not crash the caller.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin ?? '');
  });

export interface SecretSources {
  env: EnvLike;
  run: RunCommand;
}

export async function readSecret(reference: string, sources: SecretSources): Promise<string> {
  const parsed = parseSecretReference(reference);
  if (parsed.kind === 'env') {
    const value = sources.env[parsed.name];
    if (!value) throw new Error(`secret ${reference} is not set in the environment`);
    return value;
  }
  if (parsed.kind === 'op') {
    const result = await sources.run('op', ['read', '--no-newline', reference]);
    const secret = result.stdout.trim();
    if (result.code !== 0 || !secret) {
      throw new Error(
        `secret ${reference} could not be read from 1Password (${opFailure(result)})`,
      );
    }
    return secret;
  }
  const result = await sources.run('security', [
    'find-generic-password',
    '-s',
    parsed.service,
    '-a',
    parsed.account,
    '-w',
  ]);
  const secret = result.stdout.trim();
  if (result.code !== 0 || !secret) {
    throw new Error(`secret ${reference} is not in the Keychain (security exited ${result.code})`);
  }
  return secret;
}

/** Store a secret under a writable reference, replacing any earlier value. */
export async function storeSecret(
  reference: string,
  secret: string,
  run: RunCommand,
): Promise<void> {
  const parsed = parseSecretReference(reference);
  if (parsed.kind === 'op') return storeOnePasswordSecret(reference, parsed, secret, run);
  if (parsed.kind === 'keychain') return storeKeychainSecret(reference, parsed, secret, run);
  throw new Error(`cannot store ${reference}: only op:// and keychain: references are writable`);
}

// These values are embedded unquoted in a `security -i` command line, so they must not contain
// anything that tokenizer would split or interpret. Slack tokens fit the secret shape.
const KEYCHAIN_SAFE_SECRET = /^[A-Za-z0-9._-]+$/;
const KEYCHAIN_SAFE_NAME = /^[A-Za-z0-9._/-]+$/;

/** The secret travels on stdin, not in the argument list, so it never shows in `ps`. */
async function storeKeychainSecret(
  reference: string,
  parsed: Extract<SecretReference, { kind: 'keychain' }>,
  secret: string,
  run: RunCommand,
): Promise<void> {
  if (!KEYCHAIN_SAFE_NAME.test(parsed.service) || !KEYCHAIN_SAFE_NAME.test(parsed.account)) {
    throw new Error(
      `cannot store ${reference}: use only [A-Za-z0-9._/-] in the service and account`,
    );
  }
  if (!KEYCHAIN_SAFE_SECRET.test(secret)) {
    throw new Error('refusing to store a secret with characters outside [A-Za-z0-9._-]');
  }
  const command = `add-generic-password -U -s ${parsed.service} -a ${parsed.account} -w ${secret}\n`;
  const result = await run('security', ['-i'], command);
  if (result.code !== 0) {
    throw new Error(
      `could not store ${reference} in the Keychain (security exited ${result.code})`,
    );
  }
}

/** `op` explains its own failures (locked app, missing item) without echoing a secret. */
function opFailure(result: CommandResult): string {
  const [firstLine = ''] = result.stderr.trim().split('\n');
  return `op exited ${result.code}${firstLine ? `: ${firstLine}` : ''}`;
}

// The field name becomes part of an `op` assignment argument, where `.`, `=`, `[` and `\` have
// meaning. Persona keys already fit this shape.
const OP_SAFE_FIELD = /^[A-Za-z0-9_-]+$/;
const OP_PLACEHOLDER = 'pending';

/**
 * Run `op item edit` with an item template on its stdin.
 *
 * `op` reads a template only from a real pipe. Node hands a child its stdin as a socket, which
 * `op` silently ignores: the edit exits 0 and changes nothing. `cat` puts a pipe in between.
 */
function editItemFromTemplate(
  run: RunCommand,
  editArgs: string[],
  template: unknown,
): Promise<CommandResult> {
  const argv = ['op', 'item', 'edit', ...editArgs];
  return run('sh', ['-c', 'cat | "$@"', 'sh', ...argv], JSON.stringify(template));
}

const onePasswordItem = z.looseObject({
  fields: z.array(z.looseObject({ label: z.string().optional() })).default([]),
});

/**
 * Write one field of an existing 1Password item.
 *
 * `op` only takes a sensitive value through an item template on stdin; an assignment argument
 * would show in `ps`. So a missing field is first created with a placeholder, and the secret
 * then goes in by sending the item back with that one field changed. `--reveal` matters: without
 * it the item comes back with its other secrets concealed, and sending that back would erase them.
 */
async function storeOnePasswordSecret(
  reference: string,
  parsed: Extract<SecretReference, { kind: 'op' }>,
  secret: string,
  run: RunCommand,
): Promise<void> {
  if (parsed.section !== undefined || !OP_SAFE_FIELD.test(parsed.field)) {
    throw new Error(
      `cannot store ${reference}: use op://<vault>/<item>/<field>, no section, field of [A-Za-z0-9_-]`,
    );
  }
  const item = [parsed.item, '--vault', parsed.vault];
  const fetchItem = async () => {
    const fetched = await run('op', ['item', 'get', ...item, '--format=json', '--reveal']);
    if (fetched.code !== 0) {
      throw new Error(
        `cannot store ${reference}: the 1Password item could not be read (${opFailure(fetched)})`,
      );
    }
    return onePasswordItem.parse(JSON.parse(fetched.stdout));
  };
  const hasField = (candidate: z.infer<typeof onePasswordItem>) =>
    candidate.fields.some((field) => field.label === parsed.field);

  let current = await fetchItem();
  if (!hasField(current)) {
    const placeholder = `${parsed.field}[concealed]=${OP_PLACEHOLDER}`;
    const added = await editItemFromTemplate(run, [...item, placeholder], current);
    if (added.code !== 0) {
      throw new Error(`could not add the field for ${reference} (${opFailure(added)})`);
    }
    current = await fetchItem();
    if (!hasField(current)) throw new Error(`1Password did not add the field for ${reference}`);
  }

  const updated = {
    ...current,
    fields: current.fields.map((field) =>
      field.label === parsed.field ? { ...field, value: secret } : field,
    ),
  };
  const saved = await editItemFromTemplate(run, item, updated);
  if (saved.code !== 0) {
    throw new Error(`could not store ${reference} in 1Password (${opFailure(saved)})`);
  }
}
