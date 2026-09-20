/**
 * Handler-level tests for the `post_to_channel` explore tool — the success path
 * (returns the posted ts, message not linked to the task) plus the DM-rejection
 * and not_in_channel wiring. Reads/search are covered at the client layer in
 * connectors/slack/__tests__/client.test.ts; this exercises the tool itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Heavy deps tools.ts pulls in — mock to import-safe stubs (same as tool-contract.test.ts).
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

// Partial-mock the Slack client: keep the REAL error classes (format-errors uses
// `instanceof`) and just stub the network call. `vi.hoisted` makes the mock fn
// available to the hoisted vi.mock factory.
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

import { createCommsMcpServer } from '../tools.js';
import { DmPostError } from '../../connectors/slack/client.js';
import type { Agent } from '../agent.js';
import type { Task } from '../../tasks/task.js';

function makeAgent(): Agent {
  return { def: { id: 'pm-agent', key: 'pm', role: 'PM', expertise: '', pluginName: 'pm', isPm: true }, queue: {} as any, session: { active: false } } as unknown as Agent;
}
function makeTask(originChannelId?: string, opts: { muted?: boolean } = {}): Task {
  const channels: Record<string, unknown> = {};
  let default_channel: string | undefined;
  if (originChannelId) {
    const key = `slack:${originChannelId}:1.0`;
    channels[key] = {
      type: 'slack', channel_id: originChannelId, thread_id: '1.0', channel_name: 'origin',
      ...(opts.muted ? { muted: true } : {}),
    };
    default_channel = key;
  }
  let audience = originChannelId;
  return {
    taskId: 'task-1', metadata: { channels, default_channel },
    touch: vi.fn(), debouncedSave: vi.fn(), save: vi.fn().mockResolvedValue(undefined),
    prepareMemoryDelivery: vi.fn(async (channelId: string) => {
      audience ??= channelId;
      if (audience !== channelId) throw new Error('delivery blocked: this task belongs to a different Slack audience');
      return { kind: 'public', channel_id: audience };
    }),
    // post_to_user / post_files_to_user route through the Task, not the Slack
    // client directly — stub them so the mute guard can be observed as "the
    // delivery call never happened".
    postToUser: vi.fn().mockResolvedValue(null),
    postFilesToUser: vi.fn().mockResolvedValue(undefined),
  } as unknown as Task;
}

/** Build the comms server and pull a tool's invokable handler out of the MCP registry. */
function getHandler(name: string, task: Task = makeTask()): (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }> {
  const server = createCommsMcpServer(makeAgent(), task);
  const raw = (server.instance as any)._registeredTools ?? Object.fromEntries((server.instance as any)._tools ?? []);
  const entry = raw[name];
  const fn = entry.callback ?? entry.handler ?? entry.cb;
  return (args) => fn(args, {});
}

async function textOf(result: { content: { text: string }[] }): Promise<string> {
  return result.content[0].text;
}

