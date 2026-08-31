import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../agent.js';
import type { Task } from '../../tasks/task.js';
import type { Trigger } from '../../types/trigger.js';

vi.mock('../../connectors/github/client.js', () => ({
  getGitHubClient: vi.fn().mockReturnValue({}),
  fetchOrigin: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../connectors/github/repo-clone.js', () => ({
  gitExec: vi.fn().mockResolvedValue(''),
  setupSharedClone: vi.fn(),
  cloneExists: vi.fn().mockResolvedValue(false),
  isWorktree: vi.fn().mockResolvedValue(false),
  fetchOrigin: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../tasks/persistence.js', () => ({
  appendAgentFinding: vi.fn().mockResolvedValue(undefined),
  getReposPath: vi.fn().mockReturnValue('/sessions/task-1/repos'),
  isThreadMuted: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../system/logger.js', () => ({
  logger: { agentAction: vi.fn(), agentFinding: vi.fn(), agentToSlack: vi.fn(), system: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('../registry.js', () => ({
  getAgentIds: vi.fn().mockReturnValue([]),
  getVisiblePeerIdsForSender: vi.fn().mockReturnValue([]),
  getAgentDef: vi.fn().mockReturnValue(undefined),
  findAgentDefsContainingRepo: vi.fn().mockReturnValue([]),
}));
vi.mock('../../connectors/slack/channel-canvas.js', () => ({
  ensureChannelCanvas: vi.fn(), buildOtherChannelContextSection: vi.fn(), collectCanvasFileAllowlist: vi.fn(),
}));
vi.mock('../../connectors/slack/channel-pins.js', () => ({ collectPinnedFileAllowlist: vi.fn() }));
vi.mock('../../connectors/slack/client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../connectors/slack/client.js')>()),
  getChannelInfo: vi.fn().mockResolvedValue({ isIm: false }),
  listWorkspaceChannels: vi.fn().mockResolvedValue([]),
  fetchChannelIsPrivate: vi.fn().mockResolvedValue(false),
}));

