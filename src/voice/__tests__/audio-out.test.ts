// The page socket is fake, "audio" is Buffer.alloc — nothing here makes a sound.
// The output page itself must NEVER be rendered: it opens a real AudioContext connected to `destination` with no user gesture, which is how verifying it once interrupted a live Zoom call. renderPage is only ever asserted on as a string.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { logger } from '../../system/logger.js';
import { createAudioOutHub, renderPage } from '../audio-out.js';

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
    // Closing cuts, arming suppression — this test guards that it doesn't carry into the next exchange, opening it muted.
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
  it('drops the tail of a killed utterance, then lets a genuine next turn through', async () => {
    // Silencing the page is half a barge-in — the synthesizer keeps sending the rest of the sentence; unsuppressed, the next frame resumes mid-word, a glitch, not a yield.
    vi.useFakeTimers();
    const hub = createAudioOutHub();
    const page = fakePage();
    hub.handlePageSocket('bot-4', page);
    const sink = hub.sinkFor('bot-4');
    sink.setEnabled(true);

    sink.play(audio(20));
    sink.cut();
    expect(textFrames(page)).toContainEqual({ type: 'stop' });

    vi.advanceTimersByTime(50);
    sink.play(audio(20));
    expect(pcmFrames(page).length).toBe(1);

    // A gap no continuing utterance could contain — the next turn costs a round trip plus synthesis startup.
    vi.advanceTimersByTime(600);
    sink.play(audio(20));
    expect(pcmFrames(page).length).toBe(2);
  });

  it('gives up suppressing after the ceiling, because speaking late beats never speaking', async () => {
    // Two signals already end suppression; this third stops a gapless stream muting the bot for the rest of the meeting.
    vi.useFakeTimers();
    const hub = createAudioOutHub();
    const page = fakePage();
    hub.handlePageSocket('bot-5', page);
    const sink = hub.sinkFor('bot-5');
    sink.setEnabled(true);
    sink.cut();

    // A continuous burst: never a quiet gap, so only the ceiling can end this.
    for (let elapsed = 0; elapsed < 4_800; elapsed += 100) {
      vi.advanceTimersByTime(100);
      sink.play(audio(20));
    }
    expect(pcmFrames(page).length).toBe(0);

    vi.advanceTimersByTime(400);
    sink.play(audio(20));
    expect(pcmFrames(page).length).toBe(1);
  });

  it('does not restart the ceiling when a second cut lands inside the same window', async () => {
    // Or repeated side-talk could hold the bot mute indefinitely.
    vi.useFakeTimers();
    const hub = createAudioOutHub();
    const page = fakePage();
    hub.handlePageSocket('bot-6', page);
    const sink = hub.sinkFor('bot-6');
    sink.setEnabled(true);
    sink.cut();

    for (let elapsed = 0; elapsed < 4_800; elapsed += 100) {
      vi.advanceTimersByTime(100);
      sink.play(audio(20));
      sink.cut();
    }
    vi.advanceTimersByTime(400);
    sink.play(audio(20));

    expect(pcmFrames(page).length).toBe(1);
  });

  it('ends suppression the moment the room engages us again', async () => {
    // Being addressed means a fresh turn is on its way — the precise un-suppress boundary, no inference or timer.
    vi.useFakeTimers();
    const hub = createAudioOutHub();
    const page = fakePage();
    hub.handlePageSocket('bot-7', page);
    const sink = hub.sinkFor('bot-7');
    sink.setEnabled(true);
    sink.cut();

    vi.advanceTimersByTime(50);
    sink.play(audio(20));
    expect(pcmFrames(page).length).toBe(0);

    sink.setEngaged(true);
    vi.advanceTimersByTime(50);
    sink.play(audio(20));
    expect(pcmFrames(page).length).toBe(1);
  });

  it('reads as silent while suppressing, so the brain does not re-arm the window forever', async () => {
    // isSpeaking() staying true while muted would let every bit of side-talk fire another cut() — a feedback loop to avoid.
    vi.useFakeTimers();
    const hub = createAudioOutHub();
    const page = fakePage();
    hub.handlePageSocket('bot-8', page);
    const sink = hub.sinkFor('bot-8');
    sink.setEnabled(true);
    sink.cut();

    vi.advanceTimersByTime(50);
    sink.play(audio(2000));

    expect(sink.isSpeaking()).toBe(false);
  });
});

