/**
 * Handler-level tests for the sequencing gate a trigger-fired task sits behind: while it has a `home_channel` but no channel of its own, `post_to_channel` must refuse (it posts WITHOUT linking, which is the detached message homing a fired task exists to replace), while `post_to_user` and `report_completion` must be allowed through — their first post is what opens the task's thread.
 *
 * Mock shape and handler extraction follow explore-tools.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Heavy deps tools.ts pulls in — mock to import-safe stubs (same as explore-tools.test.ts).
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
// The trigger-proposal path writes a record to disk under WORKDIR. Only the binding guard is under test here,
// and it runs before any of this, so the store is stubbed rather than exercised.
vi.mock('../../system/trigger-store.js', async (importActual) => {
  const actual = await importActual<typeof import('../../system/trigger-store.js')>();
  return {
    ...actual,
    saveTrigger: vi.fn().mockResolvedValue(undefined),
    countActiveTriggers: vi.fn().mockResolvedValue(0),
  };
});

const { postSlackMessage, listBotChannels, assertPostableChannel } = vi.hoisted(() => ({
  postSlackMessage: vi.fn(),
  listBotChannels: vi.fn(),
  assertPostableChannel: vi.fn(),
}));
vi.mock('../../connectors/slack/client.js', async (importActual) => {
  const actual = await importActual<typeof import('../../connectors/slack/client.js')>();
  return { ...actual, postSlackMessage, listBotChannels, assertPostableChannel };
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

import { createCommsMcpServer, createOrchestrationMcpServer } from '../tools.js';
import type { Agent } from '../agent.js';
import type { Task } from '../../tasks/task.js';

const MANDATE = 'Sergei: "can you flag this in #incidents when you know"';

function makeAgent(): Agent {
  return { def: { id: 'pm-agent', key: 'pm', role: 'PM', expertise: '', pluginName: 'pm', isPm: true }, queue: {} as any, session: { active: false } } as unknown as Agent;
}

/**
 * `home` gives the task a `home_channel` (the trigger-fired shape); `originChannelId` gives it an actually-linked channel and a `default_channel`. A fired task that has not spoken yet has the first and not the second.
 */
function makeTask(opts: { home?: boolean; originChannelId?: string } = {}): Task {
  const channels: Record<string, unknown> = {};
  let default_channel: string | null = null;
  if (opts.originChannelId) {
    const key = `slack:${opts.originChannelId}:1.0`;
    channels[key] = {
      type: 'slack', channel_id: opts.originChannelId, thread_id: '1.0', channel_name: 'origin',
    };
    default_channel = key;
  }
  return {
    taskId: 'task-1',
    isActive: true,
    completionIntent: false,
    metadata: {
      channels,
      default_channel,
      ...(opts.home ? { home_channel: { channel_id: 'CHOME', channel_name: 'ops-daily' } } : {}),
    },
    touch: vi.fn(), debouncedSave: vi.fn(), save: vi.fn().mockResolvedValue(undefined),
    postToUser: vi.fn().mockResolvedValue(null),
    postFilesToUser: vi.fn().mockResolvedValue(undefined),
    resurfacePrCards: vi.fn().mockResolvedValue(undefined),
    suspendStatus: vi.fn(),
    setCompletionIntent: vi.fn(),
    getAgentStatus: vi.fn().mockReturnValue([]),
  } as unknown as Task;
}

/** Build an MCP server and pull a tool's invokable handler out of its registry. `post_to_channel`/`post_to_user` live on the comms server, `report_completion` on the orchestration one. */
function handlerFrom(
  build: (agent: Agent, task: Task) => { instance: unknown },
  name: string,
  task: Task,
): (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }> {
  const server = build(makeAgent(), task);
  const raw = (server.instance as any)._registeredTools ?? Object.fromEntries((server.instance as any)._tools ?? []);
  const entry = raw[name];
  const fn = entry.callback ?? entry.handler ?? entry.cb;
  return (args) => fn(args, {});
}

function getHandler(name: string, task: Task) {
  return handlerFrom(createCommsMcpServer, name, task);
}

function getOrchestrationHandler(name: string, task: Task) {
  return handlerFrom(createOrchestrationMcpServer, name, task);
}

