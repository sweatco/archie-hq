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
import { fetchSlackThread, getBotUserId, isExternalUser, extractMessageContent } from '../client.js';
import { getChannelMessageTriggers, fireTrigger } from '../../../system/trigger-scheduler.js';
import { logger } from '../../../system/logger.js';
import { Task } from '../../../tasks/task.js';
import { findTaskByThread } from '../../../tasks/persistence.js';

const CHANNEL = 'C0WATCHED';

function makeTrigger(contains?: string, from_user?: string): Trigger {
  return {
    id: 'trg-20260818-1200-abc123',
    status: 'enabled',
    created_by: 'U_DEV',
    created_at: '2026-08-18T12:00:00.000Z',
    binding: { type: 'channel', channel_id: CHANNEL, channel_name: 'watched' },
    conditions: [{
      type: 'channel_message',
      channel_id: CHANNEL,
      ...(contains || from_user ? { match: { ...(contains ? { contains } : {}), ...(from_user ? { from_user } : {}) } } : {}),
    }],
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

/**
 * The Bolt `message` handler fires `handleSlackEvent(...).catch(...)` WITHOUT awaiting, so a plain
 * `await messageHandler(...)` returns before any of the async routing has run. Without this flush an
 * assertion that something was NOT called passes trivially — it would be asserting that work which has
 * not started yet has not happened.
 */
async function flushHandler(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getChannelMessageTriggers).mockReturnValue([]);
  // `clearAllMocks` clears recorded calls but NOT implementations, so a `mockResolvedValue` set in one
  // describe leaks into the next and makes failures depend on test order. Reset the stateful ones here.
  vi.mocked(findTaskByThread).mockResolvedValue(null);
  vi.mocked(isExternalUser).mockReturnValue(false);
  vi.mocked(getBotUserId).mockReturnValue('U_BOT');
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
    // ...and the rendered body is what the filter was matched against. It is also what `fireTrigger` now reads: the body is passed as `FireContext.body`, and a fire whose fetched thread is missing the triggering message writes exactly this string to the task's knowledge log, so the same render both decides which posts FIRE and reaches the spawned agent.
    expect(vi.mocked(fireTrigger).mock.calls[0][1]).toMatchObject({
      kind: 'message',
      body: 'deploy failed on prod (build 4711)',
    });
    // The fetched thread travels with the fire — it is what the task ingests, and its root ts is the
    // triggering message's own, since dispatch only ever fires on a top-level post.
    expect(vi.mocked(fireTrigger).mock.calls[0][1].thread?.channel.id).toBe(CHANNEL);
    expect(vi.mocked(fireTrigger).mock.calls[0][1].thread?.threadId).toBe('1700000000.000100');
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

  // There is deliberately NO test here of the form "a fallback to raw text would change the match".
  // Two attempts at one are unwritable rather than merely awkward, and the reasons are worth recording
  // so nobody adds a vacuous one later. A message with empty text and no attachments renders to '' and
  // matches nothing either way, so it passes identically with and without the fix. And the rendered
  // body CONTAINS `ownText`, so it is a superset of the raw field — any filter that matches the raw
  // text also matches the render, which means no `contains` value can separate them.
  //
  // What the fix actually buys is covered above: content reachable ONLY through extraction (an
  // attachment card, a Block Kit body, a resolved mention) becomes matchable. Reverting dispatch to the
  // raw field fails the attachment-only case. The absence of the fallback itself is pinned structurally
  // by render-path-structure.test.ts only for the exact thread-root form that PR #280 used — it does NOT
  // catch an arbitrary raw-text fallback added to dispatch later, and claiming otherwise would be
  // overstating it. The discriminator that WOULD catch that is mention resolution: extraction rewrites
  // `<@U123>` to `<@U123:Real Name>`, so a filter on the resolved name matches the render and not the raw
  // field. That test is not written here; it is recorded as a known gap rather than implied to exist.

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

describe('the author filter matches the author the payload actually carries', () => {
  // The regression. An app posting through an incoming webhook carries a `bot_id` and NO `user`, and the
  // author id Archie shows an agent for such a post — in the knowledge log, in `read_channel_history` — is
  // that `B…`. A filter naming it was therefore the natural thing to write, and it was compared against
  // `event.user` alone, so it matched nothing: the trigger was approved, announced, listed as active, and
  // never fired once.
  it('fires on a `B…` filter when the app post has a bot_id and no user', async () => {
    vi.mocked(getChannelMessageTriggers).mockReturnValue([makeTrigger('expired feature flags report', 'B_REPORTER')]);

    await deliverAmbientPost({
      type: 'message',
      subtype: 'bot_message',
      channel: CHANNEL,
      bot_id: 'B_REPORTER',
      text: '',
      attachments: [{ text: 'Expired Feature Flags Report — 253.0.0 | Total: 200 flags' }],
      ts: '1700000000.000700',
    });

    expect(vi.mocked(fireTrigger)).toHaveBeenCalledTimes(1);
    // The id that decided the fire is the id the fired task is told about, so a seed naming the author
    // cannot disagree with the filter that matched.
    expect(vi.mocked(fireTrigger).mock.calls[0][1].authorId).toBe('B_REPORTER');
  });

  // The discriminator. Matching on "is a bot post at all" would pass the case above just as well, and would
  // fire this trigger on every other app in the channel.
  it('does not fire when a different app posts matching text', async () => {
    vi.mocked(getChannelMessageTriggers).mockReturnValue([makeTrigger('expired feature flags report', 'B_REPORTER')]);

    await deliverAmbientPost({
      type: 'message',
      subtype: 'bot_message',
      channel: CHANNEL,
      bot_id: 'B_SOMEONE_ELSE',
      text: '',
      attachments: [{ text: 'Expired Feature Flags Report — forwarded by another integration' }],
      ts: '1700000000.000710',
    });

    expect(vi.mocked(fireTrigger)).not.toHaveBeenCalled();
  });

  it('still matches a human `U…` filter, which is the form that always worked', async () => {
    vi.mocked(getChannelMessageTriggers).mockReturnValue([makeTrigger('deploy failed', 'U_DEV')]);

    await deliverAmbientPost({
      type: 'message',
      channel: CHANNEL,
      user: 'U_DEV',
      text: 'the deploy failed again',
      ts: '1700000000.000720',
    });

    expect(vi.mocked(fireTrigger)).toHaveBeenCalledTimes(1);
  });

  it('does not fire when a different person posts matching text', async () => {
    vi.mocked(getChannelMessageTriggers).mockReturnValue([makeTrigger('deploy failed', 'U_DEV')]);

    await deliverAmbientPost({
      type: 'message',
      channel: CHANNEL,
      user: 'U_OTHER',
      text: 'the deploy failed again',
      ts: '1700000000.000730',
    });

    expect(vi.mocked(fireTrigger)).not.toHaveBeenCalled();
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
    vi.mocked(logger.debug).mockClear();
  });

  it('registers a `message` handler at all (guards the fake-Bolt seam)', () => {
    expect(messageHandler).toBeTypeOf('function');
  });

  it('records a gate-dropped event in a trigger-watched channel, at debug because a denylist makes it routine', async () => {
    vi.mocked(getChannelMessageTriggers).mockReturnValue([makeTrigger('deploy failed')]);

    await messageHandler({
      event: { type: 'message', subtype: 'channel_join', channel: CHANNEL, user: 'U_DEV', ts: '1700000000.000500' },
    });

    expect(vi.mocked(fireTrigger)).not.toHaveBeenCalled();
    expect(vi.mocked(logger.debug)).toHaveBeenCalledTimes(1);
    // Deliberately not `warn`: with a denylist the only droppable events in a watched channel ARE the denylisted noise ones, so warning here would flag routine channel_join traffic as an anomaly.
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
    const [, message] = vi.mocked(logger.debug).mock.calls[0];
    expect(message).toContain(CHANNEL);
    expect(message).toContain('channel_join');
    expect(message).toContain('1700000000.000500');
  });

  it('stays silent when the dropped event is in a channel nothing watches', async () => {
    vi.mocked(getChannelMessageTriggers).mockReturnValue([]);

    await messageHandler({
      event: { type: 'message', subtype: 'channel_join', channel: 'C0QUIET', user: 'U_DEV', ts: '1700000000.000600' },
    });

    // Must assert on `debug`, the level production actually uses. Asserting `warn` here was vacuous:
    // it held whether or not the trigger-index guard existed, so mutating that guard to `if (true)`
    // left every case in this file green.
    expect(vi.mocked(logger.debug)).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });
});

describe('the content floor on task creation', () => {
  // The denylist inversion deliberately forwards subtypes nobody enumerated, which is what fixes the
  // trigger arm. But this branch CREATES a task and spends a PM turn, so it needs a floor that is not a
  // subtype list. Without it, a payload with no author and no body reached Task.create() and woke the PM
  // on an empty knowledge log.
  it('does not create a task for a DM whose fetched thread has no visible messages', async () => {
    vi.mocked(fetchSlackThread).mockResolvedValue({
      threadId: '1700000000.001000',
      channel: { id: 'D0USER', name: 'dm' },
      rootAuthorWasBot: false,
      messages: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await handleSlackEvent({
      type: 'message',
      channel: 'D0USER',
      user: '',
      raw: { type: 'message', subtype: 'assistant_app_thread', channel: 'D0USER', ts: '1700000000.001000' },
      ts: '1700000000.001000',
    });

    expect(vi.mocked(Task.create)).not.toHaveBeenCalled();
  });

  it('still creates a task for a DM that carries a message', async () => {
    const task = {
      metadata: { channels: {}, title: 'x' },
      append: vi.fn().mockResolvedValue({ linkedNewThread: true }),
      ackMessage: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      debouncedSave: vi.fn(),
    };
    vi.mocked(Task.create).mockResolvedValue(task as never);
    vi.mocked(fetchSlackThread).mockResolvedValue({
      threadId: '1700000000.001100',
      channel: { id: 'D0USER', name: 'dm' },
      rootAuthorWasBot: false,
      messages: [{ user: { id: 'U1', username: 'r', realName: 'R' }, ownText: 'hello', ts: '1700000000.001100' }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await handleSlackEvent({
      type: 'message',
      channel: 'D0USER',
      user: 'U1',
      raw: { type: 'message', channel: 'D0USER', user: 'U1', text: 'hello', ts: '1700000000.001100' },
      ts: '1700000000.001100',
    });

    expect(vi.mocked(Task.create)).toHaveBeenCalledTimes(1);
  });
});

describe('self-loop guard', () => {
  // Insurance with no known reachable path today, kept because the failure mode is a feedback loop:
  // handleSlackEvent refreshes the canvas and pin index, so the day any of those paths starts writing,
  // a filterless trigger would fire on Archie's own housekeeping and each firing would refresh again.
  //
  // This must drive the Bolt handler, not handleSlackEvent: the discard lives in routeSlackEvent, which
  // runs one level up. Calling handleSlackEvent directly would bypass the very guard under test.
  let messageHandler: (arg: { event: unknown }) => unknown;

  beforeEach(async () => {
    await mountSlackApp({} as Application, { slackBotToken: 'xoxb-test', slackAppToken: 'xapp-test' });
    messageHandler = bolt.handlers.get('message')!;
  });

  it('discards an event Slack attributes to our own bot user', async () => {
    vi.mocked(getBotUserId).mockReturnValue('U_ARCHIE');
    vi.mocked(getChannelMessageTriggers).mockReturnValue([makeTrigger()]);
    vi.mocked(fetchSlackThread).mockResolvedValue({
      threadId: '1700000000.001200',
      channel: { id: CHANNEL, name: 'watched' },
      rootAuthorWasBot: false,
      messages: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await messageHandler({
      event: { type: 'message', channel: CHANNEL, user: 'U_ARCHIE', text: 'archie own post', ts: '1700000000.001200' },
    });
    await flushHandler();

    expect(vi.mocked(fireTrigger)).not.toHaveBeenCalled();
  });

  it('still routes an event from a different user in the same channel', async () => {
    vi.mocked(getBotUserId).mockReturnValue('U_ARCHIE');
    vi.mocked(getChannelMessageTriggers).mockReturnValue([makeTrigger()]);
    vi.mocked(fetchSlackThread).mockResolvedValue({
      threadId: '1700000000.001300',
      channel: { id: CHANNEL, name: 'watched' },
      rootAuthorWasBot: false,
      messages: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await messageHandler({
      event: { type: 'message', channel: CHANNEL, user: 'U_HUMAN', text: 'a real post', ts: '1700000000.001300' },
    });
    await flushHandler();

    // The control that makes the assertion above meaningful: same channel, same shape, different user.
    expect(vi.mocked(fireTrigger)).toHaveBeenCalledTimes(1);
  });
});

describe('the message-edit entry point renders through the shared module', () => {
  // The edit path is one of the entry points the single-render-path contract names, and it was the ONLY
  // one with no test driving the real handler: the suite called `rawMessageBody` directly, so reverting
  // the production call to the raw `text` field would have left every test green. It also could not be
  // covered by the attachment-only BOT fixture used elsewhere — `handleSlackEdit` bails on `bot_id` and
  // on `subtype: 'bot_message'`, and then drops an edit whose text is unchanged as an unfurl re-render.
  // So this uses a reachable shape: a human author, text that genuinely changed, and the new content
  // living in an attachment card.
  let messageHandler: (arg: { event: unknown }) => unknown;

  beforeEach(async () => {
    await mountSlackApp({} as Application, { slackBotToken: 'xoxb-test', slackAppToken: 'xapp-test' });
    messageHandler = bolt.handlers.get('message')!;
  });

  it('renders an edited message from its attachment card, not from the raw text field', async () => {
    const appendSlackEdit = vi.fn().mockResolvedValue(true);
    vi.mocked(findTaskByThread).mockResolvedValue('task-1');
    vi.mocked(Task.get).mockResolvedValue({
      metadata: { channels: { 'slack:C0WATCHED:900.000': { type: 'slack', channel_id: CHANNEL, channel_name: 'watched', thread_id: '900.000' } } },
      appendSlackEdit,
      sendMessage: vi.fn().mockResolvedValue(undefined),
    } as never);

    await messageHandler({
      event: {
        type: 'message',
        subtype: 'message_changed',
        channel: CHANNEL,
        previous_message: { ts: '900.000', user: 'U_HUMAN', text: 'before' },
        message: {
          ts: '900.000',
          user: 'U_HUMAN',
          text: 'after',
          attachments: [{ text: 'deploy failed on prod (build 4711)' }],
        },
      },
    });
    await flushHandler();

    expect(appendSlackEdit).toHaveBeenCalledTimes(1);
    // The body must carry the attachment card, which only the shared renderer folds in. Reverting the
    // production call to `msg.text` yields 'after' alone and fails here.
    const body = appendSlackEdit.mock.calls[0]![3] as string;
    expect(body).toContain('deploy failed on prod (build 4711)');
  });
});

describe('an app post from another workspace never fires a trigger', () => {
  // Newly reachable, and newly closed. The external-author bail-out in handleSlackEvent is guarded by
  // `if (event.user)` and an app post carries no `user`, so it is never classified there; and this path
  // renders from the raw event rather than the fetched thread, so fetchSlackThread's own external-bot
  // filter never sees it either. While app posts were dropped by the subtype allowlist, that closed the
  // hole by accident. Forwarding them deliberately means the gate has to be explicit — mirroring the rule
  // thread ingestion and the pin index already draw: drop a bot from a foreign team, keep internal bots.
  const foreignPost = {
    type: 'message',
    subtype: 'bot_message',
    channel: CHANNEL,
    bot_id: 'B_FOREIGN',
    bot_profile: { team_id: 'T_OTHER' },
    text: '',
    attachments: [{ text: 'deploy failed on prod' }],
    ts: '1700000000.002000',
  };

  it('drops it before rendering or matching', async () => {
    vi.mocked(isExternalUser).mockImplementation((u: { teamId?: string }) => u.teamId === 'T_OTHER');
    vi.mocked(getChannelMessageTriggers).mockReturnValue([makeTrigger('deploy failed')]);

    await deliverAmbientPost({ ...foreignPost });

    expect(vi.mocked(fireTrigger)).not.toHaveBeenCalled();
    // Dropped BEFORE the render, so it costs no extraction either.
    expect(vi.mocked(extractMessageContent)).not.toHaveBeenCalled();
  });

  it('still fires for an app post from our own workspace — the control that makes the above meaningful', async () => {
    vi.mocked(isExternalUser).mockImplementation((u: { teamId?: string }) => u.teamId === 'T_OTHER');
    vi.mocked(getChannelMessageTriggers).mockReturnValue([makeTrigger('deploy failed')]);

    await deliverAmbientPost({ ...foreignPost, bot_profile: { team_id: 'T_HOME' }, ts: '1700000000.002001' });

    expect(vi.mocked(fireTrigger)).toHaveBeenCalledTimes(1);
  });
});