describe('post_to_channel handler', () => {
  beforeEach(() => {
    postSlackMessage.mockReset();
    assertPostableChannel.mockReset();
    assertPostableChannel.mockResolvedValue(undefined); // default: target is a postable channel
    isThreadMuted.mockReset();
    isThreadMuted.mockResolvedValue(false); // default: no other task has muted the target thread
    ensureChannelCanvas.mockReset();
    ensureChannelCanvas.mockResolvedValue(undefined);
    buildOtherChannelContextSection.mockReset();
    buildOtherChannelContextSection.mockResolvedValue(''); // default: destination has no canvas
  });

  it('posts a new top-level message and reports the ts, not linked to the task', async () => {
    postSlackMessage.mockResolvedValue('1716998400.123456');
    const task = makeTask();
    const post = getHandler('post_to_channel', task);

    const out = await textOf(await post({ channel: 'C123', message: 'heads up', mandate: 'Sergei: "can you flag this in that channel"' }));

    expect(postSlackMessage).toHaveBeenCalledWith({ channel: 'C123', text: 'heads up', threadTs: undefined });
    expect(task.prepareMemoryDelivery).toHaveBeenCalledWith('C123');
    expect(vi.mocked(task.prepareMemoryDelivery).mock.invocationCallOrder[0]!)
      .toBeLessThan(postSlackMessage.mock.invocationCallOrder[0]!);
    expect(out).toContain('1716998400.123456');
    expect(out).toMatch(/not linked to this task/i);
  });

  it('rejects a DM / user-id target without calling Slack', async () => {
    const post = getHandler('post_to_channel');

    const dm = await textOf(await post({ channel: 'D999', message: 'hi', mandate: 'Sergei: "can you flag this in that channel"' }));
    const user = await textOf(await post({ channel: 'U999', message: 'hi', mandate: 'Sergei: "can you flag this in that channel"' }));

    expect(dm).toMatch(/channel-only|never touches DMs/i);
    expect(user).toMatch(/channel-only|never touches DMs/i);
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it('rejects a group DM (mpim) — the gate refuses it, message is never delivered', async () => {
    // A `G…` id passes the prefix pre-check, so the API-backed gate must catch it.
    assertPostableChannel.mockRejectedValue(new DmPostError('G777'));
    const post = getHandler('post_to_channel');

    const out = await textOf(await post({ channel: 'G777', message: 'sensitive', mandate: 'Sergei: "can you flag this in that channel"' }));

    expect(assertPostableChannel).toHaveBeenCalledWith('G777');
    expect(postSlackMessage).not.toHaveBeenCalled();
    expect(out).toMatch(/DM or group DM/i);
  });

  it('maps not_in_channel to invite guidance', async () => {
    postSlackMessage.mockRejectedValue({ data: { error: 'not_in_channel' } });
    const post = getHandler('post_to_channel');

    const out = await textOf(await post({ channel: 'C123', message: 'hi', mandate: 'Sergei: "can you flag this in that channel"' }));

    expect(out).toContain('/invite @Archie');
  });

  it('does not post when the fixed task audience blocks the destination', async () => {
    const task = makeTask();
    vi.mocked(task.prepareMemoryDelivery).mockRejectedValue(new Error('delivery blocked: incompatible memory audience'));
    const post = getHandler('post_to_channel', task);

    const out = await textOf(await post({
      channel: 'C123', message: 'memory-derived detail',
      mandate: 'Sergei: "can you flag this in that channel"',
    }));

    expect(out).toMatch(/delivery blocked/i);
    expect(postSlackMessage).not.toHaveBeenCalled();
    expect(ensureChannelCanvas).not.toHaveBeenCalled();
    expect(buildOtherChannelContextSection).not.toHaveBeenCalled();
  });

  // A muted thread means someone in that channel asked Archie to step back.
  // post_to_channel is the obvious way around that — a brand-new top-level post
  // reaches the same people — so the whole channel has to be closed, not just
  // the muted thread's key.
  it('refuses a NEW top-level post in a channel whose thread is muted', async () => {
    const post = getHandler('post_to_channel', makeTask('C123', { muted: true }));

    const out = await textOf(await post({ channel: 'C123', message: 'one more thing', mandate: 'Sergei: "can you flag this in that channel"' }));

    expect(postSlackMessage).not.toHaveBeenCalled();
    expect(out).toMatch(/muted/i);
    expect(out).toMatch(/do not route around it/i);
  });

  // The mandate can't be verified semantically, but requiring the quote forces
  // the question to be asked, and refusing the filler answers stops the field
  // being padded to get past the gate.
  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['n/a', 'N/A'],
    ['none', 'none'],
    ['own judgement', 'my own judgement'],
    ['severity as a mandate', 'urgent'],
    ['too short to be a quote', 'Sergei'],
  ])('refuses a non-mandate (%s)', async (_label, mandate) => {
    const post = getHandler('post_to_channel');

    const out = await textOf(await post({ channel: 'C123', message: 'heads up', mandate }));

    expect(postSlackMessage).not.toHaveBeenCalled();
    expect(out).toMatch(/no mandate/i);
    expect(out).toMatch(/their call/i);
  });

  // The task that gets told to go away is usually not the task posting next —
  // that's exactly how #backend-dev kept being posted to on 2026-08-05.
  describe('a thread another task was told to leave', () => {
    const MANDATE = 'Sergei: "can you flag this in that channel"';

    it('refuses a reply into it', async () => {
      isThreadMuted.mockResolvedValue(true);
      const post = getHandler('post_to_channel');

      const out = await textOf(await post({ channel: 'C123', message: 'hi', thread_ts: '999.0', mandate: MANDATE }));

      expect(isThreadMuted).toHaveBeenCalledWith('C123', '999.0');
      expect(postSlackMessage).not.toHaveBeenCalled();
      expect(out).toMatch(/step out of that thread/i);
    });

    it('allows a reply into a thread nobody muted', async () => {
      isThreadMuted.mockResolvedValue(false);
      postSlackMessage.mockResolvedValue('1.5');
      const post = getHandler('post_to_channel');

      await post({ channel: 'C123', message: 'hi', thread_ts: '111.0', mandate: MANDATE });

      expect(postSlackMessage).toHaveBeenCalled();
    });
  });

  it('still rejects a different channel when the task channel is muted', async () => {
    postSlackMessage.mockResolvedValue('1.5');
    const post = getHandler('post_to_channel', makeTask('C123', { muted: true }));

    const out = await textOf(await post({ channel: 'C999', message: 'unrelated', mandate: 'Sergei: "can you flag this in that channel"' }));

    expect(postSlackMessage).not.toHaveBeenCalled();
    expect(out).toMatch(/different Slack audience/i);
  });
});

