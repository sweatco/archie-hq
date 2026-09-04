// `createMeeting` is a spy: transport captured whole, sink comparable by identity — the only witness against two meetings crossing wires and still looking healthy.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { logger } from '../../../system/logger.js';
import type { AudioSink, MeetingHost, MeetingRow, Participant, VoiceConfig, VoiceTransport } from '../../../voice/types.js';
import type { RecallConfig } from '../recall.js';

// An unbound meeting's rows go to `WORKDIR/voice-logs/` on real disk; point that at a scratch dir before the connector's module graph reads it.
const WORK = mkdtempSync(join(tmpdir(), 'voice-connector-'));
process.env.ARCHIE_WORKDIR = WORK;
import { getChannelDeliverer, getChannelRenderer } from '../../../tasks/channel-delivery.js';
import { getRegisteredConnectorPmTools } from '../../../agents/connector-tools.js';
import { deliverToRecallChannel, renderRecallChannel } from '../channel-delivery.js';
import type { MeetingOps } from '../pm-tools.js';

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
  // Every roster pushed into the conversation; the record's join/leave rows can't stand in. Separate from those rows: the defect was reaching the file, never the prompt.
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
        // The real Meeting carries it too; `stopForTask` reads it off the live registry to find the bot a task's meeting is on.
        sessionId: transport.sessionId,
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
  events: string[];
  /** The connector's teardown funnel, as handed to `createTaskHost` — `leaveMeeting` below calls it, the way the real host does. */
  end: (sessionId: string) => Promise<void>;
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
/** Every row the connector wrote into a task's own meeting record, in order — see `rowsFor` below. */
const recordedRows: Array<{ taskId: string; sessionId: string; row: MeetingRow }> = [];
/** Every `createRecallPmToolsServer` build, so a test can reach the `ops` the mount closed over (see `opsOf`). */
const pmToolsBuilds: MeetingOps[] = [];

vi.mock('../pm-tools.js', () => ({
  createRecallPmToolsServer: (_agent: unknown, _task: unknown, ops: MeetingOps) => {
    pmToolsBuilds.push(ops);
    return { name: 'recall-tools-stub' };
  },
}));

vi.mock('../../../voice/task-binding.js', () => ({
  createTaskHost: (
    taskId: string,
    sessionId: string,
    end: (sessionId: string) => Promise<void>,
  ): FakeHost => {
    const host: FakeHost = {
      taskId,
      sessionId,
      events: [],
      end,
      leaveCalls: 0,
      readWrittenExchange: async () => [],
      noteEvent: (text: string) => {
        host.events.push(text);
      },
      consult: () => {},
      leaveMeeting: () => {
        host.leaveCalls++;
        void end(sessionId);
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
  notifyMeetingEnded: (taskId: string, sessionId: string) => {
    meetingEndedCalls.push({ taskId, sessionId });
  },
  linkRecallChannel: async (taskId: string, sessionId: string, url: string) => {
    linkCalls.push({ taskId, sessionId, url });
  },
  endRecallChannel: async (taskId: string, sessionId: string) => {
    endCalls.push({ taskId, sessionId });
  },
}));

// The one writer into a task's meeting record. Async like the real one, so the connector's own serialising chain is exercised rather than bypassed.
vi.mock('../../../tasks/persistence.js', () => ({
  appendMeetingRow: async (taskId: string, sessionId: string, row: MeetingRow) => {
    recordedRows.push({ taskId, sessionId, row });
  },
}));

/** This meeting's rows, in the order the connector's chain wrote them. */
function rowsFor(sessionId: string): MeetingRow[] {
  return recordedRows.filter((r) => r.sessionId === sessionId).map((r) => r.row);
}

/** …narrowed to one type, since most assertions are about one kind of row. */
function rowsOfType<T extends MeetingRow['type']>(sessionId: string, type: T): Array<Extract<MeetingRow, { type: T }>> {
  return rowsFor(sessionId).filter((r): r is Extract<MeetingRow, { type: T }> => r.type === type);
}

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
      const existing = hub.sinks.get(pageId);
      if (existing !== undefined) {
        return existing;
      }
      const sink: AudioSink & { enabled: boolean } = {
        enabled: false,
        play: () => {},
        cut: () => {},
        setEnabled(open: boolean) {
          sink.enabled = open;
        },
        setEngaged: () => {},
        isSpeaking: () => false,
        played: async () => 0,
      };
      hub.sinks.set(pageId, sink);
      return sink;
    },
    handlePageSocket(pageId: string) {
      hub.pageSockets.push(pageId);
    },
    dispose(pageId: string) {
      hub.disposed.push(pageId);
    },
  }),
  renderPage: (pageId: string, wsUrl: string) =>
    `<!doctype html><!--${pageId}|${wsUrl}-->`,
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
/** While set, a bot-details GET waits on this before answering — lets a test hold one poll tick open. */
let botDetailsHold: Promise<void> | null = null;

function fakeFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const path = String(url);
  const method = init?.method ?? 'GET';
  let held: Promise<void> | null = null;
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
    held = botDetailsHold;
  } else if (method === 'GET' && path.startsWith('https://participants.example/')) {
    reply = participantsReplies.shift() ?? { status: 200, body: '[]' };
  } else {
    reply = { status: 200, body: '{}' };
  }
  const response = {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    text: () => Promise.resolve(reply.body),
  } as Response;
  return held === null ? Promise.resolve(response) : held.then(() => response);
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

function config(over: Partial<Omit<RecallConfig, 'voice'>> = {}): RecallConfig {
  return {
    recallApiKey: RECALL_KEY,
    recallRegion: 'eu-central-1',
    publicUrl: 'https://archie.example',
    ...over,
    voice: {
      deepgramApiKey: 'deepgram-secret-key-0000',
      sonioxApiKey: 'soniox-secret-key-33333',
      cerebrasApiKey: 'cerebras-secret-key-2222',
    },
  };
}