describe('audio out — the playback cursor', () => {
  it('reports speaking until the audio it handed over has played, plus the pipeline tail', async () => {
    // isSpeaking gates barge-in — over-report leaves it armed too long; under-report drops a real interruption.
    vi.useFakeTimers();
    const hub = createAudioOutHub();
    const page = fakePage();
    hub.handlePageSocket('bot-9', page);
    const sink = hub.sinkFor('bot-9');
    sink.setEnabled(true);

    sink.play(audio(1000));
    expect(sink.isSpeaking()).toBe(true);

    vi.advanceTimersByTime(1_100);
    expect(sink.isSpeaking()).toBe(true);

    vi.advanceTimersByTime(200);
    expect(sink.isSpeaking()).toBe(false);
  });

  it('is not speaking for a bot it has never heard of', async () => {
    expect(createAudioOutHub().sinkFor('bot-unknown').isSpeaking()).toBe(false);
  });

  it('stops claiming to speak when the page goes away', async () => {
    vi.useFakeTimers();
    const hub = createAudioOutHub();
    const page = fakePage();
    hub.handlePageSocket('bot-10', page);
    const sink = hub.sinkFor('bot-10');
    sink.setEnabled(true);
    sink.play(audio(5000));
    expect(sink.isSpeaking()).toBe(true);

    page.fire('close');

    // With no page nothing is playing — a cursor left in the future would keep isSpeaking() lying until it expired.
    expect(sink.isSpeaking()).toBe(false);

    // None of the 5000ms handed to the socket had cleared the pipeline tail — the room never heard it.
    // A close handler zeroing the cursor with no freeze (like cut()) would instantly credit the whole chunk — feeding a barge-in line for unheard audio.
    expect(sink.playedBytes()).toBe(0);

    // Freeze must hold: real time passing must not un-silence unheard audio — the same property cut() is held to below.
    vi.advanceTimersByTime(10_000);
    expect(sink.playedBytes()).toBe(0);
  });
});

