/**
 * Breadth sweep over the inverted subtype gate.
 *
 * Flipping the gate from a three-entry allowlist to a seventeen-entry denylist means every subtype nobody enumerated is now FORWARDED rather than silently dropped. That is the fix, and it is also the risk: payload shapes that never reached `handleSlackEvent` before now do. That class has already produced one real defect here — a body-less, user-less DM subtype reached `Task.create()` and woke the PM on an empty knowledge log — which is why the shapes below are swept deliberately rather than trusted.
 *
 * For every subtype the denylist admits, and for the awkward shapes (no `user`, no `text`, a nested `message` object, an app `bot_id`), each row asserts the same two things: the handler does not throw, and no task is created that should not be. Routing correctness for the specific arms lives in task-routing.test.ts and trigger-dispatch.test.ts; what this file buys is that nothing downstream chokes on a shape it has never seen.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Application } from 'express';
import type { Trigger } from '../../../types/trigger.js';
import type { SlackAttachment } from '../../../types/index.js';

// events.ts loads Bolt through `createRequire`, which bypasses vitest's module registry entirely — so `module` itself is mocked and its `createRequire` returns a require that hands back a fake Bolt while every other id falls through to the real one. That is what makes the registered `message` handler reachable from a unit test: the gate and its drop-log live inside it, not inside an exported function.
const bolt = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlers = new Map<string, (arg: any) => unknown>();
  class FakeApp {
    constructor(_opts: unknown) {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    event(name: string, handler: (arg: any) => unknown) { handlers.set(name, handler); }
    action(_name: string, _handler: unknown) {}
    async start() {}
    async stop() {}
  }
  class FakeReceiver {
    constructor(_opts: unknown) {}
  }
  return { handlers, exports: { App: FakeApp, ExpressReceiver: FakeReceiver, SocketModeReceiver: FakeReceiver } };
});

vi.mock('module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('module')>();
  return {
    ...actual,
    createRequire: (url: string | URL) => {
      const real = actual.createRequire(url);
      const patched = (id: string) => (id === '@slack/bolt' ? bolt.exports : real(id));
      return Object.assign(patched, real);
    },
  };
});

// A deliberately thin stand-in for the real extraction: top-level text plus attachment card text, authorless (the real `extractMessageContent` strips attachment authors too). Faithful extraction — blocks, mention resolution, file naming — is covered by client.test.ts; what matters here is only that dispatch reads what extraction produced rather than the raw `text` field.
vi.mock('../client.js', () => ({
  initSlackClient: vi.fn(),
  updateMessage: vi.fn().mockResolvedValue(undefined),
  getBotUserId: vi.fn().mockReturnValue('U_BOT'),
  fetchSlackThread: vi.fn(),
  getBotId: vi.fn().mockReturnValue('B_OURS'),
  addReaction: vi.fn(),
  setSlackDryRun: vi.fn(),
  getUserInfo: vi.fn().mockResolvedValue({ name: 'dev', realName: 'A Dev', teamId: 'T_HOME' }),
  isExternalUser: vi.fn().mockReturnValue(false),
  isChannelShared: vi.fn().mockResolvedValue(false),
  postEphemeral: vi.fn(),
  getSlackClient: vi.fn(),
  cleanSlackText: vi.fn((s: string) => s),
  extractMessageContent: vi.fn(
    async (message: unknown): Promise<{ text: string; attachments?: SlackAttachment[] }> => {
      const raw = (message ?? {}) as { text?: string; attachments?: Array<{ text?: string }> };
      const attachments = (raw.attachments ?? []).map((a) => ({ text: a.text ?? '' })) as SlackAttachment[];
      return { text: raw.text ?? '', ...(attachments.length > 0 ? { attachments } : {}) };
    },
  ),
}));

vi.mock('../channel-canvas.js', () => ({ ensureChannelCanvas: vi.fn() }));
vi.mock('../channel-pins.js', () => ({ ensureChannelPins: vi.fn() }));
vi.mock('../title.js', () => ({ setAssistantThreadTitle: vi.fn() }));
vi.mock('../../../tasks/title-generator.js', () => ({ generateTaskTitle: vi.fn() }));
vi.mock('../../../system/shutdown.js', () => ({ getIsShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('../../../system/event-bus.js', () => ({
  onEvent: vi.fn(),
  offEvent: vi.fn(),
  emitEvent: vi.fn(),
}));
vi.mock('../../../system/workdir.js', () => ({ SESSIONS_DIR: '/tmp/sessions' }));

vi.mock('../../../tasks/task.js', () => ({
  Task: { get: vi.fn(), create: vi.fn() },
  activeTasks: new Map(),
}));

vi.mock('../../../tasks/persistence.js', () => ({
  findTaskByThread: vi.fn().mockResolvedValue(undefined),
  readKnowledgeLog: vi.fn(),
  loadMetadata: vi.fn(),
  appendCliMessage: vi.fn(),
  readEvents: vi.fn(),
}));

vi.mock('../../../system/trigger-scheduler.js', () => ({
  getChannelMessageTriggers: vi.fn().mockReturnValue([]),
  fireTrigger: vi.fn().mockResolvedValue(undefined),
  triggerWhat: vi.fn((t: Trigger) => t.summary ?? ''),
}));

vi.mock('../../../system/logger.js', () => ({
  logger: {
    system: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn(),
    plain: vi.fn(), server: vi.fn(), slack: vi.fn(),
  },
}));

import { handleSlackEvent, mountSlackApp } from '../events.js';
import { fetchSlackThread, getBotUserId, isExternalUser, extractMessageContent } from '../client.js';
import { getChannelMessageTriggers, fireTrigger } from '../../../system/trigger-scheduler.js';
import { logger } from '../../../system/logger.js';
import { Task } from '../../../tasks/task.js';
import { findTaskByThread } from '../../../tasks/persistence.js';

const CHANNEL = 'C0SWEEP';
const DM = 'D0SWEEP';

/** Every subtype the denylist admits and that Slack can plausibly deliver, plus two it has not invented yet. */
const FORWARDED_SUBTYPES: Array<string | undefined> = [
  undefined,
  'bot_message',
  'me_message',
  'huddle_thread',
  'assistant_app_thread',
  'file_comment',
  'file_share',
  'thread_broadcast',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'group_topic',
  'group_purpose',
  'group_name',
  'reminder_add',
  'bot_add',
  'bot_remove',
  'tombstone',
  'channel_canvas_updated',
  'sh_room_created',
  'file_mention',
  'document_mention',
  'some_future_slack_thing',
  'another_unenumerated_subtype',
];

