#!/usr/bin/env node
/**
 * Manual memory housekeeping entry point.
 *
 * Usage:
 *   npm run memory:housekeeping -- --target U07ABC123
 *   npm run memory:housekeeping -- --target all
 *   npm run memory:housekeeping -- --target entities
 *
 * Runs a one-shot Sonnet consolidation pass over the chosen target memory
 * file(s). Run only while the Archie service is stopped: this command is a
 * separate process and cannot share the server's in-memory extraction queue.
 */

import { runHousekeeping } from '../src/memory/housekeeping.js';

function parseArgs(argv: string[]): { target: string } {
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--target' || argv[i] === '-t') && argv[i + 1]) {
      return { target: argv[i + 1] };
    }
  }
  return { target: 'all' };
}

async function main() {
  const { target } = parseArgs(process.argv.slice(2));
  console.log(`[memory-housekeeping] running with target=${target}`);
  await runHousekeeping(target);
  console.log('[memory-housekeeping] done');
}

main().catch((err) => {
  console.error('[memory-housekeeping] failed:', err);
  process.exit(1);
});
