/**
 * Print the session record of one task folder as JSON.
 *
 *   npx tsx tools/evals/record.ts <task-folder> [--source production|eval]
 *
 * The record contains the task's message text. For a production folder, keep
 * the output in the private location outside the repository; see
 * docs/guides/behaviour-evals.md. Grading runs through promptfoo instead.
 */

import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { z } from 'zod';
import { buildSessionRecord, type SessionRecord } from './session-record.js';

const USAGE = 'Usage: npx tsx tools/evals/record.ts <task-folder> [--source production|eval]';

const sourceSchema = z.enum(['production', 'eval']);

interface Invocation {
  taskDir: string;
  source: SessionRecord['source'];
}

export function parseInvocation(argv: string[]): Invocation {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { source: { type: 'string', default: 'production' } },
  });
  const [taskDir, ...extra] = positionals;
  if (!taskDir || extra.length > 0) throw new Error('expected exactly one task folder');
  return { taskDir: resolve(taskDir), source: sourceSchema.parse(values.source) };
}

async function main(): Promise<number> {
  let invocation: Invocation;
  try {
    invocation = parseInvocation(process.argv.slice(2));
  } catch (error) {
    console.error(`record: ${error instanceof Error ? error.message : String(error)}\n`);
    console.error(USAGE);
    return 2;
  }

  const { record, gaps } = await buildSessionRecord(invocation.taskDir, invocation.source);
  console.log(JSON.stringify(record, null, 2));
  for (const gap of gaps) console.error(`record: incomplete: ${gap}`);
  return 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`record: ERROR — ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
