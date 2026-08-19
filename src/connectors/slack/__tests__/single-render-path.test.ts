/**
 * One attachment-only Slack message, carried through every entry point that turns a Slack message into agent-facing text.
 *
 * The fixture is the shape from the reported incident (#280): a report posted through a legacy incoming webhook, where the top-level `text` is empty and the whole report lives in an attachment card. Every path below is asserted to carry the report's headline through — task ingestion, explore reads, the title generator, the edit re-render, the pinned-message index, and channel-message trigger dispatch — because a single fixture proving all six is what pins them to ONE renderer rather than six that happen to agree today.
 *
 * The raw Slack JSON goes through the real extraction: only `@slack/web-api` is faked, following the mocked-`WebClient` pattern in `client.test.ts`, so nothing here is a hand-built `SlackThreadMessage` that could quietly disagree with what Slack actually sends. The module registry is reset per test so the client's channel/user/shared caches never leak across cases.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Trigger } from '../../../types/trigger.js';

// One shared fake WebClient; methods are reconfigured per test. `WebClient` is used with `new`, so the mock implementation must be a regular (constructable) function that returns the shared fake.
const slackApi = {
  auth: { test: vi.fn() },
  conversations: { info: vi.fn(), replies: vi.fn(), history: vi.fn() },
  users: { info: vi.fn(), conversations: vi.fn(), list: vi.fn() },
  usergroups: { list: vi.fn() },
  pins: { list: vi.fn() },
  reactions: { add: vi.fn(), remove: vi.fn() },
};
vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn(function (this: unknown) { return slackApi; }),
}));

// The title generator's only outbound call is the Haiku query. Capturing the prompt is how the transcript it built becomes assertable — the transcript itself is internal to the module, by design.
const sdk = vi.hoisted(() => ({ lastPrompt: '' }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { prompt: string }) => {
    sdk.lastPrompt = args.prompt;
    return (async function* () {
      yield { type: 'result', subtype: 'success', structured_output: { title: 'Expired feature flags' } };
    })();
  }),
}));

// events.ts loads Bolt through `createRequire`, which bypasses vitest's module registry entirely — so `module` itself is mocked and its `createRequire` returns a require that hands back a fake Bolt while every other id falls through to the real one. Same seam as trigger-dispatch.test.ts.
const bolt = vi.hoisted(() => {
  class FakeApp {
    constructor(_opts: unknown) {}
    event(_name: string, _handler: unknown) {}
    action(_name: string, _handler: unknown) {}
    async start() {}
    async stop() {}
  }
  class FakeReceiver {
    constructor(_opts: unknown) {}
  }
  return { exports: { App: FakeApp, ExpressReceiver: FakeReceiver, SocketModeReceiver: FakeReceiver } };
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

// Everything downstream of the routing decision is stubbed: this file is about what text reaches an agent, not about task persistence. `../client.js` is deliberately NOT mocked — the real extractor is the thing under test.
vi.mock('../channel-canvas.js', () => ({ ensureChannelCanvas: vi.fn() }));
vi.mock('../channel-pins.js', () => ({ ensureChannelPins: vi.fn() }));
vi.mock('../title.js', () => ({ setAssistantThreadTitle: vi.fn() }));
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
vi.mock('../../../system/shutdown.js', () => ({ getIsShuttingDown: vi.fn().mockReturnValue(false) }));
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

/** The phrase exists ONLY inside `attachments[0].text`. Any path that reads the top-level `text` field instead of the rendered body loses it entirely — which is exactly what #280 was. */
const PHRASE = 'Expired Feature Flags Report';
/** A third-party bot, not Archie's own: `routeSlackEvent` discards our own bot before dispatch, and `fetchSlackThread` keeps only the root of our own bot's messages. */
const THIRD_PARTY_BOT = 'B0BQKB5G0KF';
const OUR_BOT_ID = 'BBOT';
const OUR_BOT_USER = 'UBOT';
const CHANNEL = 'C0WATCHED';
const FIXTURE_TS = '1786127951.864179';

/**
 * THE fixture — one raw Slack payload, reused by every assertion in this file.
 *
 * A legacy incoming webhook posts as `bot_message` with an empty top-level `text`; the report body is an attachment card. `bot_id` is present because `fetchSlackThread` drops any message having neither a `user` nor a `botId`.
 */
function attachmentOnlyBotPost(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'message',
    subtype: 'bot_message',
    channel: CHANNEL,
    bot_id: THIRD_PARTY_BOT,
    bot_profile: { name: 'Flag Janitor' },
    text: '',
    attachments: [{ text: `${PHRASE}\n3 flags are past their removal date: android_paywall_v3, ios_streaks, web_referral` }],
    ts: FIXTURE_TS,
    ...over,
  };
}

