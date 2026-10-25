// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InitiativeStore } from '../proactivity/store.js';
import { logger } from '../system/logger.js';

export async function runInitiativeOperator(args: string[]): Promise<void> {
  const [path, team, command, ...values] = args;
  const usage = 'Use initiative <existing database> <Slack team ID> explain <matter> <output.json> | proposals <output.json>';
  if (!path || !team || !existsSync(path)) throw new Error(usage);
  const arities = new Map([['explain', 2], ['proposals', 1]]);
  if (values.some(value => !value.trim())) throw new Error(usage);
  if (arities.get(command) !== values.length) throw new Error(usage);
  const store = new InitiativeStore(resolve(path), team, Date.now(), { readOnly: true });
  try {
    if (command === 'explain') {
      await writeFile(values[1], JSON.stringify(store.explain(values[0]), null, 2), { mode: 0o600 });
    } else if (command === 'proposals') {
      await writeFile(values[0], JSON.stringify(store.listProposals(), null, 2), { mode: 0o600 });
    }
  } finally { store.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runInitiativeOperator(process.argv.slice(2)).catch((error) => { logger.error('initiative', 'Operator command failed', error); process.exitCode = 1; });
}
