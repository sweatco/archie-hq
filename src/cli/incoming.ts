#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Incoming events operator CLI. Run it where the daemon runs: both use the same inbox and secrets. */

import 'dotenv/config';
import {
  assertNotRootBesideDaemon,
  isIncomingCommand,
  runIncomingCommand,
  USAGE,
} from '../incoming/operator.js';
import { incomingEventsEnabled, incomingSecrets, openIncomingStore } from '../incoming/runtime.js';
import { validateMasterKey } from '../system/secrets-vault.js';
import { loadMetadata } from '../tasks/persistence.js';
import { loadTrigger, triggerExists } from '../system/trigger-store.js';
import { SECRETS_DIR, WORKDIR } from '../system/workdir.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    process.stdout.write(USAGE);
    process.exitCode = args.length === 0 ? 1 : 0;
    return;
  }
  // Everything that can refuse the command is checked before anything is created or changed.
  if (!isIncomingCommand(args[0])) throw new Error(`Unknown command: ${args[0]}\n\n${USAGE}`);
  const daemonAccepts = incomingEventsEnabled();
  validateMasterKey();
  assertNotRootBesideDaemon(process.getuid?.(), [WORKDIR, SECRETS_DIR]);

  const store = openIncomingStore();
  try {
    const taskStatus = async (taskId: string) => (await loadMetadata(taskId))?.status ?? null;
    await runIncomingCommand(
      args,
      { store, secrets: incomingSecrets(), loadTrigger, triggerExists, taskStatus },
      (line) => {
        process.stdout.write(`${line}\n`);
      },
    );
  } finally {
    store.close();
  }
  if (!daemonAccepts)
    process.stdout.write(
      'Note: ARCHIE_INCOMING_EVENTS is not on here, so the daemon does not accept deliveries.\n',
    );
}

main().catch((error: unknown) => {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