/** The 17 the denylist refuses. Swept too: a denied subtype must be dropped before any thread fetch. */
const DENIED_SUBTYPES = [
  'message_changed', 'message_deleted', 'message_replied',
  'channel_join', 'channel_leave', 'group_join', 'group_leave',
  'channel_archive', 'channel_unarchive', 'group_archive', 'group_unarchive',
  'channel_convert_to_private', 'channel_convert_to_public', 'channel_posting_permissions',
  'pinned_item', 'unpinned_item', 'ekm_access_denied',
];

/**
 * The Bolt handler fires `handleSlackEvent(...).catch(...)` without awaiting, so a plain await returns before
 * routing has run and any assertion about what did NOT happen would hold trivially.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

let messageHandler: (arg: { event: unknown }) => unknown;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(getChannelMessageTriggers).mockReturnValue([]);
  vi.mocked(findTaskByThread).mockResolvedValue(null);
  vi.mocked(isExternalUser).mockReturnValue(false);
  vi.mocked(getBotUserId).mockReturnValue('U_BOT');
  // A thread that exists and carries one visible message — the ordinary case, so nothing is refused by the
  // content floor unless a row deliberately empties it.
  vi.mocked(fetchSlackThread).mockResolvedValue({
    threadId: '1700000000.000001',
    channel: { id: CHANNEL, name: 'sweep' },
    shared: false,
    currentMessageTs: '1700000000.000001',
    rootAuthorWasBot: false,
    messages: [{ user: { id: 'U_DEV', username: 'dev', realName: 'A Dev' }, ownText: 'hi', ts: '1700000000.000001' }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  await mountSlackApp({} as Application, { slackBotToken: 'xoxb-test', slackAppToken: 'xapp-test' });
  messageHandler = bolt.handlers.get('message')!;
});

/** Drive the real registered handler and surface anything it threw. */
async function deliver(event: Record<string, unknown>): Promise<void> {
  await messageHandler({ event });
  await flush();
  const thrown = vi.mocked(logger.error).mock.calls.filter((c) => String(c[1] ?? '').includes('Error processing Slack event'));
  expect(thrown, `handler threw for ${JSON.stringify(event).slice(0, 120)}`).toEqual([]);
}

