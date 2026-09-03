/**
 * Audio out — synthesized speech into the meeting. Recall renders a webpage as the bot's camera/mic; this module owns both: the server-side hub (queues, cuts playback) and the page HTML (`renderPage`).
 * PCM16 mono 24 kHz throughout — what Deepgram's TTS returns; no resampling anywhere.
 * One rule gates the room by dropping bytes: the output gate (`AudioSink.setEnabled`). What the room actually heard is never inferred here — the page's worklet counts the samples it renders and reports them back.
 */

import type { RawData, WebSocket } from 'ws';
import { logger } from '../system/logger.js';
import { BOT_NAME } from './types.js';
import type { AudioSink } from './types.js';

const SAMPLE_RATE = 24000;

/** Bytes of PCM16 mono 24 kHz per millisecond — how the queue cap below and its drop line are stated in time. */
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;

/** `ws`'s `readyState` for OPEN, inlined to keep this module's `ws` dependency type-only — the hub never constructs a socket, only receives one. */
const WS_OPEN = 1;

/** Text frame that means "drop everything and go silent". */
const STOP_FRAME = JSON.stringify({ type: 'stop' });

/**
 * Sent on every transition and again on connect, so a page (re)loading mid-engagement doesn't sit grey while Archie waits on somebody.
 * Deliberately not the output gate — see {@link AudioSink.setEngaged}.
 */
function engagedFrame(engaged: boolean): string {
  return JSON.stringify({ type: 'engaged', engaged });
}

/** Cap on audio held while the page socket is down (~10s) — long enough for output media to start, short enough a page that never connects won't grow the heap forever. */
const MAX_PENDING_BYTES = 10_000 * BYTES_PER_MS;

/** Samples the worklet renders between reports (~170ms at 24 kHz) — the resolution of `isSpeaking` and of `played()` mid-utterance. A stop is reported at once, so the one reading that decides a record is exact. */
const REPORT_SAMPLES = 4096;

/** How long `played()` waits for the exact count a stop asked the page for. Past it the last known count stands: under-counting is the safe direction, and no turn may hang on a page that has gone quiet. */
const REPORT_TIMEOUT_MS = 500;

export interface AudioOutHub {
  /** WS path the page connects to: /api/voice/out/:botId */
  handlePageSocket(botId: string, ws: WebSocket): void;
  sinkFor(botId: string): AudioSink;
  dispose(botId: string): void;
}

/** Per-bot state: one output page, and what it last said it had played. */
interface OutChannel {
  socket: WebSocket | null;
  /** PCM queued while no page socket is open, oldest first. */
  pending: Buffer[];
  pendingBytes: number;
  /** The output gate. Closed until a meeting is live; see `setEnabled`. */
  enabled: boolean;
  /** Whether Archie owes the room something — the tile's green. See `setEngaged`. */
  engaged: boolean;
  /** What pages before this one played. Each page counts from zero, so a reconnect opens a new epoch instead of continuing the old count. */
  epochBase: number;
  /** The current page's own last report: PCM bytes it has rendered into the room. */
  lastPlayed: number;
  /** Whether that report said sound was still coming out. */
  playing: boolean;
  /** A stop is out and the exact count answering it hasn't arrived — `played()` waits for it. */
  awaitingReport: boolean;
  /** `played()` calls parked on that report. */
  waiting: Array<() => void>;
}

