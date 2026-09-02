// `createMeeting` is a spy: transport captured whole, sink comparable by identity — the only witness against two meetings crossing wires and still looking healthy.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../../system/logger.js';
import type { AudioSink, MeetingHost, Participant, VoiceConfig, VoiceTransport } from '../../../voice/types.js';
import type { RecallConfig } from '../recall.js';
import { getChannelDeliverer, getChannelRenderer } from '../../../tasks/channel-delivery.js';
import { getRegisteredConnectorPmTools } from '../../../agents/connector-tools.js';
import { deliverToRecallChannel, renderRecallChannel } from '../channel-delivery.js';
import { createRecallPmToolsServer } from '../pm-tools.js';

// Hoisted because `vi.mock`'s factory runs before imports.
const wsHarness = vi.hoisted(() => {
  class FakeSocket {
    readyState = 1;
    sent: unknown[] = [];
    closed = false;
    listeners: Record<string, Array<(...args: never[]) => void>> = {};
    on(event: string, fn: (...args: never[]) => void): this {
      (this.listeners[event] ??= []).push(fn);
      return this;
    }
    fire(event: string, ...args: unknown[]): void {
      for (const fn of this.listeners[event] ?? []) {
        (fn as (...a: unknown[]) => void)(...args);
      }
    }
    send(payload: unknown): void {
      this.sent.push(payload);
    }
    close(): void {
      this.closed = true;
    }
  }

  // WebSocketServer({ noServer: true }), as the connector uses it: a handshake that hands back a socket instead of performing one.
  class FakeServer {
    upgraded: string[] = [];
    closed = false;
    listeners: Record<string, Array<(...args: never[]) => void>> = {};
    constructor(_opts: unknown) {
      servers.push(this);
    }
    on(event: string, fn: (...args: never[]) => void): this {
      (this.listeners[event] ??= []).push(fn);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      // Recorded here, not at the handshake — this is where the connector actually attaches its listeners.
      if (event === 'connection') {
        connections.push(args[0] as FakeSocket);
      }
      for (const fn of this.listeners[event] ?? []) {
        (fn as (...a: unknown[]) => void)(...args);
      }
    }
    handleUpgrade(
      req: { url?: string },
      _socket: unknown,
      _head: unknown,
      cb: (ws: FakeSocket, req: unknown) => void,
    ): void {
      this.upgraded.push(req.url ?? '');
      cb(new FakeSocket(), req);
    }
    close(): void {
      this.closed = true;
    }
  }

  const servers: FakeServer[] = [];
  const connections: FakeSocket[] = [];
  return { FakeServer, FakeSocket, servers, connections };
});

vi.mock('ws', () => ({ WebSocketServer: wsHarness.FakeServer }));

interface RosterRecord {
  name: string | null;
  is_host: boolean | null;
  joined_at: string | null;
  left_at: string | null;
}

interface Spawned {
  cfg: VoiceConfig;
  transport: VoiceTransport;
  host?: MeetingHost;
  audio: Array<{ participant: Participant; bytes: number }>;
  stopped: number;
  // Every roster pushed into the conversation; metadata.json can't stand in. Separate from liveParticipantCalls: the defect was reaching the file, never the prompt.
  rosters: RosterRecord[][];
  capabilities: string[];
}

const spawned: Spawned[] = [];

// Order: `unregisterLiveMeeting` before `Meeting.stop()`. A consult reply in that window sees "no meeting live" (below).
const teardownOrder: string[] = [];

// isArchie is left real (shared name-matching logic with the medium) since roster/teardown tests exist to exercise it; faking it would test a stand-in, not what ships.
vi.mock('../../../voice/meeting.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../voice/meeting.js')>();
  return {
    ...actual,
    createMeeting: (cfg: VoiceConfig, transport: VoiceTransport, host?: MeetingHost) => {
      const record: Spawned = {
        cfg,
        transport,
        host,
        audio: [],
        stopped: 0,
        rosters: [],
        capabilities: [],
      };
      spawned.push(record);
      return {
        onAudio(participant: Participant, pcm: Buffer) {
          record.audio.push({ participant, bytes: pcm.length });
        },
        updateParticipants(participants: readonly RosterRecord[]) {
          record.rosters.push([...participants]);
        },
        setCapabilities(summary: string) {
          record.capabilities.push(summary);
        },
        async stop() {
          record.stopped++;
          teardownOrder.push(`stop:${transport.sessionId}`);
        },
      };
    },
  };
});

// task-binding, as a spy (behaviour: task-binding.test.ts): pins the connector calls it correctly — right taskId, right moment, exactly once each.
interface FakeHost extends MeetingHost {
  taskId: string;
  sessionId: string;
  /** The bot name the host was built with (see "binding a meeting to a task"). */
  botName: string;
  utterances: Array<{ speaker: string; text: string }>;
  // Meeting-chat lines — the chat.log half of the host.
  chatLines: Array<{ speaker: string; text: string }>;
  events: string[];
  leaveCalls: number;
}

const hosts: FakeHost[] = [];
const registry = new Map<string, unknown>();
// Mirrors the real module's `reservedTaskIds`, so a test exercises the same reserve-before-await protocol `index.ts`'s startMeeting relies on (below).
const reserved = new Set<string>();
// Transcript lives at a per-meeting path keyed by sessionId — this file pins that the connector hands over the bot id that actually ended, not just the right task.
const meetingEndedCalls: Array<{ taskId: string; sessionId: string }> = [];
/** Every `linkRecallChannel` / `endRecallChannel` call, in order — the durable half of the seam ("binding a meeting to a task" below). */
const linkCalls: Array<{ taskId: string; sessionId: string; url: string }> = [];
const endCalls: Array<{ taskId: string; sessionId: string }> = [];
/** Every `writeMeetingMetadataStart` call — see the "meeting metadata" describe block. */
const metadataStartCalls: Array<{ taskId: string; sessionId: string; url: string; archieJoinedAt: string }> = [];
interface LiveParticipantRecord {
  name: string | null;
  is_host: boolean | null;
  joined_at: string | null;
  left_at: string | null;
}
/** Every `updateMeetingParticipantsLive` call, in order — see the "live participants" describe block. */
const liveParticipantCalls: Array<{
  taskId: string;
  sessionId: string;
  url: string;
  archieJoinedAt: string;
  liveParticipants: LiveParticipantRecord[];
}> = [];
interface MetadataEndInfo {
  url: string;
  archieJoinedAt: string;
  platform: string | null;
  title: string | null;
  meetingEndedAt: string | null;
  participants: Array<{ name: string | null; isHost: boolean | null }> | null;
  liveParticipants: LiveParticipantRecord[];
}
/** Every `completeMeetingMetadata` call — see the "meeting metadata" describe block. */
const metadataEndCalls: Array<{ taskId: string; sessionId: string; info: MetadataEndInfo }> = [];
/** Every `recordMeetingCapabilities` call — see the "capability summary" describe block. */
const capabilityRecords: Array<{ taskId: string; sessionId: string; summary: string }> = [];
type StartResult = { ok: true; botId: string } | { ok: false; reason: string };
let registeredStarter: ((taskId: string, meetingUrl: string) => Promise<StartResult>) | null = null;
let registeredStopper: ((sessionId: string) => Promise<void>) | null = null;

vi.mock('../../../voice/task-binding.js', () => ({
  createTaskHost: (taskId: string, sessionId: string, botName: string): FakeHost => {
    const host: FakeHost = {
      taskId,
      sessionId,
      botName,
      utterances: [],
      chatLines: [],
      events: [],
      leaveCalls: 0,
      recordUtterance: (speaker: string, text: string) => {
        host.utterances.push({ speaker, text });
      },
      recordChat: (speaker: string, text: string) => {
        host.chatLines.push({ speaker, text });
      },
      readWrittenExchange: async () => [],
      noteEvent: (text: string) => {
        host.events.push(text);
      },
      consult: () => {},
      leaveMeeting: () => {
        host.leaveCalls++;
      },
    };
    hosts.push(host);
    return host;
  },
  registerLiveMeeting: (taskId: string, meeting: unknown) => {
    reserved.delete(taskId);
    registry.set(taskId, meeting);
  },
  getLiveMeeting: (taskId: string) => registry.get(taskId),
  unregisterLiveMeeting: (taskId: string) => {
    registry.delete(taskId);
    teardownOrder.push(`unregister:${taskId}`);
  },
  reserveMeetingSlot: (taskId: string) => {
    if (registry.has(taskId) || reserved.has(taskId)) return false;
    reserved.add(taskId);
    return true;
  },
  releaseMeetingSlot: (taskId: string) => {
    reserved.delete(taskId);
  },
  setMeetingStarter: (fn: (taskId: string, meetingUrl: string) => Promise<StartResult>) => {
    registeredStarter = fn;
  },
  setMeetingStopper: (fn: (sessionId: string) => Promise<void>) => {
    registeredStopper = fn;
  },
  notifyMeetingEnded: (taskId: string, sessionId: string) => {
    meetingEndedCalls.push({ taskId, sessionId });
  },
  linkRecallChannel: async (taskId: string, sessionId: string, url: string) => {
    linkCalls.push({ taskId, sessionId, url });
  },
  endRecallChannel: async (taskId: string, sessionId: string) => {
    endCalls.push({ taskId, sessionId });
  },
  writeMeetingMetadataStart: async (taskId: string, sessionId: string, url: string, archieJoinedAt: string) => {
    metadataStartCalls.push({ taskId, sessionId, url, archieJoinedAt });
  },
  updateMeetingParticipantsLive: async (
    taskId: string,
    sessionId: string,
    url: string,
    archieJoinedAt: string,
    liveParticipants: LiveParticipantRecord[],
  ) => {
    liveParticipantCalls.push({ taskId, sessionId, url, archieJoinedAt, liveParticipants });
  },
  completeMeetingMetadata: async (taskId: string, sessionId: string, info: MetadataEndInfo) => {
    metadataEndCalls.push({ taskId, sessionId, info });
  },
  // Sync void, matching the real module — the connector calls it from an un-awaited `.then()`; a promise-shaped mock here would pass a test the real path couldn't.
  recordMeetingCapabilities: (taskId: string, sessionId: string, summary: string): void => {
    capabilityRecords.push({ taskId, sessionId, summary });
  },
}));

// Capability summary spy (behaviour: capabilities.ts, src/voice/__tests__/): pins right task asked, result handed to the meeting, join NOT held behind that call.
// No spy for the written exchange: pulled through the host per turn (MeetingHost.readWrittenExchange), not pushed at join — connector's role ends at building the host.

const capabilityCalls: Array<{ taskId: string }> = [];
// Left resolved by default; a test swaps in a pending promise to prove the join doesn't wait on it.
let capabilityResult: Promise<string> = Promise.resolve('');

vi.mock('../../../voice/capabilities.js', () => ({
  buildCapabilitySummary: (_cfg: VoiceConfig, taskId: string) => {
    capabilityCalls.push({ taskId });
    return capabilityResult;
  },
}));

// Sinks are tagged with the page they belong to — turns "wired to the right session" into an equality check (pageOf below).
interface HubLog {
  sinks: Map<string, AudioSink & { enabled: boolean }>;
  pageSockets: string[];
  disposed: string[];
}

const hub: HubLog = { sinks: new Map(), pageSockets: [], disposed: [] };

