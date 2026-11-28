import { describe, it, expect, vi } from 'vitest';

vi.mock('../persistence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../persistence.js')>();
  return { ...actual, appendAgentFinding: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../system/logger.js', () => ({
  logger: { agentAction: vi.fn(), debug: vi.fn(), error: vi.fn(), system: vi.fn(), warn: vi.fn() },
}));

import { Task } from '../task.js';
import { Agent } from '../../agents/agent.js';
import { createOrchestrationMcpServer } from '../../agents/tools.js';
import { mcpToolHandler } from '../../test-support/mcp.js';

function makeFakeTask(agent: Agent) {
  return Object.assign(Object.create(Task.prototype) as object, {
    taskId: 'task-123',
    metadata: { channels: {}, home_channel: { channel_id: 'C1', channel_name: 'orders' } },
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
  });
}
type FakeTask = ReturnType<typeof makeFakeTask>;

const callTool = (agent: Agent, task: FakeTask, name: string, args: unknown) =>
  mcpToolHandler(createOrchestrationMcpServer(agent, task as unknown as Task), name)(args);

const requestMaxMode = (agent: Agent, task: FakeTask) =>
  callTool(agent, task, 'request_max_mode', { reason: 'r' });
const requestEditMode = (agent: Agent, task: FakeTask) =>
  callTool(agent, task, 'request_edit_mode', { reason: 'r' });
const exceedResearchBudget = (_agent: Agent, task: FakeTask) =>
  Task.prototype.onResearchBudgetExceeded.call(task as unknown as Task);

describe('an answer that arrives before the requesting turn ends', () => {
  it.each([
    ['handleMaxModeDenial', requestMaxMode],
    ['handleEditModeDenial', requestEditMode],
    ['handleResearchBudgetDenial', exceedResearchBudget],
    ['handleResearchBudgetApproval', exceedResearchBudget],
  ] as const)('%s lets the PM post its reply and keeps the task running', async (answer, park) => {
    const agent = new Agent({
      id: 'pm-agent',
      key: 'pm',
      role: 'PM',
      expertise: '',
      isPm: true,
      pluginName: 'pm',
      visibility: 'global',
    });
    const task = makeFakeTask(agent);

    await park(agent, task);
    expect(agent.pendingTeardown).toBeDefined();
    await Task.prototype[answer].call(task as unknown as Task);

    await callTool(agent, task, 'report_completion', { message: 'reply' });
    expect(task.postToUser).toHaveBeenCalledWith('reply', 'pm-agent');

    await agent.pendingTeardown?.(); // what the spawn loop runs at turn end
    expect(task.stop).not.toHaveBeenCalled();
  });
});