describe('mute blocks outbound posts, not just inbound routing', () => {
  beforeEach(() => {
    postSlackMessage.mockReset();
    postSlackMessage.mockResolvedValue('1.5');
  });

  it('post_to_user refuses the muted default channel', async () => {
    const task = makeTask('C123', { muted: true });
    const out = await textOf(await getHandler('post_to_user', task)({ message: 'correcting myself' }));

    expect(task.postToUser).not.toHaveBeenCalled();
    expect(out).toMatch(/muted/i);
    // The refusal has to void the promise that pulls an agent back in.
    expect(out).toMatch(/promise to report back there is void/i);
  });

  it('post_to_user refuses an explicitly targeted muted thread', async () => {
    const task = makeTask('C123', { muted: true });
    const out = await textOf(
      await getHandler('post_to_user', task)({ message: 'hi', target: { channel: 'slack:C123:1.0' } }),
    );

    expect(task.postToUser).not.toHaveBeenCalled();
    expect(out).toMatch(/muted/i);
  });

  it('post_to_user still works when the channel is not muted', async () => {
    const task = makeTask('C123');
    const out = await textOf(await getHandler('post_to_user', task)({ message: 'hi' }));

    expect(task.postToUser).toHaveBeenCalled();
    expect(out).toMatch(/posted/i);
  });

  it('post_files_to_user refuses a muted channel before touching the filesystem', async () => {
    const out = await textOf(
      await getHandler('post_files_to_user', makeTask('C123', { muted: true }))({ paths: ['/nope.png'] }),
    );

    // No sandbox error — the mute is checked first, so the path is never read.
    expect(out).toMatch(/muted/i);
    expect(out).toMatch(/files were not uploaded/i);
  });
});

