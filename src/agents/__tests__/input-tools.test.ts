// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `list_inputs` and `get_input_history` as the PM calls them: the conversation the task is in decides what is shown.
 * The inbox file is real. Mock shape and handler extraction follow trigger-incoming-event.test.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MessageQueue } from '../message-queue.js';
import { expectDefined } from '../../test-support/assertions.js';
import { mcpToolHandler } from '../../test-support/mcp.js';
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
const { loadMetadata } = vi.hoisted(() => ({ loadMetadata: vi.fn() }));
vi.mock('../../tasks/persistence.js', () => ({
  appendAgentFinding: vi.fn().mockResolvedValue(undefined),
  getReposPath: vi.fn().mockReturnValue('/sessions/task-123/repos'),
  isThreadMuted: vi.fn().mockResolvedValue(false),
  loadMetadata,
}));
vi.mock('../../system/logger.js', () => ({
  logger: {
    agentAction: vi.fn(),
    agentFinding: vi.fn(),
    agentToSlack: vi.fn(),
    system: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));
vi.mock('../registry.js', () => ({
  getAgentIds: vi.fn().mockReturnValue([]),
  getVisiblePeerIdsForSender: vi.fn().mockReturnValue([]),
  getAgentDef: vi.fn().mockReturnValue(undefined),
}));

const { loadTrigger } = vi.hoisted(() => ({ loadTrigger: vi.fn() }));
vi.mock('../../system/trigger-store.js', async (importActual) => {
  const actual = await importActual<typeof import('../../system/trigger-store.js')>();
  return { ...actual, loadTrigger };
});

const { getChannelInfo, listWorkspaceChannels } = vi.hoisted(() => ({
  getChannelInfo: vi.fn(),
  listWorkspaceChannels: vi.fn(),
}));
vi.mock('../../connectors/slack/client.js', async (importActual) => {
  const actual = await importActual<typeof import('../../connectors/slack/client.js')>();
  return { ...actual, getChannelInfo, listWorkspaceChannels, postSlackMessage: vi.fn() };
});

vi.mock('../../connectors/slack/channel-canvas.js', () => ({
  ensureChannelCanvas: vi.fn(),
  buildOtherChannelContextSection: vi.fn().mockResolvedValue(''),
  collectCanvasFileAllowlist: vi.fn(),
}));
vi.mock('../../connectors/slack/channel-pins.js', () => ({ collectPinnedFileAllowlist: vi.fn() }));

import { setInputServices } from '../../incoming/access.js';
import { IncomingStore } from '../../incoming/store.js';
import { createOrchestrationMcpServer } from '../tools.js';
import type { Agent } from '../agent.js';
import type { Task } from '../../tasks/task.js';

const INPUT_ID = 'inp-AAAAAAAAAAAAAAAAAAAAAA';
const NOTES = 'trg-20261124-0900-notes1';
const LEADS = 'trg-20261124-0900-leads1';
const THREAD_URL = 'https://example.slack.com/archives/C0NOTES/p1795530309733459';

function makeAgent(): Agent {
  return {
    def: { id: 'pm-agent', key: 'pm', role: 'PM', expertise: '', pluginName: 'pm', isPm: true },
    queue: new MessageQueue(),
    session: { active: false },
  } as unknown as Agent;
}

/** A task whose conversation is the given Slack channel or DM. */
function taskIn(conversationId: string): Task {
  const key = `slack:${conversationId}:1.0`;
  return {
    taskId: 'task-1',
    isActive: true,
    metadata: {
      channels: { [key]: { type: 'slack', channel_id: conversationId, thread_id: '1.0' } },
      default_channel: key,
    },
    touch: vi.fn(),
    debouncedSave: vi.fn(),
  } as unknown as Task;
}

async function call(name: string, task: Task, args: Record<string, unknown> = {}): Promise<string> {
  const handler = mcpToolHandler(createOrchestrationMcpServer(makeAgent(), task), name);
  return expectDefined((await handler(args)).content[0]).text;
}

function routine(id: string, channelId: string, channelName: string, summary: string): Trigger {
  return {
    id,
    status: 'enabled',
    created_by: 'U0DANA',
    created_at: '2026-11-24T09:00:00.000Z',
    binding: { type: 'channel', channel_id: channelId, channel_name: channelName },
    conditions: [{ type: 'incoming_event', input_id: INPUT_ID }],
    action: { prompt: 'Summarize the meeting.' },
    summary,
  };
}

let root: string;
let store: IncomingStore;

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'archie-input-tools-'));
  store = new IncomingStore(join(root, 'state.sqlite'));
  store.insertInput(
    {
      id: INPUT_ID,
      state: 'enabled',
      auth: 'standard_webhooks',
      secretRefs: ['sec-1'],
      filter: [],
      routines: [NOTES, LEADS],
      revision: 1,
      owner: 'U0DANA',
      purpose: 'Meeting recordings',
    },
    1000,
  );
  setInputServices({
    store,
    secrets: {
      create: () => Promise.reject(new Error('unused')),
      read: () => Promise.reject(new Error('unused')),
      remove: () => Promise.reject(new Error('unused')),
    },
  });

  const routines = new Map([
    [NOTES, routine(NOTES, 'C0NOTES', 'notes', 'Meeting notes')],
    [LEADS, routine(LEADS, 'C0LEADS', 'leads', 'Lead alerts')],
  ]);
  loadTrigger.mockImplementation((id: string) => Promise.resolve(routines.get(id) ?? null));
  listWorkspaceChannels.mockResolvedValue([
    { id: 'C0NOTES', isPrivate: false },
    { id: 'C0LEADS', isPrivate: true },
    { id: 'C0GENERAL', isPrivate: false },
  ]);
  getChannelInfo.mockImplementation((id: string) =>
    Promise.resolve(
      id === 'D0DANA'
        ? { isIm: true, imUserId: 'U0DANA', name: 'DM with Dana' }
        : { isIm: false, name: 'general' },
    ),
  );
  loadMetadata.mockResolvedValue(null);
});