describe('audio out — playedBytes, the conservative watermark', () => {
  it('is zero for a bot it has never heard of', async () => {
    expect(createAudioOutHub().sinkFor('bot-played-unknown').playedBytes()).toBe(0);
  });

  it('credits nothing until a chunk clears its own pipeline tail, then all of it', async () => {
    // Mirrors the isSpeaking test: same cursor, same margin, opposite bias — that goes false the instant this hits full credit.
    vi.useFakeTimers();
    const hub = createAudioOutHub();
    const page = fakePage();
    hub.handlePageSocket('bot-played-1', page);
    const sink = hub.sinkFor('bot-played-1');
    sink.setEnabled(true);

    sink.play(audio(1000));
    expect(sink.playedBytes()).toBe(0);

    // Still inside the 1000ms of audio plus the 200ms pipeline tail.
    vi.advanceTimersByTime(1_100);
    expect(sink.playedBytes()).toBeGreaterThan(0);
    expect(sink.playedBytes()).toBeLessThan(1000 * BYTES_PER_MS);

    vi.advanceTimersByTime(200);
    expect(sink.playedBytes()).toBe(1000 * BYTES_PER_MS);
  });

  it('never regresses across a cut, and never credits the tail a cut silenced', async () => {
    // D11: barge-in lands a fraction into a sentence, well before the pipeline tail clears — no later time may change that the room never heard it.
    vi.useFakeTimers();
    const hub = createAudioOutHub();
    const page = fakePage();
    hub.handlePageSocket('bot-played-2', page);
    const sink = hub.sinkFor('bot-played-2');
    sink.setEnabled(true);

    sink.play(audio(100));
    vi.advanceTimersByTime(30); // barge-in 30ms into a 100ms sentence
    const before = sink.playedBytes();
    sink.cut();
    const justAfter = sink.playedBytes();

    expect(before).toBe(0);
    expect(justAfter).toBe(before); // frozen, not jumped to bytesSent

    // Well beyond when the killed sentence would have finished naturally — the reading must still exclude it.
    vi.advanceTimersByTime(5_000);
    expect(sink.playedBytes()).toBe(justAfter);
  });

  it('credits audio sent after a cut on its own terms, never crediting the tail the cut silenced', async () => {
    vi.useFakeTimers();
    const hub = createAudioOutHub();
    const page = fakePage();
    hub.handlePageSocket('bot-played-3', page);
    const sink = hub.sinkFor('bot-played-3');
    sink.setEnabled(true);

    sink.play(audio(100)); // cut long before its own tail clears
    vi.advanceTimersByTime(30);
    sink.cut();
    const frozen = sink.playedBytes() ?? -1;

    // setEngaged marks a genuine next turn, not the tail just killed — else post-barge-in suppression swallows it too, confounding the test.
    sink.setEngaged(true);
    vi.advanceTimersByTime(50);
    sink.play(audio(50)); // a fresh run, unrelated to the one just silenced
    vi.advanceTimersByTime(50 + 200 + 10); // past its own audio plus the tail

    expect(sink.playedBytes()).toBe(frozen + 50 * BYTES_PER_MS);
  });

  it('does not count audio the closed gate drops', async () => {
    // Bytes that never reach the socket must never reach bytesSent — the bias playedBytes() must never make.
    vi.useFakeTimers();
    const hub = createAudioOutHub();
    const sink = hub.sinkFor('bot-played-4');
    // Gate never opened.
    sink.play(audio(1000));

    vi.advanceTimersByTime(5_000);
    expect(sink.playedBytes()).toBe(0);

    // Opening the gate afterwards doesn't retroactively credit the drop — it was never queued, nothing left to play.
    sink.setEnabled(true);
    expect(sink.playedBytes()).toBe(0);
  });

  it('does not count audio the post-barge-in suppression drops', async () => {
    vi.useFakeTimers();
    const hub = createAudioOutHub();
    const page = fakePage();
    hub.handlePageSocket('bot-played-5', page);
    const sink = hub.sinkFor('bot-played-5');
    sink.setEnabled(true);
    sink.cut(); // arms suppression

    vi.advanceTimersByTime(50); // inside the quiet-gap window: this frame is swallowed
    sink.play(audio(200));

    vi.advanceTimersByTime(5_000);
    expect(sink.playedBytes()).toBe(0);
  });

  it('is monotonic across an ordinary cut with nothing in flight, an idempotent no-op', async () => {
    vi.useFakeTimers();
    const hub = createAudioOutHub();
    const page = fakePage();
    hub.handlePageSocket('bot-played-6', page);
    const sink = hub.sinkFor('bot-played-6');
    sink.setEnabled(true);

    sink.play(audio(100));
    vi.advanceTimersByTime(500); // well past 100ms + the tail: fully confirmed
    const played = sink.playedBytes();
    expect(played).toBe(100 * BYTES_PER_MS);

    sink.cut(); // nothing queued or in flight — must not claw back confirmed credit

    expect(sink.playedBytes()).toBe(played);
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
  it('carries the socket url and the bot name it was given, HTML-escaped', async () => {
    // Never rendered — see the file header. This is a string assertion.
    const html = renderPage('page-1', 'wss://archie.example/api/voice/out/page-1', 'Ar<chie>');

    expect(html).toContain('wss://archie.example/api/voice/out/page-1');
    expect(html).toContain('Ar&lt;chie&gt;');
    expect(html).not.toContain('<chie>');
  });

  it('cannot be escaped out of its own script literal', async () => {
    const html = renderPage('page-2', 'wss://x/</script><script>alert(1)</script>', 'Archie');

    expect(html).not.toContain('</script><script>');
  });
});
