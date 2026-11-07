// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function runtimeDiagnostics(taskPath: string) {
  const toolNames = new Set<string>(), stopReasons = new Set<string>();
  const results: { subtype: string; turns: number }[] = [], errors: string[] = [];
  const safeName = (value: unknown): value is string => typeof value === 'string' && /^[\w:.-]{1,150}$/.test(value);
  const records = async (path: string) => {
    try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
    catch (error) { errors.push(`diagnostics:${(error as NodeJS.ErrnoException).code ?? 'malformed-json'}`); return []; }
  };
  for (const record of await records(join(taskPath, 'shared/usage.jsonl'))) {
    if (safeName(record.subtype) && Number.isInteger(record.num_turns)) results.push({ subtype: record.subtype, turns: record.num_turns });
    else errors.push('diagnostics:invalid-sdk-result');
  }
  const projectPath = join(taskPath, 'claude/pm/session/projects');
  let files: string[] = [];
  try { files = (await readdir(projectPath, { recursive: true })).filter((file) => file.endsWith('.jsonl')); }
  catch (error) { errors.push(`diagnostics:${(error as NodeJS.ErrnoException).code ?? 'unreadable-transcripts'}`); }
  if (!files.length) errors.push('diagnostics:missing-transcripts');
  for (const file of files) for (const record of await records(join(projectPath, file))) {
    if (record.type !== 'assistant') continue;
    if (safeName(record.message?.stop_reason)) stopReasons.add(record.message.stop_reason);
    for (const block of Array.isArray(record.message?.content) ? record.message.content : []) {
      if (block.type === 'tool_use' && safeName(block.name)) toolNames.add(block.name);
    }
  }
  return { toolNames: [...toolNames].sort(), stopReasons: [...stopReasons].sort(), results, errors };
}

export function sdkExecutionErrors(diagnostics: Awaited<ReturnType<typeof runtimeDiagnostics>>): string[] {
  return [...diagnostics.errors, ...(diagnostics.results.length ? [] : ['No recorded SDK result']),
    ...(diagnostics.stopReasons.length ? [] : ['No recorded SDK stop reason']),
    ...diagnostics.results.filter((result) => result.subtype !== 'success').map((result) => `SDK ${result.subtype} (${result.turns} reported turns)`)];
}
