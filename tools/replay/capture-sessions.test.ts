// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

it('captures whole chronological MCP sessions without historical answers, secrets or native state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archie-session-capture-'));
  try {
    for (const variant of ['complete', 'localonly', 'missing', 'native', 'secret', 'overlap', 'notice', 'wrongsession', 'wrongtime', 'futureresult', 'midturn', 'prefix', 'image', 'orphan', 'duplicate', 'endlate', 'url', 'slackurl', 'wrapped']) {
      const task = join(root, 'sessions', `task-20261020-1000-${variant}`), shared = join(task, 'shared');
      const project = join(task, 'claude/pm/session/projects/test');
      await mkdir(shared, { recursive: true }); await mkdir(project, { recursive: true });
      await writeFile(join(shared, 'metadata.json'), JSON.stringify({ created_at: '2026-10-20T10:00:00Z', status: 'completed', memory_authors: { U12345678: 'Private Person' }, agent_sessions: { 'pm-agent': { session_id: 'current', active: false } } }));
      const messages = [variant === 'url' ? 'Fetch https://private.test/page.' : variant === 'slackurl' ? 'Fetch <https://private.test/page|Private URL Label>.' : 'Find the page for Private Person <@U12345678|Private Label>.', 'Now fetch that page.'];
      const events = messages.flatMap((message, i) => [{ type: 'message', timestamp: `2026-10-20T1${i}:00:00Z`, data: { from: 'Private Person', to: 'pm-agent', message } },
        ...(variant === 'overlap' && i === 0 ? [] : [{ type: 'task:completed', timestamp: `2026-10-20T1${i}:00:02Z` }])]);
      events.push({ type: 'message', data: { from: 'pm-agent', to: 'user', message: 'PRIVATE_HISTORICAL_ANSWER' } } as any);
      await writeFile(join(shared, 'events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n'));
      const records = messages.flatMap((message, i) => [
        { type: 'user', sessionId: 'current', message: { content: message } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: `tool${i}`, name: variant === 'native' ? 'Bash' : `mcp__fixture__${i ? 'fetch' : 'search'}`, input: { query: i ? '12345678-abcd-abcd-abcd-123456789abc' : ['url', 'slackurl'].includes(variant) ? 'https://private.test/page' : 'Private Person' } }] } },
        ...(variant === 'missing' ? [] : [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tool${i}`, content: JSON.stringify(variant === 'secret' ? { access_token: 'PRIVATE_TOKEN' } : { id: '12345678-abcd-abcd-abcd-123456789abc', url: 'https://private.test', email: 'private@example.test' }) }] } }]),
        { type: 'assistant', sessionId: 'current', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'PRIVATE_HISTORICAL_ANSWER' }, { type: 'tool_use', id: `reply${i}`, name: 'mcp__comms-tools__post_to_user', input: { message: 'PRIVATE_REPLY_ARGUMENT' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `reply${i}`, content: 'posted' }] } },
      ]);
      let activeTurn = 0;
      for (const record of records) {
        if (record.type === 'user' && typeof record.message.content === 'string' && messages.includes(record.message.content)) activeTurn = messages.indexOf(record.message.content);
        Object.assign(record, { sessionId: 'current', timestamp: `2026-10-20T1${activeTurn}:00:01Z` });
      }
      if (variant === 'notice') records.splice(1, 0, { type: 'user', sessionId: 'current', message: { content: 'System approval notice not accounted for in shared inputs' } } as any);
      if (variant === 'wrongsession') (records[2] as any).sessionId = 'other-session';
      if (variant === 'wrongtime') (records[2] as any).timestamp = '2026-10-20T09:00:00Z';
      if (variant === 'futureresult') records.push(records.splice(2, 1)[0]);
      if (variant === 'midturn') delete (records[3] as any).message.stop_reason;
      if (variant === 'prefix') (records[0] as any).message.content = 'SYSTEM NOTICE: runtime changed; await approval.\n\n' + messages[0];
      if (variant === 'image') (records[0] as any).message.content = [{ type: 'text', text: messages[0] }, { type: 'image', source: 'not supported' }];
      if (variant === 'orphan') records.push({ type: 'user', sessionId: 'current', message: { content: [{ type: 'tool_result', tool_use_id: 'unknown', content: 'HIDDEN_CONTEXT' }] } } as any);
      if (variant === 'duplicate') (records[1] as any).message.content.push({ ...(records[1] as any).message.content[0], input: { query: 'different' } });
      if (variant === 'endlate') (records[3] as any).timestamp = '2026-10-20T11:00:30Z';
      if (variant === 'wrapped') (records[0] as any).message.content = `New task. This is what arrived:\n\n[2026-10-20T10:00:00.000Z] [<@U12345678:Private Person> in slack:#<C12345678:fixture>:123.456 | msg:123.456] ${messages[0]}\n\nHandle it.`;
      if (variant === 'localonly') for (const index of [7, 6, 2, 1]) records.splice(index, 1);
      await writeFile(join(project, 'current.jsonl'), records.map((record) => JSON.stringify(record)).join('\n'));
    }
    const capture = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', resolve('tools/replay/capture-sessions.mts'), '2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z'], { env: { ...process.env, ARCHIE_WORKDIR: root }, encoding: 'utf8' }));
    expect(capture.sessions).toHaveLength(5);
    const control = capture.sessions.find((session: any) => session.catalog.length && session.turns[0].message.startsWith('Find'));
    const local = capture.sessions.find((session: any) => !session.catalog.length);
    expect(local.turns).toHaveLength(2);
    expect(local.turns.every((turn: any) => turn.tools.length === 0)).toBe(true);
    expect(capture.inventory).toMatchObject({ 'external-mcp': 4, 'local-reply-only': 1 });
    for (const session of capture.sessions.filter((session: any) => session.turns[0].message.startsWith('Fetch'))) expect(session.turns[0].message).toContain(session.turns[0].tools[0].input.query + '.');
    expect(capture.sessions.some((session: any) => session.turns[0].message.startsWith('New task. This is what arrived:'))).toBe(true);
    expect(control.turns).toHaveLength(2);
    expect(control.turns.map((turn: any) => turn.tools[0].name)).toEqual(['mcp__fixture__search', 'mcp__fixture__fetch']);
    expect(control.turns[0].tools[0].input.query).toMatch(/^PERSON_/);
    expect(control.catalog).toEqual([{ name: 'mcp__fixture__fetch', keys: ['query'] }, { name: 'mcp__fixture__search', keys: ['query'] }]);
    expect(capture.inventory).toMatchObject({ 'missing-or-duplicate-tool-result': 3, 'native-subagent-or-core-state-tools': 1, 'secret-pattern': 1, 'incomplete-or-overlapping-turn-history': 1 });
    expect(capture.inventory['unaccounted-sdk-user-context']).toBe(1);
    expect(capture.inventory['tool-result-boundary-mismatch']).toBe(3);
    expect(capture.inventory['missing-turn-completion']).toBe(1);
    expect(capture.inventory['unsupported-input-envelope']).toBe(2);
    expect(capture.inventory['turn-settlement-order']).toBe(1);
    for (const privateText of ['Private Person', 'Private Label', 'Private URL Label', 'PRIVATE_HISTORICAL_ANSWER', 'PRIVATE_REPLY_ARGUMENT', 'PRIVATE_TOKEN', 'private.test', 'private@example.test', '12345678-abcd']) expect(JSON.stringify(capture)).not.toContain(privateText);
  } finally { await rm(root, { recursive: true, force: true }); }
});
