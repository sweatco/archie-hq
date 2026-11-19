import { cp, mkdtemp, readFile, rm, writeFile, appendFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSessionRecord } from './session-record.js';

const TASK_ID = 'task-20260101-0900-evalfx';
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', TASK_ID);
const ORIGINAL_SESSION = '11111111-1111-4111-8111-111111111111';
const PROJECT = 'claude/pm/session/projects/-workdir-sessions-task-20260101-0900-evalfx-agents-pm';

const copies: string[] = [];

/** A writable copy of the fixture, for cases that alter it. */
async function copyFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'evals-record-'));
  copies.push(root);
  const taskDir = join(root, TASK_ID);
  await cp(FIXTURE, taskDir, { recursive: true });
  return taskDir;
}

afterEach(async () => {
  for (const root of copies.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('buildSessionRecord', () => {
  it('builds turns, the tool sequence across a forked session, and cost', async () => {
    const { record, gaps } = await buildSessionRecord(FIXTURE, 'eval');

    expect(gaps).toEqual([]);
    expect(record).toMatchObject({
      source: 'eval',
      taskId: TASK_ID,
      complete: true,
      terminalState: 'completed',
      manifest: 'unknown',
    });
    expect(record.turns).toEqual([
      {
        inbound: 'Set up a weekday reminder trigger for the standup.',
        replies: ['Should the reminder go to this channel?'],
      },
      { inbound: 'Yes, post it here.', replies: ['I proposed the reminder. Approve it to start.'] },
    ]);
    // The fork repeats the first turn's calls; each appears once, and the
    // worker's call sits right after the Agent call that started it.
    expect(record.toolCalls).toEqual([
      { agent: 'pm', name: 'Skill', skill: 'core:triggers', failed: false },
      { agent: 'pm', name: 'Agent', subagentType: 'helper:assistant', failed: false },
      { agent: 'helper:assistant', name: 'Bash', failed: true },
      { agent: 'pm', name: 'mcp__orchestration-tools__list_available_repos', failed: true },
      { agent: 'pm', name: 'mcp__orchestration-tools__report_completion', failed: false },
      { agent: 'pm', name: 'mcp__orchestration-tools__propose_trigger', failed: false },
      { agent: 'pm', name: 'mcp__orchestration-tools__report_completion', failed: false },
    ]);
    expect(record.usage.costUsd).toBeCloseTo(0.12, 10);
    expect(record.usage.models).toEqual(['claude-haiku-5-5', 'claude-opus-5-5']);
  });

  it('is incomplete when a transcript holds a call the reader does not return', async () => {
    const taskDir = await copyFixture();
    const transcriptPath = join(taskDir, PROJECT, `${ORIGINAL_SESSION}.jsonl`);
    const lines = (await readFile(transcriptPath, 'utf8')).trimEnd().split('\n');
    const prompt = JSON.parse(lines[0] ?? '{}') as { uuid: string };
    // An abandoned branch off the first prompt: on disk, but not on the chain the reader follows.
    const abandoned = {
      parentUuid: prompt.uuid,
      isSidechain: false,
      type: 'assistant',
      uuid: '9d9d9d9d-0000-4000-8000-000000000001',
      timestamp: '2026-01-01T09:00:02.500Z',
      sessionId: ORIGINAL_SESSION,
      message: {
        id: 'msg_fx99',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'tool_use', id: 'toolu_fx99', name: 'mcp__github__merge', input: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    };
    lines.splice(2, 0, JSON.stringify(abandoned));
    await writeFile(transcriptPath, lines.join('\n') + '\n');

    const { record, gaps } = await buildSessionRecord(taskDir, 'production');

    expect(record.complete).toBe(false);
    expect(gaps).toEqual(['1 of 8 raw tool calls were not returned by the reader']);
    expect(record.toolCalls.map((call) => call.name)).not.toContain('mcp__github__merge');
  });

  it('is incomplete when a recorded session has no transcript', async () => {
    const taskDir = await copyFixture();
    await rm(join(taskDir, PROJECT, `${ORIGINAL_SESSION}.jsonl`));
    await rm(join(taskDir, PROJECT, ORIGINAL_SESSION), { recursive: true });

    const { record, gaps } = await buildSessionRecord(taskDir, 'production');

    expect(record.complete).toBe(false);
    expect(gaps).toEqual([`session ${ORIGINAL_SESSION} (pm) is recorded but has no transcript`]);
  });

  it('reports a task still waiting on an approval', async () => {
    const taskDir = await copyFixture();
    const metadataPath = join(taskDir, 'shared', 'metadata.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
    await writeFile(metadataPath, JSON.stringify({ ...metadata, status: 'in_progress' }));
    const eventsPath = join(taskDir, 'shared', 'events.jsonl');
    await appendFile(
      eventsPath,
      JSON.stringify({
        type: 'approval:requested',
        taskId: TASK_ID,
        timestamp: '2026-01-01T09:00:30.000Z',
        data: { text: 'Approve the trigger?', approvalType: 'trigger' },
      }) + '\n',
    );

    const { record } = await buildSessionRecord(taskDir, 'production');

    expect(record.terminalState).toBe('approval_requested');
  });

  it('leaves cost unmeasured without usage records', async () => {
    const taskDir = await copyFixture();
    await rm(join(taskDir, 'shared', 'usage.jsonl'));

    const { record } = await buildSessionRecord(taskDir, 'production');

    expect(record.usage).toEqual({ costUsd: null, models: [] });
  });

  it('rejects a folder that is not a task folder', async () => {
    await expect(buildSessionRecord(dirname(FIXTURE), 'production')).rejects.toThrow(
      'shared/metadata.json is missing',
    );
  });
});
