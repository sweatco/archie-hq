import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import type { AgentDef } from '../../types/agent.js';

const fixture = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return {
    root: mkdtempSync(join(tmpdir(), 'archie-reaction-tools-')),
    add: vi.fn(),
    post: vi.fn(),
    action: vi.fn(),
  };
});

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn(function () {
    return {
      auth: { test: vi.fn().mockResolvedValue({ user_id: 'UBOT', team_id: 'T1' }) },
      reactions: { add: fixture.add },
      chat: { postMessage: fixture.post },
    };
  }),
}));
vi.mock('../../system/workdir.js', async (original) => ({
  ...(await original<typeof import('../../system/workdir.js')>()),
  SESSIONS_DIR: fixture.root,
}));
vi.mock('../../system/plugin-sync.js', () => ({ syncPlugins: vi.fn() }));
vi.mock('../registry.js', async (original) => ({
  ...(await original<typeof import('../registry.js')>()),
  scanPmDef: (): AgentDef => ({
    id: 'pm-agent',
    key: 'pm',
    role: 'PM',
    expertise: '',
    pluginName: 'core',
    visibility: 'global',
    isPm: true,
  }),
}));
vi.mock('../../system/logger.js', () => ({
  logger: {
    agentAction: fixture.action,
    system: vi.fn(),
    slack: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { Agent } from '../agent.js';
import { Task } from '../../tasks/task.js';
import { initSlackClient, setSlackDryRun } from '../../connectors/slack/client.js';
import { createCommsMcpServer, createOrchestrationMcpServer } from '../tools.js';
import { mcpToolHandler } from '../../test-support/mcp.js';

const MESSAGE = '1790000000.000100';
const DEFAULT = 'slack:C1:1790000000.000001';
const LINKED = 'slack:C1:1790000000.000002';

beforeEach(async () => {
  vi.clearAllMocks();
  fixture.add.mockReset().mockResolvedValue({ ok: true });
  await mkdir(fixture.root, { recursive: true });
  setSlackDryRun(false);
  await initSlackClient('xoxb-test');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(fixture.root, { recursive: true, force: true });
});

async function linkedTask(): Promise<Task> {
  const task = await Task.create();
  task.metadata.channels = {
    [DEFAULT]: {
      type: 'slack',
      channel_id: 'C1',
      thread_id: '1790000000.000001',
      channel_name: 'one',
      last_processed_ts: MESSAGE,
    },
    [LINKED]: {
      type: 'slack',
      channel_id: 'C1',
      thread_id: '1790000000.000002',
      channel_name: 'one',
      last_processed_ts: MESSAGE,
    },
  };
  task.metadata.default_channel = DEFAULT;
  task.metadata.memory_destination = { channel_id: 'C1' };
  return task;
}

function react(task: Task) {
  return mcpToolHandler(createCommsMcpServer(new Agent(task.pmDef), task), 'react_to_message');
}

describe('react_to_message through Task and the Slack client', () => {
  it.each([undefined, LINKED])('confirms a reaction in channel %s', async (channel) => {
    const task = await linkedTask();
    const result = await react(task)({ message_id: MESSAGE, emoji: ' :thumbsup: ', channel });

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('Added :thumbsup:');
    expect(fixture.add).toHaveBeenCalledExactlyOnceWith({
      channel: 'C1',
      timestamp: MESSAGE,
      name: 'thumbsup',
    });
    expect(fixture.action).toHaveBeenCalledWith('pm-agent', 'Reacted :thumbsup:', MESSAGE);
    expect(task.completionIntent).toBe(false);
    expect(fixture.post).not.toHaveBeenCalled();
  });

  it('accepts an existing reaction without retrying', async () => {
    const task = await linkedTask();
    fixture.add.mockRejectedValue({ data: { error: 'already_reacted' } });

    const result = await react(task)({ message_id: MESSAGE, emoji: 'thumbsup' });

    expect(result.isError).not.toBe(true);
    expect(fixture.add).toHaveBeenCalledTimes(1);
    expect(fixture.action).toHaveBeenCalledOnce();
  });

  it.each(['missing_scope', 'invalid_name', 'message_not_found'])(
    'reports %s without success',
    async (code) => {
      const task = await linkedTask();
      fixture.add.mockRejectedValue({
        data: { error: code },
        message: 'private transport details',
      });

      const result = await react(task)({ message_id: MESSAGE, emoji: 'thumbsup' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(`Error: Reaction was not confirmed (${code}).`);
      expect(fixture.action).not.toHaveBeenCalled();
      expect(fixture.add).toHaveBeenCalledTimes(1);
      expect(fixture.post).not.toHaveBeenCalled();
      expect(task.completionIntent).toBe(false);
    },
  );

  it.each([
    new Error('connection reset: private transport details'),
    { data: { error: 'xoxb-sensitive-token / diagnostic' } },
    { data: { error: 123 } },
    null,
  ])('reports unknown failures without exposing transport details: %j', async (failure) => {
    const task = await linkedTask();
    fixture.add.mockRejectedValue(failure);

    const result = await react(task)({ message_id: MESSAGE, emoji: 'thumbsup' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Error: Reaction was not confirmed (unknown_error).');
    expect(fixture.action).not.toHaveBeenCalled();
  });

  it.each([undefined, 'slack:CUNKNOWN:1.0'])(
    'refuses an unresolved channel %s',
    async (channel) => {
      const task = await Task.create();

      const result = await react(task)({ message_id: MESSAGE, emoji: 'thumbsup', channel });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).not.toContain('Added');
      expect(fixture.add).not.toHaveBeenCalled();
      expect(fixture.action).not.toHaveBeenCalled();
    },
  );

  it('preserves the destination guard even for a linked thread', async () => {
    const task = await linkedTask();
    const other = 'slack:C2:1.0';
    task.metadata.channels[other] = {
      type: 'slack',
      channel_id: 'C2',
      thread_id: '1.0',
      channel_name: 'two',
      last_processed_ts: MESSAGE,
    };

    const result = await react(task)({ message_id: MESSAGE, emoji: 'thumbsup', channel: other });

    expect(result.isError).toBe(true);
    expect(fixture.add).not.toHaveBeenCalled();
    expect(fixture.action).not.toHaveBeenCalled();
  });

  it('propagates failures from Task until the tool handles them', async () => {
    const task = await linkedTask();
    const failure = new Error('connection reset');
    fixture.add.mockRejectedValue(failure);

    await expect(task.reactToMessage(MESSAGE, 'thumbsup')).rejects.toBe(failure);
  });

  it('allows an ordinary reaction-only turn to complete without posting text', async () => {
    const task = await linkedTask();
    task.isActive = true;
    await react(task)({ message_id: MESSAGE, emoji: 'thumbsup' });
    const finish = mcpToolHandler(
      createOrchestrationMcpServer(new Agent(task.pmDef), task),
      'report_completion',
    );

    const result = await finish({});

    expect(result.isError).not.toBe(true);
    expect(task.completionIntent).toBe(true);
    expect(fixture.post).not.toHaveBeenCalled();
  });

  it('does not let a reaction satisfy a proactive task owner reply', async () => {
    const task = await Task.prepare({
      taskId: 'task-20261116-1200-reaction',
      correlation: 'initiative:test',
      version: 'v1',
      actor: 'UOWNER',
      brief: 'Investigate the approved work.',
      destination: { channel: 'D1', thread: '1790000000.000001', name: 'Owner' },
    });
    task.isActive = true;
    await react(task)({ message_id: MESSAGE, emoji: 'thumbsup' });
    const finish = mcpToolHandler(
      createOrchestrationMcpServer(new Agent(task.pmDef), task),
      'report_completion',
    );

    const result = await finish({});

    expect(result.content[0].text).toContain('Cannot finish silently');
    expect(task.metadata.approved_start?.owner_reply_delivered).toBeUndefined();
    expect(task.completionIntent).toBe(false);
    expect(fixture.post).not.toHaveBeenCalled();
  });
});