function textOf(result: { content: { text: string }[] }): string {
  return result.content[0].text;
}

const OLD_POST_TO_USER_REFUSAL =
  'No channel is linked to this task, so there is nowhere to post. ' +
  'Call report_completion() without a message to finish silently.';
const OLD_COMPLETION_REFUSAL =
  'Cannot post a completion message — no channel linked to this task. ' +
  'Call report_completion() without a message to finish silently.';

describe('post_to_channel waits until the task has a channel of its own', () => {
  beforeEach(() => {
    postSlackMessage.mockReset();
    postSlackMessage.mockResolvedValue('1716998400.123456');
    assertPostableChannel.mockReset();
    assertPostableChannel.mockResolvedValue(undefined);
    isThreadMuted.mockReset();
    isThreadMuted.mockResolvedValue(false);
    ensureChannelCanvas.mockReset();
    ensureChannelCanvas.mockResolvedValue(undefined);
    buildOtherChannelContextSection.mockReset();
    buildOtherChannelContextSection.mockResolvedValue('');
  });

  // (a) The mandate is not the missing piece — a perfectly good quote must not buy a way past this.
  it('refuses with the sequencing message even given a long, valid-looking mandate', async () => {
    const post = getHandler('post_to_channel', makeTask({ home: true }));

    const out = textOf(await post({ channel: 'C123', message: 'heads up', mandate: MANDATE }));

    expect(postSlackMessage).not.toHaveBeenCalled();
    expect(out).toMatch(/no channel of its own yet/i);
    expect(out).toMatch(/post_to_user/);
    expect(out).toContain('#ops-daily');
    expect(out).toMatch(/nothing was posted/i);
  });

  // (b) The refusal outranks the mandate gate: answering "no mandate" first would send the agent hunting for a quote when nothing may be posted anywhere yet.
  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['n/a', 'N/A'],
    ['too short to be a quote', 'Sergei'],
  ])('outranks the mandate check (%s)', async (_label, mandate) => {
    const post = getHandler('post_to_channel', makeTask({ home: true }));

    const out = textOf(await post({ channel: 'C123', message: 'heads up', mandate }));

    expect(postSlackMessage).not.toHaveBeenCalled();
    expect(out).toMatch(/no channel of its own yet/i);
    expect(out).not.toMatch(/no mandate/i);
  });

  // (c) Once the task's thread is open, the tool works normally again — including for the home channel itself, which gets no special branch.
  it('posts normally once the task has a linked default channel', async () => {
    const post = getHandler('post_to_channel', makeTask({ home: true, originChannelId: 'CHOME' }));

    const out = textOf(await post({ channel: 'C123', message: 'heads up', mandate: MANDATE }));

    expect(postSlackMessage).toHaveBeenCalledWith({ channel: 'C123', text: 'heads up', threadTs: undefined });
    expect(out).toContain('1716998400.123456');
    expect(out).not.toMatch(/no channel of its own yet/i);
  });

  it('posts into the home channel itself once the thread is open — no same-channel branch', async () => {
    const post = getHandler('post_to_channel', makeTask({ home: true, originChannelId: 'CHOME' }));

    const out = textOf(await post({ channel: 'CHOME', message: 'aside', mandate: MANDATE }));

    expect(postSlackMessage).toHaveBeenCalledWith({ channel: 'CHOME', text: 'aside', threadTs: undefined });
    expect(out).toContain('1716998400.123456');
  });

  // (d) An ordinary task — no home_channel at all — must be untouched, including the channel-less shape.
  it('does not fire for an ordinary task with no home_channel and no default channel', async () => {
    const post = getHandler('post_to_channel', makeTask());

    const out = textOf(await post({ channel: 'C123', message: 'heads up', mandate: MANDATE }));

    expect(postSlackMessage).toHaveBeenCalledWith({ channel: 'C123', text: 'heads up', threadTs: undefined });
    expect(out).not.toMatch(/no channel of its own yet/i);
  });

  it('still refuses an ordinary task on the mandate gate, not the sequencing gate', async () => {
    const post = getHandler('post_to_channel', makeTask());

    const out = textOf(await post({ channel: 'C123', message: 'heads up', mandate: 'urgent' }));

    expect(postSlackMessage).not.toHaveBeenCalled();
    expect(out).toMatch(/no mandate/i);
    expect(out).not.toMatch(/no channel of its own yet/i);
  });
});

