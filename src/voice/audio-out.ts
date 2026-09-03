/**
 * Audio out — synthesized speech into the meeting. Recall renders a webpage as the bot's camera/mic; this module owns both: the server-side hub (queues, cuts playback) and the page HTML (`renderPage`).
 * PCM16 mono 24 kHz throughout — what Deepgram's TTS returns; no resampling anywhere.
 * Two rules gate the room, both by dropping bytes: the output gate (`AudioSink.setEnabled`) and post-barge-in suppression (stops a killed utterance resuming mid-word after `cut()`).
 */

import type { RawData, WebSocket } from 'ws';
import { logger } from '../system/logger.js';
import type { AudioSink } from './types.js';

const SAMPLE_RATE = 24000;

/** Bytes of PCM16 mono 24 kHz per millisecond — the conversion `isSpeaking` runs on. */
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

/**
 * Grace period on the playback cursor: handed-over audio is still in the page's buffer, then Zoom's pipeline (~140ms round trip) — accounting reaches sentence-end slightly early.
 * `isSpeaking` gates barge-in — over-reporting leaves it armed too long (`cut()` on nothing is a no-op); under-reporting drops a real interruption. Errs high.
 */
const PIPELINE_TAIL_MS = 200;

/**
 * Quiet gap ending post-cut suppression: TTS streams near-continuously, so a frame this late after the last drop is a new turn (nothing arrives sooner — that costs an LLM round trip + TTS startup).
 * Covers what `setEngaged(true)` can't: a barge-in answered by a follow-up turn with no engagement transition to un-suppress on.
 */
const TURN_GAP_MS = 500;

/** Absolute ceiling on suppression, in case neither other signal (engagement, the gap above) fires and the bot stays mute all meeting — speaking late beats never speaking. */
const MAX_SUPPRESSION_MS = 5_000;

export interface AudioOutHub {
  /** WS path the page connects to: /api/voice/out/:botId */
  handlePageSocket(botId: string, ws: WebSocket): void;
  sinkFor(botId: string): AudioSink;
  dispose(botId: string): void;
}

/** Per-bot state: one output page, one playback cursor. */
interface OutChannel {
  socket: WebSocket | null;
  /** PCM queued while no page socket is open, oldest first. */
  pending: Buffer[];
  pendingBytes: number;
  /** Wall-clock ms by which everything sent so far finishes playing. */
  playbackDoneAt: number;
  /** The output gate. Closed until a meeting is live; see `setEnabled`. */
  enabled: boolean;
  /** Whether Archie owes the room something — the tile's green. See `setEngaged`. */
  engaged: boolean;
  /** Bytes the closed gate has dropped, for one line when it next opens. */
  closedDropBytes: number;
  /** True between a `cut()` and the start of the next agent turn. */
  suppressed: boolean;
  /** When this suppression window opened — the ceiling is measured from here. */
  suppressedSince: number;
  /** Last frame dropped by it — the quiet gap is measured from here. */
  lastDropAt: number;
  /** Bytes it has swallowed, for one summary line when it closes. */
  droppedBytes: number;
  /**
   * Cumulative PCM bytes handed to the socket, behind `AudioSink.playedBytes()`. Excludes `closedDropBytes`/`droppedBytes` — never reached the room, the over-claim `playedBytes()` exists to retire.
   * Never decremented, even by `cut()` — see `silencedBytes`.
   */
  bytesSent: number;
  /**
   * Of `bytesSent`, how many are in the current uninterrupted run — reset to just this chunk whenever a send finds playback already caught up (incl. the first send after a `cut()`).
   * Scopes `cut()` to the run it's ending, so silencing a short run can't reach an earlier, already-finished one.
   */
  currentRunBytes: number;
  /**
   * Of `bytesSent`, bytes `cut()` proved will never be heard: the still-unconfirmed tail when `STOP_FRAME` went out, frozen since the reset below erases the cursor `playedBytes()` would read it from.
   * Only ever grows.
   */
  silencedBytes: number;
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
        playbackDoneAt: 0,
        // Closed by default: a sink nobody has opened must never reach the room.
        enabled: false,
        // Grey by default: nothing is expected of Archie until it is named.
        engaged: false,
        closedDropBytes: 0,
        suppressed: false,
        suppressedSince: 0,
        lastDropAt: 0,
        droppedBytes: 0,
        bytesSent: 0,
        currentRunBytes: 0,
        silencedBytes: 0,
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