vi.mock('../audio-out.js', () => ({
  createAudioOutHub: () => ({
    sinkFor(pageId: string) {
      let sink = hub.sinks.get(pageId);
      if (!sink) {
        sink = {
          enabled: false,
          play: () => {},
          cut: () => {},
          setEnabled(open: boolean) {
            sink!.enabled = open;
          },
          setEngaged: () => {},
          isSpeaking: () => false,
        };
        hub.sinks.set(pageId, sink);
      }
      return sink;
    },
    handlePageSocket(pageId: string) {
      hub.pageSockets.push(pageId);
    },
    dispose(pageId: string) {
      hub.disposed.push(pageId);
    },
  }),
  renderPage: (pageId: string, wsUrl: string, botName: string) =>
    `<!doctype html><title>${botName}</title><!--${pageId}|${wsUrl}-->`,
}));

// Recall's REST API, faked at `fetch` only — the client itself is real, so URLs asserted here are the ones it would really call.
interface HttpCall {
  url: string;
  body: Record<string, unknown>;
}

const http: HttpCall[] = [];
const botIds: string[] = [];
let createFails: number | null = null;
// Unset (the common case) falls back to `{}`, read by getBotDetails as "nothing new," not malformed — tests indifferent to bot-details keep working unchanged.
const botDetailsReplies: Array<{ status: number; body: string }> = [];
/** Queued replies for the presigned participants download, oldest first. Same empty-is-benign fallback as above. */
const participantsReplies: Array<{ status: number; body: string }> = [];

function fakeFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const path = String(url);
  const method = init?.method ?? 'GET';
  const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
    string,
    unknown
  >;
  http.push({ url: path, body });
  let reply: { status: number; body: string };
  if (method === 'POST' && path.endsWith('/api/v1/bot/')) {
    if (createFails !== null) {
      reply = { status: createFails, body: '{"detail":"nope"}' };
      createFails = null;
    } else {
      reply = { status: 201, body: JSON.stringify({ id: botIds.shift() ?? 'bot-anon' }) };
    }
  } else if (method === 'GET' && /\/api\/v1\/bot\/[^/]+\/$/.test(path)) {
    // Never matches `/leave_call/` or `/send_chat_message/` — their trailing segment has more than the slash-free suffix this regex requires.
    reply = botDetailsReplies.shift() ?? { status: 200, body: '{}' };
  } else if (method === 'GET' && path.startsWith('https://participants.example/')) {
    reply = participantsReplies.shift() ?? { status: 200, body: '[]' };
  } else {
    reply = { status: 200, body: '{}' };
  }
  return Promise.resolve({
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    text: () => Promise.resolve(reply.body),
  } as Response);
}

type Handler = (req: unknown, res: unknown, next: (err?: unknown) => void) => void;

function fakeApp(): { app: { use: (path: string, router: Handler) => void }; router: () => Handler } {
  let mounted: Handler | null = null;
  let mountPath = '';
  return {
    app: {
      use(path: string, router: Handler) {
        mountPath = path;
        mounted = router;
      },
    },
    router() {
      if (mounted === null) throw new Error('nothing mounted');
      // Kept as an assertion (not dropped) — a moved mount prefix is a broken deployment no other test would notice.
      expect(mountPath).toBe('/api/voice');
      return mounted;
    },
  };
}

interface Reply {
  code: number;
  payload: unknown;
  contentType: string | null;
  unmatched: boolean;
}

// Resolves when the handler answers — the only way to await an async Express route, which has no other awaitable return.
function request(router: Handler, method: string, url: string, body?: unknown): Promise<Reply> {
  const out: Reply = { code: 200, payload: undefined, contentType: null, unmatched: false };
  let settle!: () => void;
  const answered = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const res = {
    status(code: number) {
      out.code = code;
      return res;
    },
    json(payload: unknown) {
      out.payload = payload;
      settle();
      return res;
    },
    type(contentType: string) {
      out.contentType = contentType;
      return res;
    },
    send(payload: unknown) {
      out.payload = payload;
      settle();
      return res;
    },
  };
  // No content-length or transfer-encoding, so express.json() leaves the body alone instead of reading a stream that isn't there.
  router({ method, url, headers: {}, body }, res, () => {
    out.unmatched = true;
    settle();
  });
  return answered.then(() => out);
}

const RECALL_KEY = 'recall-secret-key-44444';

function config(over: Partial<RecallConfig> = {}): RecallConfig {
  return {
    recallApiKey: RECALL_KEY,
    recallRegion: 'eu-central-1',
    publicUrl: 'https://archie.example',
    voice: {
      deepgramApiKey: 'deepgram-secret-key-0000',
      anthropicApiKey: 'anthropic-secret-key-111',
      botName: 'Archie',
    },
    ...over,
  };
}

async function mount(over: Partial<RecallConfig> = {}) {
  const { mountRecallConnector } = await import('../index.js');
  const { app, router } = fakeApp();
  const lifecycle = mountRecallConnector(app as never, config(over));
  const [audioWss, pageWss] = wsHarness.servers;
  return { lifecycle, router: router(), audioWss, pageWss };
}

// Matched by identity, not a tag — an equal-looking sink that isn't *the* one the hub minted is exactly the bug this catches.
function pageOf(sink: AudioSink): string | undefined {
  for (const [pageId, minted] of hub.sinks) {
    if (minted === sink) return pageId;
  }
  return undefined;
}

function lastSocket(): InstanceType<typeof wsHarness.FakeSocket> {
  const socket = wsHarness.connections[wsHarness.connections.length - 1];
  if (socket === undefined) throw new Error('no socket was opened');
  return socket;
}

function attach(lifecycle: { attach: (server: never) => void }) {
  let onUpgrade: ((req: unknown, socket: unknown, head: unknown) => void) | null = null;
  const server = {
    on(event: string, fn: (req: unknown, socket: unknown, head: unknown) => void) {
      if (event === 'upgrade') onUpgrade = fn;
    },
  };
  lifecycle.attach(server as never);
  if (onUpgrade === null) throw new Error('no upgrade listener');
  return onUpgrade as (req: unknown, socket: unknown, head: unknown) => void;
}

// The one socket carrying both audio_separate_raw.data and the two participant events — module scope since both audio-frame and participant-event tests need it.
async function withAudioSocket(over: Partial<RecallConfig> = {}) {
  const mounted = await mount(over);
  const onUpgrade = attach(mounted.lifecycle);
  onUpgrade({ url: '/api/voice/audio' }, { destroy: vi.fn() }, Buffer.alloc(0));
  return { ...mounted, onUpgrade, ws: lastSocket() };
}

async function startMeeting(
  router: Handler,
  meetingUrl = 'https://zoom.us/j/1',
  taskId?: string,
) {
  const before = http.length;
  const body: Record<string, unknown> = { meeting_url: meetingUrl };
  if (taskId !== undefined) body.task_id = taskId;
  const reply = await request(router, 'POST', '/meetings', body);
  const created = http.slice(before).find((c) => c.url.endsWith('/api/v1/bot/'));
  const media = created?.body.output_media as { camera: { config: { url: string } } } | undefined;
  const pageUrl = media?.camera.config.url ?? '';
  return {
    reply,
    botId: (reply.payload as { bot_id?: string } | undefined)?.bot_id ?? '',
    pageId: pageUrl.split('/').pop() ?? '',
    spawned: spawned[spawned.length - 1],
  };
}

// One frame in Recall's envelope, as verified live.
function audioFrame(
  botId: string,
  participant: Record<string, unknown>,
  pcm = Buffer.alloc(320),
): string {
  return JSON.stringify({
    event: 'audio_separate_raw.data',
    data: {
      bot: { id: botId },
      data: { buffer: pcm.toString('base64'), timestamp: { relative: 1 }, participant },
    },
  });
}

// Same envelope shape Recall's docs give, and the same data.bot.id placement audioFrame above already uses — verified live for audio.
function participantEventFrame(
  botId: string,
  kind: 'join' | 'leave',
  participant: Record<string, unknown>,
): string {
  return JSON.stringify({
    event: `participant_events.${kind}`,
    data: {
      bot: { id: botId },
      data: { participant, timestamp: { relative: 1 } },
    },
  });
}

// Lets `handleParticipantLeave`'s fire-and-forget `void endMeeting(...)` settle: awaits 5 mocked calls in sequence (endRecallChannel, meeting.stop(), teardown fetch, completeMeetingMetadata, recall.leave), each one microtask tick.
// Unlike persistLiveParticipants (synchronous push, no internal await — see "live participants" below, no flush needed).
// Plain Promise.resolve() draining, not a real timer — works whether or not a test also has vi.useFakeTimers() active.
async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  wsHarness.servers.length = 0;
  wsHarness.connections.length = 0;
  spawned.length = 0;
  hosts.length = 0;
  registry.clear();
  reserved.clear();
  teardownOrder.length = 0;
  meetingEndedCalls.length = 0;
  linkCalls.length = 0;
  endCalls.length = 0;
  metadataStartCalls.length = 0;
  liveParticipantCalls.length = 0;
  metadataEndCalls.length = 0;
  capabilityCalls.length = 0;
  capabilityRecords.length = 0;
  capabilityResult = Promise.resolve('');
  registeredStarter = null;
  botDetailsReplies.length = 0;
  participantsReplies.length = 0;
  hub.sinks.clear();
  hub.pageSockets.length = 0;
  hub.disposed.length = 0;
  http.length = 0;
  botIds.length = 0;
  createFails = null;
  vi.stubGlobal('fetch', fakeFetch);
  vi.spyOn(logger, 'system').mockImplementation(() => {});
  vi.spyOn(logger, 'plain').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('recall mount — the transport it assembles', () => {
  it('wires the session id, the chat channel and the sink to the same meeting', async () => {
    botIds.push('bot-alpha');
    const { router } = await mount();

    const { botId, pageId, spawned: made } = await startMeeting(router);

    expect(botId).toBe('bot-alpha');
    // The bot id is the conversation's id — the one handle that outlives every socket, which is why the activation log is named for it.
    expect(made.transport.sessionId).toBe('bot-alpha');
    // The page id is different, minted before the bot exists because output_media must be in the create request — the sink follows the page.
    expect(pageId).not.toBe(botId);
    expect(pageOf(made.transport.sink)).toBe(pageId);

    http.length = 0;
    await made.transport.sendChat?.('It shipped on Tuesday.');
    expect(http[0].url).toBe('https://eu-central-1.recall.ai/api/v1/bot/bot-alpha/send_chat_message/');
  });

  it('keeps two concurrent meetings from crossing their wires', async () => {
    botIds.push('bot-one', 'bot-two');
    const { router } = await mount();

    const one = await startMeeting(router, 'https://zoom.us/j/1');
    const two = await startMeeting(router, 'https://zoom.us/j/2');

    expect(one.botId).not.toBe(two.botId);
    expect(one.pageId).not.toBe(two.pageId);
    expect(pageOf(one.spawned.transport.sink)).toBe(one.pageId);
    expect(pageOf(two.spawned.transport.sink)).toBe(two.pageId);

    http.length = 0;
    await one.spawned.transport.sendChat?.('for one');
    await two.spawned.transport.sendChat?.('for two');
    expect(http.map((c) => c.url)).toEqual([
      'https://eu-central-1.recall.ai/api/v1/bot/bot-one/send_chat_message/',
      'https://eu-central-1.recall.ai/api/v1/bot/bot-two/send_chat_message/',
    ]);
  });

  it('hands the medium its own key as a foreign secret, keeping any already there', async () => {
    // The medium's log scrubbers redact every credential it holds — ours is the one they'd have no other way to learn.
    botIds.push('bot-secrets');
    const { router } = await mount({
      voice: { ...config().voice, foreignSecrets: ['an-earlier-secret-000'] },
    });

    const { spawned: made } = await startMeeting(router);

    expect(made.cfg.foreignSecrets).toEqual(['an-earlier-secret-000', RECALL_KEY]);
    // Nothing else about the connector leaks across — the medium gets the voice half, not the Recall half.
    expect(made.cfg).not.toHaveProperty('recallApiKey');
    expect(made.cfg).not.toHaveProperty('publicUrl');
  });

  it('derives both dial-back URLs from publicUrl, switching http for ws', async () => {
    botIds.push('bot-urls');
    const { router } = await mount({ publicUrl: 'https://x.ngrok-free.app' });

    const { pageId } = await startMeeting(router);
    const created = http.find((c) => c.url.endsWith('/api/v1/bot/'))!;
    const media = created.body.output_media as { camera: { config: { url: string } } };
    const recording = created.body.recording_config as {
      realtime_endpoints: Array<{ url: string }>;
    };

    expect(media.camera.config.url).toBe(`https://x.ngrok-free.app/api/voice/page/${pageId}`);
    expect(recording.realtime_endpoints[0].url).toBe('wss://x.ngrok-free.app/api/voice/audio');
  });
});