type ClientModule = typeof import('../client.js');

/** Reset the registry and load a freshly-initialised client, so every dynamic import in the same test shares one module graph (and one Slack client) with it. */
async function loadClient(): Promise<ClientModule> {
  vi.resetModules();
  const client = await import('../client.js');
  await client.initSlackClient('xoxb-test');
  return client;
}

/** The fixture as `fetchSlackThread` hands it to task ingestion. */
async function fetchFixtureThread() {
  const client = await loadClient();
  const thread = await client.fetchSlackThread(CHANNEL, FIXTURE_TS, FIXTURE_TS);
  return { client, thread };
}

function makeTrigger(contains?: string): Trigger {
  return {
    id: 'trg-20260818-1200-abc123',
    status: 'enabled',
    created_by: 'U_DEV',
    created_at: '2026-08-18T12:00:00.000Z',
    binding: { type: 'channel', channel_id: CHANNEL, channel_name: 'watched' },
    conditions: [{ type: 'channel_message', channel_id: CHANNEL, ...(contains ? { match: { contains } } : {}) }],
    action: { prompt: 'look into it' },
    summary: 'watch the flag janitor',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sdk.lastPrompt = '';

  slackApi.auth.test.mockResolvedValue({
    user_id: OUR_BOT_USER, bot_id: OUR_BOT_ID, team_id: 'THOME', url: 'https://acme.slack.com',
  });
  slackApi.usergroups.list.mockResolvedValue({ usergroups: [] });
  slackApi.users.list.mockResolvedValue({ members: [] });
  slackApi.users.info.mockImplementation(async ({ user }: { user: string }) => ({
    ok: true,
    user: { id: user, name: user.toLowerCase(), real_name: `Real ${user}`, team_id: 'THOME', profile: {} },
  }));
  // A public, non-shared channel — so nothing here is redacted and every loss of the phrase is a rendering bug rather than a policy decision.
  slackApi.conversations.info.mockResolvedValue({
    ok: true, channel: { id: CHANNEL, name: 'watched', is_private: false, is_im: false, is_mpim: false },
  });
  slackApi.conversations.replies.mockResolvedValue({ messages: [attachmentOnlyBotPost()] });
  slackApi.conversations.history.mockResolvedValue({ messages: [attachmentOnlyBotPost()] });
  slackApi.pins.list.mockResolvedValue({ items: [] });
});