  function endSuppression(botId: string, channel: OutChannel, reason: string): void {
    if (channel.suppressed) {
      channel.suppressed = false;
      logger.system(
        `Voice: barge-in suppression for bot ${botId} ended (${reason}) after dropping ` +
        `${Math.round(channel.droppedBytes / BYTES_PER_MS)}ms of agent audio`
      );
      channel.droppedBytes = 0;
    }
  }

  function enqueue(botId: string, pcm: Buffer): void {
    const channel = channelFor(botId);

    // Output gate, checked first: drops, not queues — a replayed stale answer is worse than none.
    if (!channel.enabled) {
      channel.closedDropBytes += pcm.length;
      return;
    }

    if (channel.suppressed) {
      const now = Date.now();
      if (now - channel.lastDropAt >= TURN_GAP_MS) {
        endSuppression(botId, channel, 'quiet gap, so this frame starts a new turn');
      } else if (now - channel.suppressedSince >= MAX_SUPPRESSION_MS) {
        endSuppression(botId, channel, 'ceiling reached');
      } else {
        // Not counted into `playbackDoneAt`: `isSpeaking()` must read false while silent, or the brain keeps firing `cut()` at ordinary side-talk, re-arming this forever.
        channel.lastDropAt = now;
        channel.droppedBytes += pcm.length;
        return;
      }
    }

    if (channel.socket && channel.socket.readyState === WS_OPEN) {
      channel.socket.send(pcm);
      channel.currentRunBytes =
        Date.now() > channel.playbackDoneAt ? pcm.length : channel.currentRunBytes + pcm.length;
      channel.bytesSent += pcm.length;
      // The page plays chunks back to back — a single advancing cursor models that exactly.
      channel.playbackDoneAt = Math.max(Date.now(), channel.playbackDoneAt) + pcm.length / BYTES_PER_MS;
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
    // Freezes the still-unconfirmed tail — see `playedBytes` for why.
    channel.silencedBytes += unconfirmedTailBytes(channel, Date.now());
    channel.pending = [];
    channel.pendingBytes = 0;
    channel.playbackDoneAt = 0;
    if (channel.socket && channel.socket.readyState === WS_OPEN) {
      // The page silences inside one audio quantum of receiving this.
      channel.socket.send(STOP_FRAME);
    }

    // Silencing the page is only half a barge-in: the Voice Agent keeps handing us the rest of the utterance — without suppression, the next frame resumes it mid-word.
    // A second cut in the same window mustn't restart the ceiling, or side-talk could hold the bot mute indefinitely.
    const now = Date.now();
    if (!channel.suppressed) {
      channel.suppressed = true;
      channel.suppressedSince = now;
      channel.droppedBytes = 0;
    }
    channel.lastDropAt = now;
  }

  /** The coarse "there's a meeting" switch — opened once Recall attaches to our page. See {@link AudioSink.setEnabled}. */
  function setEnabled(botId: string, open: boolean): void {
    const channel = channelFor(botId);
    if (open) {
      // Transition only; re-opening an open gate does nothing.
      if (!channel.enabled) {
        channel.enabled = true;
        const dropped = Math.round(channel.closedDropBytes / BYTES_PER_MS);
        channel.closedDropBytes = 0;
        logger.system(
          `Voice: output gate opened for bot ${botId}` +
          (dropped > 0 ? ` (the closed gate had dropped ${dropped}ms of agent audio)` : '')
        );
      }
    } else {
      // Closing must silence the room now, not drain the queue — exactly what a barge-in does; reuse it.
      cut(botId);
      channel.enabled = false;
      // The suppression `cut()` just armed guards one killed utterance; with the gate shut it guards nothing — carrying it forward would open the next exchange muted.
      channel.suppressed = false;
      channel.droppedBytes = 0;
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
    if (engaged) {
      // Being addressed means a fresh turn is coming — the precise un-suppress boundary a barge-in needs, no inference or timer.
      // Runs even without a transition: re-engaging mid-exchange is still a new turn.
      endSuppression(botId, channel, 'engaged with the room');
    }
  }

  function isSpeaking(botId: string): boolean {
    const channel = channels.get(botId);
    if (!channel) {
      return false;
    }
    return channel.pendingBytes > 0 || Date.now() < channel.playbackDoneAt + PIPELINE_TAIL_MS;
  }

  /**
   * Of the current run's bytes, how many aren't yet certainly past `PIPELINE_TAIL_MS` — same margin `isSpeaking` adds for "still speaking," here read as "not yet confirmed played."
   * Clamped to `currentRunBytes`: the margin can outweigh a run shorter than it.
   */
  function unconfirmedTailBytes(channel: OutChannel, atTime: number): number {
    const raw = Math.max(0, channel.playbackDoneAt - atTime + PIPELINE_TAIL_MS) * BYTES_PER_MS;
    return Math.min(channel.currentRunBytes, raw);
  }

  /**
   * `AudioSink.playedBytes()` — like `isSpeaking`, same cursor/margin, but reversed: `isSpeaking` adds it (spurious `cut()`s are free); this subtracts it, since crediting an unheard byte is the defect this method retires.
   *
   * `silencedBytes` makes this hold across a `cut()`: resetting `playbackDoneAt` to 0 is correct for `isSpeaking` (must go false at once), but naively read here it'd credit the just-silenced tail as finished, since "unconfirmed" against a reset cursor is always ~0.
   * `cut()` freezes that tail into `silencedBytes` first, so it stays excluded rather than credited the instant the cursor resets.
   */
  function playedBytes(botId: string): number {
    const channel = channels.get(botId);
    if (!channel) {
      return 0;
    }
    return channel.bytesSent - channel.silencedBytes - unconfirmedTailBytes(channel, Date.now());
  }

  return {
    handlePageSocket(botId: string, ws: WebSocket): void {
      const channel = channelFor(botId);
      const previous = channel.socket;
      channel.socket = ws;
      if (previous && previous !== ws) {
        // Page reconnected (retries on a drop, or Recall reloads it) — old socket is dead weight; close it, one page per bot.
        previous.close();
      }

      ws.on('message', (data: RawData, isBinary: boolean) => {
        if (isBinary) {
          // The page is a sink; binary back means something upstream is confused about this socket's direction.
          logger.warn('Voice', `Ignoring unexpected binary frame from bot ${botId}'s output page`);
        } else {
          // Status frames only: the page reports AudioContext state on connect — quickest way to spot a context stuck suspended in headless Chrome (silence, no other symptom).
          logger.system(`Voice: output page ${botId} → ${String(data).slice(0, 200)}`);
        }
      });

      ws.on('close', () => {
        if (channel.socket === ws) {
          channel.socket = null;
          // Same freeze as `cut()`, and for the same reason — see `playedBytes`.
          channel.silencedBytes += unconfirmedTailBytes(channel, Date.now());
          // With no page, nothing plays; leaving the cursor in the future keeps `isSpeaking()` lying until it expires.
          channel.playbackDoneAt = 0;
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
          playedBytes: () => playedBytes(botId),
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
      } else if (msg.pcm) {
        this.chunks.push(msg.pcm);
        this.queued += msg.pcm.length;
      }
    };
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

    const playing = this.queued > 0 || this.gain > 0;
    if (playing !== this.playing) {
      this.playing = playing;
      this.port.postMessage({ type: 'playing', playing: playing });
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

/**
 * The Output Media page: Recall renders this as the bot's camera and mic.
 * `botName` is optional only because the hub's callers don't all carry the config — pass `cfg.botName` when at hand; it's what the room sees on the bot's video tile.
 */
export function renderPage(botId: string, wsUrl: string, botName = 'Archie'): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(botName)} · voice</title>
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
    <div class="name">${escapeHtml(botName)}</div>
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
      node.port.onmessage = function (event) {
        if (event.data && event.data.type === 'playing') { playing = !!event.data.playing; render(); }
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
