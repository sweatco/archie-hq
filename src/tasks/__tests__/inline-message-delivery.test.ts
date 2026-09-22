/**
 * Inline delivery regression test.
 *
 * A Slack message reaching a task must arrive IN the PM's stream — author,
 * channel, timestamp, body — not as a pointer telling the PM to go and read
 * knowledge.log. The log is still written (the memory extractor and the
 * spawn-time people section read it after the fact), but nothing on the live
 * path reads it back, and the PM prompt no longer mentions it: a wake that only
 * says "something arrived" is one the PM cannot act on.
 *
 * The chain is exercised end to end with the real renderer, the real
 * persistence write and the real message queue — the only stub is the SDK
 * spawn. That matters because the guarantee is an EQUALITY: the text queued for
 * the PM is the line on disk, character for character, so the `msg:<ts>` id the
 * PM is told to pass to the reaction tools is the one that was recorded.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdir, rm, readFile } from 'fs/promises';
import { join } from 'path';

const SESSIONS_ROOT = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join: j } = await import('node:path');
  const { tmpdir } = await import('node:os');
  return mkdtempSync(j(tmpdir(), 'archie-inline-delivery-'));
});

vi.mock('../../system/workdir.js', () => ({
  SESSIONS_DIR: SESSIONS_ROOT,
  WORKDIR: SESSIONS_ROOT,
}));

vi.mock('../../system/logger.js', () => ({
  logger: {
    warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
    agent: vi.fn(), slack: vi.fn(), agentToSlack: vi.fn(),
  },
}));

// No SDK subprocess — just enough of a handle that the per-Agent isRunning
// guard behaves as in production.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('../../agents/spawn.js', () => ({ spawnAgent: spawnMock }));

import { Task, activeTasks } from '../task.js';
import { MessageQueue } from '../../agents/message-queue.js';
import { AGENT_PROMPTS } from '../../agents/prompts.js';
import { getKnowledgeLogPath, getSharedPath } from '../persistence.js';
import type { TaskMetadata, SlackThread } from '../../types/task.js';
import type { AgentDef } from '../../types/agent.js';

const TaskCtor = Task as unknown as new (
  taskId: string,
  metadata: TaskMetadata,
  pmDef: AgentDef,
) => Task;

const TASK_ID = 'task-20260910-1200-inline';

function metadata(): TaskMetadata {
  return {
    task_id: TASK_ID,
    channels: {},
    default_channel: null,
    agent_sessions: {},
    repositories: [],
    status: 'in_progress',
    created_at: '2026-09-10T12:00:00.000Z',
    updated_at: '2026-09-10T12:00:00.000Z',
  };
}

function pmDef(): AgentDef {
  return { id: 'pm-agent', key: 'pm', isPm: true, pluginName: 'pm' } as AgentDef;
}

function thread(): SlackThread {
  return {
    threadId: '1757505600.000100',
    channel: { id: 'C_ENG', name: 'engineering' },
    shared: false,
    currentMessageTs: '1757505600.000200',
    rootAuthorWasBot: false,
    messages: [
      {
        user: { id: 'U1', username: 'dana', realName: 'Dana Scully' },
        ownText: 'can you ship the release notes today',
        ts: '1757505600.000100',
      },
      {
        user: { id: 'U2', username: 'fox', realName: 'Fox Mulder' },
        ownText: 'the draft is in the doc',
        ts: '1757505600.000200',
      },
    ],
  } as SlackThread;
}

afterAll(async () => {
  await rm(SESSIONS_ROOT, { recursive: true, force: true });
});

describe('a Slack message appended to a task reaches the PM inline', () => {
  let addSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    spawnMock.mockReset();
    spawnMock.mockImplementation(async (agent: { handle?: unknown }) => {
      agent.handle = { isRunning: true, running: new Promise<void>(() => {}), abort: vi.fn() };
    });
    addSpy = vi.spyOn(MessageQueue.prototype, 'addMessage');
    activeTasks.delete(TASK_ID);
    await mkdir(getSharedPath(TASK_ID), { recursive: true });
  });

  afterEach(async () => {
    activeTasks.delete(TASK_ID);
    addSpy.mockRestore();
    vi.clearAllTimers();
    vi.useRealTimers();
    await rm(join(SESSIONS_ROOT, TASK_ID), { recursive: true, force: true });
  });

  it('queues the author, the channel, the message id and the body — not a pointer', async () => {
    const task = new TaskCtor(TASK_ID, metadata(), pmDef());

    const { entries } = await task.append(thread());
    await task.sendMessage(AGENT_PROMPTS.inboundActivity(entries));

    const queued = addSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(queued).toHaveLength(1);
    const wake = queued[0]!;

    // The content itself, both messages of the batch.
    expect(wake).toContain('can you ship the release notes today');
    expect(wake).toContain('the draft is in the doc');
    // Author, in the mention form the PM is told to copy.
    expect(wake).toContain('<@U1:Dana Scully>');
    expect(wake).toContain('<@U2:Fox Mulder>');
    // Where it was said, and which message it was — the id the reaction tools take.
    expect(wake).toContain('slack:#<C_ENG:engineering>:1757505600.000100');
    expect(wake).toContain('msg:1757505600.000100');
    // And no instruction to go and fetch any of it.
    expect(wake).not.toContain('knowledge.log');
  });

  it('queues exactly the lines it wrote to the log', async () => {
    const task = new TaskCtor(TASK_ID, metadata(), pmDef());

    const { entries } = await task.append(thread());
    await task.sendMessage(AGENT_PROMPTS.inboundActivity(entries));

    const logged = (await readFile(getKnowledgeLogPath(TASK_ID), 'utf-8'))
      .split('\n')
      .filter((l) => l.trim().length > 0);

    expect(entries).toEqual(logged);
    const wake = String(addSpy.mock.calls[0]![0]);
    for (const line of logged) expect(wake).toContain(line);
  });

  it('keeps each event a wake of its own, so a busy PM loses nothing', async () => {
    const task = new TaskCtor(TASK_ID, metadata(), pmDef());

    // First event: the thread is linked and both messages are ingested.
    const first = await task.append(thread());
    await task.sendMessage(AGENT_PROMPTS.inboundActivity(first.entries));

    // Second event on the same thread while the PM is still busy: only the new
    // message is appended, and it rides its own wake rather than being folded
    // into the previous one.
    const followUp = thread();
    followUp.messages = [
      ...followUp.messages,
      {
        user: { id: 'U1', username: 'dana', realName: 'Dana Scully' },
        ownText: 'actually make it tomorrow',
        ts: '1757505600.000300',
      },
    ];
    followUp.currentMessageTs = '1757505600.000300';
    const second = await task.append(followUp);
    await task.sendMessage(AGENT_PROMPTS.inboundActivity(second.entries));

    const queued = addSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(queued).toHaveLength(2);
    expect(second.entries).toHaveLength(1);
    expect(queued[1]).toContain('actually make it tomorrow');
    // The second wake is not a re-delivery of the first.
    expect(queued[1]).not.toContain('can you ship the release notes today');
  });
});
