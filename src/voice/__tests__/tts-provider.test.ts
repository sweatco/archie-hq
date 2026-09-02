// Split is at the wire only. Hold-back, CHAT:, Decision, bias-to-silence: shared code from live failures, re-exercised per synthesizer, not assumed.
// Audio is Buffers of counted bytes, never a device — ws is stubbed; nothing here opens a socket, reaches a vendor, or makes a sound.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/prompt-loader.js', () => ({
  loadPrompt: async () => 'SYSTEM PROMPT',
}));

type Frame = Record<string, unknown>;

// The class must live inside the `vi.mock` factory (hoisted above every declaration); this interface is what tests hold instead.
interface DrivenSocket {
  readonly url: string;
  /** Frames sent, parsed — an unparseable frame throws on send, which is the point. */
  readonly sent: Frame[];
  closedByUs: boolean;
  handshake(): void;
  /** One server frame, delivered as a Buffer exactly as `ws` does. */
  say(msg: Frame): void;
  audio(streamId: string, bytes: number, audioEnd?: boolean): void;
  /** The server hangs up, e.g. the ~182s idle close. */
  serverClose(): void;
  readonly textFrames: Frame[];
  readonly startFrames: Frame[];
}

// Referenced safely inside the hoisted `vi.mock` factory — only the constructor touches it, long after this initialiser runs.
const sockets: DrivenSocket[] = [];

vi.mock('ws', () => {
  type Handler = (...args: unknown[]) => void;

  class FakeSocket {
    static readonly OPEN = 1;
    static readonly CONNECTING = 0;
    static readonly CLOSED = 3;

    readyState = 0;
    readonly url: string;
    readonly sent: Frame[] = [];
    closedByUs = false;
    private readonly handlers = new Map<string, Handler[]>();

    constructor(url: string) {
      this.url = url;
      sockets.push(this as unknown as DrivenSocket);
    }

    on(event: string, fn: Handler): this {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
      return this;
    }

    once(event: string, fn: Handler): this {
      return this.on(event, fn);
    }

    send(raw: string): void {
      this.sent.push(JSON.parse(raw) as Frame);
    }

    close(): void {
      this.closedByUs = true;
      this.readyState = FakeSocket.CLOSED;
    }

    terminate(): void {}
    ping(): void {}

    private fire(event: string, ...args: unknown[]): void {
      for (const fn of this.handlers.get(event) ?? []) fn(...args);
    }

    handshake(): void {
      this.readyState = FakeSocket.OPEN;
      this.fire('open');
    }

    say(msg: Frame): void {
      this.fire('message', Buffer.from(JSON.stringify(msg)));
    }

    audio(streamId: string, bytes: number, audioEnd = false): void {
      const frame: Frame = {
        stream_id: streamId,
        audio: Buffer.alloc(bytes, 7).toString('base64'),
      };
      if (audioEnd) frame.audio_end = true;
      this.say(frame);
    }

    serverClose(): void {
      this.readyState = FakeSocket.CLOSED;
      this.fire('close', 1001, Buffer.from('Timeout'));
    }

    get textFrames(): Frame[] {
      return this.sent.filter((f) => f.text !== undefined);
    }

    get startFrames(): Frame[] {
      return this.sent.filter((f) => f.model !== undefined);
    }
  }

  return { default: FakeSocket, WebSocket: FakeSocket };
});

import { logger } from '../../system/logger.js';
import { decideResponse } from '../comprehension.js';
import { createSpeechSession, ttsProviderName } from '../speech.js';
import type { SpeechStream, VoiceConfig } from '../types.js';

const base: VoiceConfig = {
  deepgramApiKey: 'dg-key',
  anthropicApiKey: 'anthropic-key',
  botName: 'Archie',
};

const onDeepgram: VoiceConfig = base;
const onSoniox: VoiceConfig = {
  ...base,
  ttsProvider: 'soniox',
  sonioxApiKey: 'sx-test-key-long-enough',
};
const sonioxWithoutKey: VoiceConfig = { ...base, ttsProvider: 'soniox' };

function latest(): DrivenSocket {
  const socket = sockets[sockets.length - 1];
  expect(socket).toBeDefined();
  return socket;
}