async function mount(over: Partial<Omit<RecallConfig, 'voice'>> = {}) {
  const { mountRecallConnector } = await import('../index.js');
  const { app, router } = fakeApp();
  const lifecycle = mountRecallConnector(app as never, config(over));
  const [audioWss, pageWss] = wsHarness.servers;
  return { lifecycle, router: router(), audioWss, pageWss };
}

/**
 * The `ops` this mount handed the PM-tools factory — `join_recall_meeting`/`leave_recall_meeting` are the only callers, so this is how a test reaches them.
 * Builds a server to get at them, the way `spawn.ts` would; the factory is registered process-wide, so call this straight after `mount()`.
 */
function opsOf(): MeetingOps {
  const factory = getRegisteredConnectorPmTools().get('recall-tools');
  if (factory === undefined) throw new Error('no recall-tools factory was registered');
  factory({} as never, {} as never);
  const ops = pmToolsBuilds[pmToolsBuilds.length - 1];
  if (ops === undefined) throw new Error('the registered factory built no server');
  return ops;
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
async function withAudioSocket(over: Partial<Omit<RecallConfig, 'voice'>> = {}) {
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

// Lets a fire-and-forget `void endMeeting(...)` settle, and the recorder's own promise chain along with it: each mocked call in sequence costs one microtask tick.
// Plain Promise.resolve() draining, not a real timer — works whether or not a test also has vi.useFakeTimers() active. A real file (an unbound meeting's record) needs `waitForFile` instead.
async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

/** Waits for a real file to appear: an unbound meeting's rows go through `fs`, which no amount of microtask draining reaches. */
async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 100 && !existsSync(path); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
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
  recordedRows.length = 0;
  capabilityCalls.length = 0;
  capabilityResult = Promise.resolve('');
  pmToolsBuilds.length = 0;
  botDetailsReplies.length = 0;
  botDetailsHold = null;
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
    await made.transport.sendChat('It shipped on Tuesday.');
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
    await one.spawned.transport.sendChat('for one');
    await two.spawned.transport.sendChat('for two');
    expect(http.map((c) => c.url)).toEqual([
      'https://eu-central-1.recall.ai/api/v1/bot/bot-one/send_chat_message/',
      'https://eu-central-1.recall.ai/api/v1/bot/bot-two/send_chat_message/',
    ]);
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

describe('recall mount — shutdown', () => {
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
  it('builds a host, opens the record with a started row and notes the started event', async () => {
    botIds.push('bot-bound');
    const { router } = await mount();

    const { spawned: made } = await startMeeting(router, 'https://zoom.us/j/bound', 'task-1');
    await flushMicrotasks();

    expect(hosts).toHaveLength(1);
    expect(hosts[0].taskId).toBe('task-1');
    // createTaskHost gets the bot id too — it's what lets the wake-up prompt and the durable channel record agree on the same key.
    expect(hosts[0].sessionId).toBe('bot-bound');
    // The exact same host object createTaskHost returned, not a look-alike.
    expect(made.host).toBe(hosts[0]);
    // The record's first row, carrying the meeting URL no other row repeats.
    expect(rowsFor('bot-bound')[0]).toEqual(
      { at: expect.any(String), type: 'started', url: 'https://zoom.us/j/bound', bot_id: 'bot-bound' },
    );
    expect(recordedRows[0].taskId).toBe('task-1');
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
    // Its transport still carries a recorder — an unbound meeting records into `voice-logs/`, not into a task it does not have.
    expect(typeof made.transport.record).toBe('function');
    expect(recordedRows).toEqual([]);
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

  it('wakes it exactly once via the status poll', async () => {
    vi.useFakeTimers();
    botIds.push('bot-poll-wake');
    botDetailsReplies.push(ledger('in_call_recording', 'call_ended'));
    const mounted = await mount();
    attach(mounted.lifecycle);
    await startMeeting(mounted.router, 'https://zoom.us/j/poll-wake', 'task-poll-wake');

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushMicrotasks();

    expect(meetingEndedCalls).toEqual([{ taskId: 'task-poll-wake', sessionId: 'bot-poll-wake' }]);
  });

  it('wakes it exactly once via a spoken LEAVE:', async () => {
    botIds.push('bot-spoken-leave');
    const { router } = await mount();
    await startMeeting(router, 'https://zoom.us/j/spoken-leave', 'task-spoken-leave');

    // What the room's own `LEAVE:` reaches, once the farewell has been spoken: MeetingHost.leaveMeeting, built over this connector's endMeeting.
    hosts[0].leaveMeeting();
    await flushMicrotasks();

    expect(meetingEndedCalls).toEqual([{ taskId: 'task-spoken-leave', sessionId: 'bot-spoken-leave' }]);
    expect(spawned[0].stopped).toBe(1);
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

describe('recall mount — the record a meeting leaves', () => {
  it('opens the record the moment the bot exists, whether or not there is a task', async () => {
    botIds.push('bot-rec-start');
    const { router } = await mount();

    await startMeeting(router, 'https://zoom.us/j/rec-start', 'task-rec-start');
    await flushMicrotasks();

    expect(rowsOfType('bot-rec-start', 'started')).toEqual([
      { at: expect.any(String), type: 'started', url: 'https://zoom.us/j/rec-start', bot_id: 'bot-rec-start' },
    ]);
  });

  it('writes an unbound meeting\'s record to voice-logs instead of a task folder', async () => {
    // The manual POST entry point has no task to write into, and a manual test should still leave something to read.
    botIds.push('bot-rec-unbound');
    const { router } = await mount();

    await startMeeting(router, 'https://zoom.us/j/rec-unbound');
    await flushMicrotasks();

    expect(recordedRows).toEqual([]);
    const path = join(WORK, 'voice-logs', 'bot-rec-unbound.jsonl');
    await waitForFile(path);
    expect(existsSync(path)).toBe(true);
    const first = JSON.parse(readFileSync(path, 'utf8').split('\n')[0]) as MeetingRow;
    expect(first).toEqual({
      at: expect.any(String),
      type: 'started',
      url: 'https://zoom.us/j/rec-unbound',
      bot_id: 'bot-rec-unbound',
    });
  });

  it('records what Recall says the occasion is, the first time the poll asks', async () => {
    vi.useFakeTimers();
    botIds.push('bot-rec-details');
    botDetailsReplies.push({
      status: 200,
      body: JSON.stringify({
        meeting_url: { platform: 'zoom' },
        status_changes: [{ code: 'in_call_recording', created_at: '2026-08-29T10:00:00.000Z' }],
        recordings: [{ media_shortcuts: { meeting_metadata: { data: { title: 'Sprint planning' } } } }],
      }),
    });
    const mounted = await mount();
    attach(mounted.lifecycle);
    await startMeeting(mounted.router, 'https://zoom.us/j/rec-details', 'task-rec-details');

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushMicrotasks();

    expect(rowsOfType('bot-rec-details', 'details')).toEqual([
      { at: expect.any(String), type: 'details', platform: 'zoom', title: 'Sprint planning' },
    ]);
  });

  it('records the same pair once, however many ticks report it', async () => {
    // Recall answers every tick; a row per tick would bury the meeting's own content under its own bookkeeping.
    vi.useFakeTimers();
    botIds.push('bot-rec-details-same');
    const reply = {
      status: 200,
      body: JSON.stringify({
        meeting_url: { platform: 'zoom' },
        status_changes: [{ code: 'in_call_recording', created_at: '2026-08-29T10:00:00.000Z' }],
        recordings: [{ media_shortcuts: { meeting_metadata: { data: { title: 'Sprint planning' } } } }],
      }),
    };
    botDetailsReplies.push(reply, { ...reply });
    const mounted = await mount();
    attach(mounted.lifecycle);
    await startMeeting(mounted.router, 'https://zoom.us/j/rec-details-same', 'task-rec-details-same');

    await vi.advanceTimersByTimeAsync(2 * POLL_MS);
    await flushMicrotasks();

    expect(rowsOfType('bot-rec-details-same', 'details')).toHaveLength(1);
  });

  it('records a second details row when the title arrives later', async () => {
    // Recall produces the title asynchronously once the bot is in the call, so the first tick usually has only the platform.
    vi.useFakeTimers();
    botIds.push('bot-rec-details-late');
    botDetailsReplies.push(
      {
        status: 200,
        body: JSON.stringify({
          meeting_url: { platform: 'zoom' },
          status_changes: [{ code: 'joining_call', created_at: '2026-08-29T10:00:00.000Z' }],
        }),
      },
      {
        status: 200,
        body: JSON.stringify({
          meeting_url: { platform: 'zoom' },
          status_changes: [{ code: 'in_call_recording', created_at: '2026-08-29T10:00:30.000Z' }],
          recordings: [{ media_shortcuts: { meeting_metadata: { data: { title: 'Sprint planning' } } } }],
        }),
      },
    );
    const mounted = await mount();
    attach(mounted.lifecycle);
    await startMeeting(mounted.router, 'https://zoom.us/j/rec-details-late', 'task-rec-details-late');

    await vi.advanceTimersByTimeAsync(2 * POLL_MS);
    await flushMicrotasks();

    // The reader takes the last one; both are kept so a title that only ever half-arrives is visible as that.
    expect(rowsOfType('bot-rec-details-late', 'details')).toEqual([
      { at: expect.any(String), type: 'details', platform: 'zoom', title: null },
      { at: expect.any(String), type: 'details', platform: 'zoom', title: 'Sprint planning' },
    ]);
  });

  it("closes the record with Recall's own call_ended time when the poll is what found the ending", async () => {
    vi.useFakeTimers();
    botIds.push('bot-rec-ended');
    botDetailsReplies.push({
      status: 200,
      body: JSON.stringify({
        meeting_url: { platform: 'zoom' },
        status_changes: [
          { code: 'in_call_recording', created_at: '2026-09-02T11:40:00.000Z' },
          { code: 'call_ended', created_at: '2026-09-02T11:44:43.000Z' },
          // `done` marks Recall's own later post-processing, not when the call ended.
          { code: 'done', created_at: '2026-09-02T11:45:10.000Z' },
        ],
      }),
    });
    const mounted = await mount();
    attach(mounted.lifecycle);
    await startMeeting(mounted.router, 'https://zoom.us/j/rec-ended', 'task-rec-ended');

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushMicrotasks();

    expect(rowsOfType('bot-rec-ended', 'ended')).toEqual([
      { at: expect.any(String), type: 'ended', call_ended_at: '2026-09-02T11:44:43.000Z' },
    ]);
  });

  it('says null rather than guessing when nobody asked Recall when the call ended', async () => {
    // The DELETE route, a spoken LEAVE:, `leave_recall_meeting` and shutdown all end the meeting without a fetch — there is no time to report.
    botIds.push('bot-rec-ended-null');
    const { router } = await mount();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/rec-ended-null', 'task-rec-ended-null');

    await request(router, 'DELETE', `/meetings/${botId}`);
    await flushMicrotasks();

    expect(rowsOfType('bot-rec-ended-null', 'ended')).toEqual([
      { at: expect.any(String), type: 'ended', call_ended_at: null },
    ]);
  });

  it('closes the record last, after the conversation has stopped', async () => {
    botIds.push('bot-rec-order');
    const { router } = await mount();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/rec-order', 'task-rec-order');

    await request(router, 'DELETE', `/meetings/${botId}`);
    await flushMicrotasks();

    // A row settling in the last turn must not land behind the ending; the connector's own chain is what orders them.
    expect(rowsFor('bot-rec-order').map((r) => r.type)).toEqual(['started', 'capabilities', 'ended']);
  });

  it('records the capability block, once, with the same text handed to the model', async () => {
    // Held only in the meeting's closure, shaping every later model call — without it, wrong/empty/malformed/ignored are indistinguishable.
    botIds.push('bot-rec-caps');
    capabilityResult = Promise.resolve('- Look up numbers in the analytics warehouse');
    const { router } = await mount();

    const { spawned: made } = await startMeeting(router, 'https://zoom.us/j/rec-caps', 'task-rec-caps');
    await flushMicrotasks();

    expect(rowsOfType('bot-rec-caps', 'capabilities')).toEqual([
      { at: expect.any(String), type: 'capabilities', text: '- Look up numbers in the analytics warehouse' },
    ]);
    // What the meeting was told and what was written down cannot be allowed to drift.
    expect(rowsOfType('bot-rec-caps', 'capabilities')[0].text).toBe(made.capabilities[0]);
  });

  it('records an empty block as such rather than leaving no row — the empty case is a finding, not an absence', async () => {
    botIds.push('bot-rec-caps-empty');
    capabilityResult = Promise.resolve('   \n\t ');
    const { router } = await mount();

    await startMeeting(router, 'https://zoom.us/j/rec-caps-empty', 'task-rec-caps-empty');
    await flushMicrotasks();

    // Trimmed, because trimmed is what the model got: a whitespace-only summary reaches the prompt as no block at all.
    expect(rowsOfType('bot-rec-caps-empty', 'capabilities')).toEqual([
      { at: expect.any(String), type: 'capabilities', text: '' },
    ]);
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


describe('recall mount — join and leave rows', () => {
  it('records a join before any audio, so someone who never speaks still appears', async () => {
    botIds.push('bot-join-only');
    const { router, ws } = await withAudioSocket();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/join-only', 'task-join-only');

    ws.fire(
      'message',
      Buffer.from(participantEventFrame(botId, 'join', { id: 11, name: 'Ghost', is_host: false, platform: 'zoom', extra_data: {}, email: null })),
    );
    await flushMicrotasks();

    expect(rowsOfType(botId, 'join')).toEqual([
      {
        at: expect.any(String),
        type: 'join',
        // Recall's own opaque id rides along, so a rejoin under a fresh id reads as the separate visit it is; `platform`/`extra_data`/`email` are Recall-internal and dropped.
        participant: { id: '11', name: 'Ghost', is_host: false },
      },
    ]);
    expect(recordedRows[recordedRows.length - 1].taskId).toBe('task-join-only');
  });

  it('records a leave as its own row — presence is the pair, not a mutated entry', async () => {
    botIds.push('bot-join-leave');
    const { router, ws } = await withAudioSocket();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/join-leave', 'task-join-leave');

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 21, name: 'Ann', is_host: true })));
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 21, name: 'Ann', is_host: true })));
    await flushMicrotasks();

    expect(rowsFor(botId).filter((r) => r.type === 'join' || r.type === 'leave')).toEqual([
      { at: expect.any(String), type: 'join', participant: { id: '21', name: 'Ann', is_host: true } },
      { at: expect.any(String), type: 'leave', participant: { id: '21', name: 'Ann', is_host: true } },
    ]);
  });

  it('records a leave for somebody it never saw join, rather than dropping it', async () => {
    // An orphaned leave is all Recall sent — the departure is real and recorded; only the arrival is unknown, which the absent `join` row says.
    botIds.push('bot-orphan-leave');
    const { router, ws } = await withAudioSocket();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/orphan-leave', 'task-orphan-leave');

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 42, name: 'Mystery', is_host: null })));
    await flushMicrotasks();

    expect(rowsOfType(botId, 'join')).toEqual([]);
    expect(rowsOfType(botId, 'leave')).toEqual([
      { at: expect.any(String), type: 'leave', participant: { id: '42', name: 'Mystery', is_host: null } },
    ]);
  });

  it('keeps every visit, in the order it happened', async () => {
    botIds.push('bot-roster');
    const { router, ws } = await withAudioSocket();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/roster', 'task-roster');

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 2, name: 'Bob', is_host: false })));
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 1, name: 'Ann', is_host: true })));
    await flushMicrotasks();

    expect(rowsFor(botId).filter((r) => r.type === 'join' || r.type === 'leave').map((r) => [r.type, (r as { participant: { name: string | null } }).participant.name])).toEqual([
      ['join', 'Ann'],
      ['join', 'Bob'],
      ['leave', 'Ann'],
    ]);
  });

  it('never records Archie itself, on join or leave', async () => {
    botIds.push('bot-self-roster');
    const { router, ws } = await withAudioSocket();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/self-roster', 'task-self-roster');

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 99, name: 'Archie', is_host: false })));
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 99, name: 'Archie', is_host: false })));
    await flushMicrotasks();

    expect(rowsFor(botId).filter((r) => r.type === 'join' || r.type === 'leave')).toEqual([]);
  });

  it('matches Archie by name case- and punctuation-insensitively, the same standard the medium uses for turn attribution', async () => {
    botIds.push('bot-self-fuzzy');
    const { router, ws } = await withAudioSocket();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/self-fuzzy', 'task-self-fuzzy');

    // Neither exact-equals "Archie" — a plain === (the audio path's older check) would have missed both.
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 5, name: 'Archie!', is_host: false })));
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 6, name: '  archie ', is_host: false })));
    await flushMicrotasks();

    expect(rowsOfType(botId, 'join')).toEqual([]);
  });

  it("records into an unbound meeting's own file, not into any task", async () => {
    botIds.push('bot-unbound-roster');
    const { router, ws } = await withAudioSocket();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/unbound-roster'); // no task_id

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    await flushMicrotasks();

    expect(recordedRows).toEqual([]);
    const path = join(WORK, 'voice-logs', `${botId}.jsonl`);
    await waitForFile(path);
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('"type":"join"');
    expect(written).toContain('Ann');
  });

  it("keeps two concurrent meetings' rows from crossing wires", async () => {
    botIds.push('bot-roster-a', 'bot-roster-b');
    const { router, ws } = await withAudioSocket();
    const a = await startMeeting(router, 'https://zoom.us/j/a', 'task-roster-a');
    const b = await startMeeting(router, 'https://zoom.us/j/b', 'task-roster-b');

    ws.fire('message', Buffer.from(participantEventFrame(a.botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('message', Buffer.from(participantEventFrame(b.botId, 'join', { id: 1, name: 'Bob', is_host: true })));
    await flushMicrotasks();

    expect(rowsOfType(a.botId, 'join').map((r) => r.participant.name)).toEqual(['Ann']);
    expect(rowsOfType(b.botId, 'join').map((r) => r.participant.name)).toEqual(['Bob']);
    // Each meeting's rows reach its own task's folder, not the other's.
    expect(new Set(recordedRows.filter((r) => r.sessionId === a.botId).map((r) => r.taskId))).toEqual(
      new Set(['task-roster-a']),
    );
  });
});


describe('recall mount — the roster the conversation gets', () => {
  // meeting.ts builds its participant map from onAudio alone; Recall sends nothing for a muted participant — the record could show four, live prompt one.
  it('pushes the roster into the conversation on a join, not only into the record', async () => {
    botIds.push('bot-ctx-join');
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(router, 'https://zoom.us/j/ctx-join', 'task-ctx-join');

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 11, name: 'Muted Mary', is_host: false })));

    expect(made.rosters).toHaveLength(1);
    expect(made.rosters[0]).toHaveLength(1);
    expect(made.rosters[0][0].name).toBe('Muted Mary');
    expect(made.rosters[0][0].left_at).toBeNull();
    // Built from the same event as the `join` row, so the roster the model sees and the record a reader rebuilds cannot disagree about who arrived.
    await flushMicrotasks();
    expect(rowsOfType(botId, 'join').map((r) => r.participant.name)).toEqual(['Muted Mary']);
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

  it('pushes it for an UNBOUND meeting too — no task to reach, but still a room to talk to', async () => {
    botIds.push('bot-ctx-unbound');
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(router, 'https://zoom.us/j/ctx-unbound'); // no task_id

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));

    expect(recordedRows).toEqual([]);
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
    // The record still got its row, so one failure did not cost the other.
    await flushMicrotasks();
    expect(rowsOfType(botId, 'join')).toHaveLength(1);
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

  it('does NOT hold the join behind the capability model call', async () => {
    // A model call in front of a join would put the room's first impression behind a provider's latency, and a hung one would stop the join.
    botIds.push('bot-caps-slow');
    let release: (summary: string) => void = () => {};
    capabilityResult = new Promise<string>((resolve) => {
      release = resolve;
    });
    const { router } = await mount();

    const { reply, spawned: made } = await startMeeting(router, 'https://zoom.us/j/caps-slow', 'task-caps-slow');

    // Nothing recorded either — the row rides inside the same pending `.then()` as the handoff, not a separate earlier step.
    expect(reply.code).toBe(201);
    expect(made.capabilities).toEqual([]);
    expect(rowsOfType('bot-caps-slow', 'capabilities')).toEqual([]);

    release('- Read the code in the team repositories');
    await flushMicrotasks();
    expect(made.capabilities).toEqual(['- Read the code in the team repositories']);
    expect(rowsOfType('bot-caps-slow', 'capabilities')).toEqual([
      { at: expect.any(String), type: 'capabilities', text: '- Read the code in the team repositories' },
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
    expect(rowsOfType('bot-caps-empty', 'capabilities')).toEqual([
      { at: expect.any(String), type: 'capabilities', text: '' },
    ]);
  });

  it('stays quiet about a failed handoff when the handoff worked', async () => {
    // A summary that lands must draw no capability warning at all — that wording belongs to a meeting running without a block.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    botIds.push('bot-caps-ok');
    capabilityResult = Promise.resolve('- Look up numbers in the analytics warehouse');
    const { router } = await mount();

    const { spawned: made } = await startMeeting(router, 'https://zoom.us/j/caps-ok', 'task-caps-ok');
    await flushMicrotasks();
    await new Promise((resolve) => setImmediate(resolve));

    expect(made.capabilities).toEqual(['- Look up numbers in the analytics warehouse']);
    expect(rowsOfType('bot-caps-ok', 'capabilities')).toEqual([
      { at: expect.any(String), type: 'capabilities', text: '- Look up numbers in the analytics warehouse' },
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
    // Nothing to record either — an unbound meeting has no task to summarise, so the call and the row sit inside the same binding branch.
    expect(rowsOfType(made.transport.sessionId, 'capabilities')).toEqual([]);
  });
});

// Literal, not imported from connector.ts's STATUS_POLL_MS — importing would pass for any value, zero included, which is the bug this block exists to catch. This number is the contract.
const POLL_MS = 30 * 1000;

// Bare codes (call_ended), not bot.-prefixed webhook names — the shape `pollBotStatuses` reads.
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

// The poll and the teardown fetch share this URL, so counting *polls* needs an unbound meeting or a pre-teardown baseline — each test below says which.
function botDetailGets(botId: string): HttpCall[] {
  return http.filter((c) => c.url.endsWith(`/api/v1/bot/${botId}/`));
}

/** Every `leave_call` sent for this bot — one per teardown, so a second means two teardowns. */
function leaveCalls(botId: string): HttpCall[] {
  return http.filter((c) => c.url.endsWith(`/bot/${botId}/leave_call/`));
}

describe('recall mount — Recall ends the meeting, the poll finds out', () => {
  // Nothing here infers an ending: Recall pulls the bot out itself once the room has been empty for `everyone_left_timeout` (recall.ts), and this poll only reads the ledger that says so.
  // Wrong permissively is how Archie vanishes from a live room; wrong the other way costs one poll interval.

  it('ends the meeting once Recall reports it out of the call, and only once', async () => {
    vi.useFakeTimers();
    botIds.push('bot-poll-ended');
    // Answers the poll; teardown's own fetch falls through to the default reply.
    botDetailsReplies.push(ledger('joining_call', 'in_call_recording', 'call_ended'));
    const mounted = await mount();
    attach(mounted.lifecycle);
    const { botId, spawned: made } = await startMeeting(
      mounted.router,
      'https://zoom.us/j/poll-ended',
      'task-poll-ended',
    );

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushMicrotasks();

    expect(made.stopped).toBe(1);
    expect(meetingEndedCalls).toEqual([{ taskId: 'task-poll-ended', sessionId: botId }]);
    expect(leaveCalls(botId)).toHaveLength(1);

    // Later ticks find nothing to end: `endMeeting` deletes from `live` before its first await, so no route can end a meeting twice.
    await vi.advanceTimersByTimeAsync(3 * POLL_MS);
    await flushMicrotasks();
    expect(made.stopped).toBe(1);
    expect(meetingEndedCalls).toHaveLength(1);
    expect(leaveCalls(botId)).toHaveLength(1);
  });

  // Recall: call_ended="left call", done="shut down" (after leaving), fatal="error causing shutdown" — Archie's out in all three; returns only via another join_recall_meeting.
  // Closed over "certainly out", not open over "certainly in" — Recall may add codes without notice, so a new code (last row) must default to NOT ending the meeting.
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
    const mounted = await mount();
    attach(mounted.lifecycle);
    const { spawned: made } = await startMeeting(mounted.router, `https://zoom.us/j/status-${code}`);

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushMicrotasks();

    expect(made.stopped).toBe(endsIt ? 1 : 0);
  });

  it('reads a terminal status anywhere in the ledger, not only as its last entry', async () => {
    // Post-processing/breakout entries can land after the bot's gone; a bot never rejoins (Recall issues a new one) — a terminal code can't be followed by a return.
    vi.useFakeTimers();
    botIds.push('bot-trailing-ledger');
    botDetailsReplies.push(ledger('in_call_recording', 'call_ended', 'done'));
    const mounted = await mount();
    attach(mounted.lifecycle);
    const { spawned: made } = await startMeeting(mounted.router, 'https://zoom.us/j/trailing-ledger');

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushMicrotasks();

    expect(made.stopped).toBe(1);
  });

  it('does not end the meeting on a ledger with nothing in it at all', async () => {
    vi.useFakeTimers();
    botIds.push('bot-empty-ledger');
    botDetailsReplies.push(ledger());
    const mounted = await mount();
    attach(mounted.lifecycle);
    const { spawned: made } = await startMeeting(mounted.router, 'https://zoom.us/j/empty-ledger');

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushMicrotasks();

    // Nothing known isn't the same as nothing happening — only one of those readings can end a live meeting by mistake.
    expect(made.stopped).toBe(0);
  });

  it('leaves a meeting Recall still has in the call alone, and it carries on afterwards', async () => {
    vi.useFakeTimers();
    botIds.push('bot-poll-live');
    botDetailsReplies.push(ledger('joining_call', 'in_call_recording'));
    const { router, ws, lifecycle } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(
      router,
      'https://zoom.us/j/poll-live',
      'task-poll-live',
    );

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushMicrotasks();

    expect(made.stopped).toBe(0);
    // The worst consequence avoided: no premature "room dispersed" wake-up while Ann is still in it.
    expect(meetingEndedCalls).toEqual([]);

    // Genuinely intact, not merely un-torn-down — audio still reaches the conversation.
    ws.fire('message', Buffer.from(audioFrame(botId, { id: 1, name: 'Ann' })));
    expect(made.audio).toHaveLength(1);
    await lifecycle.stop();
  });

  it('leaves the meeting live and says so loudly when the poll itself fails', async () => {
    vi.useFakeTimers();
    const warns = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    botIds.push('bot-poll-fails');
    botDetailsReplies.push({ status: 500, body: '{"detail":"upstream exploded"}' });
    const mounted = await mount();
    attach(mounted.lifecycle);
    const { botId, spawned: made } = await startMeeting(
      mounted.router,
      'https://zoom.us/j/poll-fails',
      'task-poll-fails',
    );

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushMicrotasks();

    // A network error must never be read as an ending.
    expect(made.stopped).toBe(0);
    expect(meetingEndedCalls).toEqual([]);
    expect(
      warns.mock.calls.some(
        ([prefix, message]) => prefix === 'voice' && String(message).includes(botId),
      ),
    ).toBe(true);

    // And the next tick asks again — one failed answer doesn't retire the poll.
    botDetailsReplies.push(ledger('call_ended'));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushMicrotasks();
    expect(made.stopped).toBe(1);
    expect(meetingEndedCalls).toEqual([{ taskId: 'task-poll-fails', sessionId: botId }]);
  });

  it('polls every live meeting, ending only the one Recall reports out', async () => {
    vi.useFakeTimers();
    botIds.push('bot-poll-a', 'bot-poll-b');
    // Queued in the order the tick walks `live`: the first meeting started is asked about first.
    botDetailsReplies.push(ledger('in_call_recording'), ledger('call_ended'));
    const mounted = await mount();
    attach(mounted.lifecycle);
    const a = await startMeeting(mounted.router, 'https://zoom.us/j/poll-a', 'task-poll-a');
    const b = await startMeeting(mounted.router, 'https://zoom.us/j/poll-b', 'task-poll-b');

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushMicrotasks();

    // Both asked about — the tick doesn't stop at the first meeting, either to end it or to leave it.
    expect(botDetailGets('bot-poll-a')).toHaveLength(1);
    expect(botDetailGets('bot-poll-b').length).toBeGreaterThanOrEqual(1);
    expect(a.spawned.stopped).toBe(0);
    expect(b.spawned.stopped).toBe(1);
    expect(meetingEndedCalls).toEqual([{ taskId: 'task-poll-b', sessionId: 'bot-poll-b' }]);
  });

  it('does nothing on a tick that finds the previous one still in flight', async () => {
    vi.useFakeTimers();
    botIds.push('bot-poll-slow');
    let release!: () => void;
    botDetailsHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    botDetailsReplies.push(ledger('in_call_recording'), ledger('in_call_recording'));
    const mounted = await mount();
    attach(mounted.lifecycle);
    // Unbound on purpose: no task means no teardown metadata fetch, so every bot-details GET here is a poll — "asked once" is a count, not an inference.
    const { botId } = await startMeeting(mounted.router, 'https://zoom.us/j/poll-slow');

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushMicrotasks();
    expect(botDetailGets(botId)).toHaveLength(1);

    // Three more ticks come due while that answer is still outstanding; not one of them asks again.
    await vi.advanceTimersByTimeAsync(3 * POLL_MS);
    await flushMicrotasks();
    expect(botDetailGets(botId)).toHaveLength(1);

    botDetailsHold = null;
    release();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushMicrotasks();
    expect(botDetailGets(botId)).toHaveLength(2);
  });

  it('does not end the meeting when the last human leaves — that call is Recall\'s', async () => {
    // Zoom issues a new participant id on rejoin, so `leave(id1)` then `join(id2)` is indistinguishable from an empty room here. Recall's own `everyone_left_timeout` is what waits that out.
    vi.useFakeTimers();
    botIds.push('bot-last-leaves');
    botDetailsReplies.push(ledger('in_call_recording'), ledger('in_call_recording'));
    const { router, ws } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(
      router,
      'https://zoom.us/j/last-leaves',
      'task-last-leaves',
    );

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('message', Buffer.from(participantEventFrame(botId, 'leave', { id: 1, name: 'Ann', is_host: true })));
    await flushMicrotasks();

    // Nothing armed by that leave — the poll is the only timer this connector owns.
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(2 * POLL_MS);
    await flushMicrotasks();

    expect(made.stopped).toBe(0);
    expect(meetingEndedCalls).toEqual([]);
    // The departure is still recorded, which is all a leave event is for now.
    expect(rowsOfType(botId, 'leave')).toHaveLength(1);
  });

  it('does not end the meeting when the audio socket closes — a blip and an ending look identical there', async () => {
    vi.useFakeTimers();
    botIds.push('bot-socket-close');
    botDetailsReplies.push(ledger('in_call_recording'));
    const { router, ws, onUpgrade, lifecycle } = await withAudioSocket();
    const { botId, spawned: made } = await startMeeting(
      router,
      'https://zoom.us/j/socket-close',
      'task-socket-close',
    );

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    ws.fire('close');
    await flushMicrotasks();
    // Nothing armed, nothing asked on the spot — and the poll's own answer keeps it live.
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushMicrotasks();
    expect(made.stopped).toBe(0);

    // Audio flows again on the socket that replaced it.
    onUpgrade({ url: '/api/voice/audio' }, { destroy: vi.fn() }, Buffer.alloc(0));
    lastSocket().fire('message', Buffer.from(audioFrame(botId, { id: 1, name: 'Ann' })));
    expect(made.audio).toHaveLength(1);
    await lifecycle.stop();
  });

  it('stops polling once the connector is stopped', async () => {
    vi.useFakeTimers();
    botIds.push('bot-poll-stop');
    const { router, lifecycle } = await mount();
    attach(lifecycle);
    const meeting = await startMeeting(router);

    // The poll is the only timer this connector owns, so the count shows it running directly — a surviving interval leaves no trace otherwise.
    expect(vi.getTimerCount()).toBe(1);

    await lifecycle.stop();

    expect(meeting.spawned.stopped).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still records Recall's own end time on this path, not the moment the poll noticed", async () => {
    vi.useFakeTimers();
    botIds.push('bot-poll-end-time');
    botDetailsReplies.push({
      status: 200,
      body: JSON.stringify({
        meeting_url: { platform: 'zoom' },
        status_changes: [
          { code: 'in_call_recording', created_at: '2026-09-02T11:40:00.000Z' },
          { code: 'call_ended', created_at: '2026-09-02T11:44:43.000Z' },
        ],
      }),
    });
    const mounted = await mount();
    attach(mounted.lifecycle);
    await startMeeting(mounted.router, 'https://zoom.us/j/poll-end-time', 'task-poll-end-time');

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushMicrotasks();

    // The one read the poll already made carries the ending forward — no second fetch at teardown, so nothing can disagree with it.
    expect(botDetailGets('bot-poll-end-time')).toHaveLength(1);
    expect(rowsOfType('bot-poll-end-time', 'ended')).toEqual([
      { at: expect.any(String), type: 'ended', call_ended_at: '2026-09-02T11:44:43.000Z' },
    ]);
    expect(rowsOfType('bot-poll-end-time', 'details')).toEqual([
      { at: expect.any(String), type: 'details', platform: 'zoom', title: null },
    ]);
  });

  it('leaves the join and leave rows alone at teardown, inventing no departure nobody witnessed', async () => {
    vi.useFakeTimers();
    botIds.push('bot-poll-roster');
    botDetailsReplies.push(ledger('call_ended'));
    const { router, ws } = await withAudioSocket();
    const { botId } = await startMeeting(router, 'https://zoom.us/j/poll-roster', 'task-poll-roster');

    ws.fire('message', Buffer.from(participantEventFrame(botId, 'join', { id: 1, name: 'Ann', is_host: true })));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushMicrotasks();

    // Recall pulled the bot out, which says nothing about when Ann left — so no `leave` row is written on her behalf.
    expect(rowsOfType(botId, 'join')).toHaveLength(1);
    expect(rowsOfType(botId, 'leave')).toEqual([]);
    expect(rowsOfType(botId, 'ended')).toHaveLength(1);
  });
});

describe('recall mount — what join_recall_meeting reaches', () => {
  it('starts a real, task-bound meeting', async () => {
    botIds.push('bot-starter');
    await mount();

    const result = await opsOf().start('task-starter', 'https://zoom.us/j/starter');

    expect(result).toEqual({ ok: true, botId: 'bot-starter' });
    expect(hosts.some((h) => h.taskId === 'task-starter')).toBe(true);
    expect(registry.has('task-starter')).toBe(true);
    expect(spawned).toHaveLength(1);
  });

  it('refuses a second join on a task that already has one live', async () => {
    botIds.push('bot-starter-1', 'bot-starter-2');
    await mount();
    const ops = opsOf();

    const first = await ops.start('task-dup', 'https://zoom.us/j/1');
    const second = await ops.start('task-dup', 'https://zoom.us/j/2');

    expect(first).toEqual({ ok: true, botId: 'bot-starter-1' });
    expect(second.ok).toBe(false);
    expect((second as { ok: false; reason: string }).reason).toMatch(/already live/i);
    // The refused attempt never reached the conversation at all.
    expect(hosts.filter((h) => h.taskId === 'task-dup')).toHaveLength(1);
    expect(spawned).toHaveLength(1);
  });

  it('reserves the task slot before creating a bot, so two overlapping joins cannot both succeed', async () => {
    // Unlike the sequential case above, these race — the shape a retried tool call, or a double join_recall_meeting emission, produces.
    // An async function runs synchronously to its first await, so calling start twice back to back beats the second's check to the reservation — no fake timers.
    botIds.push('bot-race-1', 'bot-race-2');
    await mount();
    const ops = opsOf();

    const [first, second] = await Promise.all([
      ops.start('task-race', 'https://zoom.us/j/race-1'),
      ops.start('task-race', 'https://zoom.us/j/race-2'),
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
    const ops = opsOf();

    const failed = await ops.start('task-retry', 'https://zoom.us/j/1');
    expect(failed.ok).toBe(false);

    botIds.push('bot-retry-ok');
    const retried = await ops.start('task-retry', 'https://zoom.us/j/2');

    expect(retried).toEqual({ ok: true, botId: 'bot-retry-ok' });
  });
});

describe('recall mount — what leave_recall_meeting reaches', () => {
  it("ends the meeting live on the task it names, by that meeting's own bot id", async () => {
    botIds.push('bot-leave');
    await mount();
    const ops = opsOf();
    expect(await ops.start('task-leave', 'https://zoom.us/j/leave')).toEqual({ ok: true, botId: 'bot-leave' });

    expect(await ops.stop('task-leave')).toEqual({ ok: true });

    // The same endMeeting funnel the DELETE route and the status poll use ("ends the meeting the path names" above, for DELETE).
    expect(spawned.find((m) => m.transport.sessionId === 'bot-leave')?.stopped).toBe(1);
    expect(registry.has('task-leave')).toBe(false);
    expect(http.map((c) => c.url)).toContain('https://eu-central-1.recall.ai/api/v1/bot/bot-leave/leave_call/');
  });

  it('leaves a meeting live on another task alone', async () => {
    botIds.push('bot-leave-keep', 'bot-leave-drop');
    await mount();
    const ops = opsOf();
    await ops.start('task-leave-keep', 'https://zoom.us/j/keep');
    await ops.start('task-leave-drop', 'https://zoom.us/j/drop');

    await ops.stop('task-leave-drop');

    expect(spawned.find((m) => m.transport.sessionId === 'bot-leave-drop')?.stopped).toBe(1);
    expect(spawned.find((m) => m.transport.sessionId === 'bot-leave-keep')?.stopped).toBe(0);
    expect(registry.has('task-leave-drop')).toBe(false);
    expect(registry.has('task-leave-keep')).toBe(true);
  });

  it('fails plainly, never a silent no-op, when no meeting is live on the task', async () => {
    await mount();

    expect(await opsOf().stop('task-nothing-live')).toEqual({
      ok: false,
      reason: 'No meeting is live on this task.',
    });
    expect(http).toEqual([]);
  });
});

describe('recall mount — the two seams a connector plugs into', () => {
  // Registered once, at mount, into registries task.ts/spawn.ts read generically, never naming Recall — makes "no mount, no tool" true.
  // See src/agents/__tests__/connector-tools.test.ts for the absent-until-registered half — earlier tests here already mounted the connector, same worker.
  it('registers the real recall channel deliverer under the "recall" kind', async () => {
    await mount();
    expect(getChannelDeliverer('recall')).toBe(deliverToRecallChannel);
  });

  it('registers the real recall channel renderer under the "recall" kind, in the same call as the deliverer', async () => {
    await mount();
    expect(getChannelRenderer('recall')).toBe(renderRecallChannel);
  });

  it('registers a PM-tools factory under "recall-tools", built over this mount\'s own start and stop', async () => {
    botIds.push('bot-tools-wired');
    await mount();

    // Identity is no longer the assertion: the factory is a closure over `ops`, so what matters is that the tools it builds reach this connector.
    const ops = opsOf();
    expect(await ops.start('task-tools-wired', 'https://zoom.us/j/tools-wired')).toEqual({
      ok: true,
      botId: 'bot-tools-wired',
    });
    expect(await ops.stop('task-tools-wired')).toEqual({ ok: true });
    expect(spawned.find((m) => m.transport.sessionId === 'bot-tools-wired')?.stopped).toBe(1);
  });
});