describe('list_channels handler — public channels + this task\'s own channel', () => {
  beforeEach(() => {
    listBotChannels.mockReset();
    listBotChannels.mockResolvedValue([{ id: 'C1', name: 'general', isPrivate: false, topic: '' }]);
  });

  it('lists the public channels Archie is in', async () => {
    const list = getHandler('list_channels', makeTask('C1')); // origin is a public channel it's in
    const out = await textOf(await list({}));
    expect(out).toContain('#general');
  });

  it("appends this task's OWN private channel (not in the public list)", async () => {
    // Task lives in a private channel C_priv that users.conversations won't return.
    const out = await textOf(await getHandler('list_channels', makeTask('C_priv'))({}));
    expect(out).toContain('#general');               // public
    expect(out).toContain('C_priv');                 // the task's own private channel
    expect(out).toMatch(/this task's own channel/i);
  });

  it("appends this task's OWN DM", async () => {
    const out = await textOf(await getHandler('list_channels', makeTask('D123'))({}));
    expect(out).toContain('D123');
    expect(out).toMatch(/this task's own channel/i);
  });

  // A trigger-fired task's home channel is its own before it has a thread there: the canvas and pin blocks in
  // its prompt name that channel, and `read_channel_history` takes an id. Listing the capability without
  // listing the channel would leave the first turn told about context it has no way to go and look at.
  it("appends a trigger-fired task's home channel before it has a thread there", async () => {
    const task = makeTask();
    (task.metadata as unknown as { home_channel: unknown }).home_channel = { channel_id: 'C_HOME', channel_name: 'ops-private' };

    const out = await textOf(await getHandler('list_channels', task)({}));

    expect(out).toContain('#ops-private');
    expect(out).toContain('C_HOME');
    expect(out).toMatch(/this task's own channel/i);
  });

  it('does not list a home channel twice once its thread is linked', async () => {
    const task = makeTask('C_HOME');
    (task.metadata as unknown as { home_channel: unknown }).home_channel = { channel_id: 'C_HOME', channel_name: 'ops-private' };

    const out = await textOf(await getHandler('list_channels', task)({}));

    // Linked first and first-link-wins, so the entry carries the linked channel's name, exactly once.
    expect(out.match(/C_HOME/g)).toHaveLength(1);
  });

  it('never enumerates other private channels (only public + own come from the data)', async () => {
    // listBotChannels is public-only by construction; the handler must not ask it for more.
    await getHandler('list_channels', makeTask('C_priv'))({});
    expect(listBotChannels).toHaveBeenCalledWith(); // no arguments — public-only
  });

  it('no memberships and no own channel → friendly invite hint', async () => {
    listBotChannels.mockResolvedValue([]);
    const out = await textOf(await getHandler('list_channels', makeTask())({}));
    expect(out).toMatch(/invite/i);
  });
});

// The destination channel's standing brief governs what gets said there, and the
// agent arrives carrying only its own channel's context.
describe('post_to_channel — destination brief preflight', () => {
  const MANDATE = 'Sergei: "can you flag this in that channel"';
  const BRIEF = '<other_channel_context channel="#incidents" id="C123">rules</other_channel_context>';

  beforeEach(() => {
    postSlackMessage.mockReset();
    assertPostableChannel.mockReset();
    assertPostableChannel.mockResolvedValue(undefined);
    isThreadMuted.mockReset();
    isThreadMuted.mockResolvedValue(false);
    ensureChannelCanvas.mockReset();
    ensureChannelCanvas.mockResolvedValue(undefined);
    buildOtherChannelContextSection.mockReset();
    buildOtherChannelContextSection.mockResolvedValue('');
  });

  it('returns the brief instead of posting on the first attempt, then posts on the retry', async () => {
    buildOtherChannelContextSection.mockResolvedValue(BRIEF);
    postSlackMessage.mockResolvedValue('1716998400.123456');
    const task = makeTask();
    const post = getHandler('post_to_channel', task);

    const first = await textOf(await post({ channel: 'C123', message: 'heads up', mandate: MANDATE }));
    expect(postSlackMessage).not.toHaveBeenCalled();
    expect(first).toContain(BRIEF);
    expect(first).toMatch(/not posted yet/i);
    expect(task.prepareMemoryDelivery).toHaveBeenCalledWith('C123');

    const second = await textOf(await post({ channel: 'C123', message: 'heads up', mandate: MANDATE }));
    expect(postSlackMessage).toHaveBeenCalledWith({ channel: 'C123', text: 'heads up', threadTs: undefined });
    expect(task.prepareMemoryDelivery).toHaveBeenCalledTimes(2);
    expect(second).toContain('1716998400.123456');
  });

  // The common case must stay a single round-trip.
  it('posts immediately when the destination has no canvas', async () => {
    postSlackMessage.mockResolvedValue('1716998400.123456');
    const post = getHandler('post_to_channel');

    const out = await textOf(await post({ channel: 'C123', message: 'heads up', mandate: MANDATE }));

    expect(postSlackMessage).toHaveBeenCalledTimes(1);
    expect(out).toContain('1716998400.123456');
  });

  // A reply is still speaking into that channel, so the brief applies.
  // Once per task: after the brief has been shown, later posts to that channel go
  // straight through. Tracked in task metadata, so it survives the task being
  // rebuilt from disk between requests.
  it('briefs a channel once per task, not once per re-activation', async () => {
    buildOtherChannelContextSection.mockResolvedValue(BRIEF);
    postSlackMessage.mockResolvedValue('1716998400.123456');
    const task = makeTask();
    const post = getHandler('post_to_channel', task);

    await post({ channel: 'C123', message: 'a', mandate: MANDATE });   // briefed
    await post({ channel: 'C123', message: 'b', mandate: MANDATE });   // posts
    ensureChannelCanvas.mockClear();
    buildOtherChannelContextSection.mockClear();
    const third = await textOf(await post({ channel: 'C123', message: 'c', mandate: MANDATE }));

    expect(third).not.toMatch(/not posted yet/i);
    expect(ensureChannelCanvas).not.toHaveBeenCalled();
    expect((task.metadata as { briefed_channels?: string[] }).briefed_channels).toEqual(['C123']);
  });

  it('blocks a second, different channel before loading its brief', async () => {
    buildOtherChannelContextSection.mockResolvedValue(BRIEF);
    const task = makeTask();
    const post = getHandler('post_to_channel', task);

    await post({ channel: 'C123', message: 'a', mandate: MANDATE });
    const other = await textOf(await post({ channel: 'C999', message: 'b', mandate: MANDATE }));

    expect(other).toMatch(/different Slack audience/i);
    expect((task.metadata as { briefed_channels?: string[] }).briefed_channels).toEqual(['C123']);
  });

  it('applies to thread replies', async () => {
    buildOtherChannelContextSection.mockResolvedValue(BRIEF);
    const post = getHandler('post_to_channel');

    const out = await textOf(await post({ channel: 'C123', message: 'hi', mandate: MANDATE, thread_ts: '1.0' }));

    expect(postSlackMessage).not.toHaveBeenCalled();
    expect(out).toContain(BRIEF);
  });

  // A refused post must not scan: the scan announces canvas adoption in the
  // destination, and nothing is being posted there.
  it('does not scan the destination when the mandate is rejected', async () => {
    const post = getHandler('post_to_channel');

    await post({ channel: 'C123', message: 'hi', mandate: 'yes' });

    expect(ensureChannelCanvas).not.toHaveBeenCalled();
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it('does not scan a muted destination', async () => {
    const post = getHandler('post_to_channel', makeTask('C123', { muted: true }));

    await post({ channel: 'C123', message: 'hi', mandate: MANDATE });

    expect(ensureChannelCanvas).not.toHaveBeenCalled();
    expect(postSlackMessage).not.toHaveBeenCalled();
  });
});

// The allowlist is the only thing standing between a prompt-influenced file id and the
// task workspace, and it now has two independent sources. Nothing exercised the union
// itself: reverting it to canvas-only left the whole suite green.
describe('fetch_slack_reference allowlist', () => {
  beforeEach(() => {
    collectCanvasFileAllowlist.mockReset();
    collectPinnedFileAllowlist.mockReset();
    collectCanvasFileAllowlist.mockResolvedValue(new Set(['FCANVAS']));
    collectPinnedFileAllowlist.mockResolvedValue(new Set(['FPINNED']));
  });

  it('refuses a file id that is neither canvas-referenced nor pinned', async () => {
    const fetchRef = getHandler('fetch_slack_reference');

    const out = await textOf(await fetchRef({ reference: 'FSTRANGER' }));

    expect(out).toContain('FSTRANGER');
    expect(out).toMatch(/neither referenced .* nor pinned/i);
  });

  // Past the gate the handler runs on into the fetch, which has neither a sandbox nor a
  // Slack behind it in this harness — so what it does there is not the point. The point
  // is only that it was not turned away as out of scope, which is what the union buys.
  async function outcomeOf(reference: string): Promise<string> {
    const fetchRef = getHandler('fetch_slack_reference');
    try {
      return await textOf(await fetchRef({ reference }));
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  it('lets a PINNED file id past the allowlist', async () => {
    expect(await outcomeOf('FPINNED')).not.toMatch(/neither referenced .* nor pinned/i);
  });

  it('still lets a CANVAS-referenced file id past, so the union did not replace it', async () => {
    expect(await outcomeOf('FCANVAS')).not.toMatch(/neither referenced .* nor pinned/i);
  });
});