function speakOn(cfg: VoiceConfig, sentences: string[]) {
  const played: Buffer[] = [];
  const session = createSpeechSession(cfg);
  const stream = session.speak((pcm) => played.push(pcm));
  latest().handshake();
  for (const sentence of sentences) stream.say(sentence);
  return { session, stream, socket: latest(), played };
}

function languages(socket: DrivenSocket): string[] {
  return socket.startFrames.map((f) => String(f.language));
}

beforeEach(() => {
  sockets.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  sockets.length = 0;
});

describe('choosing the synthesizer', () => {
  it('stays on Deepgram when the config says nothing, dialling the Aura URL', () => {
    // Exact match: a config with no opinion must reach the same endpoint it did before the knob existed.
    expect(ttsProviderName(onDeepgram)).toBe('deepgram');
    const session = createSpeechSession(onDeepgram);
    expect(latest().url).toBe(
      'wss://api.deepgram.com/v1/speak?model=aura-2-orion-en&encoding=linear16&sample_rate=24000&mip_opt_out=true',
    );
    session.close();
  });

  it('dials Soniox when the config selects it, with the approved model and voice', () => {
    expect(ttsProviderName(onSoniox)).toBe('soniox');
    const { socket, session } = speakOn(onSoniox, ['Done.']);
    expect(socket.url).toBe('wss://tts-rt.soniox.com/tts-websocket');
    // A native speaker approved this pairing, including a Russian sentence carrying English technical terms.
    expect(socket.startFrames[0].model).toBe('tts-rt-v2');
    expect(socket.startFrames[0].voice).toBe('Adrian');
    // Nothing negotiates the format — pinning it guards against a container arriving instead of raw PCM16.
    expect(socket.startFrames[0].audio_format).toBe('pcm_s16le');
    expect(socket.startFrames[0].sample_rate).toBe(24000);
    expect(socket.startFrames[0].api_key).toBe('sx-test-key-long-enough');
    session.close();
  });

  it('falls back to Deepgram when Soniox is named without a key, and says so', () => {
    // A bot on the old voice beats going silent for the rest of the meeting.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(ttsProviderName(sonioxWithoutKey)).toBe('deepgram');
    const session = createSpeechSession(sonioxWithoutKey);
    expect(latest().url).toContain('api.deepgram.com');
    expect(
      warn.mock.calls.some((call) => String(call[1]).includes('SONIOX_API_KEY is not set')),
    ).toBe(true);
    session.close();
  });

  it('treats a whitespace-only key as no key at all', () => {
    // `SONIOX_API_KEY=` in .env arrives empty; a stray space is the same mistake — neither authenticates at Soniox.
    expect(ttsProviderName({ ...base, ttsProvider: 'soniox', sonioxApiKey: '   ' })).toBe(
      'deepgram',
    );
  });

  it('warns and defaults on a name that is not a synthesizer at all', () => {
    // A connector hands down a whole VoiceConfig from its caller, so the guard must sit at the decision, not just the env parse.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const typo = { ...base, ttsProvider: 'soniix' } as unknown as VoiceConfig;
    expect(ttsProviderName(typo)).toBe('deepgram');
    expect(
      warn.mock.calls.some((call) => String(call[1]).includes('not a known voice synthesizer')),
    ).toBe(true);
  });

  it('never opens a Soniox socket on the Deepgram path', () => {
    // "Untouched" includes not paying for a Soniox connection it doesn't use.
    const session = createSpeechSession(onDeepgram);
    const stream = session.speak(() => undefined);
    stream.say('The deploy finished at noon.');
    stream.abort();
    session.close();
    expect(sockets.every((s) => s.url.includes('deepgram.com'))).toBe(true);
  });
});

