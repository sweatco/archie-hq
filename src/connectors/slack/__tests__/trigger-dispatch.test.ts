/**
 * Channel-message trigger dispatch matches against the *rendered* message body, and the routing gate says so when it drops an event in a channel a trigger is watching.
 *
 * The regression these tests pin: a webhook / app post carries an empty top-level `text` with all of its content in `attachments`, so a `contains` filter matched against the raw event field never fired. Dispatch now renders the payload through the same extraction every other agent-facing path uses, with no fallback to the raw text — a fallback would silently restore the bug on exactly the payloads it was meant to fix.
 *
 * Two entry points are exercised: the exported `handleSlackEvent` (whose ambient-top-level-message branch is the only caller of trigger dispatch), and the Bolt `message` handler registered by `mountSlackApp` (where the routing gate and its drop-log live).
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
import { fetchSlackThread } from '../client.js';
import { getChannelMessageTriggers, fireTrigger } from '../../../system/trigger-scheduler.js';
import { logger } from '../../../system/logger.js';

const CHANNEL = 'C0WATCHED';

function makeTrigger(contains?: string): Trigger {
  return {
    id: 'trg-20260818-1200-abc123',
    status: 'enabled',
    created_by: 'U_DEV',
    created_at: '2026-08-18T12:00:00.000Z',
    binding: { type: 'channel', channel_id: CHANNEL, channel_name: 'watched' },
    conditions: [{ type: 'channel_message', channel_id: CHANNEL, ...(contains ? { match: { contains } } : {}) }],
    action: { prompt: 'look into it' },
    summary: 'watch the deploy bot',
  };
}

/** The ambient top-level channel post that reaches trigger dispatch: no task follows the thread, it isn't an @mention, and it isn't a thread reply. */
async function deliverAmbientPost(raw: Record<string, unknown>): Promise<void> {
  vi.mocked(fetchSlackThread).mockResolvedValue({
    threadId: raw.ts as string,
    channel: { id: CHANNEL, name: 'watched' },
    rootAuthorWasBot: false,
    messages: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  await handleSlackEvent({
    type: 'message',
    channel: CHANNEL,
    user: (raw.user as string) ?? '',
    raw,
    ts: raw.ts as string,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getChannelMessageTriggers).mockReturnValue([]);
});

describe('channel-message trigger dispatch matches the rendered body', () => {
  // The core regression. A webhook post ("deploy failed on prod") has an empty
  // top-level `text`; the words only exist inside an attachment card. Matching
  // the raw field made this post invisible to the filter watching for it.
  it('fires a `contains` trigger on text that exists only in attachments', async () => {
    vi.mocked(getChannelMessageTriggers).mockReturnValue([makeTrigger('deploy failed')]);

    await deliverAmbientPost({
      type: 'message',
      subtype: 'bot_message',
      channel: CHANNEL,
      bot_id: 'B_OTHER',
      text: '',
      attachments: [{ text: 'deploy failed on prod (build 4711)' }],
      ts: '1700000000.000100',
    });

    expect(vi.mocked(fireTrigger)).toHaveBeenCalledTimes(1);
    // ...and the rendered body — not the empty raw text — is what travels on.
    expect(vi.mocked(fireTrigger).mock.calls[0][1]).toMatchObject({
      kind: 'message',
      text: 'deploy failed on prod (build 4711)',
      threadId: '1700000000.000100',
      channelId: CHANNEL,
    });
  });

  it('still fires on plain top-level text', async () => {
    vi.mocked(getChannelMessageTriggers).mockReturnValue([makeTrigger('deploy failed')]);

    await deliverAmbientPost({
      type: 'message',
      channel: CHANNEL,
      user: 'U_DEV',
      text: 'the deploy failed again',
      ts: '1700000000.000200',
    });

    expect(vi.mocked(fireTrigger)).toHaveBeenCalledTimes(1);
  });

  // No fallback of any kind: when extraction yields nothing, the filter sees an
  // empty body and simply does not match. A `?? rawText` fallback here would
  // reopen the original bug.
  it('does not match a non-empty filter when extraction yields an empty body', async () => {
    vi.mocked(getChannelMessageTriggers).mockReturnValue([makeTrigger('deploy failed')]);

    await deliverAmbientPost({
      type: 'message',
      subtype: 'bot_message',
      channel: CHANNEL,
      bot_id: 'B_OTHER',
      text: '',
      ts: '1700000000.000300',
    });

    expect(vi.mocked(fireTrigger)).not.toHaveBeenCalled();
  });

  it('costs no rendering when no trigger watches the channel', async () => {
    vi.mocked(getChannelMessageTriggers).mockReturnValue([]);
    const { extractMessageContent } = await import('../client.js');

    await deliverAmbientPost({
      type: 'message',
      channel: CHANNEL,
      user: 'U_DEV',
      text: 'nobody is watching this',
      ts: '1700000000.000400',
    });

    expect(vi.mocked(fireTrigger)).not.toHaveBeenCalled();
    expect(vi.mocked(extractMessageContent)).not.toHaveBeenCalled();
  });
});

describe('routing-gate drop log', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let messageHandler: (arg: { event: any }) => unknown;

  beforeEach(async () => {
    await mountSlackApp({} as Application, {
      slackBotToken: 'xoxb-test',
      slackAppToken: 'xapp-test',
    });
    messageHandler = bolt.handlers.get('message')!;
    vi.mocked(logger.warn).mockClear();
  });

  it('registers a `message` handler at all (guards the fake-Bolt seam)', () => {
    expect(messageHandler).toBeTypeOf('function');
  });

  it('warns when a gate-dropped event lands in a trigger-watched channel', async () => {
    vi.mocked(getChannelMessageTriggers).mockReturnValue([makeTrigger('deploy failed')]);

    await messageHandler({
      event: { type: 'message', subtype: 'channel_join', channel: CHANNEL, user: 'U_DEV', ts: '1700000000.000500' },
    });

    expect(vi.mocked(fireTrigger)).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    const [, message] = vi.mocked(logger.warn).mock.calls[0];
    expect(message).toContain(CHANNEL);
    expect(message).toContain('channel_join');
    expect(message).toContain('1700000000.000500');
  });

  it('stays silent when the dropped event is in a channel nothing watches', async () => {
    vi.mocked(getChannelMessageTriggers).mockReturnValue([]);

    await messageHandler({
      event: { type: 'message', subtype: 'channel_join', channel: 'C0QUIET', user: 'U_DEV', ts: '1700000000.000600' },
    });

    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });
});