describe('recall mount — routes', () => {
  it('refuses to create a bot without a meeting url', async () => {
    const { router } = await mount();

    const reply = await request(router, 'POST', '/meetings', {});

    expect(reply.code).toBe(400);
    expect(http.length).toBe(0);
    expect(spawned.length).toBe(0);
  });

  it('answers 500 when Recall refuses, and registers no meeting to tear down later', async () => {
    // A 500 here is how a wrong-region key becomes visible at all — a half-registered meeting would otherwise leak forever.
    const errors = vi.spyOn(logger, 'error').mockImplementation(() => {});
    createFails = 401;
    const { router, lifecycle } = await mount();

    const reply = await request(router, 'POST', '/meetings', { meeting_url: 'https://zoom.us/j/1' });

    expect(reply.code).toBe(500);
    expect(spawned.length).toBe(0);
    expect(errors).toHaveBeenCalled();
    http.length = 0;
    await lifecycle.stop();
    expect(http.length).toBe(0);
  });

  it('ends the meeting the path names, and only that one', async () => {
    botIds.push('bot-keep', 'bot-drop');
    const { router } = await mount();
    const keep = await startMeeting(router, 'https://zoom.us/j/keep');
    const drop = await startMeeting(router, 'https://zoom.us/j/drop');

    http.length = 0;
    const reply = await request(router, 'DELETE', '/meetings/bot-drop');

    expect(reply.payload).toEqual({ ok: true });
    expect(drop.spawned.stopped).toBe(1);
    expect(keep.spawned.stopped).toBe(0);
    expect(hub.disposed).toEqual([drop.pageId]);
    expect(http.map((c) => c.url)).toEqual([
      'https://eu-central-1.recall.ai/api/v1/bot/bot-drop/leave_call/',
    ]);
  });

  it('serves each page id its own socket url', async () => {
    const { router } = await mount({ publicUrl: 'https://archie.example' });

    const reply = await request(router, 'GET', '/page/page-xyz');

    expect(reply.contentType).toBe('html');
    expect(String(reply.payload)).toContain('wss://archie.example/api/voice/out/page-xyz');
  });
});

describe('recall mount — inbound audio', () => {

  it('routes each upgrade to its own server and destroys anything else', async () => {
    // Node auto-closes an unhandled upgrade socket only with NO listener; ours is the only one, so an ignored URL sits half-open on a necessarily public path.
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { lifecycle, audioWss, pageWss } = await mount();
    const onUpgrade = attach(lifecycle);

    const stray = { destroy: vi.fn() };
    onUpgrade({ url: '/api/voice/audio' }, { destroy: vi.fn() }, Buffer.alloc(0));
    onUpgrade({ url: '/api/voice/out/page-7' }, { destroy: vi.fn() }, Buffer.alloc(0));
    onUpgrade({ url: '/api/voice/outsider' }, stray, Buffer.alloc(0));

    expect(audioWss.upgraded).toEqual(['/api/voice/audio']);
    expect(pageWss.upgraded).toEqual(['/api/voice/out/page-7']);
    // `outsider` must not resolve to the page id "sider".
    expect(stray.destroy).toHaveBeenCalled();
  });

  it('delivers a frame to the meeting its bot id names', async () => {
    botIds.push('bot-a', 'bot-b');
    const { router, ws } = await withAudioSocket();
    const a = await startMeeting(router, 'https://zoom.us/j/a');
    const b = await startMeeting(router, 'https://zoom.us/j/b');

    ws.fire('message', Buffer.from(audioFrame('bot-b', { id: 7, name: 'Ann' })));

    expect(a.spawned.audio.length).toBe(0);
    expect(b.spawned.audio.length).toBe(1);
    expect(b.spawned.audio[0].bytes).toBe(320);
  });

  it('converts Recall\'s numeric participant id into an opaque string', async () => {
    // Recall's wire format is a number; the medium keys per-speaker state on an opaque string — conversion belongs at this boundary.
    // Zero is included deliberately — as a number it's falsy, so a truthiness check on the id would drop that speaker.
    botIds.push('bot-ids');
    const { router, ws } = await withAudioSocket();
    const { spawned: made } = await startMeeting(router);

    ws.fire('message', Buffer.from(audioFrame('bot-ids', { id: 0, name: 'Zero' })));
    ws.fire('message', Buffer.from(audioFrame('bot-ids', { id: 16778240, name: 'Ann' })));
    ws.fire('message', Buffer.from(audioFrame('bot-ids', { name: 'Nameless id' })));

    expect(made.audio.map((a) => a.participant.id)).toEqual(['0', '16778240', 'unknown']);
    for (const { participant } of made.audio) {
      expect(typeof participant.id).toBe('string');
    }
    // Distinct speakers staying distinct is the only property the medium relies on.
    expect(new Set(made.audio.map((a) => a.participant.id)).size).toBe(3);
  });

  it('carries the rest of the envelope through unchanged', async () => {
    botIds.push('bot-env');
    const { router, ws } = await withAudioSocket();
    const { spawned: made } = await startMeeting(router);

    ws.fire(
      'message',
      Buffer.from(audioFrame('bot-env', { id: 3, name: 'Ann', email: 'a@b.c', is_host: true })),
    );

    expect(made.audio[0].participant).toEqual({
      id: '3',
      name: 'Ann',
      email: 'a@b.c',
      isHost: true,
    });
  });

  it('drops our own voice, which would otherwise trigger the bot on itself', async () => {
    botIds.push('bot-self');
    const { router, ws } = await withAudioSocket();
    const { spawned: made } = await startMeeting(router);

    ws.fire('message', Buffer.from(audioFrame('bot-self', { id: 9, name: 'Archie' })));

    expect(made.audio.length).toBe(0);
  });

  it('ignores frames it cannot place, without taking the socket down', async () => {
    botIds.push('bot-live');
    const { router, ws } = await withAudioSocket();
    const { spawned: made } = await startMeeting(router);

    ws.fire('message', Buffer.from('not json at all'));
    ws.fire('message', Buffer.from(JSON.stringify({ event: 'bot.status_change', data: {} })));
    ws.fire('message', Buffer.from(audioFrame('bot-gone', { id: 1, name: 'Ann' })));
    ws.fire('message', Buffer.from(audioFrame('bot-live', { id: 1, name: 'Ann' }, Buffer.alloc(0))));
    // Still working afterwards is what matters — a throw here takes down the whole process, not just this meeting.
    ws.fire('message', Buffer.from(audioFrame('bot-live', { id: 1, name: 'Ann' })));

    expect(made.audio.length).toBe(1);
  });

  it('greets once and opens the output gate when the page connects, for that page only', async () => {
    botIds.push('bot-greet', 'bot-quiet');
    const { router, lifecycle } = await mount();
    const onUpgrade = attach(lifecycle);
    const greeted = await startMeeting(router, 'https://zoom.us/j/greet');
    const quiet = await startMeeting(router, 'https://zoom.us/j/quiet');

    http.length = 0;
    onUpgrade({ url: `/api/voice/out/${greeted.pageId}` }, { destroy: vi.fn() }, Buffer.alloc(0));
    onUpgrade({ url: `/api/voice/out/${greeted.pageId}` }, { destroy: vi.fn() }, Buffer.alloc(0));

    // The gate defaults closed so nothing can play before Recall renders our page — it opens here, only for the page that connected.
    expect(hub.sinks.get(greeted.pageId)?.enabled).toBe(true);
    expect(hub.sinks.get(quiet.pageId)?.enabled).toBe(false);
    expect(hub.pageSockets).toEqual([greeted.pageId, greeted.pageId]);
    // Once, though the page connected twice — it retries on a drop, and Recall may reload it.
    expect(http.map((c) => c.url)).toEqual([
      'https://eu-central-1.recall.ai/api/v1/bot/bot-greet/send_chat_message/',
    ]);
  });

  it('warns rather than throwing when a page connects for an id it does not know', async () => {
    const warns = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { lifecycle } = await mount();
    const onUpgrade = attach(lifecycle);

    onUpgrade({ url: '/api/voice/out/page-nobody' }, { destroy: vi.fn() }, Buffer.alloc(0));

    expect(warns).toHaveBeenCalled();
  });
});

describe('recall mount — idle teardown', () => {
  it('tears down a meeting that has gone quiet and leaves a live one alone', async () => {
    // Without this sweep, every Deepgram socket the meeting opened stays alive on its own keepalive, billing for the life of the process — meeting.stop() closes them.
    vi.useFakeTimers();
    botIds.push('bot-live', 'bot-stale');
    const mounted = await mount();
    const onUpgrade = attach(mounted.lifecycle);
    onUpgrade({ url: '/api/voice/audio' }, { destroy: vi.fn() }, Buffer.alloc(0));
    const socket = lastSocket();

    const alive = await startMeeting(mounted.router, 'https://zoom.us/j/alive');
    const stale = await startMeeting(mounted.router, 'https://zoom.us/j/stale');

    // Two minutes in, both are inside the three-minute window.
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(alive.spawned.stopped).toBe(0);
    expect(stale.spawned.stopped).toBe(0);

    socket.fire('message', Buffer.from(audioFrame('bot-live', { id: 1, name: 'Ann' })));

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(stale.spawned.stopped).toBe(1);
    expect(alive.spawned.stopped).toBe(0);
    expect(hub.disposed).toEqual([stale.pageId]);
  });

  it('stops sweeping once the connector is stopped', async () => {
    vi.useFakeTimers();
    botIds.push('bot-sweep');
    const { router, lifecycle } = await mount();
    attach(lifecycle);
    const meeting = await startMeeting(router);

    // The sweep is the only timer this connector owns, so the count shows it's running directly — a surviving interval leaves no trace otherwise.
    expect(vi.getTimerCount()).toBe(1);

    await lifecycle.stop();

    expect(meeting.spawned.stopped).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends every live meeting and closes both socket servers on stop', async () => {
    botIds.push('bot-x', 'bot-y');
    const { router, lifecycle, audioWss, pageWss } = await mount();
    const onUpgrade = attach(lifecycle);
    const x = await startMeeting(router, 'https://zoom.us/j/x');
    const y = await startMeeting(router, 'https://zoom.us/j/y');
    onUpgrade({ url: '/api/voice/audio' }, { destroy: vi.fn() }, Buffer.alloc(0));

    http.length = 0;
    await lifecycle.stop();

    expect(x.spawned.stopped).toBe(1);
    expect(y.spawned.stopped).toBe(1);
    expect(new Set(http.map((c) => c.url))).toEqual(
      new Set([
        'https://eu-central-1.recall.ai/api/v1/bot/bot-x/leave_call/',
        'https://eu-central-1.recall.ai/api/v1/bot/bot-y/leave_call/',
      ]),
    );
    expect(audioWss.closed).toBe(true);
    expect(pageWss.closed).toBe(true);
  });
});

