// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ObservationStore } from '../memory/observation-store.js';
import { ModelGateway } from '../proactivity/model.js';
import { LearningService } from '../proactivity/learning.js';
import { logger } from '../system/logger.js';

export async function runInitiativeOperator(args: string[]): Promise<void> {
  const [path, team, command, ...values] = args;
  if (!path || !team || !existsSync(path)) throw new Error('Use initiative <existing database> <Slack team ID> export|cohort|evaluate|proposals|ack <arguments>');
  const store = new ObservationStore(resolve(path), team);
  try {
    // Offline operator work can label/export and acknowledge development, but cannot
    // dispatch a model request or activate policy. Activation remains owner-only in Slack.
    const learning = new LearningService(store, new ModelGateway(store), 'claude-haiku-5-5', [], async () => false);
    if (command === 'export' && values.length === 2) {
      await writeFile(values[1], JSON.stringify(learning.exportReview(values[0]), null, 2), { mode: 0o600 });
    } else if (command === 'cohort' && values.length === 2) {
      learning.freezeCohort(values[0], JSON.parse(await readFile(values[1], 'utf8')));
    } else if (command === 'evaluate' && values.length === 3) {
      const labels = JSON.parse(await readFile(values[1], 'utf8'));
      const report = learning.evaluate(values[0], labels, Date.now());
      await writeFile(values[2], JSON.stringify(report, null, 2), { mode: 0o600 });
    } else if (command === 'proposals' && values.length === 1) {
      await writeFile(values[0], JSON.stringify(store.rows('SELECT * FROM proposals').map((r) => ({ ...r, body: JSON.parse(String(r.body)) })), null, 2), { mode: 0o600 });
    } else if (command === 'ack' && values.length >= 3) {
      learning.acknowledge(values[0], values[1], z.enum(['filed', 'implementing', 'completed', 'rejected']).parse(values[2]), values.slice(3).join(' ').slice(0, 1200) || undefined);
    } else throw new Error('Use export <policy> <output.json>, cohort <policy> <ground-truth.json>, evaluate <policy> <labels.json> <report.json>, proposals <output.json>, or ack <proposal> <issue URL> <status> [outcome]');
  } finally { store.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runInitiativeOperator(process.argv.slice(2)).catch((error) => { logger.error('initiative', 'Operator command failed', error); process.exitCode = 1; });
}