export function createAudioOutHub(): AudioOutHub {
  const channels = new Map<string, OutChannel>();
  const sinks = new Map<string, AudioSink>();

  function channelFor(botId: string): OutChannel {
    let channel = channels.get(botId);
    if (!channel) {
      channel = {
        socket: null,
        pending: [],
        pendingBytes: 0,
        // Closed by default: a sink nobody has opened must never reach the room.
        enabled: false,
        // Grey by default: nothing is expected of Archie until it is named.
        engaged: false,
        epochBase: 0,
        lastPlayed: 0,
        playing: false,
        awaitingReport: false,
        waiting: [],
      };
      channels.set(botId, channel);
    }
    return channel;
  }

  function sendEngaged(channel: OutChannel, engaged: boolean): void {
    if (channel.socket && channel.socket.readyState === WS_OPEN) {
      channel.socket.send(engagedFrame(engaged));
    }
  }

  /** Hands every parked `played()` the count it was waiting for. */
  function settleWaiting(channel: OutChannel): void {
    const parked = channel.waiting;
    channel.waiting = [];
    for (const resume of parked) {
      resume();
    }
  }

  /** Banks the outgoing page's count. The next page counts from zero, holds none of its predecessor's buffer, and will never answer a stop the old one was sent. */
  function startEpoch(channel: OutChannel): void {
    channel.epochBase += channel.lastPlayed;
    channel.lastPlayed = 0;
    channel.playing = false;
    channel.awaitingReport = false;
    settleWaiting(channel);
  }

  function enqueue(botId: string, pcm: Buffer): void {
    const channel = channelFor(botId);

    // Output gate, checked first: drops, not queues — a replayed stale answer is worse than none.
    if (!channel.enabled) {
      return;
    }

    if (channel.socket && channel.socket.readyState === WS_OPEN) {
      channel.socket.send(pcm);
    } else {
      channel.pending.push(pcm);
      channel.pendingBytes += pcm.length;

      // Drop from the front when over cap: oldest audio answers a question the room's moved on from.
      let dropped = 0;
      while (channel.pendingBytes > MAX_PENDING_BYTES && channel.pending.length > 0) {
        const stale = channel.pending.shift()!;
        channel.pendingBytes -= stale.length;
        dropped += stale.length;
      }
      if (dropped > 0) {
        logger.warn(
          'Voice',
          `Dropped ${Math.round(dropped / BYTES_PER_MS)}ms of queued audio for bot ${botId}: output page never connected`
        );
      }
    }
  }

  function flush(botId: string, channel: OutChannel): void {
    if (channel.pending.length > 0) {
      const queued = channel.pending;
      channel.pending = [];
      channel.pendingBytes = 0;
      for (const pcm of queued) {
        enqueue(botId, pcm);
      }
      logger.system(`Voice: flushed ${queued.length} queued audio chunk(s) to bot ${botId}'s output page`);
    }
  }

  function cut(botId: string): void {
    const channel = channelFor(botId);
    channel.pending = [];
    channel.pendingBytes = 0;
    if (channel.socket && channel.socket.readyState === WS_OPEN) {
      // The page silences inside one audio quantum of receiving this, and answers it with an exact played count.
      channel.socket.send(STOP_FRAME);
      channel.awaitingReport = true;
    }
    // Nothing here suppresses what arrives next: a killed utterance's later chunks never reach `play()` — `meeting.ts`'s `onPcm` returns before the sink once the turn is abandoned — and its synthesizer is stopped server-side.
  }

  /** The coarse "there's a meeting" switch — opened once Recall attaches to our page. See {@link AudioSink.setEnabled}. */
  function setEnabled(botId: string, open: boolean): void {
    const channel = channelFor(botId);
    if (open) {
      // Transition only; re-opening an open gate does nothing.
      if (!channel.enabled) {
        channel.enabled = true;
        logger.system(`Voice: output gate opened for bot ${botId}`);
      }
    } else {
      // Closing must silence the room now, not drain the queue — exactly what a barge-in does; reuse it.
      cut(botId);
      channel.enabled = false;
      logger.system(`Voice: output gate closed for bot ${botId}`);
      // Nothing can be spoken through a shut gate, so any engagement it was showing is a claim we can no longer honour.
      setEngaged(botId, false);
    }
  }

  /**
   * Whether Archie owes the room something, shown by the tile. `cut()` does *not* clear it — interrupted mid-sentence doesn't settle the debt, so barge-in drops to steady green, never grey.
   */
  function setEngaged(botId: string, engaged: boolean): void {
    const channel = channelFor(botId);
    // Transition only: the brain may re-assert the same state every turn, and a frame per utterance would be noise on the wire and log.
    if (channel.engaged !== engaged) {
      channel.engaged = engaged;
      sendEngaged(channel, engaged);
      logger.system(`Voice: bot ${botId} is ${engaged ? 'engaged with' : 'disengaged from'} the room`);
    }
  }

  function isSpeaking(botId: string): boolean {
    const channel = channels.get(botId);
    if (!channel) {
      return false;
    }
    return channel.pendingBytes > 0 || channel.playing;
  }

  /**
   * `AudioSink.played()` — what the page says it rendered, plus what pages before it rendered.
   * Waiting on an outstanding stop report is what makes the one reading that decides a record exact: the page counts to the sample it silenced at, and answers the stop with that number.
   */
  function played(botId: string): Promise<number> {
    const channel = channels.get(botId);
    if (!channel) {
      return Promise.resolve(0);
    }
    const total = (): number => channel.epochBase + channel.lastPlayed;
    if (!channel.awaitingReport) {
      return Promise.resolve(total());
    }
    return new Promise<number>((resolve) => {
      let settled = false;
      // Past the timeout the last known count stands — under-counting is safe, and a page that has gone quiet must not hold a turn open.
      const finish = (): void => {
        if (!settled) {
          settled = true;
          resolve(total());
        }
      };
      const giveUp = setTimeout(finish, REPORT_TIMEOUT_MS);
      giveUp.unref();
      channel.waiting.push(() => {
        clearTimeout(giveUp);
        finish();
      });
    });
  }

  return {
    handlePageSocket(botId: string, ws: WebSocket): void {
      const channel = channelFor(botId);
      const previous = channel.socket;
      channel.socket = ws;
      if (previous && previous !== ws) {
        // Page reconnected (retries on a drop, or Recall reloads it) — old socket is dead weight; close it, one page per bot.
        previous.close();
        // Its own close event is skipped below (the channel no longer points at it), so bank its count here instead.
        startEpoch(channel);
      }

      ws.on('message', (data: RawData, isBinary: boolean) => {
        if (isBinary) {
          // The page is a sink; binary back means something upstream is confused about this socket's direction.
          logger.warn('Voice', `Ignoring unexpected binary frame from bot ${botId}'s output page`);
        } else {
          const text = String(data);
          const report = playedFrame(text);
          // A report from a socket we have already replaced would land in the live page's epoch and credit its bytes twice.
          if (report === null || channel.socket !== ws) {
            // Status frames: the page reports AudioContext state on connect — quickest way to spot a context stuck suspended in headless Chrome (silence, no other symptom).
            logger.system(`Voice: output page ${botId} → ${text.slice(0, 200)}`);
          } else if (typeof report.bytes !== 'number' || !Number.isFinite(report.bytes)) {
            logger.warn('Voice', `Ignoring a played frame with no usable byte count from bot ${botId}'s output page: ${text.slice(0, 200)}`);
          } else {
            channel.lastPlayed = report.bytes;
            channel.playing = report.playing === true;
            channel.awaitingReport = false;
            settleWaiting(channel);
          }
        }
      });

      ws.on('close', () => {
        if (channel.socket === ws) {
          channel.socket = null;
          startEpoch(channel);
        }
        logger.system(`Voice: output page for bot ${botId} disconnected`);
      });

      ws.on('error', (error: Error) => {
        logger.warn('Voice', `Output page socket error for bot ${botId}`, error);
      });

      logger.system(`Voice: output page for bot ${botId} connected`);
      sendEngaged(channel, channel.engaged);
      flush(botId, channel);
    },

    sinkFor(botId: string): AudioSink {
      let sink = sinks.get(botId);
      if (!sink) {
        sink = {
          play: (pcm: Buffer) => enqueue(botId, pcm),
          cut: () => cut(botId),
          setEnabled: (open: boolean) => setEnabled(botId, open),
          setEngaged: (engaged: boolean) => setEngaged(botId, engaged),
          isSpeaking: () => isSpeaking(botId),
          played: () => played(botId),
        };
        sinks.set(botId, sink);
      }
      return sink;
    },

    dispose(botId: string): void {
      const channel = channels.get(botId);
      if (channel) {
        if (channel.socket) {
          channel.socket.close();
        }
        channels.delete(botId);
        sinks.delete(botId);
        logger.system(`Voice: disposed output channel for bot ${botId}`);
      }
    },
  };
}