describe('recall mount — binding a meeting to a task', () => {
  it('builds a host, records the transcript header line and notes the started event', async () => {
    botIds.push('bot-bound');
    const { router } = await mount();

    const { spawned: made } = await startMeeting(router, 'https://zoom.us/j/bound', 'task-1');

    expect(hosts).toHaveLength(1);
    expect(hosts[0].taskId).toBe('task-1');
    // createTaskHost gets the bot id too — it's what lets the wake-up prompt and the durable channel record agree on the same key.
    expect(hosts[0].sessionId).toBe('bot-bound');
    // Display name is what readWrittenExchange renders every line as — must match the join name and trigger, or a mismatched host adds a second colleague to the written block.
    expect(hosts[0].botName).toBe(made.cfg.botName);
    // The exact same host object createTaskHost returned, not a look-alike.
    expect(made.host).toBe(hosts[0]);
    expect(hosts[0].utterances).toEqual([
      { speaker: 'meeting', text: expect.stringContaining('bot-bound') },
    ]);
    expect(hosts[0].events.some((e) => /started/.test(e))).toBe(true);
    expect(registry.has('task-1')).toBe(true);
    // The durable half of the seam: linked before the meeting reports success.
    expect(linkCalls).toEqual([{ taskId: 'task-1', sessionId: 'bot-bound', url: 'https://zoom.us/j/bound' }]);
  });

  it('notes the ended event on the same host when the meeting is torn down', async () => {
    botIds.push('bot-bound-2');
    const { router } = await mount();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/bound2', 'task-2');

    await request(router, 'DELETE', `/meetings/${botId}`);

    expect(hosts[0].events.some((e) => e.includes('meeting ended') && e.includes(botId))).toBe(true);
    // The slot is freed, so a later join for the same task is not refused.
    expect(registry.has('task-2')).toBe(false);
    // Channel record is marked ended, not removed — endRecallChannel does that; nothing here deletes the metadata.
    expect(endCalls).toEqual([{ taskId: 'task-2', sessionId: botId }]);
  });

  it('does none of that, and still works, when started without a task_id', async () => {
    botIds.push('bot-unbound');
    const { router } = await mount();

    const { reply, spawned: made } = await startMeeting(router, 'https://zoom.us/j/unbound');

    expect(reply.code).toBe(201);
    expect(hosts).toHaveLength(0);
    expect(made.host).toBeUndefined();
    expect(registry.size).toBe(0);
    expect(linkCalls).toEqual([]);
  });

  it('refuses a second meeting posted directly for a task_id already live', async () => {
    botIds.push('bot-dup-post');
    const { router } = await mount();
    await startMeeting(router, 'https://zoom.us/j/1', 'task-dup-post');

    http.length = 0;
    const reply = await startMeeting(router, 'https://zoom.us/j/2', 'task-dup-post');

    expect(reply.reply.code).toBe(500);
    expect(http.length).toBe(0); // never even asked Recall for a second bot
    expect(hosts.filter((h) => h.taskId === 'task-dup-post')).toHaveLength(1);
  });
});

describe('recall mount — waking the PM when a meeting ends', () => {
  it('wakes it exactly once via the DELETE route', async () => {
    botIds.push('bot-del');
    const { router } = await mount();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/del', 'task-del');

    await request(router, 'DELETE', `/meetings/${botId}`);

    expect(meetingEndedCalls).toEqual([{ taskId: 'task-del', sessionId: 'bot-del' }]);
  });

  it('wakes it exactly once via the idle sweep', async () => {
    vi.useFakeTimers();
    botIds.push('bot-idle');
    const mounted = await mount();
    attach(mounted.lifecycle);
    await startMeeting(mounted.router, 'https://zoom.us/j/idle', 'task-idle');

    // Past the three-minute idle window plus one more sweep tick.
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);

    expect(meetingEndedCalls).toEqual([{ taskId: 'task-idle', sessionId: 'bot-idle' }]);
  });

  it('wakes it exactly once via process shutdown', async () => {
    botIds.push('bot-shutdown');
    const { router, lifecycle } = await mount();
    await startMeeting(router, 'https://zoom.us/j/shutdown', 'task-shutdown');

    await lifecycle.stop();

    expect(meetingEndedCalls).toEqual([{ taskId: 'task-shutdown', sessionId: 'bot-shutdown' }]);
  });

  it('never wakes it for an unbound meeting', async () => {
    botIds.push('bot-unbound-end');
    const { router } = await mount();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/unbound-end');

    await request(router, 'DELETE', `/meetings/${botId}`);

    expect(meetingEndedCalls).toEqual([]);
  });

  it('unregisters the task before awaiting the meeting to stop, not after', async () => {
    botIds.push('bot-order');
    const { router } = await mount();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/order', 'task-order');

    teardownOrder.length = 0;
    await request(router, 'DELETE', `/meetings/${botId}`);

    expect(teardownOrder).toEqual([`unregister:task-order`, `stop:${botId}`]);
  });
});

describe('recall mount — meeting metadata', () => {
  it('writes the initial metadata at start, with what is known then', async () => {
    botIds.push('bot-meta-start');
    const { router } = await mount();

    const before = Date.now();
    await startMeeting(router, 'https://zoom.us/j/meta-start', 'task-meta-start');
    const after = Date.now();

    expect(metadataStartCalls).toHaveLength(1);
    const call = metadataStartCalls[0];
    expect(call.taskId).toBe('task-meta-start');
    expect(call.sessionId).toBe('bot-meta-start');
    expect(call.url).toBe('https://zoom.us/j/meta-start');
    const joinedMs = Date.parse(call.archieJoinedAt);
    expect(joinedMs).toBeGreaterThanOrEqual(before);
    expect(joinedMs).toBeLessThanOrEqual(after);
  });

  it('never writes metadata at all for an unbound meeting', async () => {
    botIds.push('bot-meta-unbound');
    const { router } = await mount();

    await startMeeting(router, 'https://zoom.us/j/meta-unbound');

    expect(metadataStartCalls).toEqual([]);
  });

  it('completes the metadata at teardown with what the Recall fetch found, including a participant who never spoke', async () => {
    botIds.push('bot-meta-end');
    botDetailsReplies.push({
      status: 200,
      body: JSON.stringify({
        meeting_url: { platform: 'zoom' },
        status_changes: [
          { code: 'joining_call', created_at: '2026-08-29T10:00:00.000Z' },
          { code: 'call_ended', created_at: '2026-08-29T10:45:00.000Z' },
          { code: 'done', created_at: '2026-08-29T10:45:30.000Z' },
        ],
        recordings: [
          {
            media_shortcuts: {
              participant_events: { data: { participants_download_url: 'https://participants.example/roster/1' } },
              meeting_metadata: { data: { title: 'Sprint planning' } },
            },
          },
        ],
      }),
    });
    participantsReplies.push({
      status: 200,
      // "Ghost" never triggers an audio frame — roster is presence, not speech, and must include them anyway.
      body: JSON.stringify([
        { id: 1, name: 'Ann', is_host: true, platform: 'zoom', extra_data: {}, email: null },
        { id: 2, name: 'Ghost', is_host: false, platform: 'zoom', extra_data: {}, email: null },
      ]),
    });
    const { router } = await mount();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/meta-end', 'task-meta-end');

    await request(router, 'DELETE', `/meetings/${botId}`);

    expect(metadataEndCalls).toHaveLength(1);
    const { taskId, sessionId, info } = metadataEndCalls[0];
    expect(taskId).toBe('task-meta-end');
    expect(sessionId).toBe(botId);
    // Carried forward from the start write, not re-derived.
    expect(info.url).toBe('https://zoom.us/j/meta-end');
    expect(info.platform).toBe('zoom');
    expect(info.title).toBe('Sprint planning');
    expect(info.meetingEndedAt).toBe('2026-08-29T10:45:00.000Z');
    expect(info.participants).toEqual([
      { name: 'Ann', isHost: true },
      { name: 'Ghost', isHost: false },
    ]);
  });

  it('still completes the metadata, honestly, when the whole teardown fetch fails', async () => {
    botIds.push('bot-meta-fail');
    botDetailsReplies.push({ status: 500, body: '{"detail":"upstream exploded"}' });
    const { router } = await mount();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/meta-fail', 'task-meta-fail');

    await request(router, 'DELETE', `/meetings/${botId}`);

    expect(metadataEndCalls).toHaveLength(1);
    const { info } = metadataEndCalls[0];
    // Nothing guessed in place of what the fetch could not supply.
    expect(info.platform).toBeNull();
    expect(info.title).toBeNull();
    expect(info.meetingEndedAt).toBeNull();
    expect(info.participants).toBeNull();
    // What the start write already knew is still there.
    expect(info.url).toBe('https://zoom.us/j/meta-fail');
    expect(info.archieJoinedAt.length).toBeGreaterThan(0);
    // The fetch failing did not throw into the rest of teardown.
    expect(meetingEndedCalls).toEqual([{ taskId: 'task-meta-fail', sessionId: botId }]);
  });

  it('keeps the platform and ended time even when only the participants download fails', async () => {
    botIds.push('bot-meta-partial');
    botDetailsReplies.push({
      status: 200,
      body: JSON.stringify({
        meeting_url: { platform: 'google_meet' },
        status_changes: [{ code: 'call_ended', created_at: '2026-08-29T11:00:00.000Z' }],
        recordings: [
          {
            media_shortcuts: {
              participant_events: { data: { participants_download_url: 'https://participants.example/roster/2' } },
            },
          },
        ],
      }),
    });
    participantsReplies.push({ status: 500, body: '{"detail":"gone"}' });
    const { router } = await mount();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/meta-partial', 'task-meta-partial');

    await request(router, 'DELETE', `/meetings/${botId}`);

    const { info } = metadataEndCalls[0];
    expect(info.platform).toBe('google_meet');
    expect(info.meetingEndedAt).toBe('2026-08-29T11:00:00.000Z');
    // Title was never in the response at all — absent is normal, not an error.
    expect(info.title).toBeNull();
    expect(info.participants).toBeNull();
  });

  it('never completes metadata for an unbound meeting either', async () => {
    botIds.push('bot-meta-unbound-end');
    const { router } = await mount();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/meta-unbound-end');

    await request(router, 'DELETE', `/meetings/${botId}`);

    expect(metadataEndCalls).toEqual([]);
  });

  it('points the started/ended knowledge-log lines at the meeting folder rather than carrying the url', async () => {
    botIds.push('bot-meta-pointer');
    const { router } = await mount();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/should-not-appear', 'task-meta-pointer');

    expect(hosts[0].events).toEqual([`meeting started — recall/${botId}/`]);
    expect(hosts[0].events[0]).not.toContain('zoom.us');

    await request(router, 'DELETE', `/meetings/${botId}`);

    expect(hosts[0].events).toEqual([
      `meeting started — recall/${botId}/`,
      `meeting ended — recall/${botId}/`,
    ]);
  });
});

