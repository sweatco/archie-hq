#!/usr/bin/env node
/**
 * OAuth CLI — connect / list / revoke / refresh subcommands.
 *
 * Run on the same host as the daemon (they share `SECRETS_DIR`).
 * `connect` does discovery + DCR locally, writes a pending file, prints
 * the authorize URL, then polls the filesystem until the daemon's
 * callback handler completes the exchange.
 */

import 'dotenv/config';
import { setTimeout as sleep } from 'timers/promises';
import { validateMasterKey } from '../system/secrets-vault.js';
import {
  listOAuthServers,
  readOAuthRecord,
  deleteOAuthRecord,
  readPendingRecord,
  deletePendingRecord,
} from '../system/oauth/storage.js';
import { beginConnect } from '../system/oauth/connect.js';
import { ensureFreshToken } from '../system/oauth/refresh.js';

const USAGE = `archie oauth — manage OAuth credentials for HTTP/SSE MCP servers

Usage:
  npm run oauth:connect <server-name> [--label <text>] [--client-id <id> --client-secret <secret>]
  npm run oauth:list
  npm run oauth:revoke <server-name>
  npm run oauth:refresh <server-name>

Environment:
  ARCHIE_SECRETS_KEY   32-byte master key (base64)            (required)
  ARCHIE_PUBLIC_URL    Public URL of this Archie deployment   (required for connect)
  ARCHIE_SECRETS_DIR   Override secrets directory             (optional)
`;

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (!subcommand || subcommand === '-h' || subcommand === '--help') {
    process.stdout.write(USAGE);
    process.exit(subcommand ? 0 : 1);
    return;
  }

  try {
    validateMasterKey();
  } catch (err) {
    fatal(err);
  }

  switch (subcommand) {
    case 'connect': await runConnect(rest); break;
    case 'list':    await runList(); break;
    case 'revoke':  await runRevoke(rest); break;
    case 'refresh': await runRefresh(rest); break;
    default:
      process.stderr.write(`Unknown subcommand: ${subcommand}\n\n${USAGE}`);
      process.exit(1);
  }
}

// ---- connect ----------------------------------------------------------------

async function runConnect(args: string[]): Promise<void> {
  const parsed = parseArgs(args, {
    flags: ['--label', '--client-id', '--client-secret', '--client-name'],
  });
  const serverName = parsed.positional[0];
  if (!serverName) fatal('Usage: oauth:connect <server-name> [--label X]');

  const publicUrl = process.env.ARCHIE_PUBLIC_URL;
  if (!publicUrl) {
    fatal(
      'ARCHIE_PUBLIC_URL is not set. Set it to the public HTTPS URL where the daemon is reachable, ' +
      'e.g. https://archie.example.com',
    );
  }
  const redirectUri = new URL(`${publicUrl.replace(/\/+$/, '')}/oauth/callback`).toString();

  const result = await beginConnect({
    serverName,
    redirectUri,
    label: parsed.flags['--label'],
    clientId: parsed.flags['--client-id'],
    clientSecret: parsed.flags['--client-secret'],
    clientName: parsed.flags['--client-name'],
  });

  process.stdout.write(`\nConnecting MCP server: ${serverName}\n`);
  process.stdout.write(`Open this URL in your browser to authorize:\n\n  ${result.authorizeUrl}\n\n`);
  if (result.scopes.length) {
    process.stdout.write(`Requested scopes: ${result.scopes.join(', ')}\n\n`);
  }
  process.stdout.write(`Waiting for the provider to redirect to:\n  ${redirectUri}\n\n`);

  const outcome = await pollForCompletion(serverName, result.state);
  if (outcome.ok) {
    process.stdout.write(`✓ Connected. Run "npm run oauth:list" to confirm.\n`);
  } else {
    process.stderr.write(`✗ ${outcome.message}\n`);
    process.exit(1);
  }
}

interface PollOutcome {
  ok: boolean;
  message: string;
}

async function pollForCompletion(
  serverName: string,
  state: string,
  timeoutMs = 10 * 60_000,
): Promise<PollOutcome> {
  const deadline = Date.now() + timeoutMs;
  const intervalMs = 1500;
  while (Date.now() < deadline) {
    const pending = await readPendingRecord(state);
    if (!pending) {
      // Pending file is gone — either the callback completed (vault record
      // exists) or someone else cleaned it up. Verify the vault record.
      const record = await readOAuthRecord(serverName);
      if (record) return { ok: true, message: 'connected' };
      return {
        ok: false,
        message: 'Pending state disappeared without producing a vault record (was it reaped or already revoked?)',
      };
    }
    if (pending.error) {
      // Best-effort cleanup; the daemon's reaper will catch leftovers.
      await deletePendingRecord(state).catch(() => {});
      return { ok: false, message: pending.error };
    }
    if (pending.completed_at) {
      return { ok: true, message: 'connected' };
    }
    await sleep(intervalMs);
  }
  return { ok: false, message: `Timed out after ${Math.round(timeoutMs / 60_000)}m — try again` };
}

// ---- list -------------------------------------------------------------------

async function runList(): Promise<void> {
  const names = await listOAuthServers();
  if (!names.length) {
    process.stdout.write('No OAuth records yet. Connect one with `npm run oauth:connect <server-name>`.\n');
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  process.stdout.write('Server               Label               Expires             Updated\n');
  process.stdout.write('───────────────────  ──────────────────  ──────────────────  ──────────────────\n');
  for (const name of names) {
    const record = await readOAuthRecord(name);
    if (!record) continue;
    const expiresIn = record.expires_at - now;
    const expiry = expiresIn > 0 ? `in ${formatDuration(expiresIn)}` : `expired ${formatDuration(-expiresIn)} ago`;
    const updatedAgo = formatDuration(now - record.updated_at);
    process.stdout.write(
      `${pad(name, 19)}  ${pad(record.label ?? '', 18)}  ${pad(expiry, 18)}  ${updatedAgo} ago\n`,
    );
  }
}

// ---- revoke -----------------------------------------------------------------

async function runRevoke(args: string[]): Promise<void> {
  const serverName = args[0];
  if (!serverName) fatal('Usage: oauth:revoke <server-name>');
  const removed = await deleteOAuthRecord(serverName);
  if (removed) {
    process.stdout.write(`Revoked OAuth record for "${serverName}".\n`);
  } else {
    process.stdout.write(`No OAuth record for "${serverName}" — nothing to do.\n`);
  }
}

// ---- refresh ----------------------------------------------------------------

async function runRefresh(args: string[]): Promise<void> {
  const serverName = args[0];
  if (!serverName) fatal('Usage: oauth:refresh <server-name>');
  // Force a refresh by claiming the token already expired.
  const farFuture = Date.now() + 365 * 24 * 60 * 60 * 1000;
  const result = await ensureFreshToken(serverName, farFuture).catch((err) => {
    fatal(err);
  });
  if (!result) return;
  process.stdout.write(
    `Refreshed "${serverName}" — token now expires at ${new Date(result.expiresAt * 1000).toISOString()}\n`,
  );
}

// ---- helpers ----------------------------------------------------------------

function parseArgs(args: string[], schema: { flags: string[] }): {
  positional: string[];
  flags: Record<string, string | undefined>;
} {
  const flags: Record<string, string | undefined> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (schema.flags.includes(arg)) {
      const value = args[i + 1];
      if (value === undefined || schema.flags.includes(value)) {
        fatal(`Flag ${arg} requires a value`);
      }
      flags[arg] = value;
      i++;
    } else if (arg.startsWith('--')) {
      fatal(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + ' '.repeat(width - s.length);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function fatal(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

main().catch((err) => fatal(err));