/** The fields of a `played` frame, or null if this text isn't one. Unvalidated: the caller decides what an unusable count deserves. */
function playedFrame(text: string): { bytes: unknown; playing: unknown } | null {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed === 'object' && parsed !== null && (parsed as { type?: unknown }).type === 'played') {
    const frame = parsed as { bytes?: unknown; playing?: unknown };
    return { bytes: frame.bytes, playing: frame.playing };
  } else {
    return null;
  }
}

/**
 * The AudioWorklet feeding the speakers, as source text loaded from a blob URL — the page must be self-contained.
 * Worklet, not scheduled `AudioBufferSourceNode`s: TTS chunks are contiguous samples, so a sample ring plays seamlessly by construction, and barge-in drops the queue on the audio thread itself — no main-thread scheduling matches that.
 * Timing is in render quanta (128 frames, ~5.3ms at 24 kHz) — the audio thread's only resolution.
 */
const WORKLET_SOURCE = `
// Cushion before the first sample plays. A burst of small frames would
// otherwise start playing and underrun a quantum later.
const PREBUFFER_SAMPLES = 1440;   // 60ms at 24kHz

// ...but never strand audio shorter than the cushion: arm anyway after this
// long with data waiting.
const ARM_TIMEOUT_SAMPLES = 6000; // 250ms at 24kHz

// Rendered samples between reports while playing.
const REPORT_SAMPLES = ${REPORT_SAMPLES};

class PcmQueueProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];     // Float32Array queue, oldest first
    this.read = 0;        // read offset inside chunks[0]
    this.queued = 0;      // samples still to play
    this.armed = false;   // past the prebuffer cushion
    this.waited = 0;      // samples of real time spent waiting to arm
    this.gain = 0;        // declick envelope, travels 0..1 in one quantum
    this.last = 0;        // last raw sample, held while the envelope decays
    this.playing = false;
    this.played = 0;      // samples taken from the ring and rendered, ever
    this.reported = 0;    // this.played as of the last report

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg) {
        return;
      }
      if (msg.type === 'stop') {
        // Barge-in. Control messages are delivered between render quanta, so
        // dropping the queue here means the very next process() call finds no
        // data and the envelope reaches zero inside that same quantum.
        this.chunks = [];
        this.read = 0;
        this.queued = 0;
        this.armed = false;
        this.waited = 0;
        // The ring is gone, so this count is final for the utterance just killed — and it is the one a record gets filed on.
        this.playing = false;
        this.report();
      } else if (msg.pcm) {
        this.chunks.push(msg.pcm);
        this.queued += msg.pcm.length;
      }
    };
  }

  // Counts samples that actually left for the output, never the silence this node renders while idle.
  report() {
    this.reported = this.played;
    this.port.postMessage({ type: 'played', played: this.played * 2, playing: this.playing });
  }

  process(inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) {
      return true;
    }
    const n = out.length;

    if (!this.armed && this.queued > 0) {
      this.waited += n;
      if (this.queued >= PREBUFFER_SAMPLES || this.waited >= ARM_TIMEOUT_SAMPLES) {
        this.armed = true;
        this.waited = 0;
      }
    }

    // One quantum of envelope travel: a ~5ms fade, short enough to be inaudible
    // as a fade and long enough to remove the step that would be heard as a click.
    const step = 1 / n;

    for (let i = 0; i < n; i++) {
      if (this.armed && this.queued > 0) {
        const chunk = this.chunks[0];
        this.last = chunk[this.read];
        this.read++;
        this.queued--;
        this.played++;
        if (this.read >= chunk.length) {
          this.chunks.shift();
          this.read = 0;
        }
        if (this.gain < 1) {
          this.gain = Math.min(1, this.gain + step);
        }
      } else {
        // Underrun or barge-in: decay the held sample toward zero rather than
        // jumping to it. The jump is what a click is.
        if (this.gain > 0) {
          this.gain = Math.max(0, this.gain - step);
        }
      }
      out[i] = this.last * this.gain;
    }

    // Re-arm for the next utterance: the cushion applies to every start from
    // silence, not just the first one.
    if (this.queued === 0) {
      this.armed = false;
    }

    // Every change of state, the drain to idle included, plus enough of a drip while playing that the server is never far behind the room.
    const playing = this.queued > 0 || this.gain > 0;
    if (playing !== this.playing || this.played - this.reported >= REPORT_SAMPLES) {
      this.playing = playing;
      this.report();
    }

    // Always keep the node alive. It renders silence when idle, which keeps
    // Recall's capture stream running — reviving a stalled capture costs far
    // more than rendering zeros.
    return true;
  }
}

registerProcessor('pcm-queue', PcmQueueProcessor);
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A JS string literal safe to inline in a `<script>` (no `</script>` escape hatch). */
function scriptLiteral(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** The Output Media page: Recall renders this as the bot's camera and mic. */
export function renderPage(botId: string, wsUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(BOT_NAME)} · voice</title>
<style>
  html, body {
    margin: 0;
    height: 100%;
    background: #0b0d10;
    color: #e8eaed;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  }
  body { display: flex; align-items: center; justify-content: center; }
  .tile { display: flex; flex-direction: column; align-items: center; gap: 20px; }
  /* Three states, in the order they escalate. Grey is "nothing is expected of
     me until you say my name"; both live states are the same green so the room
     learns one colour for "Archie is on the hook", and only speaking moves. */
  .dot {
    width: 22px; height: 22px; border-radius: 50%;
    background: #39414f;
    transition: background 140ms linear, box-shadow 140ms linear;
  }
  .dot.engaged {
    background: #4ade80;
    /* A still halo: reads as present at thumbnail size without competing with
       the speaking animation. */
    box-shadow: 0 0 0 6px rgba(74, 222, 128, 0.14);
  }
  .dot.speaking {
    background: #4ade80;
    animation: pulse 1.1s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { transform: scale(1);    box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.45); }
    50%      { transform: scale(1.12); box-shadow: 0 0 0 14px rgba(74, 222, 128, 0); }
  }
  .name { font-size: 44px; font-weight: 600; letter-spacing: 0.2px; }
  .id { font-size: 12px; color: #6b7280; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
  <div class="tile">
    <div class="dot" id="dot"></div>
    <div class="name">${escapeHtml(BOT_NAME)}</div>
    <div class="id">${escapeHtml(botId)}</div>
  </div>
<script>
(function () {
  'use strict';

  var WS_URL = ${scriptLiteral(wsUrl)};
  var WORKLET_SRC = ${scriptLiteral(WORKLET_SOURCE)};
  var SAMPLE_RATE = ${SAMPLE_RATE};
  var MAX_PENDING_FRAMES = 64;

  var dot = document.getElementById('dot');
  var ctx = null;
  var node = null;
  var ws = null;
  var ready = false;
  var attempt = 0;
  var firstFrame = true;
  var pending = [];   // frames that arrived before the audio graph was up

  function noop() {}

  // Exactly one active tile state, derived from two independent facts:
  // whether Archie owes the room something (the server) and whether audio is
  // flowing (the worklet). Speaking outranks engaged; neither means grey.
  var engaged = false;
  var playing = false;

  function render() {
    if (playing) { dot.className = 'dot speaking'; }
    else if (engaged) { dot.className = 'dot engaged'; }
    else { dot.className = 'dot'; }
  }

  function report(payload) {
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(payload)); } catch (e) { noop(); }
    }
  }

  // WARNING TO ANYONE VERIFYING THIS PAGE: it plays real sound, with no user
  // gesture required. The context below is connected to ctx.destination and
  // self-resume()s on purpose, so that it works headlessly inside Recall's
  // browser — which means loading this page in a browser on a developer's
  // machine emits audio out of their speakers. That has already interrupted a
  // live Zoom call once. Verify it with --mute-audio, an OfflineAudioContext, or
  // a zeroed destination gain; or better, drive the worklet directly in Node and
  // assert on the PCM, which gives sharper evidence than listening does.
  function startAudio() {
    ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    // A context created without a user gesture can come back suspended, and a
    // suspended context renders nothing at all — silence with no other symptom.
    // resume() here, and again on the first inbound frame (see handleAudio).
    var blobUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    return ctx.resume().catch(noop).then(function () {
      return ctx.audioWorklet.addModule(blobUrl);
    }).then(function () {
      URL.revokeObjectURL(blobUrl);
      node = new AudioWorkletNode(ctx, 'pcm-queue', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      });
      // The worklet is the only thing that knows what the room actually heard;
      // every report it makes goes straight up the socket.
      node.port.onmessage = function (event) {
        if (event.data && event.data.type === 'played') {
          playing = !!event.data.playing;
          render();
          report({ type: 'played', bytes: event.data.played, playing: playing });
        }
      };
      node.connect(ctx.destination);
      ready = true;
      for (var i = 0; i < pending.length; i++) { push(pending[i]); }
      pending = [];
      report({ type: 'hello', stage: 'audio-ready', ctx: ctx.state, sampleRate: ctx.sampleRate });
    }).catch(function (error) {
      report({ type: 'error', where: 'startAudio', message: String(error) });
    });
  }

  function push(buffer) {
    // PCM16 → Float32. Whole samples only: a frame with an odd byte count would
    // otherwise misalign every sample after it.
    var count = Math.floor(buffer.byteLength / 2);
    if (count === 0) { return; }
    var pcm16 = new Int16Array(buffer, 0, count);
    var f32 = new Float32Array(count);
    for (var i = 0; i < count; i++) { f32[i] = pcm16[i] / 32768; }
    // Transfer rather than copy — the worklet is the only owner from here.
    node.port.postMessage({ pcm: f32 }, [f32.buffer]);
  }

  function handleAudio(buffer) {
    if (firstFrame) {
      firstFrame = false;
      // The resume() that usually matters: by now the tab has been alive for a
      // while and Chrome will grant it even where the one at creation failed.
      if (ctx) { ctx.resume().catch(noop); }
    }
    if (ready) {
      push(buffer);
    } else if (pending.length < MAX_PENDING_FRAMES) {
      pending.push(buffer);
    }
  }

  function handleText(raw) {
    var msg = null;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg && msg.type === 'stop') {
      // Barge-in: clear what has not reached the worklet yet, then let the
      // worklet drop its own queue. Both happen before the next render quantum.
      pending = [];
      if (node) { node.port.postMessage({ type: 'stop' }); }
      // Straight to steady green, never grey: being interrupted mid-sentence
      // does not settle what Archie owes the room, and that is exactly when
      // people need to see it is still on the hook.
      playing = false;
      render();
    } else if (msg && msg.type === 'engaged') {
      engaged = !!msg.engaged;
      render();
    }
  }

  function connect() {
    ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';
    ws.onopen = function () {
      attempt = 0;
      report({ type: 'hello', stage: 'socket-open', ctx: ctx ? ctx.state : 'pending', sampleRate: ctx ? ctx.sampleRate : 0 });
    };
    ws.onmessage = function (event) {
      if (typeof event.data === 'string') { handleText(event.data); } else { handleAudio(event.data); }
    };
    ws.onerror = noop;   // a close event always follows; reconnect there
    ws.onclose = function () {
      // Audio has stopped for certain. Engagement survives a quick reconnect
      // so the tile doesn't flicker, but a socket that stays down means we
      // can no longer claim anything — better grey than a lying green dot.
      playing = false;
      attempt++;
      if (attempt >= 3) { engaged = false; }
      render();
      // Short backoff: the engine restarting is the common case, and the bot is
      // mute until this socket is back.
      setTimeout(connect, Math.min(5000, 250 * Math.pow(2, attempt - 1)));
    };
  }

  // Any real gesture is another chance to unsuspend, for when a human opens
  // this page directly to debug it.
  document.addEventListener('pointerdown', function () {
    if (ctx) { ctx.resume().catch(noop); }
  });

  startAudio();
  connect();
})();
</script>
</body>
</html>
`;
}