describe('the language Soniox is told to speak', () => {
  it('asks for Russian when the reply is Russian', () => {
    const { socket, session } = speakOn(onSoniox, ['Я откатил миграцию.']);
    expect(languages(socket)).toEqual(['ru']);
    session.close();
  });

  it('asks for English when the reply is English', () => {
    const { socket, session } = speakOn(onSoniox, ['The deploy finished at noon.']);
    expect(languages(socket)).toEqual(['en']);
    session.close();
  });

  it('asks for Russian for Russian carrying English technical terms', () => {
    // Sent as `en`, a native speaker judged this non-native (English L1, accent 3/5) — the failure that got the prior synthesizer rejected; as `ru`, native.
    const { socket, session } = speakOn(onSoniox, [
      'Проблема в rate limiter на API gateway, он отдавал 429.',
    ]);
    expect(languages(socket)).toEqual(['ru']);
    session.close();
  });

  it('does not choose by character count, which picks the wrong language', () => {
    // Counts are spelled out inline, not just asserted, so anyone "simplifying" this to a majority vote sees the arithmetic they'd be trusting.
    const sentence = 'Проблема в rate limiter.';
    const latin = (sentence.match(/[A-Za-z]/g) ?? []).length;
    const cyrillic = (sentence.match(/\p{Script=Cyrillic}/gu) ?? []).length;
    expect(latin).toBeGreaterThan(cyrillic);

    const { socket, session } = speakOn(onSoniox, [sentence]);
    expect(languages(socket)).toEqual(['ru']);
    session.close();
  });

  it('keeps a whole answer in Russian once any sentence is Russian', () => {
    // Language belongs to the whole reply, committed before the reply is whole — monotone is the safe direction, since an all-Latin sentence inside Russian is a technical term.
    const { socket, session } = speakOn(onSoniox, [
      'Проблема в rate limiter.',
      'Rate limiter.',
      'Он отдавал 429.',
    ]);
    // Serialised, so only the first is on the wire until it terminates.
    socket.say({ stream_id: 's1', terminated: true });
    socket.say({ stream_id: 's2', terminated: true });
    expect(languages(socket)).toEqual(['ru', 'ru', 'ru']);
    session.close();
  });

  it('sends a language on every stream, and never a BCP 47 tag', () => {
    // ISO 639-1 only: omitted, null, "" all get "Missing language"; `en-US`/`ru-RU` are rejected as invalid — either mistake costs every utterance.
    const { socket, session } = speakOn(onSoniox, ['Done.', 'Готово.']);
    socket.say({ stream_id: 's1', terminated: true });
    for (const frame of socket.startFrames) {
      expect(frame.language).toMatch(/^(en|ru)$/);
    }
    expect(socket.startFrames.length).toBe(2);
    session.close();
  });
});

describe('the Soniox text frame', () => {
  it('always ends the text, on every stream', () => {
    // Below ~150 chars Soniox emits nothing until end-of-input; median reply is ~58 chars — without text_end the bot is mute. A stream left open is killed after ~5s (request_timeout).
    const { socket, session } = speakOn(onSoniox, ['Yes.', 'The migration ran after it.']);
    socket.say({ stream_id: 's1', terminated: true });
    expect(socket.textFrames.length).toBe(2);
    for (const frame of socket.textFrames) {
      expect(frame.text_end).toBe(true);
    }
    session.close();
  });

});