describe('recall mount — live participants', () => {
  it('records a join before any audio, so someone who never speaks still appears', async () => {
    botIds.push('bot-join-only');
    const { router, ws } = await withAudioSocket();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/join-only', 'task-join-only');

    ws.fire(
      'message',
      Buffer.from(participantEventFrame(botId, 'join', { id: 11, name: 'Ghost', is_host: false, platform: 'zoom', extra_data: {}, email: null })),
    );

    expect(liveParticipantCalls).toHaveLength(1);
    const call = liveParticipantCalls[0];
    expect(call.taskId).toBe('task-join-only');
    expect(call.sessionId).toBe(botId);
    expect(call.liveParticipants).toHaveLength(1);
    const [ghost] = call.liveParticipants;
    expect(ghost.name).toBe('Ghost');
    expect(ghost.is_host).toBe(false);
    expect(ghost.left_at).toBeNull();
    expect(typeof ghost.joined_at).toBe('string');
  });

  it('records a leave, closing the entry rather than removing it — history preserved', async () => {
    botIds.push('bot-join-leave');
    const { router, ws } = await withAudioSocket();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/join-leave', 'task-join-leave');

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 21, name: 'Ann', is_host: true })));
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 21, name: 'Ann', is_host: true })));

    // Two writes, one per event — the roster still holds one entry, now closed rather than gone.
    expect(liveParticipantCalls).toHaveLength(2);
    const last = liveParticipantCalls[liveParticipantCalls.length - 1];
    expect(last.liveParticipants).toHaveLength(1);
    expect(last.liveParticipants[0].name).toBe('Ann');
    expect(last.liveParticipants[0].joined_at).not.toBeNull();
    expect(last.liveParticipants[0].left_at).not.toBeNull();
  });

  it('accumulates a full roster across several joins and leaves, in join order', async () => {
    botIds.push('bot-roster');
    const { router, ws } = await withAudioSocket();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/roster', 'task-roster');

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 2, name: 'Bob', is_host: false })));
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 1, name: 'Ann', is_host: true })));

    const last = liveParticipantCalls[liveParticipantCalls.length - 1];
    expect(last.liveParticipants.map((p) => p.name)).toEqual(['Ann', 'Bob']);
    expect(last.liveParticipants[0].left_at).not.toBeNull(); // Ann left
    expect(last.liveParticipants[1].left_at).toBeNull(); // Bob still present
  });

  it('never adds Archie itself to the roster, on join or leave', async () => {
    botIds.push('bot-self-roster');
    const { router, ws } = await withAudioSocket();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/self-roster', 'task-self-roster');

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 99, name: 'Archie', is_host: false })));
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 99, name: 'Archie', is_host: false })));

    expect(liveParticipantCalls).toEqual([]);
  });

  it('matches Archie by name case- and punctuation-insensitively, the same standard the medium uses for turn attribution', async () => {
    botIds.push('bot-self-fuzzy');
    const { router, ws } = await withAudioSocket();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/self-fuzzy', 'task-self-fuzzy');

    // Neither exact-equals "Archie" — a plain === (the audio path's older check) would have missed both.
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 5, name: 'Archie!', is_host: false })));
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 6, name: '  archie ', is_host: false })));

    expect(liveParticipantCalls).toEqual([]);
  });

  it('writes nothing for an unbound meeting — there is no task to write to', async () => {
    botIds.push('bot-unbound-roster');
    const { router, ws } = await withAudioSocket();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/unbound-roster'); // no task_id

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));

    expect(liveParticipantCalls).toEqual([]);
  });

  it('keeps two concurrent meetings\' rosters from crossing wires', async () => {
    botIds.push('bot-roster-a', 'bot-roster-b');
    const { router, ws } = await withAudioSocket();
    const a = await startMeeting(router, 'https://zoom.us/j/a', 'task-roster-a');
    const b = await startMeeting(router, 'https://zoom.us/j/b', 'task-roster-b');

    ws.fire('message', Buffer.from(participantEventFrame(a.botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('message', Buffer.from(participantEventFrame(b.botId, 'join', { id: 1, name: 'Bob', is_host: true })));

    const aCalls = liveParticipantCalls.filter((c) => c.taskId === 'task-roster-a');
    const bCalls = liveParticipantCalls.filter((c) => c.taskId === 'task-roster-b');
    expect(aCalls).toHaveLength(1);
    expect(bCalls).toHaveLength(1);
    expect(aCalls[0].liveParticipants[0].name).toBe('Ann');
    expect(bCalls[0].liveParticipants[0].name).toBe('Bob');
  });
});

describe('recall mount — the roster the conversation gets', () => {
  // meeting.ts builds its participant map from onAudio alone; Recall sends nothing for a muted participant — metadata.json could show four, live prompt one.
  it('pushes the roster into the conversation on a join, not only into metadata', async () => {
    botIds.push('bot-ctx-join');
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(router, 'https://zoom.us/j/ctx-join', 'task-ctx-join');

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 11, name: 'Muted Mary', is_host: false })));

    expect(made.rosters).toHaveLength(1);
    expect(made.rosters[0]).toHaveLength(1);
    expect(made.rosters[0][0].name).toBe('Muted Mary');
    expect(made.rosters[0][0].left_at).toBeNull();
    // The same snapshot went both ways, so the two destinations can never disagree about who is in the room.
    expect(made.rosters[0]).toEqual(liveParticipantCalls[0].liveParticipants);
  });

  it('pushes it again on a leave, with the departure marked', async () => {
    botIds.push('bot-ctx-leave');
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(router, 'https://zoom.us/j/ctx-leave', 'task-ctx-leave');

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 2, name: 'Bob', is_host: false })));
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 1, name: 'Ann', is_host: true })));

    expect(made.rosters).toHaveLength(3);
    const last = made.rosters[2];
    expect(last.map((p) => p.name)).toEqual(['Ann', 'Bob']);
    expect(last[0].left_at).not.toBeNull();
    expect(last[1].left_at).toBeNull();
  });

  it('pushes it for an UNBOUND meeting too — no task to write to, but still a room to talk to', async () => {
    // The one place this seam deliberately differs from `persistLiveParticipants`.
    botIds.push('bot-ctx-unbound');
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(router, 'https://zoom.us/j/ctx-unbound'); // no task_id

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));

    expect(liveParticipantCalls).toEqual([]);
    expect(made.rosters).toHaveLength(1);
    expect(made.rosters[0][0].name).toBe('Ann');
  });

  it('never puts Archie itself in the roster it hands over', async () => {
    botIds.push('bot-ctx-self');
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(router, 'https://zoom.us/j/ctx-self', 'task-ctx-self');

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 99, name: 'Archie', is_host: false })));

    expect(made.rosters).toEqual([]);
  });

  it('survives a medium that cannot take a roster, without taking the audio socket down', async () => {
    // Called from the audio socket's message handler, which must not throw — a roster the conversation never learns about costs it context, not voice.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    botIds.push('bot-ctx-throw');
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(router, 'https://zoom.us/j/ctx-throw', 'task-ctx-throw');
    // Closest stand-in for updateParticipants failing: make the fake's own recording throw.
    (made as unknown as { rosters: unknown }).rosters = {
      push() {
        throw new Error('the medium exploded');
      },
    };

    expect(() =>
      ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true }))),
    ).not.toThrow();
    // The persistence half still ran, so one failure did not cost the other.
    expect(liveParticipantCalls).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  });
});

