// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runtimeDiagnostics, sdkExecutionErrors } from './diagnostics.js';
import { checks } from './types.js';
import { fixtures } from './corpus.js';

it('retains only tool names, stop reasons and SDK result status/turns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archie-diagnostics-'));
  try {
    await mkdir(join(root, 'shared'));
    const project = join(root, 'claude/pm/session/projects/test'); await mkdir(project, { recursive: true });
    await writeFile(join(root, 'shared/usage.jsonl'), JSON.stringify({ subtype: 'error_max_turns', num_turns: 4, usage: 'PRIVATE_USAGE', error: 'PRIVATE_ERROR' }));
    await writeFile(join(project, 'session.jsonl'), JSON.stringify({ type: 'assistant', message: { stop_reason: 'tool_use', content: [
      { type: 'text', text: 'PRIVATE_TEXT' }, { type: 'tool_use', name: 'ToolSearch', input: { query: 'PRIVATE_QUERY' } },
    ] } }));
    expect(await runtimeDiagnostics(root)).toEqual({ toolNames: ['ToolSearch'], stopReasons: ['tool_use'], results: [{ subtype: 'error_max_turns', turns: 4 }], errors: [] });
    await writeFile(join(project, 'malformed.jsonl'), 'PRIVATE_MALFORMED');
    expect((await runtimeDiagnostics(root)).errors).toEqual(['diagnostics:malformed-json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('fails execution on SDK errors or incomplete diagnostics despite a delivered correct response', () => {
  const diagnostics = { toolNames: [], stopReasons: ['end_turn'], results: [{ subtype: 'success', turns: 1 }], errors: [] };
  for (const record of [
    { ...diagnostics, results: [...diagnostics.results, { subtype: 'error_max_turns', turns: 5 }] },
    { ...diagnostics, results: [] }, { ...diagnostics, stopReasons: [] }, { ...diagnostics, errors: ['diagnostics:malformed-json'] },
  ]) {
    const gates = checks(fixtures()[0], { id: 'response-facts', mode: 'fresh-sdk', status: 'completed', posts: ['Friday Morgan'],
      deliveries: [{ audience: 'cli', text: 'Friday Morgan' }], errors: sdkExecutionErrors(record), elapsedMs: 1, firstPostMs: 1, words: 2,
      usage: { sdkUsd: null, backgroundUsd: null, coverage: 'unknown' } });
    expect(gates).toEqual({ execution: false, 'required-facts': true, access: true, delivery: true });
  }
  expect(sdkExecutionErrors(diagnostics)).toEqual([]);
});