describe('post_to_user reaches the open path on a trigger-fired task', () => {
  beforeEach(() => {
    postSlackMessage.mockReset();
    postSlackMessage.mockResolvedValue('1.5');
  });

  // (e) This is the call that opens the thread, so it must not be refused for having no channels yet.
  it('posts with no target when the task has a home channel and no channels', async () => {
    const task = makeTask({ home: true });

    const out = textOf(await getHandler('post_to_user', task)({ message: 'trigger result' }));

    expect(task.postToUser).toHaveBeenCalled();
    expect(out).toMatch(/posted/i);
    expect(out).not.toMatch(/nowhere to post/i);
  });

  // (f) Without a home channel the old refusal stands, byte for byte.
  it('still returns the byte-identical old refusal without a home channel', async () => {
    const task = makeTask();

    const out = textOf(await getHandler('post_to_user', task)({ message: 'nowhere to go' }));

    expect(task.postToUser).not.toHaveBeenCalled();
    expect(out).toBe(OLD_POST_TO_USER_REFUSAL);
  });
});

// (g) report_completion carries the same exception: on a fired task the completion message is often the first thing it says.
describe('report_completion with a message across both shapes', () => {
  beforeEach(() => {
    postSlackMessage.mockReset();
    postSlackMessage.mockResolvedValue('1.5');
  });

  it('posts the completion message on a task with a home channel and no channels', async () => {
    const task = makeTask({ home: true });

    const out = textOf(await getOrchestrationHandler('report_completion', task)({ message: 'done, here is the digest' }));

    expect(task.postToUser).toHaveBeenCalled();
    expect(task.setCompletionIntent).toHaveBeenCalled();
    expect(out).not.toMatch(/no channel linked/i);
  });

  it('still returns the byte-identical old refusal without a home channel', async () => {
    const task = makeTask();

    const out = textOf(await getOrchestrationHandler('report_completion', task)({ message: 'done' }));

    expect(task.postToUser).not.toHaveBeenCalled();
    expect(task.setCompletionIntent).not.toHaveBeenCalled();
    expect(out).toBe(OLD_COMPLETION_REFUSAL);
  });
});

// The binding's channel id is model-supplied text, and a fired task is HOMED in that channel: it opens its own
// thread there and treats it as its own for reads, which means the id decides what the task may later read.
// Everywhere else in the tools layer a `D…`/`U…` value is refused by prefix, and the human approving a trigger
// sees only the channel NAME on the card — so an id that is not a channel has to be refused at the source.
describe('propose_trigger refuses a binding that is not a channel', () => {
  const args = (channel_id: string) => ({
    binding: { type: 'channel' as const, channel_id, channel_name: 'looks-fine' },
    conditions: [{ type: 'schedule' as const, cron: '0 9 * * *', tz: 'UTC' }],
    action_prompt: 'post the daily digest',
    summary: 'Daily digest',
  });

  it.each(['D0123456789', 'U0123456789', 'W0123456789'])('refuses %s', async (channelId) => {
    const task = makeTask();

    const out = textOf(await getOrchestrationHandler('propose_trigger', task)(args(channelId)));

    expect(out).toMatch(/has to deliver to a channel/i);
    // Refused before anything is written: no proposal id is stashed, so nothing reaches an approval card.
    expect(task.metadata.pending_trigger_id).toBeUndefined();
  });

  // The control that gives the cases above their meaning: the same call with a real channel id must get PAST
  // this guard. Without it, a `propose_trigger` broken in some entirely different way would satisfy every
  // refusal assertion above. The proposal path beyond the guard is stubbed (`saveTrigger`, and the approval
  // card the Task would post), because what is under test here is the prefix check, not trigger creation.
  it('lets a C… id through the guard', async () => {
    const task = makeTask();
    (task as unknown as { postInteractiveToUser: unknown }).postInteractiveToUser = vi.fn().mockResolvedValue(undefined);

    const out = textOf(await getOrchestrationHandler('propose_trigger', task)(args('C0123456789')));

    expect(out).not.toMatch(/has to deliver to a channel/i);
    expect(task.metadata.pending_trigger_id).toBeDefined();
  });
});