describe('recall mount — the capability summary', () => {
  it('asks for the capability summary and hands it over once it lands', async () => {
    botIds.push('bot-caps');
    capabilityResult = Promise.resolve('- Look up numbers in the analytics warehouse');
    const { router } = await mount();

    const { spawned: made } = await startMeeting(router, 'https://zoom.us/j/caps', 'task-caps');
    await flushMicrotasks();

    expect(capabilityCalls).toEqual([{ taskId: 'task-caps' }]);
    expect(made.capabilities).toEqual(['- Look up numbers in the analytics warehouse']);
  });

  it('records the block alongside the meeting, once, with the same text handed to the model', async () => {
    // Held only in the meeting's closure, shaping every later model call — without it, wrong/empty/malformed/ignored are indistinguishable.
    botIds.push('bot-caps-record');
    capabilityResult = Promise.resolve('- Look up numbers in the analytics warehouse');
    const { router } = await mount();

    const { spawned: made } = await startMeeting(router, 'https://zoom.us/j/caps-record', 'task-caps-record');
    await flushMicrotasks();

    // Keyed on the bot id, like every other file in the meeting's folder.
    expect(capabilityRecords).toEqual([
      { taskId: 'task-caps-record', sessionId: 'bot-caps-record', summary: '- Look up numbers in the analytics warehouse' },
    ]);
    // What the meeting was told and what was written down cannot be allowed to drift.
    expect(capabilityRecords[0].summary).toBe(made.capabilities[0]);
  });

  it('does NOT hold the join behind the capability model call', async () => {
    // A model call in front of a join would put the room's first impression behind a provider's latency, and a hung one would stop the join.
    botIds.push('bot-caps-slow');
    let release: (summary: string) => void = () => {};
    capabilityResult = new Promise<string>((resolve) => {
      release = resolve;
    });
    const { router } = await mount();

    const { reply, spawned: made } = await startMeeting(router, 'https://zoom.us/j/caps-slow', 'task-caps-slow');

    // Nothing recorded either — the write rides inside the same pending `.then()` as the handoff, not a separate earlier step.
    expect(reply.code).toBe(201);
    expect(made.capabilities).toEqual([]);
    expect(capabilityRecords).toEqual([]);

    release('- Read the code in the team repositories');
    await flushMicrotasks();
    expect(made.capabilities).toEqual(['- Read the code in the team repositories']);
    expect(capabilityRecords).toEqual([
      { taskId: 'task-caps-slow', sessionId: 'bot-caps-slow', summary: '- Read the code in the team repositories' },
    ]);
  });

  it('hands over an empty summary rather than nothing, so the meeting logs it as degraded', async () => {
    botIds.push('bot-caps-empty');
    capabilityResult = Promise.resolve('');
    const { router } = await mount();

    const { spawned: made } = await startMeeting(router, 'https://zoom.us/j/caps-empty', 'task-caps-empty');
    await flushMicrotasks();

    expect(made.capabilities).toEqual(['']);
    // Recorded, not skipped — "the summariser returned nothing" is a real outcome, and must not reach disk as an absence that could equally mean the write failed.
    expect(capabilityRecords).toEqual([
      { taskId: 'task-caps-empty', sessionId: 'bot-caps-empty', summary: '' },
    ]);
  });

  it('survives a handoff that throws, instead of taking the whole process down with it', async () => {
    // Deliberately un-awaited (see above); a throw has nowhere to go. No global `unhandledRejection` handler exists in src/, so in production it kills every task and meeting.
    // The listener below is the detector, not the fix — registering one here also stops Node acting on the rejection, which is why its absence in src/ is the hazard.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const escaped: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      escaped.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      botIds.push('bot-caps-throw');
      // Left pending so the throwing recorder installs before the summary lands — a resolved promise would hand it over during the join.
      let release: (summary: string) => void = () => {};
      capabilityResult = new Promise<string>((resolve) => {
        release = resolve;
      });
      const { router } = await mount();

      const { reply, spawned: made } = await startMeeting(router, 'https://zoom.us/j/caps-throw', 'task-caps-throw');
      // Closest stand-in for setCapabilities failing — same trick the roster test above uses for updateParticipants.
      (made as unknown as { capabilities: unknown }).capabilities = {
        push() {
          throw new Error('the medium exploded');
        },
      };

      release('- Look up numbers in the analytics warehouse');
      await flushMicrotasks();
      // A full event-loop turn, not just microtasks — Node emits unhandledRejection only after microtasks drain, so draining alone would prove nothing.
      await new Promise((resolve) => setImmediate(resolve));

      expect(escaped).toEqual([]);
      // Distinct from the empty-summary warning in meeting.ts and the failed-write warning in task-binding.ts — two different faults.
      expect(
        warn.mock.calls.some(
          ([, message]) => typeof message === 'string' && message.includes('threw instead of landing'),
        ),
      ).toBe(true);
      // The join itself was never at risk, which is the point of the `void`.
      expect(reply.code).toBe(201);
      // The record rides after the handoff in the same continuation — losing the handoff loses it too, deliberately, since recording must never delay the block.
      expect(capabilityRecords).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('stays quiet about a failed handoff when the handoff worked', async () => {
    // Control for the test above: a catch broad enough to fire on the happy path would log "no capability block" for a meeting that has one, letting an over-broad fix pass.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    botIds.push('bot-caps-ok');
    capabilityResult = Promise.resolve('- Look up numbers in the analytics warehouse');
    const { router } = await mount();

    const { spawned: made } = await startMeeting(router, 'https://zoom.us/j/caps-ok', 'task-caps-ok');
    await flushMicrotasks();
    await new Promise((resolve) => setImmediate(resolve));

    expect(made.capabilities).toEqual(['- Look up numbers in the analytics warehouse']);
    expect(capabilityRecords).toEqual([
      { taskId: 'task-caps-ok', sessionId: 'bot-caps-ok', summary: '- Look up numbers in the analytics warehouse' },
    ]);
    expect(
      warn.mock.calls.filter(([, message]) => typeof message === 'string' && message.includes('capability')),
    ).toEqual([]);
  });

  it('asks for none on an unbound meeting — there is no task to ask about', async () => {
    botIds.push('bot-unbound-ctx');
    const { router } = await mount();

    const { spawned: made } = await startMeeting(router, 'https://zoom.us/j/unbound-ctx'); // no task_id

    expect(capabilityCalls).toEqual([]);
    expect(made.capabilities).toEqual([]);
    // Nothing to record it in either — an unbound meeting has no task folder, so both calls sit inside the same binding branch.
    expect(capabilityRecords).toEqual([]);
  });
});

// Literal, not imported from index.ts's EMPTY_ROOM_GRACE_MS — importing would pass for any value, zero included, which is the bug this block exists to catch. This number is the contract.
const GRACE_MS = 45 * 1000;

describe('recall mount — the meeting ends once the room has STAYED empty', () => {
  // Zoom issues a new id on rejoin: reconnect = leave(id1) then join(id2). In a two-person room that gap looks empty — tearing down there ends a live meeting and wakes the PM mid-conversation.

  it('does not end when the last human leaves — not yet', async () => {
    vi.useFakeTimers();
    botIds.push('bot-empty-not-yet');
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(router, 'https://zoom.us/j/empty-not-yet', 'task-empty-not-yet');

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 1, name: 'Ann', is_host: true })));
    await flushMicrotasks();

    // One second short of the grace period — still nothing, and the PM hasn't been told the room dispersed.
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1000);
    await flushMicrotasks();

    expect(made.stopped).toBe(0);
    expect(meetingEndedCalls).toEqual([]);
  });

  it('ends it once the grace period passes with nobody coming back', async () => {
    vi.useFakeTimers();
    botIds.push('bot-empty-then');
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(router, 'https://zoom.us/j/empty-then', 'task-empty-then');

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 1, name: 'Ann', is_host: true })));
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(GRACE_MS);
    await flushMicrotasks();

    expect(made.stopped).toBe(1);
    expect(meetingEndedCalls).toEqual([{ taskId: 'task-empty-then', sessionId: botId }]);
    // Grace timer, not idle sweep: nothing at GRACE_MS-1000, ended at GRACE_MS — a 1s window the sweep (30s ticks, 3min cutoff) can't produce.
  });

  it('does NOT end when somebody rejoins inside the grace period — Zoom gives them a new id', async () => {
    vi.useFakeTimers();
    botIds.push('bot-rejoin');
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(router, 'https://zoom.us/j/rejoin', 'task-rejoin');

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 1, name: 'Ann', is_host: true })));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(8 * 1000);
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 2, name: 'Ann', is_host: true })));
    await flushMicrotasks();

    // Well past both the original armed teardown's fire time and a fresh grace period counted from the rejoin.
    await vi.advanceTimersByTimeAsync(2 * GRACE_MS);
    await flushMicrotasks();

    expect(made.stopped).toBe(0);
    // The worst consequence avoided: no premature "room dispersed" wake-up, no meeting summary landing in Slack mid-meeting.
    expect(meetingEndedCalls).toEqual([]);
    // Ann is in the room, under both ids — the old one closed, the new one open.
    const roster = made.rosters[made.rosters.length - 1];
    expect(roster.map((p) => p.left_at === null)).toEqual([false, true]);
  });

  it('gives a rejoiner who leaves again the full grace period over, not the remainder of the first', async () => {
    vi.useFakeTimers();
    botIds.push('bot-rejoin-releave');
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(router, 'https://zoom.us/j/rejoin-releave', 'task-rejoin-releave');

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 1, name: 'Ann', is_host: true })));
    await vi.advanceTimersByTimeAsync(40 * 1000); // deep into the first grace period
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 2, name: 'Ann', is_host: true })));
    await vi.advanceTimersByTimeAsync(5 * 1000);
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 2, name: 'Ann', is_host: true })));
    await flushMicrotasks();

    // First timer cancelled outright, not re-evaluated on expiry — else this departure inherits the first period's remainder, and the meeting would have ended by now.
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1000);
    await flushMicrotasks();
    expect(made.stopped).toBe(0);

    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(made.stopped).toBe(1);
    expect(meetingEndedCalls).toEqual([{ taskId: 'task-rejoin-releave', sessionId: botId }]);
  });

  it('does not end while Archie is alone at the start — zero participants is not the end', async () => {
    botIds.push('bot-alone');
    const { router } = await withAudioSocket();
    const { spawned: made } = await startMeeting(router, 'https://zoom.us/j/alone', 'task-alone');

    await flushMicrotasks();

    // Nothing has joined or left at all — the state every meeting starts in.
    expect(made.stopped).toBe(0);
  });

  it("does not end on Archie's own leave event, even before any human has joined", async () => {
    vi.useFakeTimers();
    botIds.push('bot-self-leave');
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(router, 'https://zoom.us/j/self-leave', 'task-self-leave');

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 1, name: 'Archie', is_host: false })));
    await flushMicrotasks();

    // Nothing armed, not just nothing done synchronously — the whole grace period passes and the meeting is still here.
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    await flushMicrotasks();

    expect(made.stopped).toBe(0);
    expect(meetingEndedCalls).toEqual([]);
  });

  it('does not end on an orphaned leave — one with no join this connector ever witnessed', async () => {
    vi.useFakeTimers();
    botIds.push('bot-orphan-leave');
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(router, 'https://zoom.us/j/orphan-leave', 'task-orphan-leave');

    // A leave for someone never seen joining doesn't prove the room is empty — it could hold others never witnessed arriving either.
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 42, name: 'Mystery', is_host: null })));
    await flushMicrotasks();

    // No teardown armed either — the grace period passes and it is still live.
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    await flushMicrotasks();

    expect(made.stopped).toBe(0);
    expect(meetingEndedCalls).toEqual([]);
    // Still recorded, though — their departure is not silently lost.
    expect(liveParticipantCalls[0].liveParticipants).toEqual([
      { name: 'Mystery', is_host: null, joined_at: null, left_at: expect.any(String) },
    ]);
  });

  it('keeps the room open until the SECOND of two humans leaves', async () => {
    vi.useFakeTimers();
    botIds.push('bot-two-humans');
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(router, 'https://zoom.us/j/two-humans', 'task-two-humans');

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 2, name: 'Bob', is_host: false })));
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 1, name: 'Ann', is_host: true })));
    await flushMicrotasks();

    expect(made.stopped).toBe(0); // Bob is still there

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 2, name: 'Bob', is_host: false })));
    await flushMicrotasks();
    expect(made.stopped).toBe(0); // and still not yet — the grace period runs

    await vi.advanceTimersByTimeAsync(GRACE_MS);
    await flushMicrotasks();

    expect(made.stopped).toBe(1);
    expect(meetingEndedCalls).toEqual([{ taskId: 'task-two-humans', sessionId: botId }]);
  });

  it('arms nothing at all while other people are still in the room', async () => {
    // The arming decision is about the room, not the person who left — a busy meeting with people coming and going must never carry a pending teardown.
    vi.useFakeTimers();
    botIds.push('bot-crowd');
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(router, 'https://zoom.us/j/crowd', 'task-crowd');

    for (const id of [1, 2, 3]) {
      ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id, name: `P${id}`, is_host: id === 1 })));
    }
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 2, name: 'P2', is_host: false })));
    await flushMicrotasks();

    // Same reading as "stops sweeping once the connector is stopped" — a grace timer here would show up as a second one.
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(2 * GRACE_MS);
    await flushMicrotasks();

    expect(made.stopped).toBe(0);
    expect(meetingEndedCalls).toEqual([]);
  });

  it('arms ONE teardown however many leaves arrive, and the idle sweep afterwards finds nothing left to do', async () => {
    vi.useFakeTimers();
    botIds.push('bot-double-teardown');
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(router, 'https://zoom.us/j/double-teardown', 'task-double-teardown');

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 1, name: 'Ann', is_host: true })));
    await flushMicrotasks();

    // Stray duplicate leaves, trusted no further than handleAudioMessage elsewhere. Still `live` in the grace period, so these DO reach handleParticipantLeave again.
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 1, name: 'Ann', is_host: true })));
    await flushMicrotasks();

    // Three leaves, but only the idle sweep plus a single grace timer are pending — not three teardowns queued up.
    expect(vi.getTimerCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(GRACE_MS);
    await flushMicrotasks();
    expect(made.stopped).toBe(1);
    expect(meetingEndedCalls).toEqual([{ taskId: 'task-double-teardown', sessionId: botId }]);

    // The idle sweep, now a backstop with nothing to find — must not tear this meeting down twice, nor wake the PM again.
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(made.stopped).toBe(1);
    expect(meetingEndedCalls).toEqual([{ taskId: 'task-double-teardown', sessionId: botId }]);
  });

  it('stands the armed teardown down when the meeting ends by another route, rather than firing at a dead meeting', async () => {
    // DELETE stands for any explicit ending (LEAVE:, leave_recall_meeting, shutdown) — same funnel; armed, the timer would endMeeting a gone meeting, waking the PM twice.
    vi.useFakeTimers();
    botIds.push('bot-cancel-on-end');
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(router, 'https://zoom.us/j/cancel-on-end', 'task-cancel-on-end');

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 1, name: 'Ann', is_host: true })));
    await flushMicrotasks();
    expect(vi.getTimerCount()).toBe(2); // idle sweep + the armed teardown

    await request(router, 'DELETE', `/meetings/${botId}`);
    await flushMicrotasks();

    expect(made.stopped).toBe(1);
    // Disarmed: the idle sweep is the only timer left.
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(GRACE_MS + 4 * 60 * 1000);
    await flushMicrotasks();

    expect(made.stopped).toBe(1);
    expect(meetingEndedCalls).toEqual([{ taskId: 'task-cancel-on-end', sessionId: botId }]);
    // And no second `leave_call` at Recall from a timer firing into the void.
    expect(http.filter((c) => c.url.endsWith(`/bot/${botId}/leave_call/`))).toHaveLength(1);
  });

  it("still records the meeting's end time from Recall's own status ledger, not the moment the room emptied", async () => {
    vi.useFakeTimers();
    botIds.push('bot-recorded-end-time');
    botDetailsReplies.push({
      status: 200,
      body: JSON.stringify({
        status_changes: [{ code: 'call_ended', created_at: '2026-08-29T09:00:00.000Z' }],
      }),
    });
    const { router, ws } = await withAudioSocket();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/recorded-end-time', 'task-recorded-end-time');

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 1, name: 'Ann', is_host: true })));
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    await flushMicrotasks();

    expect(metadataEndCalls).toHaveLength(1);
    // Not "now" (this test's wall-clock moment) — Recall's ledger value exactly, even though the room was detected empty 45s earlier.
    expect(metadataEndCalls[0].info.meetingEndedAt).toBe('2026-08-29T09:00:00.000Z');
  });

  it('carries the live roster forward into the final teardown metadata, unmodified', async () => {
    vi.useFakeTimers();
    botIds.push('bot-final-roster');
    const { router, ws } = await withAudioSocket();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/final-roster', 'task-final-roster');

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 1, name: 'Ann', is_host: true })));
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    await flushMicrotasks();

    expect(metadataEndCalls).toHaveLength(1);
    expect(metadataEndCalls[0].info.liveParticipants).toEqual([
      { name: 'Ann', is_host: true, joined_at: expect.any(String), left_at: expect.any(String) },
    ]);
  });
});