describe('the Soniox socket', () => {
  it('does not connect until there is an answer to speak', () => {
    // Streamless connections close at ~10.4s regardless of keepalives (measured); `speak()` runs the handshake before the model call, so a meeting-start socket wouldn't die before the first question.
    const session = createSpeechSession(onSoniox);
    expect(sockets.length).toBe(0);
    session.speak(() => undefined);
    expect(sockets.length).toBe(1);
    session.close();
  });

  it('delivers audio for the stream on the wire', async () => {
    const { socket, stream, played, session } = speakOn(onSoniox, ['Done.']);
    socket.audio('s1', 480);
    socket.audio('s1', 240, true);
    socket.say({ stream_id: 's1', terminated: true });

    const result = await stream.end();
    expect(played.map((b) => b.length)).toEqual([480, 240]);
    expect(result.bytes).toBe(720);
    expect(result.incomplete).toBeNull();
    session.close();
  });

  it('speaks the sentences one at a time, in order', async () => {
    // Concurrent streams would interleave chunks on the way back — the sink is a byte stream, not a mixer, so the answer comes out as noise.
    const { socket, stream, played, session } = speakOn(onSoniox, ['One.', 'Two.']);
    expect(socket.startFrames.length).toBe(1);

    socket.audio('s1', 100);
    socket.say({ stream_id: 's1', terminated: true });
    expect(socket.startFrames.length).toBe(2);

    socket.audio('s2', 200);
    socket.say({ stream_id: 's2', terminated: true });

    const result = await stream.end();
    expect(played.map((b) => b.length)).toEqual([100, 200]);
    expect(result.bytes).toBe(300);
    session.close();
  });

  it('discards a chunk that arrives after a cancel', async () => {
    // Cancel is a true discard, but at most one chunk still arrives (measured 29-51ms after) — already in flight when the server saw the cancel.
    const { socket, stream, played, session } = speakOn(onSoniox, ['Done.']);
    socket.audio('s1', 100);
    expect(played.length).toBe(1);

    stream.abort();
    expect(socket.sent.some((f) => f.cancel === true && f.stream_id === 's1')).toBe(true);

    socket.audio('s1', 100);
    expect(played.length).toBe(1);

    const result = await stream.end();
    expect(result.bytes).toBe(100);
    session.close();
  });

  it('never lets a cancelled stream leak into the next answer', async () => {
    // Barge-in stays safe without replacing the socket (unlike Aura, where a stale flush confirmation would truncate the next answer): audio is bound to `stream_id`, so a straggler can't reach it.
    const played: Buffer[] = [];
    const session = createSpeechSession(onSoniox);
    const first = session.speak(() => played.push(Buffer.alloc(1)));
    latest().handshake();
    first.say('Interrupted.');
    const socket = latest();
    first.abort();

    const second: Buffer[] = [];
    const next = session.speak((pcm) => second.push(pcm));
    next.say('The room asked again.');

    socket.audio('s1', 999);
    expect(second).toEqual([]);

    socket.audio('s2', 64);
    expect(second.map((b) => b.length)).toEqual([64]);

    socket.say({ stream_id: 's2', terminated: true });
    const result = await next.end();
    expect(result.bytes).toBe(64);
    session.close();
  });

  it('reports a refused stream as incomplete rather than as silence', async () => {
    // A real constraint: 3 concurrent TTS streams per org. Must arrive through `incomplete` — `settleAnswer` already knows how to settle a truncated debt.
    const { socket, stream, session } = speakOn(onSoniox, ['Done.']);
    socket.say({
      stream_id: 's1',
      error_code: 429,
      error_type: 'limit_exceeded',
      error_message: 'Concurrent requests limit for text-to-speech has been exceeded.',
    });

    const result = await stream.end();
    expect(result.incomplete).toContain('429');
    expect(result.bytes).toBe(0);
    session.close();
  });

  it('reports a socket lost mid-answer as incomplete', async () => {
    const { socket, stream, session } = speakOn(onSoniox, ['Done.']);
    socket.audio('s1', 100);
    socket.serverClose();

    const result = await stream.end();
    expect(result.incomplete).toContain('socket lost');
    expect(result.bytes).toBe(100);
    session.close();
  });

  it('survives the idle close between two questions without failing an answer', async () => {
    // The ~182s idle close lands in the quiet between questions far more often than during one — failing there breaks a quiet meeting, so the next sentence just reconnects.
    const session = createSpeechSession(onSoniox);
    const stream = session.speak(() => undefined);
    const first = latest();
    first.handshake();
    first.serverClose();

    stream.say('Still here.');
    const second = latest();
    expect(second).not.toBe(first);
    second.handshake();
    expect(second.startFrames.length).toBe(1);
    expect(second.textFrames.length).toBe(1);

    second.audio('s1', 32);
    second.say({ stream_id: 's1', terminated: true });
    const result = await stream.end();
    expect(result.incomplete).toBeNull();
    expect(result.bytes).toBe(32);
    session.close();
  });

  it('keeps the socket alive between sentences', () => {
    vi.useFakeTimers();
    const { socket, session } = speakOn(onSoniox, ['Done.']);
    vi.advanceTimersByTime(16_000);
    // Measured: after one stream runs, keepalives take an idle socket from 42s to 182s of headroom between sentences.
    expect(socket.sent.some((f) => f.keep_alive === true)).toBe(true);
    session.close();
  });

});