const store = vi.hoisted(() => ({
  trigger: null as Trigger | null,
  save: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('../../system/trigger-store.js', async (importActual) => ({
  ...(await importActual<typeof import('../../system/trigger-store.js')>()),
  loadTrigger: vi.fn(async () => store.trigger),
  saveTrigger: store.save,
  deleteTrigger: store.remove,
  countActiveTriggers: vi.fn().mockResolvedValue(0),
}));

const scheduler = vi.hoisted(() => ({
  announce: vi.fn(),
  index: vi.fn(),
  deindex: vi.fn(),
  authorize: vi.fn(),
}));
vi.mock('../../system/trigger-scheduler.js', async (importActual) => ({
  ...(await importActual<typeof import('../../system/trigger-scheduler.js')>()),
  announceTriggerChange: scheduler.announce,
  indexTrigger: scheduler.index,
  deindexTrigger: scheduler.deindex,
  authorizeTriggerMemoryBinding: scheduler.authorize,
  triggersEnabled: () => true,
}));

import { createOrchestrationMcpServer } from '../tools.js';

function trigger(status: 'enabled' | 'paused' = 'enabled'): Trigger {
  return {
    id: 'trigger-1',
    status,
    created_by: 'U07PERSON1',
    created_at: '2026-08-31T00:00:00.000Z',
    binding: { type: 'channel', channel_id: 'C07TARGET1', channel_name: 'target' },
    conditions: [{ type: 'schedule', tz: 'UTC', cron: '0 * * * *', next_run_at: '2026-09-01T00:00:00.000Z' }],
    action: { prompt: 'Do the work.' },
    summary: 'Do work',
  };
}

function makeTask(): Task {
  return {
    taskId: 'task-1',
    metadata: { channels: {}, default_channel: null },
    prepareMemoryDelivery: vi.fn().mockRejectedValue(new Error('delivery blocked')),
    postInteractiveToUser: vi.fn().mockResolvedValue(undefined),
    debouncedSave: vi.fn(),
  } as unknown as Task;
}

function handler(name: string, task: Task) {
  const agent = { def: { id: 'pm-agent', isPm: true }, session: {}, queue: {} } as unknown as Agent;
  const server = createOrchestrationMcpServer(agent, task);
  const raw = (server.instance as any)._registeredTools ?? Object.fromEntries((server.instance as any)._tools ?? []);
  return raw[name].callback ?? raw[name].handler ?? raw[name].cb;
}

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content[0]!.text;
}

describe('trigger memory delivery gate ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.trigger = trigger();
    store.save.mockResolvedValue(undefined);
    store.remove.mockResolvedValue(undefined);
    scheduler.announce.mockResolvedValue(undefined);
    scheduler.authorize.mockResolvedValue(true);
  });

  it('pauses before checking whether the bound-channel announcement is compatible', async () => {
    const task = makeTask();
    const result = await handler('update_trigger', task)({ id: 'trigger-1', status: 'paused' }, {});

    expect(textOf(result)).toContain('paused');
    expect(store.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'paused' }));
    expect(store.save.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(task.prepareMemoryDelivery).mock.invocationCallOrder[0]!);
    expect(scheduler.announce).not.toHaveBeenCalled();
  });

  it('deletes before checking whether the bound-channel announcement is compatible', async () => {
    const task = makeTask();
    const result = await handler('delete_trigger', task)({ id: 'trigger-1' }, {});

    expect(textOf(result)).toContain('deleted');
    expect(store.remove).toHaveBeenCalledWith('trigger-1');
    expect(store.remove.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(task.prepareMemoryDelivery).mock.invocationCallOrder[0]!);
    expect(scheduler.announce).not.toHaveBeenCalled();
  });

  it.each([
    ['resume', trigger('paused'), { id: 'trigger-1', status: 'enabled' }],
    ['content edit', trigger('enabled'), { id: 'trigger-1', summary: 'Changed summary' }],
  ])('retains the compatibility gate for %s', async (_label, value, args) => {
    store.trigger = value;
    const task = makeTask();
    const result = await handler('update_trigger', task)(args, {});

    expect(textOf(result)).toMatch(/Trigger not updated: delivery blocked/);
    expect(store.save).not.toHaveBeenCalled();
  });

  it.each([
    ['no-op', { id: 'trigger-1' }, /Nothing to update/],
    ['invalid conditions', { id: 'trigger-1', conditions: [] }, /Could not update/],
  ])('rejects %s before the scope-mutating compatibility check', async (_label, args, message) => {
    const task = makeTask();
    const result = await handler('update_trigger', task)(args, {});

    expect(textOf(result)).toMatch(message);
    expect(task.prepareMemoryDelivery).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });

  it('persists pause and rejects accompanying edits before delivery authorization', async () => {
    const task = makeTask();
    const result = await handler('update_trigger', task)({
      id: 'trigger-1', status: 'paused', summary: 'Sensitive edit',
    }, {});

    expect(textOf(result)).toMatch(/paused.*edits were rejected/i);
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenCalledWith(expect.objectContaining({
      status: 'paused', summary: 'Do work',
    }));
    expect(scheduler.deindex).toHaveBeenCalledWith('trigger-1');
    expect(store.save.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(task.prepareMemoryDelivery).mock.invocationCallOrder[0]!);
  });

  it('merges the authoring task exposure into accepted trigger edits', async () => {
    const task = makeTask();
    task.metadata.memory_exposed = true;
    task.metadata.memory_exposure_scope = { kind: 'channel', channel_id: 'C07TARGET1' };
    vi.mocked(task.prepareMemoryDelivery).mockResolvedValue({ kind: 'channel', channel_id: 'C07TARGET1' });

    const result = await handler('update_trigger', task)({ id: 'trigger-1', summary: 'Sensitive edit' }, {});

    expect(textOf(result)).toContain('updated');
    expect(store.save).toHaveBeenCalledWith(expect.objectContaining({
      memory_exposure_scope: { kind: 'channel', channel_id: 'C07TARGET1' },
    }));
  });

  it('persists authoring-task exposure on a new trigger proposal', async () => {
    const task = makeTask();
    task.metadata.memory_exposed = true;
    task.metadata.memory_exposure_scope = { kind: 'channel', channel_id: 'C07TARGET1' };
    vi.mocked(task.prepareMemoryDelivery).mockResolvedValue({ kind: 'channel', channel_id: 'C07TARGET1' });

    const result = await handler('propose_trigger', task)({
      binding: { type: 'channel', channel_id: 'C07TARGET1', channel_name: 'target' },
      conditions: [{ type: 'schedule', cron: '0 * * * *', tz: 'UTC' }],
      action_prompt: 'Use remembered context.',
      summary: 'Sensitive automation',
    }, {});

    expect(textOf(result)).toContain('proposed');
    expect(store.save).toHaveBeenCalledWith(expect.objectContaining({
      status: 'pending',
      memory_exposure_scope: { kind: 'channel', channel_id: 'C07TARGET1' },
    }));
  });
});
