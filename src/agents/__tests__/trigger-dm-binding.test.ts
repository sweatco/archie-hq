import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../connectors/github/client.js', () => ({
  getGitHubClient: vi.fn().mockReturnValue({}),
  fetchOrigin: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../connectors/github/repo-clone.js', () => ({
  gitExec: vi.fn().mockResolvedValue(''),
  setupSharedClone: vi.fn().mockResolvedValue({ clone_path: '/wt', branch: 'feat/x', base_branch: 'main' }),
  cloneExists: vi.fn().mockResolvedValue(false),
  isWorktree: vi.fn().mockResolvedValue(false),
  fetchOrigin: vi.fn().mockResolvedValue(undefined),
}));
const { isThreadMuted } = vi.hoisted(() => ({ isThreadMuted: vi.fn() }));
vi.mock('../../tasks/persistence.js', () => ({
  appendAgentFinding: vi.fn().mockResolvedValue(undefined),
  getReposPath: vi.fn().mockReturnValue('/sessions/task-123/repos'),
  isThreadMuted,
}));
vi.mock('../../system/logger.js', () => ({
  logger: { agentAction: vi.fn(), agentFinding: vi.fn(), agentToSlack: vi.fn(), system: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('../registry.js', () => ({
  getAgentIds: vi.fn().mockReturnValue([]),
  getVisiblePeerIdsForSender: vi.fn().mockReturnValue([]),
  getAgentDef: vi.fn().mockReturnValue(undefined),
}));

const { saveTrigger, countActiveTriggers, loadTrigger, listTriggers } = vi.hoisted(() => ({
  saveTrigger: vi.fn(),
  countActiveTriggers: vi.fn(),
  loadTrigger: vi.fn(),
  listTriggers: vi.fn(),
}));
vi.mock('../../system/trigger-store.js', async (importActual) => {
  const actual = await importActual<typeof import('../../system/trigger-store.js')>();
  return { ...actual, saveTrigger, countActiveTriggers, loadTrigger, listTriggers };
});

const { postSlackMessage, listBotChannels, assertPostableChannel, getChannelInfo, getUserInfo, listWorkspaceChannels } = vi.hoisted(() => ({
  postSlackMessage: vi.fn(),
  listBotChannels: vi.fn(),
  assertPostableChannel: vi.fn(),
  getChannelInfo: vi.fn(),
  getUserInfo: vi.fn(),
  listWorkspaceChannels: vi.fn(),
}));
vi.mock('../../connectors/slack/client.js', async (importActual) => {
  const actual = await importActual<typeof import('../../connectors/slack/client.js')>();
  return { ...actual, postSlackMessage, listBotChannels, assertPostableChannel, getChannelInfo, getUserInfo, listWorkspaceChannels };
});

const {
  ensureChannelCanvas,
  buildOtherChannelContextSection,
  collectCanvasFileAllowlist,
  collectPinnedFileAllowlist,
} = vi.hoisted(() => ({
  ensureChannelCanvas: vi.fn(),
  buildOtherChannelContextSection: vi.fn(),
  collectCanvasFileAllowlist: vi.fn(),
  collectPinnedFileAllowlist: vi.fn(),
}));
vi.mock('../../connectors/slack/channel-canvas.js', () => ({
  ensureChannelCanvas,
  buildOtherChannelContextSection,
  collectCanvasFileAllowlist,
}));
vi.mock('../../connectors/slack/channel-pins.js', () => ({
  collectPinnedFileAllowlist,
}));

import { createOrchestrationMcpServer } from '../tools.js';
import type { Agent } from '../agent.js';
import type { Task } from '../../tasks/task.js';
import type { Trigger } from '../../types/trigger.js';

const DM_CHANNEL = 'D0DANA';
const DM_USER = 'U1';
const PUBLIC_CHANNEL = 'C0PUBLIC';
const PRIVATE_CHANNEL = 'C0PRIVATE';

const DM_INFO = { id: DM_CHANNEL, name: 'DM with Dana', isPrivate: true, isIm: true, imUserId: DM_USER };
const PUBLIC_INFO = { id: PUBLIC_CHANNEL, name: 'general', isPrivate: false, isIm: false };

function makeAgent(): Agent {
  return { def: { id: 'pm-agent', key: 'pm', role: 'PM', expertise: '', pluginName: 'pm', isPm: true }, queue: {} as any, session: { active: false } } as unknown as Agent;
}

function makeTask(opts: { originChannelId?: string; homeChannel?: { channel_id: string; channel_name: string } } = {}): Task {
  const channels: Record<string, unknown> = {};
  let default_channel: string | null = null;
  if (opts.originChannelId) {
    const key = `slack:${opts.originChannelId}:1.0`;
    channels[key] = { type: 'slack', channel_id: opts.originChannelId, thread_id: '1.0', channel_name: 'origin' };
    default_channel = key;
  }
  return {
    taskId: 'task-1',
    isActive: true,
    completionIntent: false,
    metadata: { channels, default_channel, ...(opts.homeChannel ? { home_channel: opts.homeChannel } : {}) },
    touch: vi.fn(), debouncedSave: vi.fn(), save: vi.fn().mockResolvedValue(undefined),
    postToUser: vi.fn().mockResolvedValue(null),
    postInteractiveToUser: vi.fn().mockResolvedValue(undefined),
    prepareTriggerDelivery: vi.fn().mockResolvedValue(undefined),
    postFilesToUser: vi.fn().mockResolvedValue(undefined),
    resurfacePrCards: vi.fn().mockResolvedValue(undefined),
    suspendStatus: vi.fn(),
    setCompletionIntent: vi.fn(),
    getAgentStatus: vi.fn().mockReturnValue([]),
  } as unknown as Task;
}

function getOrchestrationHandler(
  name: string,
  task: Task,
): (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }> {
  const server = createOrchestrationMcpServer(makeAgent(), task);
  const raw = (server.instance as any)._registeredTools ?? Object.fromEntries((server.instance as any)._tools ?? []);
  const entry = raw[name];
  const fn = entry.callback ?? entry.handler ?? entry.cb;
  return (args) => fn(args, {});
}

function textOf(result: { content: { text: string }[] }): string {
  return result.content[0].text;
}

const SCHEDULE = { type: 'schedule' as const, cron: '0 9 * * *', tz: 'UTC' };

function proposal(binding: Record<string, unknown>, conditions: Record<string, unknown>[] = [SCHEDULE]) {
  return { binding, conditions, action_prompt: 'send the morning digest', summary: 'Morning digest' };
}

function savedTrigger(): Trigger {
  expect(saveTrigger).toHaveBeenCalledTimes(1);
  return saveTrigger.mock.calls[0]![0] as Trigger;
}

beforeEach(() => {
  vi.clearAllMocks();
  saveTrigger.mockResolvedValue(undefined);
  countActiveTriggers.mockResolvedValue(0);
  loadTrigger.mockResolvedValue(null);
  listTriggers.mockResolvedValue([]);
  listWorkspaceChannels.mockResolvedValue([{ id: PUBLIC_CHANNEL, isPrivate: false }, { id: PRIVATE_CHANNEL, isPrivate: true }]);
  getChannelInfo.mockResolvedValue(PUBLIC_INFO);
  getUserInfo.mockResolvedValue({ name: 'dana', realName: 'Dana', tz: 'UTC' });
});

describe('a DM binding is derived from the origin, never from the arguments', () => {
  beforeEach(() => {
    getChannelInfo.mockResolvedValue(DM_INFO);
  });

  it('stores the asking user, their DM conversation and its label', async () => {
    const task = makeTask({ originChannelId: DM_CHANNEL });

    const out = textOf(await getOrchestrationHandler('propose_trigger', task)(proposal({ type: 'user' })));

    expect(out).toMatch(/proposed/i);
    expect(savedTrigger().binding).toEqual({
      type: 'user',
      user_id: DM_USER,
      channel_id: DM_CHANNEL,
      channel_name: 'DM with Dana',
    });
  });

  it('ignores a channel_id and channel_name passed alongside type "user"', async () => {
    const task = makeTask({ originChannelId: DM_CHANNEL });

    await getOrchestrationHandler('propose_trigger', task)(
      proposal({ type: 'user', channel_id: 'DEVIL', channel_name: 'DM with Someone Else' }),
    );

    expect(savedTrigger().binding).toEqual({
      type: 'user',
      user_id: DM_USER,
      channel_id: DM_CHANNEL,
      channel_name: 'DM with Dana',
    });
  });
});

describe('a DM binding is refused when the request did not come from a DM', () => {
  it.each([
    ['public', PUBLIC_INFO],
    ['private', { id: PRIVATE_CHANNEL, name: 'exec-private', isPrivate: true, isIm: false }],
  ])('refuses from a %s channel', async (_kind, info) => {
    getChannelInfo.mockResolvedValue(info);
    const task = makeTask({ originChannelId: info.id });

    const out = textOf(await getOrchestrationHandler('propose_trigger', task)(proposal({ type: 'user' })));

    expect(out).toMatch(/only be set up from a DM/i);
    expect(saveTrigger).not.toHaveBeenCalled();
    expect(task.metadata.pending_trigger_id).toBeUndefined();
  });

  it('refuses from an operator task with no Slack channel', async () => {
    const task = makeTask();

    const out = textOf(await getOrchestrationHandler('propose_trigger', task)(proposal({ type: 'user' })));

    expect(out).toMatch(/only be set up from a DM/i);
    expect(saveTrigger).not.toHaveBeenCalled();
    expect(task.metadata.pending_trigger_id).toBeUndefined();
  });
});

describe('a DM trigger can only run on a schedule', () => {
  const WATCH = { type: 'channel_message' as const, channel_id: 'C0WATCHED' };

  it('refuses a channel_message condition at creation', async () => {
    getChannelInfo.mockResolvedValue(DM_INFO);
    const task = makeTask({ originChannelId: DM_CHANNEL });

    const out = textOf(await getOrchestrationHandler('propose_trigger', task)(proposal({ type: 'user' }, [WATCH])));

    expect(out).toMatch(/only run on a schedule/i);
    expect(saveTrigger).not.toHaveBeenCalled();
    expect(task.metadata.pending_trigger_id).toBeUndefined();
  });

  it('refuses a channel_message condition on update', async () => {
    getChannelInfo.mockResolvedValue(DM_INFO);
    loadTrigger.mockResolvedValue({
      id: 'trg-20260827-0900-abc123',
      status: 'enabled',
      created_by: DM_USER,
      created_at: '2026-08-27T09:00:00.000Z',
      binding: { type: 'user', user_id: DM_USER, channel_id: DM_CHANNEL, channel_name: 'DM with Dana' },
      conditions: [{ type: 'schedule', tz: 'UTC', cron: '0 9 * * *', next_run_at: '2099-01-01T09:00:00.000Z' }],
      action: { prompt: 'send the morning digest' },
      summary: 'Morning digest',
    } satisfies Trigger);
    const task = makeTask({ originChannelId: DM_CHANNEL });

    const out = textOf(await getOrchestrationHandler('update_trigger', task)({
      id: 'trg-20260827-0900-abc123',
      conditions: [WATCH],
    }));

    expect(out).toMatch(/only run on a schedule/i);
    expect(saveTrigger).not.toHaveBeenCalled();
  });
});

describe('a channel binding still works', () => {
  it('stores the channel it was proposed in', async () => {
    const task = makeTask({ originChannelId: PUBLIC_CHANNEL });

    const out = textOf(await getOrchestrationHandler('propose_trigger', task)(
      proposal({ type: 'channel', channel_id: PUBLIC_CHANNEL, channel_name: 'general' }),
    ));

    expect(out).toMatch(/proposed/i);
    expect(savedTrigger().binding).toEqual({ type: 'channel', channel_id: PUBLIC_CHANNEL, channel_name: 'general' });
    expect(task.metadata.pending_trigger_id).toBeDefined();
  });
});

describe('a trigger-fired task is confined to the conversation it is homed in', () => {
  const publicTrigger: Trigger = {
    id: 'trg-pub', status: 'enabled', created_by: 'U9', created_at: '2026-08-01T00:00:00Z',
    binding: { type: 'channel', channel_id: PUBLIC_CHANNEL, channel_name: 'general' },
    conditions: [{ type: 'schedule', tz: 'UTC', cron: '0 9 * * *', next_run_at: '2026-08-28T09:00:00Z' }],
    action: { prompt: 'x' }, summary: 'Public digest',
  };
  const privateTrigger: Trigger = {
    ...publicTrigger, id: 'trg-priv',
    binding: { type: 'channel', channel_id: PRIVATE_CHANNEL, channel_name: 'exec-private' },
    summary: 'Exec private digest',
  };
  const ownDmTrigger: Trigger = {
    ...publicTrigger, id: 'trg-mine', created_by: DM_USER,
    binding: { type: 'user', user_id: DM_USER, channel_id: DM_CHANNEL, channel_name: 'DM with Dana' },
    summary: 'My private digest',
  };
  const otherDmTrigger: Trigger = {
    ...publicTrigger, id: 'trg-theirs', created_by: 'UOTHER',
    binding: { type: 'user', user_id: 'UOTHER', channel_id: 'D0OTHER', channel_name: 'DM with Sam' },
    summary: 'Someone else private digest',
  };

  beforeEach(() => {
    listTriggers.mockResolvedValue([publicTrigger, privateTrigger, ownDmTrigger, otherDmTrigger]);
  });

  it('homed in a DM, sees that DM and public — never another private channel or another person\'s DM', async () => {
    getChannelInfo.mockResolvedValue(DM_INFO);
    const task = makeTask({ homeChannel: { channel_id: DM_CHANNEL, channel_name: 'DM with Dana' } });

    const out = textOf(await getOrchestrationHandler('list_triggers', task)({}));

    expect(out).toContain('trg-mine');
    expect(out).toContain('trg-pub');
    expect(out).not.toContain('trg-priv');
    expect(out).not.toContain('trg-theirs');
  });

  it('homed in a private channel, sees that channel and public — never a DM trigger', async () => {
    getChannelInfo.mockResolvedValue({ id: PRIVATE_CHANNEL, name: 'exec-private', isPrivate: true, isIm: false });
    const task = makeTask({ homeChannel: { channel_id: PRIVATE_CHANNEL, channel_name: 'exec-private' } });

    const out = textOf(await getOrchestrationHandler('list_triggers', task)({}));

    expect(out).toContain('trg-priv');
    expect(out).toContain('trg-pub');
    expect(out).not.toContain('trg-mine');
    expect(out).not.toContain('trg-theirs');
  });

  it('a CLI task with no conversation at all is still the operator tier', async () => {
    const out = textOf(await getOrchestrationHandler('list_triggers', makeTask())({}));

    for (const id of ['trg-pub', 'trg-priv', 'trg-mine', 'trg-theirs']) expect(out).toContain(id);
  });

  it('names each DM by its own conversation, not relative to the reader', async () => {
    const out = textOf(await getOrchestrationHandler('list_triggers', makeTask())({}));

    expect(out).toContain('DM with Dana');
    expect(out).toContain('DM with Sam');
    expect(out).not.toMatch(/your DM/i);
  });
});

describe('a homed task with no thread of its own cannot propose a trigger', () => {
  beforeEach(() => {
    getChannelInfo.mockResolvedValue(DM_INFO);
  });

  it('refuses, and writes nothing', async () => {
    const task = makeTask({ homeChannel: { channel_id: DM_CHANNEL, channel_name: 'DM with Dana' } });

    const out = textOf(await getOrchestrationHandler('propose_trigger', task)(proposal({ type: 'user' })));

    expect(out).toMatch(/no thread of its own yet/i);
    expect(saveTrigger).not.toHaveBeenCalled();
    expect(task.metadata.pending_trigger_id).toBeUndefined();
  });

  it('goes through once the task has opened its thread', async () => {
    const task = makeTask({ originChannelId: DM_CHANNEL, homeChannel: { channel_id: DM_CHANNEL, channel_name: 'DM with Dana' } });

    const out = textOf(await getOrchestrationHandler('propose_trigger', task)(proposal({ type: 'user' })));

    expect(out).not.toMatch(/no thread of its own yet/i);
    expect(savedTrigger().binding).toEqual({
      type: 'user', user_id: DM_USER, channel_id: DM_CHANNEL, channel_name: 'DM with Dana',
    });
  });
});