const encoder = new TextEncoder();

function anthropicDelta(text: string): string {
  const event = { type: 'content_block_delta', delta: { type: 'text_delta', text } };
  return `data: ${JSON.stringify(event)}\n`;
}

function openStream() {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, body, text: async () => '' }));
  return {
    push(text: string): void {
      controller?.enqueue(encoder.encode(anthropicDelta(text)));
    },
    fail(why: string): void {
      controller?.error(new Error(why));
    },
    close(): void {
      controller?.close();
    },
  };
}

/** Let the reader drain whatever is queued and the emitter act on it. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

// Real production wiring: sentences go from comprehension.ts straight into a real Soniox SpeechStream — what's asserted is what reached the wire.
function decideInto(stream: SpeechStream) {
  return decideResponse(onSoniox, {
    transcript: 'Ann: Archie, what happened with the deploy?',
    onSentence: (text) => stream.say(text),
  });
}

describe('the shared speaking path, on Soniox', () => {
  it('never puts the SILENCE token on the wire, one character at a time', async () => {
    const session = createSpeechSession(onSoniox);
    const stream = session.speak(() => undefined);
    latest().handshake();

    const reply = openStream();
    const pending = decideInto(stream);
    // A trailing full stop bites: a bare token is caught by the final whole-reply check regardless, but a terminator completes mid-stream — hold-back alone stops "silence" here.
    for (const ch of 'SILENCE.') {
      reply.push(ch);
      await settle();
      expect(latest().textFrames).toEqual([]);
    }
    reply.close();

    expect(await pending).toEqual({ outcome: 'silence' });
    expect(latest().textFrames).toEqual([]);
    stream.abort();
    session.close();
  });

  it('never puts the CHAT payload on the wire, one character at a time', async () => {
    const session = createSpeechSession(onSoniox);
    const stream = session.speak(() => undefined);
    latest().handshake();
    const socket = latest();

    const reply = openStream();
    const pending = decideInto(stream);
    for (const ch of 'It is done.\nCHAT: sha 9f2a1c and path a_b/c.md') {
      reply.push(ch);
      await settle();
    }
    reply.close();
    const decision = await pending;

    // A hash read aloud is noise — CHAT: is written to be read. The strong assertion: it never reached Soniox at all, not merely that a callback didn't fire.
    expect(socket.textFrames.map((f) => f.text)).toEqual(['It is done.']);
    const wire = JSON.stringify(socket.sent);
    expect(wire).not.toContain('9f2a1c');
    expect(wire).not.toContain('CHAT');
    expect(decision).toEqual({
      outcome: 'speak',
      response: { speech: 'It is done.', chat: 'sha 9f2a1c and path a_b/c.md' },
    });
    stream.abort();
    session.close();
  });

  it('speaks: the sentence reaches the wire while the reply is still being written', async () => {
    const session = createSpeechSession(onSoniox);
    const stream = session.speak(() => undefined);
    latest().handshake();
    const socket = latest();

    const reply = openStream();
    const pending = decideInto(stream);
    reply.push('The deploy finished at noon. ');
    await settle();
    expect(socket.textFrames.map((f) => f.text)).toEqual(['The deploy finished at noon.']);

    reply.close();
    expect(await pending).toEqual({
      outcome: 'speak',
      response: { speech: 'The deploy finished at noon.' },
    });
    stream.abort();
    session.close();
  });

  it('reports a stream that died mid-reply as failed, not as silence', async () => {
    // Recording a mid-stream death as "decided to say nothing" discharges the debt and loses the words already heard.
    const session = createSpeechSession(onSoniox);
    const stream = session.speak(() => undefined);
    latest().handshake();
    const socket = latest();

    const reply = openStream();
    const pending = decideInto(stream);
    reply.push('The deploy finished at noon. ');
    await settle();
    expect(socket.textFrames.length).toBe(1);

    reply.fail('socket hung up');
    const decision = await pending;

    expect(decision.outcome).toBe('failed');
    if (decision.outcome === 'failed') {
      expect(decision.handedOver).toBe(1);
      expect(decision.why).toContain('socket hung up');
    }
    stream.abort();
    session.close();
  });
});