// A literal for the same reason as GRACE_MS — this value is the contract, making a missed ending cost 10 seconds instead of 3.5 minutes.
const SETTLE_MS = 10 * 1000;

// Bare codes (call_ended), not bot.-prefixed webhook names — the shape askWhetherWeAreStillInTheCall reads.
function ledger(...codes: string[]): { status: number; body: string } {
  return {
    status: 200,
    body: JSON.stringify({
      status_changes: codes.map((code, i) => ({
        code,
        created_at: new Date(Date.UTC(2026, 8, 2, 11, 40 + i, 0)).toISOString(),
      })),
    }),
  };
}

// Socket-close question and teardown fetch share this URL, so counting *questions* needs an unbound meeting or a pre-teardown baseline — each test below says which.
function botDetailGets(botId: string): HttpCall[] {
  return http.filter((c) => c.url.endsWith(`/api/v1/bot/${botId}/`));
}

/** Every `leave_call` sent for this bot — one per teardown, so a second means two teardowns. */
function leaveCalls(botId: string): HttpCall[] {
  return http.filter((c) => c.url.endsWith(`/bot/${botId}/leave_call/`));
}

describe('recall mount — the audio socket closing is a question, not an answer', () => {
  // Recall can stop delivering audio with no leave event ever sent, so the grace period never arms — without this path, only the slower idle sweep would catch it.
  // Must NOT tear down on socket close: "audio stopped" is equally true of an ended call and a 2s wobble. Close triggers a question; only Recall's answer ends anything.

  it('ends the meeting as soon as Recall says the call is over, with no leave event ever arriving', async () => {
    vi.useFakeTimers();
    botIds.push('bot-close-ended');
    botDetailsReplies.push(ledger('joining_call', 'in_call_recording', 'call_ended'));
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(
      router,
      'https://zoom.us/j/close-ended',
      'task-close-ended',
    );

    // This frame is also how the socket learns its meeting — Recall assigns the bot id after we hand over the URL, so every audio socket arrives before that's known.
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    await flushMicrotasks();
    ws.fire('close');

    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await flushMicrotasks();

    expect(made.stopped).toBe(1);
    expect(meetingEndedCalls).toEqual([{ taskId: 'task-close-ended', sessionId: botId }]);
    expect(vi.getTimerCount()).toBe(1);
    // Why this path, not the grace period: our own roster still has Ann in the room, since the leave event never came.
    expect(metadataEndCalls[0].info.liveParticipants).toEqual([
      { name: 'Ann', is_host: true, joined_at: expect.any(String), left_at: null },
    ]);
  });

  it('does nothing when Recall says the bot is still in the call, and the meeting carries on afterwards', async () => {
    vi.useFakeTimers();
    botIds.push('bot-close-blip');
    botDetailsReplies.push(ledger('joining_call', 'in_call_recording'));
    const { router, ws, onUpgrade } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(
      router,
      'https://zoom.us/j/close-blip',
      'task-close-blip',
    );

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('close');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await flushMicrotasks();

    // A blip doesn't make Recall report call_ended, so nothing ends — the PM isn't told the room dispersed while Ann is still in it.
    expect(made.stopped).toBe(0);
    expect(meetingEndedCalls).toEqual([]);

    // Genuinely intact, not merely un-torn-down — audio flows again on the new socket.
    onUpgrade({ url: '/api/voice/audio' }, { destroy: vi.fn() }, Buffer.alloc(0));
    const reconnected = lastSocket();
    reconnected.fire('message', Buffer.from(audioFrame(botId, { id: 1, name: 'Ann' })));
    expect(made.audio).toHaveLength(1);

    // The ordinary ending still works from here, through the grace period, on the socket that replaced the one that closed.
    reconnected.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 1, name: 'Ann', is_host: true })));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    await flushMicrotasks();

    expect(made.stopped).toBe(1);
    expect(meetingEndedCalls).toEqual([{ taskId: 'task-close-blip', sessionId: botId }]);
  });

  it('leaves the meeting alone and says so loudly when the question itself fails, then lets the sweep have it', async () => {
    vi.useFakeTimers();
    const warns = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    botIds.push('bot-close-ask-fails');
    botDetailsReplies.push({ status: 500, body: '{"detail":"upstream exploded"}' });
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(
      router,
      'https://zoom.us/j/close-ask-fails',
      'task-close-ask-fails',
    );

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('close');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await flushMicrotasks();

    // A network error must never be read as an ending.
    expect(made.stopped).toBe(0);
    expect(meetingEndedCalls).toEqual([]);
    // Visible because this is the one branch where a real ending can be missed — the log line explains a teardown that later came from the sweep instead of here.
    expect(
      warns.mock.calls.some(
        ([prefix, message]) =>
          prefix === 'voice' && String(message).includes(botId) && /idle sweep/.test(String(message)),
      ),
    ).toBe(true);

    // Nor is the meeting wedged open: the backstop underneath is untouched.
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    await flushMicrotasks();
    expect(made.stopped).toBe(1);
    expect(meetingEndedCalls).toEqual([{ taskId: 'task-close-ask-fails', sessionId: botId }]);
  });

  it('asks once however many times the socket closes, and tears down once', async () => {
    vi.useFakeTimers();
    botIds.push('bot-close-storm');
    botDetailsReplies.push(ledger('in_call_recording', 'call_ended'));
    const { router, ws } = await withAudioSocket();
    // Unbound on purpose: no task means no teardown metadata fetch, so every bot-details GET here is a question — "asked once" is a count, not an inference.
    const { botId, spawned: made } = await startMeeting(router, 'https://zoom.us/j/close-storm');

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    // Three closes in a row — a flapping connection, or Recall retrying.
    ws.fire('close');
    ws.fire('close');
    ws.fire('close');

    // One question pending, plus the sweep — not three questions, and not three teardowns queued up.
    expect(vi.getTimerCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await flushMicrotasks();

    expect(botDetailGets(botId)).toHaveLength(1);
    expect(made.stopped).toBe(1);
    expect(leaveCalls(botId)).toHaveLength(1);
  });

  it('wakes the PM once when the question and an armed grace timer both point at the same ending', async () => {
    vi.useFakeTimers();
    botIds.push('bot-close-vs-grace');
    botDetailsReplies.push(ledger('in_call_recording', 'call_ended'));
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(
      router,
      'https://zoom.us/j/close-vs-grace',
      'task-close-vs-grace',
    );

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 1, name: 'Ann', is_host: true })));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1000);
    ws.fire('close');
    await flushMicrotasks();
    expect(vi.getTimerCount()).toBe(3); // sweep + grace + question

    // The question comes due first — ten seconds beats forty-five.
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await flushMicrotasks();

    expect(made.stopped).toBe(1);
    expect(meetingEndedCalls).toEqual([{ taskId: 'task-close-vs-grace', sessionId: botId }]);
    // The grace timer was stood down as the meeting ended, not left to fire at a gone meeting — only the sweep remains.
    expect(vi.getTimerCount()).toBe(1);

    // Well past where it would have fired, and past the sweep too.
    await vi.advanceTimersByTimeAsync(GRACE_MS + 4 * 60 * 1000);
    await flushMicrotasks();
    expect(made.stopped).toBe(1);
    expect(meetingEndedCalls).toHaveLength(1);
    expect(leaveCalls(botId)).toHaveLength(1);
  });

  it('drops a pending question when the grace timer gets there first, rather than asking about a dead meeting', async () => {
    vi.useFakeTimers();
    botIds.push('bot-grace-vs-close');
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(
      router,
      'https://zoom.us/j/grace-vs-close',
      'task-grace-vs-close',
    );

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 1, name: 'Ann', is_host: true })));
    await flushMicrotasks();
    // Socket dies at 40s, its question comes due at 50s — 5s after the grace period ends the meeting at 45s. The race, run the other way round from the test above.
    await vi.advanceTimersByTimeAsync(40 * 1000);
    ws.fire('close');
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(5 * 1000);
    await flushMicrotasks();
    expect(made.stopped).toBe(1);
    // The question went with the meeting; the sweep is the only timer left.
    expect(vi.getTimerCount()).toBe(1);

    // The only bot-details GET so far is teardown's; nothing added when the dropped question's moment passes.
    const duringTeardown = botDetailGets(botId).length;
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await flushMicrotasks();
    expect(botDetailGets(botId)).toHaveLength(duringTeardown);
    expect(meetingEndedCalls).toHaveLength(1);
    expect(leaveCalls(botId)).toHaveLength(1);
  });

  // Recall: call_ended="left call", done="shut down" (after leaving), fatal="error causing shutdown" — Archie's out in all three; returns only via another join_recall_meeting.
  // Closed over "certainly out", not open over "certainly in" — Recall may add codes without notice, so a new code (last row) must default to NOT ending the meeting.
  // Wrong permissively is how Archie vanishes from a live room; wrong the other way only costs the delay this path removes.
  it.each([
    ['call_ended', true],
    ['done', true],
    ['fatal', true],
    ['joining_call', false],
    ['in_waiting_room', false],
    ['in_call_not_recording', false],
    ['recording_permission_allowed', false],
    ['in_call_recording', false],
    ['breakout_room_entered', false],
    ['some_status_recall_adds_next_year', false],
  ])('reads %s as ending the meeting: %s', async (code, endsIt) => {
    vi.useFakeTimers();
    botIds.push(`bot-status-${code}`);
    botDetailsReplies.push(ledger(code));
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(router, `https://zoom.us/j/status-${code}`);

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('close');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await flushMicrotasks();

    expect(made.stopped).toBe(endsIt ? 1 : 0);
  });

  it('reads a terminal status anywhere in the ledger, not only as its last entry', async () => {
    // Post-processing/breakout entries can land after the bot's gone; a bot never rejoins (Recall issues a new one) — a terminal code can't be followed by a return.
    vi.useFakeTimers();
    botIds.push('bot-trailing-ledger');
    botDetailsReplies.push(ledger('in_call_recording', 'call_ended', 'done'));
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(router, 'https://zoom.us/j/trailing-ledger');

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('close');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await flushMicrotasks();

    expect(made.stopped).toBe(1);
  });

  it('does not end the meeting on a ledger with nothing in it at all', async () => {
    vi.useFakeTimers();
    botIds.push('bot-empty-ledger');
    botDetailsReplies.push(ledger());
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(router, 'https://zoom.us/j/empty-ledger');

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('close');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await flushMicrotasks();

    // Nothing known isn't the same as nothing happening — only one of those readings can end a live meeting by mistake.
    expect(made.stopped).toBe(0);
  });

  it('skips the question outright when audio comes back while it waits', async () => {
    vi.useFakeTimers();
    botIds.push('bot-audio-back');
    // Queued and deliberately never consumed — it would end the meeting if asked, which is what makes this an assertion about the skip, not the answer.
    botDetailsReplies.push(ledger('call_ended'));
    const { router, ws, onUpgrade } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(
      router,
      'https://zoom.us/j/audio-back',
      'task-audio-back',
    );

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('close');
    await vi.advanceTimersByTimeAsync(2000);
    onUpgrade({ url: '/api/voice/audio' }, { destroy: vi.fn() }, Buffer.alloc(0));
    lastSocket().fire('message', Buffer.from(audioFrame(botId, { id: 1, name: 'Ann' })));

    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await flushMicrotasks();

    // A reconnect is proof on its own — the API call is never made.
    expect(botDetailGets(botId)).toHaveLength(0);
    expect(made.stopped).toBe(0);
    expect(meetingEndedCalls).toEqual([]);
  });

  it('asks nothing when the socket that closed never carried a meeting', async () => {
    vi.useFakeTimers();
    botIds.push('bot-untouched');
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(
      router,
      'https://zoom.us/j/untouched',
      'task-untouched',
    );

    // Recall opens the audio socket before the bot is admitted, so a socket closing with nothing delivered is ordinary — no bot id to ask about.
    ws.fire('close');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await flushMicrotasks();

    expect(botDetailGets(botId)).toHaveLength(0);
    expect(made.stopped).toBe(0);
    expect(vi.getTimerCount()).toBe(1); // nothing armed by that close
  });

  it('asks nothing about a meeting that has already ended, and sends no second leave', async () => {
    vi.useFakeTimers();
    botIds.push('bot-close-after-end');
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(
      router,
      'https://zoom.us/j/close-after-end',
      'task-close-after-end',
    );
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));

    await request(router, 'DELETE', `/meetings/${botId}`);
    await flushMicrotasks();
    const duringTeardown = botDetailGets(botId).length;

    // The socket dies on the way out, the ordinary shutdown order — stop() ends every meeting first, only then closes sockets.
    ws.fire('close');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await flushMicrotasks();

    expect(botDetailGets(botId)).toHaveLength(duringTeardown);
    expect(made.stopped).toBe(1);
    expect(leaveCalls(botId)).toHaveLength(1);
  });

  it('still ends through the idle sweep when the answer was "in the call" and the socket never came back', async () => {
    // The composition the three mechanisms promise: this is a third, faster route for what the other two miss, removing neither.
    vi.useFakeTimers();
    botIds.push('bot-never-back');
    botDetailsReplies.push(ledger('in_call_recording'));
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(
      router,
      'https://zoom.us/j/never-back',
      'task-never-back',
    );

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('close');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await flushMicrotasks();
    expect(made.stopped).toBe(0);

    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    await flushMicrotasks();

    expect(made.stopped).toBe(1);
    expect(meetingEndedCalls).toEqual([{ taskId: 'task-never-back', sessionId: botId }]);
  });

  it("records Recall's own end time on this path too, not the moment the socket died", async () => {
    vi.useFakeTimers();
    botIds.push('bot-close-end-time');
    botDetailsReplies.push(
      // The question, then teardown's own fetch, in that order — the question is what triggers the teardown.
      ledger('in_call_recording', 'call_ended'),
      {
        status: 200,
        body: JSON.stringify({
          meeting_url: { platform: 'zoom' },
          status_changes: [{ code: 'call_ended', created_at: '2026-09-02T11:44:43.000Z' }],
        }),
      },
    );
    const { router, ws } = await withAudioSocket();
    const { botId } = await startMeeting(
      router,
      'https://zoom.us/j/close-end-time',
      'task-close-end-time',
    );

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('close');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await flushMicrotasks();

    expect(metadataEndCalls).toHaveLength(1);
    // Recall's ledger value (11:44:43), not the socket close moments earlier, and not the instant teardown happened to run — that's the fact the field names.
    expect(metadataEndCalls[0].info.meetingEndedAt).toBe('2026-09-02T11:44:43.000Z');
    expect(metadataEndCalls[0].info.platform).toBe('zoom');
  });
});

