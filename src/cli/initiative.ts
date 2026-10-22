// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { InitiativeStore } from '../proactivity/store.js';
import { ModelGateway } from '../proactivity/model.js';
import { logger } from '../system/logger.js';

export async function runInitiativeOperator(args: string[]): Promise<void> {
  const [path, team, command, ...values] = args;
  const usage = 'Use initiative <existing database> <Slack team ID> migrate | explain <matter> <output.json> | proposals <output.json> | ack <proposal> <issue URL> <filed|implementing> [note] | bind-provider <local batch ID> | reconcile-batch <provider batch ID>';
  if (!path || !team || !existsSync(path)) throw new Error(usage);
  const arities = new Map([['migrate', 0], ['explain', 2], ['proposals', 1], ['bind-provider', 1], ['reconcile-batch', 1]]);
  if (values.some(value => !value.trim())) throw new Error(usage);
  if (command === 'ack') {
    if (values.length < 3) throw new Error(usage);
    z.enum(['filed', 'implementing']).parse(values[2]);
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(values[1])) throw new Error('A repository issue URL is required');
  } else if (arities.get(command) !== values.length) throw new Error(usage);
  const store = new InitiativeStore(resolve(path), team, Date.now(), { readOnly: ['proposals', 'explain'].includes(command) });
  try {
    const gateway = new ModelGateway(store);
    if (command === 'migrate' && values.length === 0) {
      logger.system('Initiative schema is current.');
    } else if (command === 'explain' && values.length === 2) {
      await writeFile(values[1], JSON.stringify(store.explain(values[0]), null, 2), { mode: 0o600 });
    } else if (command === 'bind-provider' && values.length === 1) {
      gateway.bindProvider(values[0]);
    } else if (command === 'reconcile-batch' && values.length === 1) {
      await gateway.reconcileRemote(values[0], AbortSignal.timeout(45_000));
    } else if (command === 'proposals' && values.length === 1) {
      await writeFile(values[0], JSON.stringify(store.listProposals(), null, 2), { mode: 0o600 });
    } else if (command === 'ack' && values.length >= 3) {
      store.acknowledgeDevelopment(values[0], values[1], z.enum(['filed', 'implementing']).parse(values[2]), values.slice(3).join(' ').slice(0, 1200) || undefined);
    } else throw new Error(usage);
  } finally { store.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runInitiativeOperator(process.argv.slice(2)).catch((error) => { logger.error('initiative', 'Operator command failed', error); process.exitCode = 1; });
}