describe('an attachment-only bot post survives into every agent-facing entry point', () => {
  it('reaches task ingestion — the body written to the knowledge log carries the report headline', async () => {
    const { thread } = await fetchFixtureThread();
    const { renderMessageBody, shouldRedact } = await import('../message-body.js');
    const msg = thread.messages[0];

    // Asserted on `renderMessageBody` rather than through a real `Task.append`: `append` needs a session directory on disk and runs the file-download step before rendering, neither of which changes the text. These are the exact arguments `Task.append` passes (`src/tasks/task.ts`) — the fetched message's parts plus the redaction verdict from `shouldRedact` — so this is the string that would land in knowledge.log.
    const body = renderMessageBody({ ...msg, files: undefined }, { redacted: shouldRedact(msg, thread) });

    expect(body).toContain(PHRASE);
  });

  it('reaches an explore read — formatExploreMessages renders the card, not a blank line', async () => {
    const client = await loadClient();
    const { messages } = await client.fetchExploreThread(CHANNEL, FIXTURE_TS);
    const { formatExploreMessages } = await import('../../../agents/tools.js');

    const out = formatExploreMessages(messages);

    expect(out).toContain(PHRASE);
    expect(out).toContain(`msg:${FIXTURE_TS}`);
  });

  it('reaches the title generator — the transcript it sends to Haiku carries the report headline', async () => {
    const { thread } = await fetchFixtureThread();
    const { generateTaskTitle } = await import('../../../tasks/title-generator.js');

    await generateTaskTitle(thread);

    expect(sdk.lastPrompt).toContain(PHRASE);
  });

  it('reaches a message edit — rawMessageBody re-renders the payload the edit handler holds', async () => {
    await loadClient();
    const { rawMessageBody } = await import('../message-body.js');

    // The edit handler has a raw payload rather than a fetched thread, so it renders through this entry point (`handleSlackEdit` in events.ts). An edit that only touched the attachment card must still re-render to the card's content.
    const body = await rawMessageBody(attachmentOnlyBotPost(), CHANNEL);

    expect(body).toContain(PHRASE);
  });

  it('reaches the pinned-message index — listChannelPins hands out parts the pin renderer folds in', async () => {
    const client = await loadClient();
    client.__resetPinsScopeFlagForTests();
    slackApi.pins.list.mockResolvedValue({
      items: [{ type: 'message', created: 1700000000, created_by: 'UPINNER', message: attachmentOnlyBotPost() }],
    });
    const { pinBody } = await import('../message-body.js');

    const pins = await client.listChannelPins(CHANNEL);
    const item = pins![0];
    // Calls `pinBody`, the function `channel-pins.ts:145` actually uses, rather than re-implementing its
    // options inline. Inlining `renderMessageBody(..., { includeReactions: false })` here looked equivalent
    // but left the case green against any change INSIDE `pinBody` — including dropping the reactions
    // suppression that keeps a reaction out of the pin's content digest.
    const rendered = pinBody(item);

    // The client hands the parts out structured; nothing is pre-joined, so the phrase exists only once the caller renders.
    expect(item.ownText).toBe('');
    expect(rendered).toContain(PHRASE);
  });

  it('reaches trigger dispatch — the body a `contains` filter is matched against carries the report headline', async () => {
    await loadClient();
    const { handleSlackEvent } = await import('../events.js');
    const { getChannelMessageTriggers, fireTrigger } = await import('../../../system/trigger-scheduler.js');
    // A watching trigger with no filter at all: whatever body dispatch rendered is the body a filter would have been matched against. This enters at `handleSlackEvent`, so it does NOT cross the inbound subtype gate — that `bot_message` is forwarded at all is asserted in task-routing.test.ts, and this asserts what dispatch does once it arrives. Note also that `FireContext.text` is never read inside `fireTrigger`, so this pins the matcher's input rather than anything the spawned agent goes on to see.
    vi.mocked(getChannelMessageTriggers).mockReturnValue([makeTrigger()]);

    await handleSlackEvent({
      type: 'message', channel: CHANNEL, user: '', raw: attachmentOnlyBotPost(), ts: FIXTURE_TS,
    });

    expect(vi.mocked(fireTrigger)).toHaveBeenCalledTimes(1);
    expect((vi.mocked(fireTrigger).mock.calls[0][1] as { text: string }).text).toContain(PHRASE);
  });
});

describe('the routing gate lets the message kinds #280 lost through', () => {
  it('fires a `contains` trigger on a top-level bot_message whose text is empty — the #280 regression, from handleSlackEvent inward', async () => {
    await loadClient();
    const { handleSlackEvent } = await import('../events.js');
    const { getChannelMessageTriggers, fireTrigger } = await import('../../../system/trigger-scheduler.js');
    vi.mocked(getChannelMessageTriggers).mockReturnValue([makeTrigger(PHRASE)]);

    // Top-level (no `thread_ts`), a real channel rather than a DM, and no task follows the thread — the exact conditions under which the ambient-post branch calls trigger dispatch.
    await handleSlackEvent({
      type: 'message', channel: CHANNEL, user: '', raw: attachmentOnlyBotPost(), ts: FIXTURE_TS,
    });

    expect(vi.mocked(fireTrigger)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fireTrigger).mock.calls[0][1]).toMatchObject({
      kind: 'message', threadId: FIXTURE_TS, channelId: CHANNEL,
    });
  });

  it('forwards a me_message thread reply — the message kind the old allowlist made invisible', async () => {
    const { mayWakeTask } = await import('../task-routing.js');

    expect(mayWakeTask({
      subtype: 'me_message', channel: CHANNEL, ts: '1786127960.000100', thread_ts: FIXTURE_TS,
    })).toBe(true);
  });
});

describe('the partial field and the message body are different things', () => {
  /**
   * The negative control for everything above. On the old code the two were conflated: `SlackThreadMessage.text` WAS the body, so a caller reading the field got the whole message and this distinction did not exist. Asserting only "the body is non-empty" would pass under either design; asserting that the author's own text is empty WHILE the body is not is what proves the split.
   */
  it('leaves ownText empty for an attachment-only post while the rendered body carries the report', async () => {
    const { thread } = await fetchFixtureThread();
    const { renderMessageBody } = await import('../message-body.js');
    const msg = thread.messages[0];

    expect(msg.ownText).toBe('');
    const body = renderMessageBody(msg, { redacted: false });
    expect(body).not.toBe('');
    expect(body).toContain(PHRASE);
  });
});
