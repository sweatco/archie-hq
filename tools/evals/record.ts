/**
 * Print the graded session record of one task folder as JSON.
 *
 *   npx tsx tools/evals/record.ts <task-folder> [options]
 *
 * The record contains the task's message text. For a production folder, keep
 * the output in the private location outside the repository; see
 * docs/guides/behaviour-evals.md.
 */

import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { z } from 'zod';
import { gradeRecord, parseToolMatcher, type Assertions } from './graders.js';
import { buildSessionRecord, type SessionRecord } from './session-record.js';

const USAGE = `Usage: npx tsx tools/evals/record.ts <task-folder> [options]

Options (each assertion option is repeatable):
  --source production|eval        Where the folder came from (default: production)
  --expect-state STATE            completed, stopped, in_progress, preparing or approval_requested
  --called TOOL                   TOOL was called
  --not-called TOOL               TOOL was never called
  --order TOOL,TOOL,...           The tools were called in this order
  --approval-before APPROVAL,MUTATION
                                  Every successful MUTATION follows its own APPROVAL call

TOOL is Skill(name), Agent(type), a full tool name or an MCP tool's short name.
Exits 1 when an assertion fails, 2 on a usage error.`;

const sourceSchema = z.enum(['production', 'eval']);
const terminalStateSchema = z.enum([
  'completed',
  'stopped',
  'in_progress',
  'preparing',
  'approval_requested',
]);

interface Invocation {
  taskDir: string;
  source: SessionRecord['source'];
  assertions: Assertions;
}

export function parseInvocation(argv: string[]): Invocation {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      source: { type: 'string', default: 'production' },
      'expect-state': { type: 'string' },
      called: { type: 'string', multiple: true, default: [] },
      'not-called': { type: 'string', multiple: true, default: [] },
      order: { type: 'string', multiple: true, default: [] },
      'approval-before': { type: 'string', multiple: true, default: [] },
    },
  });
  const [taskDir, ...extra] = positionals;
  if (!taskDir || extra.length > 0) throw new Error('expected exactly one task folder');

  const approvalBeforeMutation = values['approval-before'].map((pair) => {
    const [approval, mutation, ...rest] = pair.split(',');
    if (!approval || !mutation || rest.length > 0) {
      throw new Error(`--approval-before needs APPROVAL,MUTATION, got "${pair}"`);
    }
    return { approval: parseToolMatcher(approval), mutation: parseToolMatcher(mutation) };
  });

  return {
    taskDir: resolve(taskDir),
    source: sourceSchema.parse(values.source),
    assertions: {
      terminalState: values['expect-state']
        ? terminalStateSchema.parse(values['expect-state'])
        : undefined,
      called: values.called.map(parseToolMatcher),
      notCalled: values['not-called'].map(parseToolMatcher),
      order: values.order.map((list) => list.split(',').map(parseToolMatcher)),
      approvalBeforeMutation,
    },
  };
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
  record.grades = gradeRecord(record, invocation.assertions);
  console.log(JSON.stringify(record, null, 2));

  for (const gap of gaps) console.error(`record: incomplete: ${gap}`);
  const failed = record.grades.filter((grade) => grade.pass === false);
  for (const grade of failed) console.error(`record: FAIL ${grade.grader}: ${grade.reason ?? ''}`);
  return failed.length > 0 ? 1 : 0;
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