describe('the denylist admits these subtypes without anything downstream choking', () => {
  for (const subtype of FORWARDED_SUBTYPES) {
    const label = subtype ?? '(no subtype)';

    it(`survives a top-level channel post: ${label}`, async () => {
      await deliver({ type: 'message', ...(subtype ? { subtype } : {}), channel: CHANNEL, user: 'U_DEV', text: 'hello', ts: '1700000000.000100' });
      // Nothing watches this channel, so an ambient post must not create a task.
      expect(vi.mocked(Task.create)).not.toHaveBeenCalled();
    });

    it(`survives a thread reply with no task following it: ${label}`, async () => {
      await deliver({ type: 'message', ...(subtype ? { subtype } : {}), channel: CHANNEL, user: 'U_DEV', text: 'hello', ts: '1700000000.000200', thread_ts: '1700000000.000001' });
      expect(vi.mocked(Task.create)).not.toHaveBeenCalled();
    });

    it(`survives the awkward shape — no user, no text, an app bot_id: ${label}`, async () => {
      await deliver({ type: 'message', ...(subtype ? { subtype } : {}), channel: CHANNEL, bot_id: 'B_THIRD', ts: '1700000000.000300' });
      expect(vi.mocked(Task.create)).not.toHaveBeenCalled();
    });

    it(`survives a nested message object: ${label}`, async () => {
      await deliver({ type: 'message', ...(subtype ? { subtype } : {}), channel: CHANNEL, user: 'U_DEV', ts: '1700000000.000400', message: { ts: '1700000000.000400', user: 'U_DEV', text: 'nested' } });
      expect(vi.mocked(Task.create)).not.toHaveBeenCalled();
    });
  }
});

describe('a body-less DM cannot seed a task, whatever its subtype', () => {
  // The defect this sweep exists for: an assistant-container notice with no author and no body reached
  // Task.create() and woke the PM on an empty knowledge log. The floor is the fetched thread being empty.
  beforeEach(() => {
    vi.mocked(fetchSlackThread).mockResolvedValue({
      threadId: '1700000000.000900',
      channel: { id: DM, name: 'dm' },
      shared: false,
      currentMessageTs: '1700000000.000900',
      rootAuthorWasBot: false,
      messages: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });

  for (const subtype of FORWARDED_SUBTYPES) {
    it(`refuses to create a task for a content-less DM: ${subtype ?? '(no subtype)'}`, async () => {
      await deliver({ type: 'message', ...(subtype ? { subtype } : {}), channel: DM, ts: '1700000000.000900' });
      expect(vi.mocked(Task.create)).not.toHaveBeenCalled();
    });
  }

  it('still creates a task for a DM that carries a message', async () => {
    vi.mocked(fetchSlackThread).mockResolvedValue({
      threadId: '1700000000.000901',
      channel: { id: DM, name: 'dm' },
      shared: false,
      currentMessageTs: '1700000000.000901',
      rootAuthorWasBot: false,
      messages: [{ user: { id: 'U_DEV', username: 'dev', realName: 'A Dev' }, ownText: 'hello', ts: '1700000000.000901' }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.mocked(Task.create).mockResolvedValue({
      metadata: { channels: {}, title: 'x' },
      append: vi.fn().mockResolvedValue({ linkedNewThread: true }),
      ackMessage: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      debouncedSave: vi.fn(),
    } as never);

    await deliver({ type: 'message', channel: DM, user: 'U_DEV', text: 'hello', ts: '1700000000.000901' });
    expect(vi.mocked(Task.create)).toHaveBeenCalledTimes(1);
  });
});

describe('the denied subtypes are dropped before any thread fetch', () => {
  for (const subtype of DENIED_SUBTYPES) {
    it(`drops ${subtype} without fetching a thread`, async () => {
      // `message_changed` has its own handler and is expected to reach it, so only assert no task is created.
      await deliver({ type: 'message', subtype, channel: CHANNEL, user: 'U_DEV', text: 'noise', ts: '1700000000.000500' });
      expect(vi.mocked(Task.create)).not.toHaveBeenCalled();
      if (subtype !== 'message_changed') {
        expect(vi.mocked(fetchSlackThread), `${subtype} should be refused before the thread fetch`).not.toHaveBeenCalled();
      }
    });
  }
});
