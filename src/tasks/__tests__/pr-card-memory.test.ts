import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDef } from '../../types/agent.js';
import type { PrCardData, TaskMetadata } from '../../types/task.js';

const {
  getPRCardData,
  postInteractiveToThread,
  updateMessage,
  deleteMessage,
} = vi.hoisted(() => ({
  getPRCardData: vi.fn(),
  postInteractiveToThread: vi.fn(),
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
}));

vi.mock('../../connectors/github/client.js', () => ({
  getGitHubClient: () => ({ getPRCardData }),
}));

vi.mock('../../connectors/slack/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../connectors/slack/client.js')>()),
  postInteractiveToThread,
  updateMessage,
  deleteMessage,
}));

vi.mock('../../agents/spawn.js', () => ({ spawnAgent: vi.fn() }));
vi.mock('../../system/logger.js', () => ({
  logger: {
    warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), agent: vi.fn(), slack: vi.fn(),
  },
}));

import { Task } from '../task.js';

const TaskCtor = Task as unknown as new (taskId: string, metadata: TaskMetadata, team: AgentDef[]) => Task;
const CARD: PrCardData = {
  repo: 'acme/app', prNumber: 42, url: 'https://github.com/acme/app/pull/42',
  headRef: 'feature', state: 'open', head_sha: 'new-sha', ci: 'passed', ciPassed: 2, ciTotal: 2,
};

function newTask(): Task {
  const task = new TaskCtor('task-1', {
    task_id: 'task-1',
    participants: [],
    channels: {
      'slack:C07CHANNEL:100.0': {
        type: 'slack', channel_id: 'C07CHANNEL', channel_name: 'dev', thread_id: '100.0',
      },
    },
    default_channel: 'slack:C07CHANNEL:100.0',
    agent_sessions: {},
    repositories: {
      'repo-agent': [{
        github: 'acme/app',
        branch_states: {
          feature: {
            pr_number: 42,
            pr_card: {
              fingerprint: 'old',
              slack: { ts: '90.0', channel_id: 'C07CHANNEL', thread_id: '100.0' },
            },
          },
        },
      }],
    },
  } as unknown as TaskMetadata, []);
  (task as unknown as { save: (flush?: boolean) => Promise<void> }).save = vi.fn().mockResolvedValue(undefined);
  (task as unknown as { prepareMemoryDelivery: (channelId: string) => Promise<unknown> }).prepareMemoryDelivery = vi.fn().mockResolvedValue({ kind: 'public', channel_id: 'C07CHANNEL' });
  return task;
}

describe('PR-card memory audience checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPRCardData.mockResolvedValue(CARD);
    postInteractiveToThread.mockResolvedValue('101.0');
    updateMessage.mockResolvedValue(undefined);
    deleteMessage.mockResolvedValue(undefined);
  });

  it('classifies the destination before resurfacing a card', async () => {
    const task = newTask();

    await task.resurfacePrCards();

    expect(task.prepareMemoryDelivery).toHaveBeenCalledWith('C07CHANNEL');
    expect(vi.mocked(task.prepareMemoryDelivery).mock.invocationCallOrder[0]!)
      .toBeLessThan(postInteractiveToThread.mock.invocationCallOrder[0]!);
  });

  it('classifies the destination before an in-place card update', async () => {
    const task = newTask();

    await task.refreshPrCardInPlace('acme/app', 42);

    expect(task.prepareMemoryDelivery).toHaveBeenCalledWith('C07CHANNEL');
    expect(vi.mocked(task.prepareMemoryDelivery).mock.invocationCallOrder[0]!)
      .toBeLessThan(updateMessage.mock.invocationCallOrder[0]!);
  });
});
