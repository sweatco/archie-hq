// The page socket is fake, "audio" is Buffer.alloc — nothing here makes a sound.
// The output page itself must NEVER be rendered: it opens a real AudioContext connected to `destination` with no user gesture, which is how verifying it once interrupted a live Zoom call. renderPage is only ever asserted on as a string.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { logger } from '../../../system/logger.js';
import { createAudioOutHub, renderPage } from '../audio-out.js';
import { BOT_NAME } from '../../../voice/types.js';

/** PCM16 mono 24kHz: 48 bytes per millisecond. */
const BYTES_PER_MS = 48;

function fakePage(readyState = 1) {
  const page = {
    readyState,
    frames: [] as unknown[],
    closed: 0,
    listeners: {} as Record<string, Array<(...args: never[]) => void>>,
    on(event: string, fn: (...args: never[]) => void) {
      (page.listeners[event] ??= []).push(fn);
      return page;
    },
    fire(event: string, ...args: unknown[]) {
      for (const fn of page.listeners[event] ?? []) (fn as (...a: unknown[]) => void)(...args);
    },
    send(frame: unknown) {
      page.frames.push(frame);
    },
    close() {
      page.closed++;
    },
  };
  // The hub only reads readyState and calls on/send/close — the cast narrows the fake to that, not a full ws instance.
  return page as unknown as typeof page & WebSocket;
}

const audio = (ms: number) => Buffer.alloc(ms * BYTES_PER_MS);

/** What the page sends back: the worklet's own count of what it rendered into the room. */
const playedReport = (ms: number, playing: boolean) =>
  JSON.stringify({ type: 'played', bytes: ms * BYTES_PER_MS, playing });

const deliver = (page: ReturnType<typeof fakePage>, frame: string) => page.fire('message', frame, false);

const pcmFrames = (page: ReturnType<typeof fakePage>) =>
  page.frames.filter((f): f is Buffer => Buffer.isBuffer(f));

const textFrames = (page: ReturnType<typeof fakePage>) =>
  page.frames.filter((f): f is string => typeof f === 'string').map((f) => JSON.parse(f));

