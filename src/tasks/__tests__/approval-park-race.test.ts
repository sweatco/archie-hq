/**
 * Regression tests for a user's answer that arrives while the PM turn that asked for it is still running.
 *
 * `request_max_mode`, `request_edit_mode` and the research-budget gate park the task by arming a teardown that the spawn loop runs when the turn's SDK `result` arrives. The answer reaches the PM inside that same turn. A handler that leaves the park armed lets the PM act on the answer while `report_completion` refuses to post ("Task already stopping"), and the stop then fires at turn end: the task ends `stopped` and the PM's reply is never posted. Observed on 2026-11-24 for every max-mode request denied about a second after it was made.
 *
 * Drives the real request tools, Task handlers, Agent teardown slot and `report_completion` on a minimal fake task (no LLM, no SDK, no Slack).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../persistence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../persistence.js')>();
  return { ...actual, appendAgentFinding: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../system/logger.js', () => ({
  logger: {
    system: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    slack: vi.fn(),
    agentAction: vi.fn(),
    agentFinding: vi.fn(),
    agentToSlack: vi.fn(),
  },
}));

vi.mock('../../system/event-bus.js', () => ({ emitEvent: vi.fn() }));

import { Task } from '../task.js';
import { Agent } from '../../agents/agent.js';
import { createOrchestrationMcpServer } from '../../agents/tools.js';
import { mcpToolHandler } from '../../test-support/mcp.js';
import type { TaskMetadata } from '../../types/task.js';

const CHANNEL = 'slack:C1:1.0';
const REPLY = 'Your order #42 shipped on Monday.';

type FakeTask = {
  taskId: string;
  metadata: Partial<TaskMetadata>;
  isActive: boolean;
  completionIntent: boolean;
  agent: Agent;
  budgets: { researchRequestCount: number; researchRequestLimit: number };
  statusController: { suspend: ReturnType<typeof vi.fn> };
  postInteractiveToUser: ReturnType<typeof vi.fn>;
  postToUser: ReturnType<typeof vi.fn>;
  resurfacePrCards: ReturnType<typeof vi.fn>;
  suspendStatus: ReturnType<typeof vi.fn>;
  touch: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  debouncedSave: ReturnType<typeof vi.fn>;
};

/**
 * Built on `Task.prototype` so the handlers reach the real `notifyPm` and `setCompletionIntent`; every effect they lead to is an explicit mock on the instance.
 */
function makeFakeTask(agent: Agent): FakeTask {
  return Object.assign(Object.create(Task.prototype) as object, {
    taskId: 'task-123',
    metadata: {
      channels: {
        [CHANNEL]: {
          type: 'slack',
          channel_id: 'C1',
          thread_id: '1.0',
          channel_name: 'orders',
          last_processed_ts: '1.0',
        },
      },
      default_channel: CHANNEL,
      repositories: [],
    },
    isActive: true,
    completionIntent: false,
    agent,
    budgets: { researchRequestCount: 5, researchRequestLimit: 5 },
    statusController: { suspend: vi.fn() },
    postInteractiveToUser: vi.fn().mockResolvedValue(undefined),
    postToUser: vi.fn().mockResolvedValue(undefined),
    resurfacePrCards: vi.fn().mockResolvedValue(undefined),
    suspendStatus: vi.fn(),
    touch: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    debouncedSave: vi.fn(),
  }) as FakeTask;
}

function makePm(): Agent {
  return new Agent({
    id: 'pm-agent',
    key: 'pm',
    role: 'PM',
    expertise: '',
    isPm: true,
    pluginName: 'pm',
    visibility: 'global',
  });
}

function callTool(agent: Agent, task: FakeTask, name: string, args: unknown) {
  return mcpToolHandler(createOrchestrationMcpServer(agent, task as unknown as Task), name)(args);
}

/** What the spawn loop does when the turn's SDK `result` arrives. */
async function endTurn(agent: Agent): Promise<void> {
  await agent.pendingTeardown?.();
}

type Park = (agent: Agent, task: FakeTask) => Promise<unknown>;

const requestMaxMode: Park = (agent, task) =>
  callTool(agent, task, 'request_max_mode', { reason: 'needs deeper reasoning' });
const requestEditMode: Park = (agent, task) =>
  callTool(agent, task, 'request_edit_mode', { reason: 'apply the fix' });
const exceedResearchBudget: Park = (_agent, task) =>
  Task.prototype.onResearchBudgetExceeded.call(task as unknown as Task);

const answers: {
  name: string;
  park: Park;
  answer: (task: FakeTask) => Promise<void>;
  notice: string;
}[] = [
  {
    name: 'max mode denied',
    park: requestMaxMode,
    answer: (task) => Task.prototype.handleMaxModeDenial.call(task as unknown as Task),
    notice: 'Max mode denied',
  },
  {
    name: 'max mode approved',
    park: requestMaxMode,
    answer: (task) => Task.prototype.handleMaxModeApproval.call(task as unknown as Task, 'Dana'),
    notice: 'Max mode approved',
  },
  {
    name: 'edit mode denied',
    park: requestEditMode,
    answer: (task) => Task.prototype.handleEditModeDenial.call(task as unknown as Task),
    notice: 'Edit mode denied',
  },
  {
    name: 'research budget denied',
    park: exceedResearchBudget,
    answer: (task) => Task.prototype.handleResearchBudgetDenial.call(task as unknown as Task),
    notice: 'Additional research denied',
  },
  {
    name: 'research budget approved',
    park: exceedResearchBudget,
    answer: (task) => Task.prototype.handleResearchBudgetApproval.call(task as unknown as Task),
    notice: 'Research budget extended',
  },
];

beforeEach(() => vi.clearAllMocks());

describe('an answer that arrives before the requesting turn ends', () => {
  it.each(answers)(
    '$name: the PM can still post its reply and the task keeps running',
    async ({ park, answer, notice }) => {
      const agent = makePm();
      const task = makeFakeTask(agent);

      await park(agent, task);
      expect(agent.pendingTeardown).toBeDefined();

      await answer(task);
      expect(task.sendMessage).toHaveBeenCalledWith(expect.stringContaining(notice));

      const result = await callTool(agent, task, 'report_completion', { message: REPLY });
      expect(task.postToUser).toHaveBeenCalledWith(REPLY, 'pm-agent');
      expect(result.content[0]?.text).toMatch(/Message posted/);

      await endTurn(agent);
      expect(task.stop).not.toHaveBeenCalled();
    },
  );
});