afterEach(() => {
  setInputServices(null);
  store.close();
  rmSync(root, { recursive: true, force: true });
});

it("lists an input from a public channel without a private channel's routine", async () => {
  const listed = await call('list_inputs', taskIn('C0GENERAL'));

  expect(listed).toContain(`routine [${NOTES}] (enabled) “Meeting notes” — delivers to #notes`);
  expect(listed).toContain('and 1 other consumer not visible from here');
  expect(listed).not.toContain('Lead alerts');
});

it("lists the input whole in its owner's DM", async () => {
  const listed = await call('list_inputs', taskIn('D0DANA'));

  expect(listed).toContain('Meeting notes');
  expect(listed).toContain('Lead alerts');
});

it('reads a delivery as delivered once its task has opened a thread', async () => {
  store.receive(
    {
      inputId: INPUT_ID,
      binding: 'generic',
      eventKey: 'msg_1',
      digest: 'd1',
      body: Buffer.from('{}'),
      receivedAt: Date.UTC(2026, 10, 24, 9, 0),
    },
    [{ kind: 'routine', consumerId: NOTES, snapshot: '{}' }],
  );
  const claimed = expectDefined(store.claimHandoff(Date.UTC(2026, 10, 25), 60_000));
  store.saveReservation(claimed.handoff.id, claimed.token, JSON.stringify({ task_id: 'task-9' }));
  store.finishHandoff(claimed.handoff.id, claimed.token, 'accepted');
  loadMetadata.mockImplementation((taskId: string) =>
    Promise.resolve(
      taskId === 'task-9'
        ? {
            status: 'completed',
            default_channel: 'C0NOTES',
            channels: { C0NOTES: { type: 'slack', channel_id: 'C0NOTES', url: THREAD_URL } },
          }
        : null,
    ),
  );

  const shown = await call('get_input_history', taskIn('C0GENERAL'), { input_id: INPUT_ID });

  expect(shown).toContain(
    `• 2026-11-24 09:00 UTC — delivered: [${NOTES}] “Meeting notes” ran as task-9 and posted in its conversation — ${THREAD_URL}`,
  );
});

it('says so when incoming events are not available', async () => {
  setInputServices(null);

  expect(await call('list_inputs', taskIn('C0GENERAL'))).toBe(
    'Incoming events are not available on this instance right now.',
  );
  expect(await call('get_input_history', taskIn('C0GENERAL'), { input_id: INPUT_ID })).toBe(
    'Incoming events are not available on this instance right now.',
  );
});