describe('recall mount — the starter hook', () => {
  it('lets join_recall_meeting reach a real, task-bound meeting', async () => {
    botIds.push('bot-starter');
    await mount();
    expect(registeredStarter).not.toBeNull();

    const result = await registeredStarter!('task-starter', 'https://zoom.us/j/starter');

    expect(result).toEqual({ ok: true, botId: 'bot-starter' });
    expect(hosts.some((h) => h.taskId === 'task-starter')).toBe(true);
    expect(registry.has('task-starter')).toBe(true);
    expect(spawned).toHaveLength(1);
  });

  it('refuses a second join on a task that already has one live', async () => {
    botIds.push('bot-starter-1', 'bot-starter-2');
    await mount();

    const first = await registeredStarter!('task-dup', 'https://zoom.us/j/1');
    const second = await registeredStarter!('task-dup', 'https://zoom.us/j/2');

    expect(first).toEqual({ ok: true, botId: 'bot-starter-1' });
    expect(second.ok).toBe(false);
    expect((second as { ok: false; reason: string }).reason).toMatch(/already live/i);
    // The refused attempt never reached the medium at all.
    expect(hosts.filter((h) => h.taskId === 'task-dup')).toHaveLength(1);
    expect(spawned).toHaveLength(1);
  });

  it('reserves the task slot before creating a bot, so two overlapping joins cannot both succeed', async () => {
    // Unlike the sequential case above, these race — the shape a retried tool call, or a double join_recall_meeting emission, produces.
    // An async function runs synchronously to its first await, so calling the starter twice back to back beats the second's check to the reservation — no fake timers.
    botIds.push('bot-race-1', 'bot-race-2');
    await mount();

    const [first, second] = await Promise.all([
      registeredStarter!('task-race', 'https://zoom.us/j/race-1'),
      registeredStarter!('task-race', 'https://zoom.us/j/race-2'),
    ]);

    const results = [first, second];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok) as { ok: false; reason: string };
    expect(loser.reason).toMatch(/already live/i);
    // The loser never reached Recall at all — a bot left live with nothing able to reach it is exactly the defect this pins.
    expect(spawned).toHaveLength(1);
    expect(http.filter((c) => c.url.endsWith('/api/v1/bot/'))).toHaveLength(1);
  });

  it('releases the reservation when bot creation fails, so the task can try again', async () => {
    createFails = 500;
    await mount();

    const failed = await registeredStarter!('task-retry', 'https://zoom.us/j/1');
    expect(failed.ok).toBe(false);

    botIds.push('bot-retry-ok');
    const retried = await registeredStarter!('task-retry', 'https://zoom.us/j/2');

    expect(retried).toEqual({ ok: true, botId: 'bot-retry-ok' });
  });
});

describe('recall mount — the stopper hook', () => {
  it('registers a stopper that reaches the same meeting a LEAVE: request names', async () => {
    botIds.push('bot-leave');
    await mount();
    expect(registeredStopper).not.toBeNull();

    const started = await registeredStarter!('task-leave', 'https://zoom.us/j/leave');
    expect(started).toEqual({ ok: true, botId: 'bot-leave' });

    await registeredStopper!('bot-leave');

    // The same endMeeting funnel the DELETE route and idle sweep already use ("ends the meeting the path names" above, for DELETE).
    expect(spawned.find((m) => m.transport.sessionId === 'bot-leave')?.stopped).toBe(1);
    expect(registry.has('task-leave')).toBe(false);
    expect(http.map((c) => c.url)).toContain('https://eu-central-1.recall.ai/api/v1/bot/bot-leave/leave_call/');
  });

  it('leaves a meeting nothing else is tearing down alone', async () => {
    botIds.push('bot-leave-keep', 'bot-leave-drop');
    await mount();
    await registeredStarter!('task-leave-keep', 'https://zoom.us/j/keep');
    await registeredStarter!('task-leave-drop', 'https://zoom.us/j/drop');

    await registeredStopper!('bot-leave-drop');

    expect(spawned.find((m) => m.transport.sessionId === 'bot-leave-drop')?.stopped).toBe(1);
    expect(spawned.find((m) => m.transport.sessionId === 'bot-leave-keep')?.stopped).toBe(0);
    expect(registry.has('task-leave-drop')).toBe(false);
    expect(registry.has('task-leave-keep')).toBe(true);
  });
});

describe('recall mount — the other two seams a connector plugs into', () => {
  // Like the starter hook: registered once, at mount, into a registry task.ts/spawn.ts read generically, never naming Recall — makes "no mount, no tool" true.
  // See src/agents/__tests__/connector-tools.test.ts for the absent-until-registered half — earlier tests here already mounted the connector, same worker.
  it('registers the real recall channel deliverer under the "recall" kind', async () => {
    await mount();
    expect(getChannelDeliverer('recall')).toBe(deliverToRecallChannel);
  });

  it('registers the real recall channel renderer under the "recall" kind, in the same call as the deliverer', async () => {
    await mount();
    expect(getChannelRenderer('recall')).toBe(renderRecallChannel);
  });

  it('registers the real recall PM-tools factory under "recall-tools"', async () => {
    await mount();
    expect(getRegisteredConnectorPmTools().get('recall-tools')).toBe(createRecallPmToolsServer);
  });
});
