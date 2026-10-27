// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const roots: string[] = [];
afterEach(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

it('selects and sanitizes automatically, quarantines gaps, and audits a WAL-consistent SQLite snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archie-capture-test-')); roots.push(root);
  const request = 'Rewrite this: "Person Secret will release Friday. Contact person@example.test, <@U87654321:Private Label> and <@U87654322|Private Pipe Label>, and use https://private.test/path for the checklist."';
  const session = 'current-session';
  for (const suffix of ['good', 'external', 'missing', 'old', 'mismatch', 'unfinished', 'nosettlement', 'descendant']) {
    const task = join(root, 'sessions', `task-20261020-1000-${suffix}`);
    const shared = join(task, 'shared'); await mkdir(shared, { recursive: true });
    await writeFile(join(shared, 'metadata.json'), JSON.stringify({ status: 'completed', created_at: '2026-10-20T10:00:00Z', agent_sessions: { 'pm-agent': { session_id: session, active: false } }, memory_authors: { U12345678: 'Person Secret' } }));
    const events = [{ type: 'message', data: { from: 'Person Secret', to: 'pm-agent', message: request } }, ...(suffix === 'nosettlement' ? [] : [{ type: 'task:completed', data: {} }])];
    await writeFile(join(shared, 'events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n'));
    if (suffix !== 'missing') {
      const transcripts = join(task, 'claude/pm/session/projects/project'); await mkdir(transcripts, { recursive: true });
      const records = [{ type: 'user', sessionId: session, message: { content: suffix === 'old' || suffix === 'mismatch' ? 'Unrelated old request' : request } },
        ...(suffix === 'old' || suffix === 'unfinished' ? [] : [{ type: 'assistant', sessionId: session, message: { stop_reason: 'end_turn', content: [{ type: 'tool_use', name: suffix === 'external' ? 'Bash' : 'mcp__orchestration-tools__report_completion' }] } }])];
      await writeFile(join(transcripts, `${suffix === 'old' ? 'old-session' : session}.jsonl`), records.map((record) => JSON.stringify(record)).join('\n'));
      if (suffix === 'descendant') {
        const child = join(transcripts, session, 'subagents/child'); await mkdir(child, { recursive: true });
        await writeFile(join(child, 'agent.jsonl'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }));
      }
      await writeFile(join(task, 'claude/pm/session/.credentials.json'), 'NEVER_EXPORT_THIS');
    }
  }
  await mkdir(join(root, 'initiative'));
  const db = new DatabaseSync(join(root, 'initiative/state.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE things(secret TEXT); INSERT INTO things VALUES (\'PRIVATE_DATABASE_TEXT\')');
  const capture = () => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', resolve('tools/replay/capture.mts'), '2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z', '2', 'fixed-seed'], { env: { ...process.env, ARCHIE_WORKDIR: root }, encoding: 'utf8' }));
  try {
    const first = capture(); const second = capture();
    expect(first.tasks).toEqual(second.tasks);
    expect(first.tasks).toHaveLength(1);
    expect(first.inventory.counts['in-window']).toBe(8);
    expect(first.inventory.counts['needs-external-state-or-tools']).toBe(2);
    expect(first.inventory.counts['missing-transcripts']).toBe(1);
    expect(first.inventory.counts['missing-current-session']).toBe(1);
    expect(first.inventory.counts['incomplete-current-session']).toBe(3);
    expect(first.initiative.tables.things).toBe(1);
    const text = JSON.stringify(first);
    for (const privateText of ['Person Secret', 'Private Label', 'Private Pipe Label', 'U87654321', 'U87654322', 'person@example.test', 'private.test', 'NEVER_EXPORT_THIS', 'PRIVATE_DATABASE_TEXT']) expect(text).not.toContain(privateText);
    expect(first.tasks[0].prompt).toMatch(/PERSON_[a-f0-9]+/);
    expect(first.initiative).not.toHaveProperty('sqlite');
  } finally { db.close(); }
});

it('captures language-neutral local-reply histories only with complete local-only discovery results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archie-discovery-test-')); roots.push(root);
  for (const variant of ['local', 'external', 'missing', 'error', 'mixed']) {
    const task = join(root, 'sessions', `task-20261020-1000-${variant}`);
    const shared = join(task, 'shared'), project = join(task, 'claude/pm/session/projects/test');
    await mkdir(shared, { recursive: true }); await mkdir(project, { recursive: true });
    const prompt = 'Добрый день, расскажи о себе.';
    await writeFile(join(shared, 'metadata.json'), JSON.stringify({ status: 'completed', created_at: '2026-10-20T10:00:00Z', agent_sessions: { 'pm-agent': { session_id: 'current', active: false } } }));
    await writeFile(join(shared, 'events.jsonl'), [{ type: 'message', data: { from: 'user', to: 'pm-agent', message: prompt } }, { type: 'task:completed' }].map((row) => JSON.stringify(row)).join('\n'));
    const local = { type: 'tool_reference', tool_name: 'mcp__orchestration-tools__report_completion' };
    const external = { type: 'tool_reference', tool_name: 'mcp__comms-tools__read_thread' };
    const rows = [{ type: 'user', sessionId: 'current', message: { content: prompt } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ToolSearch', id: 'search' }] } },
      ...(variant === 'missing' ? [] : [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'search', is_error: variant === 'error', content: variant === 'external' ? [external] : variant === 'mixed' ? [local, external] : [local] }] } }]),
      { type: 'assistant', sessionId: 'current', message: { stop_reason: 'end_turn', content: [{ type: 'tool_use', name: local.tool_name }] } }];
    await writeFile(join(project, 'current.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n'));
  }
  const captured = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', resolve('tools/replay/capture.mts'), '2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z', '2'], { env: { ...process.env, ARCHIE_WORKDIR: root }, encoding: 'utf8' }));
  expect(captured.inventory.eligible).toBe(1);
  expect(captured.inventory.counts['unproven-local-discovery']).toBe(4);
  expect(captured.tasks[0].prompt).toBe('Добрый день, расскажи о себе.');
});
