// The Soniox wire, and the shared speaking path over it: hold-back, CHAT:, Decision, bias-to-silence — all from live failures, exercised end to end rather than assumed.
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

import { decideResponse } from '../comprehension.js';
import { createSonioxSpeechSession } from '../soniox.js';
import type { SpeechStream, VoiceConfig } from '../types.js';

const onSoniox: VoiceConfig = {
  deepgramApiKey: 'dg-key',
  sonioxApiKey: 'sx-test-key-long-enough',
  cerebrasApiKey: 'cerebras-key',
};

function latest(): DrivenSocket {
  const socket = sockets[sockets.length - 1];
  expect(socket).toBeDefined();
  return socket;
}

/**
 * Speaks these sentences as one whole turn. `end()` is what puts a turn on the wire — a turn is buffered until the reply is finished — so the helper calls it; the promise it returns is held rather than awaited, since it is the server frames a test drives that settle it.
 */
function speakOn(cfg: VoiceConfig, sentences: string[]) {
  const played: Buffer[] = [];
  const session = createSonioxSpeechSession(cfg);
  const stream = session.speak((pcm) => played.push(pcm));
  latest().handshake();
  for (const sentence of sentences) stream.say(sentence, () => undefined);
  const done = stream.end();
  return { session, stream, socket: latest(), played, done };
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

describe('the Soniox connection', () => {
  it('dials Soniox with the approved model and voice, and nothing else', () => {
    const { socket, session } = speakOn(onSoniox, ['Done.']);
    expect(socket.url).toBe('wss://tts-rt.soniox.com/tts-websocket');
    // A native speaker approved this pairing, including a Russian sentence carrying English technical terms.
    expect(socket.startFrames[0].model).toBe('tts-rt-v2');
    expect(socket.startFrames[0].voice).toBe('Adrian');
    // Nothing negotiates the format — pinning it guards against a container arriving instead of raw PCM16.
    expect(socket.startFrames[0].audio_format).toBe('pcm_s16le');
    expect(socket.startFrames[0].sample_rate).toBe(24000);
    expect(socket.startFrames[0].api_key).toBe('sx-test-key-long-enough');
    // Deepgram's socket is the listening one; nothing here may open a synthesis socket against it.
    expect(sockets.some((sk) => new URL(sk.url).pathname === '/v1/speak')).toBe(false);
    session.close();
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
    // Sent as `en`, a native speaker judged this non-native (English L1, accent 3/5); as `ru`, native.
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
    // Language belongs to the whole reply — monotone is the safe direction, since an all-Latin sentence inside Russian is a technical term.
    const { socket, session } = speakOn(onSoniox, [
      'Проблема в rate limiter.',
      'Rate limiter.',
      'Он отдавал 429.',
    ]);
    expect(languages(socket)).toEqual(['ru']);
    session.close();
  });

  it('speaks a reply whose Russian arrives late in Russian, not in the language of its first sentence', () => {
    // Buffering settles what stickiness alone could only limit: the language is chosen once the whole turn is in hand, so an English-looking opener no longer commits the answer to English.
    const { socket, session } = speakOn(onSoniox, ['Rate limiter.', 'Он отдавал 429.']);
    expect(languages(socket)).toEqual(['ru']);
    session.close();
  });

  it('sends a language on every stream, and never a BCP 47 tag', () => {
    // ISO 639-1 only: omitted, null, "" all get "Missing language"; `en-US`/`ru-RU` are rejected as invalid — either mistake costs every utterance. Two streams here because the stall guard fired, which is the only way one turn becomes two.
    vi.useFakeTimers();
    const session = createSonioxSpeechSession(onSoniox);
    const stream = session.speak(() => undefined);
    latest().handshake();
    const socket = latest();

    stream.say('Готово.', () => undefined);
    vi.advanceTimersByTime(3_000);
    stream.say('Migration ran.', () => undefined);
    void stream.end();
    socket.say({ stream_id: 's1', terminated: true });

    expect(socket.startFrames.length).toBe(2);
    for (const frame of socket.startFrames) {
      expect(frame.language).toMatch(/^(en|ru)$/);
    }
    session.close();
  });
});

describe('the Soniox text frame', () => {
  it('ends the text once for the whole turn, not once per sentence', () => {
    // The defect this exists for: text_end is where the synthesizer puts terminal intonation, so one per sentence made a three-sentence reply land as three finished-sounding announcements instead of one flowing turn.
    const { socket, stream, session } = speakOn(onSoniox, [
      'The pool ran dry.',
      'Then it recovered.',
      'It has held since.',
    ]);
    void stream.end();

    expect(socket.startFrames.length).toBe(1);
    expect(socket.textFrames.length).toBe(1);
    expect(socket.textFrames[0].text).toBe('The pool ran dry. Then it recovered. It has held since.');
    expect(socket.textFrames[0].text_end).toBe(true);
    session.close();
  });

  it('puts the same bytes on the wire for a one-sentence reply as the per-sentence design did', () => {
    // Below ~150 chars Soniox emits nothing until end-of-input; median reply is ~58 chars — without text_end the bot is mute. A stream left open is killed after ~5s (request_timeout), which is why text and text_end ship together.
    // Asserted as the serialised frames rather than a shape, because this is the claim that buffering changed nothing for the common reply: it held before the turn was buffered and holds after.
    const { socket, stream, session } = speakOn(onSoniox, ['The deploy finished at noon.']);
    void stream.end();

    expect(JSON.stringify(socket.sent)).toBe(
      JSON.stringify([
        {
          api_key: 'sx-test-key-long-enough',
          model: 'tts-rt-v2',
          voice: 'Adrian',
          language: 'en',
          audio_format: 'pcm_s16le',
          sample_rate: 24000,
          stream_id: 's1',
        },
        { text: 'The deploy finished at noon.', text_end: true, stream_id: 's1' },
      ]),
    );
    session.close();
  });
});

describe('the Soniox socket', () => {
  it('does not connect until there is an answer to speak', () => {
    // Streamless connections close at ~10.4s regardless of keepalives (measured); `speak()` runs the handshake before the model call, so a meeting-start socket wouldn't die before the first question.
    const session = createSonioxSpeechSession(onSoniox);
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

  it('speaks a stall-flushed front and the remainder one at a time, in order', async () => {
    // Concurrent streams would interleave chunks on the way back — the sink is a byte stream, not a mixer, so the answer comes out as noise. One turn is one stream, so the stall guard is the only thing that can put two in flight at once.
    vi.useFakeTimers();
    const played: Buffer[] = [];
    const session = createSonioxSpeechSession(onSoniox);
    const stream = session.speak((pcm) => played.push(pcm));
    latest().handshake();
    const socket = latest();

    stream.say('One.', () => undefined);
    vi.advanceTimersByTime(3_000);
    expect(socket.startFrames.length).toBe(1);

    stream.say('Two.', () => undefined);
    const done = stream.end();
    // The remainder is queued, not sent: the front is still on the wire.
    expect(socket.startFrames.length).toBe(1);

    socket.audio('s1', 100);
    socket.say({ stream_id: 's1', terminated: true });
    expect(socket.startFrames.length).toBe(2);
    expect(socket.textFrames.map((f) => f.text)).toEqual(['One.', 'Two.']);

    socket.audio('s2', 200);
    socket.say({ stream_id: 's2', terminated: true });

    const result = await done;
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
    // Barge-in stays safe without replacing the socket: audio is bound to `stream_id`, so a straggler can't reach it.
    const played: Buffer[] = [];
    const session = createSonioxSpeechSession(onSoniox);
    const first = session.speak(() => played.push(Buffer.alloc(1)));
    latest().handshake();
    first.say('Interrupted.', () => undefined);
    void first.end();
    const socket = latest();
    first.abort();

    const second: Buffer[] = [];
    const next = session.speak((pcm) => second.push(pcm));
    next.say('The room asked again.', () => undefined);
    void next.end();

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
    // A real constraint: 3 concurrent TTS streams per org. Must arrive through `incomplete` — `answerRoom` already knows how to settle a truncated debt.
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
    const session = createSonioxSpeechSession(onSoniox);
    const stream = session.speak(() => undefined);
    const first = latest();
    first.handshake();
    first.serverClose();

    stream.say('Still here.', () => undefined);
    void stream.end();
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


describe('buffering a turn', () => {
  it('holds a sentence back while the reply is still being written', () => {
    const session = createSonioxSpeechSession(onSoniox);
    const stream = session.speak(() => undefined);
    latest().handshake();
    const socket = latest();

    stream.say('The pool ran dry.', () => undefined);
    stream.say('Then it recovered.', () => undefined);
    // The whole point: one terminal intonation per turn, so nothing goes out while the model is still writing.
    expect(socket.sent).toEqual([]);

    void stream.end();
    expect(socket.startFrames.length).toBe(1);
    expect(socket.textFrames.map((f) => f.text)).toEqual(['The pool ran dry. Then it recovered.']);
    session.close();
  });

  it('speaks what it has when a reply stalls, rather than leaving the room in silence', () => {
    // The failure mode buffering introduces: with generation bounded only by GENERATION_TIMEOUT_MS (15s), a stall would be 15s of dead air, which is worse than a seam.
    vi.useFakeTimers();
    const session = createSonioxSpeechSession(onSoniox);
    const stream = session.speak(() => undefined);
    latest().handshake();
    const socket = latest();

    stream.say('Let me check that.', () => undefined);
    // 3,000ms sits above the observed maximum decideMs of 2,562ms, so on measured behaviour the guard never fires at all.
    vi.advanceTimersByTime(2_999);
    expect(socket.sent).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(socket.textFrames.map((f) => f.text)).toEqual(['Let me check that.']);
    expect(socket.textFrames[0].text_end).toBe(true);
    session.close();
  });

  it('keeps a reply that finishes inside the window whole', () => {
    // The guard bounds the pathological case; it must not shape the normal one into pieces.
    vi.useFakeTimers();
    const session = createSonioxSpeechSession(onSoniox);
    const stream = session.speak(() => undefined);
    latest().handshake();
    const socket = latest();

    stream.say('One.', () => undefined);
    vi.advanceTimersByTime(2_500);
    stream.say('Two.', () => undefined);
    void stream.end();

    expect(socket.startFrames.length).toBe(1);
    expect(socket.textFrames.map((f) => f.text)).toEqual(['One. Two.']);
    // The guard is disarmed by the flush; the timer left behind must not open a second stream.
    vi.advanceTimersByTime(5_000);
    expect(socket.startFrames.length).toBe(1);
    session.close();
  });

  it('completes every sentence of the turn when its stream terminates, in hand-over order', async () => {
    // `meeting.ts` pairs completions with handed sentences by index and reads its own byte count at each, so hand-over order is the contract. One stream per turn means the sentences share the turn's end offset — resolution the synthesizer no longer has, not a truth it got wrong.
    const completed: string[] = [];
    const session = createSonioxSpeechSession(onSoniox);
    const stream = session.speak(() => undefined);
    latest().handshake();
    const socket = latest();

    for (const sentence of ['One.', 'Two.', 'Three.']) {
      stream.say(sentence, () => completed.push(sentence));
    }
    const done = stream.end();

    socket.audio('s1', 300);
    // Nothing is complete while its stream is still running, however much audio has arrived.
    expect(completed).toEqual([]);

    socket.say({ stream_id: 's1', terminated: true });
    expect(completed).toEqual(['One.', 'Two.', 'Three.']);

    const result = await done;
    expect(result.bytes).toBe(300);
    expect(result.incomplete).toBeNull();
    session.close();
  });

  it('reports the bytes the room got, and completes nothing, when a turn is cut off part-way', async () => {
    // Barge-in: the audio stops at the source and the caller measures what was heard from the played count — but no sentence may be reported as spoken, since the stream never finished one.
    const completed: string[] = [];
    const played: Buffer[] = [];
    const session = createSonioxSpeechSession(onSoniox);
    const stream = session.speak((pcm) => played.push(pcm));
    latest().handshake();
    const socket = latest();

    stream.say('The pool ran dry.', () => completed.push('first'));
    stream.say('Then it recovered.', () => completed.push('second'));
    const done = stream.end();
    socket.audio('s1', 100);

    stream.abort();
    expect(socket.sent.some((f) => f.cancel === true && f.stream_id === 's1')).toBe(true);
    // Already in flight when the server saw the cancel (measured 29-51ms later); it belongs to nobody.
    socket.audio('s1', 100);

    const result = await done;
    expect(result.bytes).toBe(100);
    expect(played.map((b) => b.length)).toEqual([100]);
    expect(completed).toEqual([]);
    session.close();
  });

  it('says nothing at all of a turn abandoned before it was flushed', async () => {
    // The room took the floor while the model was still writing: the buffer is dropped unspoken, and nothing in it may be reported as heard.
    const completed: string[] = [];
    const session = createSonioxSpeechSession(onSoniox);
    const stream = session.speak(() => undefined);
    latest().handshake();
    const socket = latest();

    stream.say('The pool ran dry.', () => completed.push('first'));
    stream.abort();
    void stream.end();

    expect(socket.sent).toEqual([]);
    const result = await stream.end();
    expect(result.bytes).toBe(0);
    expect(completed).toEqual([]);
    session.close();
  });
});

const encoder = new TextEncoder();

function cerebrasDelta(text: string): string {
  const event = { choices: [{ delta: { content: text }, index: 0 }] };
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
      controller?.enqueue(encoder.encode(cerebrasDelta(text)));
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
    onSentence: (text) => stream.say(text, () => undefined),
  });
}

describe('the shared speaking path, on Soniox', () => {
  it('never puts the SILENCE token on the wire, one character at a time', async () => {
    const session = createSonioxSpeechSession(onSoniox);
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
    // Held past the flush too: `end()` is what puts a turn on the wire, and there must be no turn to put there.
    void stream.end();
    expect(latest().textFrames).toEqual([]);
    stream.abort();
    session.close();
  });

  it('never puts the CHAT payload on the wire, one character at a time', async () => {
    const session = createSonioxSpeechSession(onSoniox);
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
    void stream.end();

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

  it('speaks: the sentence is held while the reply is written, then goes out whole', async () => {
    const session = createSonioxSpeechSession(onSoniox);
    const stream = session.speak(() => undefined);
    latest().handshake();
    const socket = latest();

    const reply = openStream();
    const pending = decideInto(stream);
    reply.push('The deploy finished at noon. It has held since. ');
    await settle();
    // Two sentences are in hand, and neither is on the wire: the turn ships once, at the end.
    expect(socket.sent).toEqual([]);

    reply.close();
    expect(await pending).toEqual({
      outcome: 'speak',
      response: { speech: 'The deploy finished at noon. It has held since.' },
    });
    void stream.end();
    expect(socket.textFrames.map((f) => f.text)).toEqual(['The deploy finished at noon. It has held since.']);
    expect(socket.textFrames[0].text_end).toBe(true);
    stream.abort();
    session.close();
  });

  it('reports a stream that died mid-reply as failed, not as silence', async () => {
    // Recording a mid-stream death as "decided to say nothing" discharges the debt and loses the words already heard.
    const session = createSonioxSpeechSession(onSoniox);
    const stream = session.speak(() => undefined);
    latest().handshake();
    const socket = latest();

    const reply = openStream();
    const pending = decideInto(stream);
    reply.push('The deploy finished at noon. ');
    await settle();
    // Buffered rather than spoken, so a reply dying this early costs the room the sentence too — the seam a stall would have made is bounded by the stall guard, not by every failure.
    expect(socket.sent).toEqual([]);

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