beforeEach(() => {
  vi.spyOn(logger, 'system').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('audio out — the output gate', () => {
  it('drops everything until the gate is opened, and does not replay it afterwards', async () => {
    // Closed by default: an early bug goes inaudible, not embarrassing. A drop, not a queue — a stale answer later beats one unheard.
    const hub = createAudioOutHub();
    const page = fakePage();
    hub.handlePageSocket('bot-1', page);
    const sink = hub.sinkFor('bot-1');

    sink.play(audio(100));
    expect(pcmFrames(page).length).toBe(0);

    sink.setEnabled(true);
    expect(pcmFrames(page).length).toBe(0);

    sink.play(audio(100));
    expect(pcmFrames(page).length).toBe(1);
  });

  it('closing the gate silences the room immediately rather than draining the queue', async () => {
    const hub = createAudioOutHub();
    const page = fakePage();
    hub.handlePageSocket('bot-2', page);
    const sink = hub.sinkFor('bot-2');
    sink.setEnabled(true);
    sink.setEngaged(true);

    sink.setEnabled(false);

    // The tile can no longer claim an engagement it has no way to honour.
    expect(textFrames(page)).toContainEqual({ type: 'stop' });
    expect(textFrames(page).filter((f) => f.type === 'engaged').pop()).toEqual({
      type: 'engaged',
      engaged: false,
    });
  });

  it('opens a fresh exchange unmuted after the gate has been closed', async () => {
    // Closing cuts, and a cut must leave nothing behind that could open the next exchange muted.
    const hub = createAudioOutHub();
    const page = fakePage();
    hub.handlePageSocket('bot-3', page);
    const sink = hub.sinkFor('bot-3');
    sink.setEnabled(true);
    sink.setEnabled(false);
    sink.setEnabled(true);

    sink.play(audio(100));

    expect(pcmFrames(page).length).toBe(1);
  });
});

describe('audio out — barge-in', () => {
  it('sends a stop and drops what the page has not been given yet', async () => {
    const hub = createAudioOutHub();
    const sink = hub.sinkFor('bot-4');
    sink.setEnabled(true);
    sink.play(audio(100)); // queued: no page socket yet
    expect(sink.isSpeaking()).toBe(true);

    sink.cut();

    expect(sink.isSpeaking()).toBe(false);
    const page = fakePage();
    hub.handlePageSocket('bot-4', page);
    // Nothing survives the cut to be flushed into the room a moment later.
    expect(pcmFrames(page).length).toBe(0);
    expect(textFrames(page)).not.toContainEqual({ type: 'stop' });
  });

  it('waits for the exact count the page answers a stop with', async () => {
    // The last report is already stale by up to a report interval, and only the page knows how far past it the room got.
    const hub = createAudioOutHub();
    const page = fakePage();
    hub.handlePageSocket('bot-5', page);
    const sink = hub.sinkFor('bot-5');
    sink.setEnabled(true);
    sink.play(audio(1000));
    deliver(page, playedReport(200, true));

    sink.cut();
    expect(textFrames(page)).toContainEqual({ type: 'stop' });

    let settled: number | null = null;
    const waiting = sink.played().then((bytes) => {
      settled = bytes;
    });
    await Promise.resolve();
    expect(settled).toBeNull();

    deliver(page, playedReport(260, false));
    await waiting;
    expect(settled).toBe(260 * BYTES_PER_MS);
  });

  it('gives up on that count after half a second, keeping what the page last confirmed', async () => {
    // A page that has gone quiet must not hold a turn open, and under-counting is the safe direction to give up in.
    vi.useFakeTimers();
    const hub = createAudioOutHub();
    const page = fakePage();
    hub.handlePageSocket('bot-6', page);
    const sink = hub.sinkFor('bot-6');
    sink.setEnabled(true);
    sink.play(audio(1000));
    deliver(page, playedReport(300, true));

    sink.cut(); // the page never answers

    let settled: number | null = null;
    const waiting = sink.played().then((bytes) => {
      settled = bytes;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBeNull();

    await vi.advanceTimersByTimeAsync(2);
    await waiting;
    expect(settled).toBe(300 * BYTES_PER_MS);
  });

  it('resolves a wait when the page disconnects instead of answering', async () => {
    const hub = createAudioOutHub();
    const page = fakePage();
    hub.handlePageSocket('bot-7', page);
    const sink = hub.sinkFor('bot-7');
    sink.setEnabled(true);
    sink.play(audio(1000));
    deliver(page, playedReport(150, true));
    sink.cut();

    const waiting = sink.played();
    page.fire('close');

    // A page that is gone will never answer; what it had already reported is the whole of what the room heard.
    await expect(waiting).resolves.toBe(150 * BYTES_PER_MS);
    expect(sink.isSpeaking()).toBe(false);
  });
});

describe('audio out — what the page says it played', () => {
  it('is zero for a bot it has never heard of', async () => {
    await expect(createAudioOutHub().sinkFor('bot-played-unknown').played()).resolves.toBe(0);
  });

  it('credits nothing until the page reports it, then exactly what it reports', async () => {
    // Handed to the socket is not heard: the page's worklet is the only thing that knows what reached the room.
    const hub = createAudioOutHub();
    const page = fakePage();
    hub.handlePageSocket('bot-played-1', page);
    const sink = hub.sinkFor('bot-played-1');
    sink.setEnabled(true);

    sink.play(audio(1000));
    await expect(sink.played()).resolves.toBe(0);

    deliver(page, playedReport(300, true));
    await expect(sink.played()).resolves.toBe(300 * BYTES_PER_MS);

    deliver(page, playedReport(1000, false));
    await expect(sink.played()).resolves.toBe(1000 * BYTES_PER_MS);
  });

  it('starts a new epoch when the page reconnects, carrying the old total forward', async () => {
    const hub = createAudioOutHub();
    const first = fakePage();
    hub.handlePageSocket('bot-played-2', first);
    const sink = hub.sinkFor('bot-played-2');
    sink.setEnabled(true);

    deliver(first, playedReport(400, false));

    // Reconnecting straight over the live socket, which is how the page usually comes back.
    const second = fakePage();
    hub.handlePageSocket('bot-played-2', second);
    await expect(sink.played()).resolves.toBe(400 * BYTES_PER_MS);

    // A fresh page counts from zero — its 100ms adds to what the old one played rather than replacing it.
    deliver(second, playedReport(100, false));
    await expect(sink.played()).resolves.toBe(500 * BYTES_PER_MS);

    // The displaced socket's own close event lands late and must not bank the same bytes a second time.
    first.fire('close');
    await expect(sink.played()).resolves.toBe(500 * BYTES_PER_MS);

    // And the other ordering — a clean close, then a reconnect — carries the total the same way.
    second.fire('close');
    const third = fakePage();
    hub.handlePageSocket('bot-played-2', third);
    deliver(third, playedReport(10, false));
    await expect(sink.played()).resolves.toBe(510 * BYTES_PER_MS);
  });

  it('ignores a played frame with no usable byte count, rather than trusting it', async () => {
    const hub = createAudioOutHub();
    const page = fakePage();
    hub.handlePageSocket('bot-played-3', page);
    const sink = hub.sinkFor('bot-played-3');
    sink.setEnabled(true);
    deliver(page, playedReport(500, false));

    deliver(page, JSON.stringify({ type: 'played', bytes: 'lots', playing: true }));

    await expect(sink.played()).resolves.toBe(500 * BYTES_PER_MS);
    // Nothing of the bad frame is believed, its playing flag included.
    expect(sink.isSpeaking()).toBe(false);
    const warnings = vi.mocked(logger.warn).mock.calls.map((call) => String(call[1]));
    expect(warnings.some((line) => line.includes('played frame'))).toBe(true);
  });

  it('never credits audio the closed gate dropped', async () => {
    // The bias this whole mechanism exists to rule out: bytes that never reached the room counted as heard.
    const hub = createAudioOutHub();
    const page = fakePage();
    hub.handlePageSocket('bot-played-4', page);
    const sink = hub.sinkFor('bot-played-4');

    sink.play(audio(1000));

    expect(pcmFrames(page).length).toBe(0);
    await expect(sink.played()).resolves.toBe(0);
  });
});

describe('audio out — is it speaking', () => {
  it('is not speaking for a bot it has never heard of', async () => {
    expect(createAudioOutHub().sinkFor('bot-unknown').isSpeaking()).toBe(false);
  });

  it('is speaking while audio is queued, and then for as long as the page says it is', async () => {
    // isSpeaking gates barge-in, so it follows the room rather than a clock: queued audio, then the page's own flag.
    const hub = createAudioOutHub();
    const sink = hub.sinkFor('bot-9');
    sink.setEnabled(true);

    sink.play(audio(100));
    expect(sink.isSpeaking()).toBe(true);

    const page = fakePage();
    hub.handlePageSocket('bot-9', page); // the queue drains into the page
    expect(sink.isSpeaking()).toBe(false);

    deliver(page, playedReport(10, true));
    expect(sink.isSpeaking()).toBe(true);

    deliver(page, playedReport(100, false));
    expect(sink.isSpeaking()).toBe(false);
  });

  it('stops claiming to speak when the page goes away', async () => {
    const hub = createAudioOutHub();
    const page = fakePage();
    hub.handlePageSocket('bot-10', page);
    const sink = hub.sinkFor('bot-10');
    sink.setEnabled(true);
    sink.play(audio(5000));
    deliver(page, playedReport(100, true));
    expect(sink.isSpeaking()).toBe(true);

    page.fire('close');

    // With no page nothing plays, and the 4900ms it never got to render stays uncredited.
    expect(sink.isSpeaking()).toBe(false);
    await expect(sink.played()).resolves.toBe(100 * BYTES_PER_MS);
  });
});

describe('audio out — the page socket', () => {
  it('queues audio while the page is coming up and flushes it on connect', async () => {
    // Output media can take a few seconds to come up, so a short queue is worth keeping.
    const hub = createAudioOutHub();
    const sink = hub.sinkFor('bot-11');
    sink.setEnabled(true);
    sink.play(audio(100));
    sink.play(audio(100));

    const page = fakePage();
    hub.handlePageSocket('bot-11', page);

    expect(pcmFrames(page).length).toBe(2);
  });

  it('drops the oldest queued audio rather than growing the heap for a page that never connects', async () => {
    // If we're this far behind, the oldest audio answers a question the room has moved on from.
    const hub = createAudioOutHub();
    const sink = hub.sinkFor('bot-12');
    sink.setEnabled(true);
    for (let i = 0; i < 20; i++) {
      sink.play(audio(1000));
    }

    const page = fakePage();
    hub.handlePageSocket('bot-12', page);

    // Ten seconds' worth survives, not twenty.
    expect(pcmFrames(page).length).toBe(10);
  });

  it('re-asserts engagement to a page that connects mid-exchange', async () => {
    // A page that loads (or reconnects) while Archie is waiting on somebody must not sit there grey.
    const hub = createAudioOutHub();
    const sink = hub.sinkFor('bot-13');
    sink.setEnabled(true);
    sink.setEngaged(true);

    const page = fakePage();
    hub.handlePageSocket('bot-13', page);

    expect(textFrames(page)).toContainEqual({ type: 'engaged', engaged: true });
  });

  it('sends an engagement frame on the transition only', async () => {
    // The brain re-asserts the same state every turn; a frame per utterance would be noise on the wire and in the log.
    const hub = createAudioOutHub();
    const page = fakePage();
    hub.handlePageSocket('bot-14', page);
    const sink = hub.sinkFor('bot-14');

    sink.setEngaged(true);
    sink.setEngaged(true);
    sink.setEngaged(true);
    sink.setEngaged(false);

    expect(textFrames(page).filter((f) => f.type === 'engaged')).toEqual([
      { type: 'engaged', engaged: false },
      { type: 'engaged', engaged: true },
      { type: 'engaged', engaged: false },
    ]);
  });

  it('closes the previous socket when the page reconnects, keeping one page per bot', async () => {
    const hub = createAudioOutHub();
    const first = fakePage();
    const second = fakePage();
    hub.handlePageSocket('bot-15', first);
    hub.handlePageSocket('bot-15', second);

    expect(first.closed).toBe(1);
    expect(second.closed).toBe(0);

    // And the old socket's own close event must not orphan the new one.
    first.fire('close');
    hub.sinkFor('bot-15').setEnabled(true);
    hub.sinkFor('bot-15').play(audio(100));
    expect(pcmFrames(second).length).toBe(1);
  });

  it('does not push into a socket that is not open', async () => {
    const hub = createAudioOutHub();
    const page = fakePage(0); // CONNECTING
    hub.handlePageSocket('bot-16', page);
    const sink = hub.sinkFor('bot-16');
    sink.setEnabled(true);

    sink.play(audio(100));

    expect(pcmFrames(page).length).toBe(0);
  });

  it('disposes a channel and its socket', async () => {
    const hub = createAudioOutHub();
    const page = fakePage();
    hub.handlePageSocket('bot-17', page);
    hub.sinkFor('bot-17').setEnabled(true);
    hub.sinkFor('bot-17').play(audio(100));
    expect(pcmFrames(page).length).toBe(1);

    hub.dispose('bot-17');

    expect(page.closed).toBe(1);
    // Channel forgotten: next sinkFor builds fresh with the gate closed — a re-used bot id must not inherit an open gate from an ended meeting.
    hub.sinkFor('bot-17').play(audio(100));
    expect(pcmFrames(page).length).toBe(1);
  });
});

describe('audio out — the page as text', () => {
  it('carries the socket url and the bot name, HTML-escaping the id it was handed', async () => {
    // Never rendered — see the file header. This is a string assertion.
    const html = renderPage('pa<ge>-1', 'wss://archie.example/api/voice/out/page-1');

    expect(html).toContain('wss://archie.example/api/voice/out/page-1');
    expect(html).toContain(BOT_NAME);
    expect(html).toContain('pa&lt;ge&gt;-1');
    expect(html).not.toContain('<ge>');
  });

  it('cannot be escaped out of its own script literal', async () => {
    const html = renderPage('page-2', 'wss://x/</script><script>alert(1)</script>');

    expect(html).not.toContain('</script><script>');
  });

  it('ships the worklet that counts rendered samples, and the sender that forwards its count', async () => {
    // The page is what actually knows; these are the two halves of it saying so. Not executed here — see the file header.
    const html = renderPage('page-3', 'wss://archie.example/api/voice/out/page-3');

    // Counted in exactly one place: where a sample leaves the ring for the output. Never in the branch that renders silence.
    expect(html.match(/this\.played\+\+/g)).toHaveLength(1);
    expect(html).toContain("type: 'played', played: this.played * 2");
    // A stop is answered at once, which is what makes the count exact at a barge-in.
    expect(html).toMatch(/msg\.type === 'stop'[\s\S]*this\.report\(\);/);
    // And the main thread hands every report straight to the server.
    expect(html).toContain("report({ type: 'played', bytes: event.data.played");
  });
});
