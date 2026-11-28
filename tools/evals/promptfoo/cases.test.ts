/**
 * Contract test for the case files of live runs: a case that the live provider
 * would refuse, or an assertion whose config is malformed, should fail here
 * and not in a run that is paid for.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { evalCaseSchema } from '../live-driver.js';
import type { SessionRecord } from '../session-record.js';
import * as assertions from './assertions.js';

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const CASE_FILES = ['paired.promptfooconfig.yaml', 'baseline.promptfooconfig.yaml'];
const OWN_ASSERTION = /^file:\/\/assertions\.ts:(\w+)$/;

const configSchema = z.object({
  tests: z
    .array(
      z.object({
        description: z.string().min(1),
        metadata: z.object({ guards: z.string().min(1) }),
        vars: z.unknown(),
        assert: z
          .array(
            z.object({
              type: z.string(),
              value: z.unknown().optional(),
              config: z.record(z.string(), z.unknown()).optional(),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});

/** The root install has no YAML parser of its own; gray-matter reads YAML as front matter. */
function readCases(file: string) {
  const yaml = readFileSync(join(PACKAGE_DIR, file), 'utf8');
  return configSchema.parse(matter(`---\n${yaml}\n---\n`).data).tests;
}

/** A record of a trial that played every turn and did nothing: enough for an assertion to read its config. */
function emptyRecord(turns: number): SessionRecord {
  return {
    source: 'eval',
    taskId: 'task-20260101-0900-cases',
    turns: Array.from({ length: turns }, () => ({ inbound: '', replies: [] })),
    toolCalls: [],
    complete: true,
    terminalState: 'completed',
    usage: { costUsd: null, models: [] },
    manifest: 'unknown',
  };
}

describe.each(CASE_FILES)('%s', (file) => {
  const cases = readCases(file);

  it('names each case once', () => {
    const caseIds = cases.map((test) => evalCaseSchema.parse(test.vars).caseId);
    expect(new Set(caseIds).size).toBe(caseIds.length);
  });

  it.each(cases)('$description', (test) => {
    const evalCase = evalCaseSchema.parse(test.vars);
    const record = emptyRecord(evalCase.turns.length);

    for (const assertion of test.assert) {
      if (assertion.type !== 'javascript') continue;
      const name = OWN_ASSERTION.exec(String(assertion.value))?.[1];
      const grade = Object.entries(assertions).find(([exported]) => exported === name)?.[1];
      if (!grade)
        throw new Error(`${String(assertion.value)} is not an assertion in assertions.ts`);

      // Throws on a malformed config.
      grade('', { config: assertion.config, providerResponse: { metadata: { record } } });
      const turn = assertion.config?.['turn'];
      if (typeof turn === 'number') expect(turn).toBeLessThanOrEqual(evalCase.turns.length);
    }
  });
});
