/**
 * Soniox: speech out, and nothing else.
 *
 * Chosen because Deepgram's Aura-2 has no Russian voice — Soniox `tts-rt-v2` speaks one voice across 64 languages, so it answers in both English and Russian.
 *
 * Wire-level concerns only: URL, auth, framing, chunk decoding. Sentence emission, barge-in policy and output gating live above it. Implements {@link SpeechSession}; knows nothing about meetings.
 *
 * Never throws: audio-path failures (bad key, dropped socket, bad frame) log instead of killing the engine.
 *
 * **One stream per turn, not per sentence.** A turn is buffered whole and synthesised as a single utterance: one start frame, the full text, one `text_end`. `text_end` is where the synthesizer puts terminal intonation, so one per sentence made a three-sentence reply land in the room as three finished-sounding announcements instead of one flowing turn — that was the defect. On a single-sentence reply the frames are identical either way.
 *
 * Two measured wire facts drive the framing, and both dissolve into the same rule — text and `text_end` ship together, in one flush, so no stream is ever left open waiting:
 *  1. **Nothing synthesizes until `text_end`.** Below ~150 chars, Soniox emits no audio until end-of-input (measured: 0 chunks/4s at 64 chars, 19 at 152) — irrelevant here, since `text_end` rides along with the text.
 *  2. **An open stream awaiting text is killed after ~5s** (`request_timeout`) — never armed here, for the same reason.
 * A third shapes connection handling: **no warm idle socket** — see {@link ensureLink}.
 *
 * What buffering costs is the generation time of the sentences after the first, not a round trip: the whole model call is median 770ms, p90 1,751ms, max 2,562ms, and ~620ms of that is Cerebras' fixed per-request admission floor, so the tokens themselves are on the order of 150ms. Against that it removes one synthesis admission per extra sentence (`ttfbMs` median 310ms), so a multi-sentence reply is plausibly faster end to end as well as smoother. The one case where buffering would cost the room silence is bounded by {@link STALL_FLUSH_MS}; see {@link Round.queue} for why streams are then serialised.
 *
 * **KNOWN QUIRK, NOT HANDLED: square brackets** — Soniox's inline audio-tag syntax; bracketed content in ordinary text is silently deleted, no error. Low exposure (only prose is spoken, not `CHAT:` ids/hashes). Fix in `prompts/voice-speaking.md`, not here.
 */

import WebSocket from 'ws';

import { logger } from '../system/logger.js';
import type { SpeechResult, SpeechSession, SpeechStream, VoiceConfig } from './types.js';

const LOG = 'voice-soniox';

/** Soniox's US endpoint. The key is US-only — EU/JP 401 it; regions are separate deployments with separate credentials. */
const SONIOX_URL = 'wss://tts-rt.soniox.com/tts-websocket';

/** Voice approved by a native Russian speaker, incl. mixed Russian/English terms. This voice id isn't language-specific — language is a separate mandatory field, so one voice answers both. Test both languages before changing either. */
const TTS_MODEL = 'tts-rt-v2';
const TTS_VOICE = 'Adrian';

/**
 * Raw little-endian PCM16 mono 24kHz, no container — measured headerless across 603 chunks (no RIFF/WAVE/Ogg/MPEG magic). Pinned in the start frame, asserted in a test: a mismatch is the request's fault, not the decoder's.
 */
const AUDIO_FORMAT = 'pcm_s16le';
const SAMPLE_RATE = 24000;

/** Watchdog on progress, not total length: a stalled answer settles, a merely long one doesn't. */
const AUDIO_WATCHDOG_MS = 6_000;

/**
 * How long a complete sentence may sit buffered while the reply is still being written, before it is synthesised without the rest.
 *
 * The guard exists because buffering changes the failure mode: generation stalling mid-reply now leaves the room in silence rather than mid-sentence, bounded only by `GENERATION_TIMEOUT_MS` (15s, comprehension.ts), and 15 seconds of dead air is worse than a seam. Sits above the observed maximum `decideMs` of 2,562ms (median 770ms, p90 1,751ms), so on measured behaviour it never fires: it bounds the pathological case rather than shaping the normal one.
 */
const STALL_FLUSH_MS = 3_000;

/** Measured: once a stream has run, keepalives extend idle survival to 182s (vs 42s without) — headroom between sentences. Doesn't buy a warm socket at meeting start — see {@link ensureLink}. */
const KEEPALIVE_MS = 15_000;

const LIMIT_EXCEEDED = 429;

/** Consumer callbacks run inside socket handlers, where a throw would be fatal. */
function guarded(label: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    logger.error(LOG, `Soniox ${label} handler threw`, error);
  }
}

/** Soniox's key travels in the message body (not a header, unlike Deepgram) — an error frame echoing the request could leak it; scrub before truncating, or a key splits mid-cut. Every key on the config, not only Soniox's: an echoed request isn't choosy about what it echoes. */
function safeForLog(text: string, cfg: VoiceConfig, max = 300): string {
  let safe = text;
  for (const secret of [cfg.sonioxApiKey, cfg.deepgramApiKey, cfg.cerebrasApiKey]) {
    // Length floor: splitting on '' would mark every character.
    if (secret.length >= 8) {
      safe = safe.split(secret).join('[redacted]');
    }
  }
  return safe.length > max ? `${safe.slice(0, max)}...` : safe;
}

/**
 * ISO 639-1 only, never omitted — omitted, `null`, `""` all reject as "Missing language"; BCP 47 forms like `en-US` are invalid too. Exactly two valid values.
 *
 * Choice is load-bearing: mixed Russian-with-English sent as `en` was judged non-native (accent 3/5); sent as `ru`, judged native.
 *
 * **Presence, not proportion:** any Cyrillic means Russian. Never a character count or majority vote — "Проблема в rate limiter." has 12 Latin vs 8 Cyrillic chars; a count would pick English and mangle the sentence.
 */
function hasCyrillic(text: string): boolean {
  return /\p{Script=Cyrillic}/u.test(text);
}

/** The slice of Soniox's server messages this module acts on. */
interface SonioxMessage {
  stream_id?: string;
  audio?: string;
  audio_end?: boolean;
  terminated?: boolean;
  error_code?: number;
  error_message?: string;
  error_type?: string;
}

/** One sentence handed over by the caller, waiting for the flush that will speak it. */
interface Sentence {
  text: string;
  /** `say`'s `onSentenceComplete`. */
  onComplete: () => void;
}

/** One stream on this wire: a whole turn, spoken as a single utterance — or, if {@link STALL_FLUSH_MS} fired, the part of it that had been buffered by then. */
interface Utterance {
  id: string;
  /** The buffered sentences joined, which is what actually goes out. */
  text: string;
  language: string;
  /** The sentences this stream carries, in hand-over order; every one completes when the stream reports `terminated` (see {@link handleMessage}). */
  sentences: Sentence[];
}

type LinkState = 'idle' | 'connecting' | 'ready' | 'dead';

interface Round {
  onPcm: (pcm: Buffer) => void;
  /** When the first text went out, for {@link SpeechResult.msToFirstByte}. */
  firstTextAt: number | null;
  bytes: number;
  msToFirstByte: number | null;
  awaitingFirstChunk: boolean;
  /** Sentences handed over but not yet flushed — the turn being buffered. Emptied by {@link flush}, whether that is `end()` or the stall guard. */
  buffer: Sentence[];
  /** Armed while the buffer holds something; see {@link STALL_FLUSH_MS}. */
  stall: NodeJS.Timeout | null;
  /** Serialized deliberately: Soniox multiplexes one socket, so concurrent streams' chunks would interleave on return — a byte-stream sink, not a mixer, would play noise. Ordinarily holds one stream for the whole turn; a stall flush is what can put a second behind it. */
  queue: Utterance[];
  active: Utterance | null;
  ending: boolean;
  /** Sticky once Russian appears: language belongs to the reply, not the sentence. Buffering settles most of this — the whole turn is one stream, so one language — and stickiness still covers the rest: after a stall flush, a later all-Latin "Rate limiter." speaks as the Russian term rather than switching mid-answer. */
  sawCyrillic: boolean;
  settled: boolean;
  resolve: (r: SpeechResult) => void;
  watchdog: NodeJS.Timeout | null;
}

export function createSonioxSpeechSession(cfg: VoiceConfig): SpeechSession {
  let link: WebSocket | null = null;
  let state: LinkState = 'idle';
  let closed = false;
  let round: Round | null = null;
  const queue: string[] = [];
  let keepalive: NodeJS.Timeout | null = null;
  let streamSeq = 0;

  function stopKeepalive(): void {
    if (keepalive !== null) {
      clearInterval(keepalive);
      keepalive = null;
    }
  }

  function stopTimer(t: NodeJS.Timeout | null): null {
    if (t !== null) clearTimeout(t);
    return null;
  }

  /**
   * No warm socket — measured, not chosen: an unconfigured connection closes at ~10.4s regardless of keepalives, so an "open at session start, keep hot" shape doesn't exist here; an early connect is just dead by the first question.
   * Free substitute: `speak()` starts the connect; `meeting.ts` calls it before the model call, so the ~310ms handshake hides under the model's ~900ms-to-first-sentence. Once a stream runs, the socket holds (182s idle, keepalives) for reuse.
   */
  function ensureLink(): void {
    if (closed) return;
    if (state === 'idle' || state === 'dead') {
      connect();
    }
  }

  function send(frame: Record<string, unknown>): void {
    if (closed) return;

    const text = JSON.stringify(frame);
    const ws = link;
    if (state === 'ready' && ws !== null && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(text);
      } catch (error) {
        logger.warn(LOG, 'Sending to the Soniox socket failed', error);
      }
    } else {
      // Held, not dropped — socket (re)opens underneath: an answer starting mid-connect, or after an idle close, must still be spoken.
      queue.push(text);
      ensureLink();
    }
  }

  function drainQueue(): void {
    const ws = link;
    if (state !== 'ready' || ws === null) return;
    for (const text of queue.splice(0, queue.length)) {
      try {
        ws.send(text);
      } catch (error) {
        logger.warn(LOG, 'Sending a queued frame to the Soniox socket failed', error);
      }
    }
  }

  function armWatchdog(r: Round): void {
    r.watchdog = stopTimer(r.watchdog);
    r.watchdog = setTimeout(() => {
      if (r.bytes === 0) {
        settleRound(r, `no audio within ${AUDIO_WATCHDOG_MS}ms`);
      } else {
        settleRound(r, `audio stalled for ${AUDIO_WATCHDOG_MS}ms`);
      }
    }, AUDIO_WATCHDOG_MS);
  }

  /**
   * `why`: set only when synthesis stopped early (stall, lost socket, rejection) — surfaces via {@link SpeechResult.incomplete}, so the caller knows the room heard less than the transcript says.
   * `abort`/`close` settle with no `why`: the caller's own stop, already tracked.
   */
  function settleRound(r: Round, why?: string): void {
    if (r.settled) return;
    r.settled = true;
    r.watchdog = stopTimer(r.watchdog);
    r.stall = stopTimer(r.stall);
    // Dropped without completing: nothing buffered was ever spoken, and reporting it as spoken is how the transcript starts lying.
    r.buffer.length = 0;
    r.queue.length = 0;
    r.active = null;
    if (why !== undefined) {
      logger.warn(LOG, `Soniox synthesis ended after ${r.bytes} bytes (${why})`);
    }
    if (round === r) round = null;
    r.resolve({ bytes: r.bytes, msToFirstByte: r.msToFirstByte, incomplete: why ?? null });
  }

  /**
   * Turns the buffered sentences into one stream and queues it. The one place a stream is minted, so `end()` and the stall guard produce the same shape.
   *
   * Language is decided here rather than at hand-over: by flush time the whole buffered turn has been seen, so a reply whose first sentence is all-Latin and whose second is Russian goes out as Russian rather than committing to English before the reply was whole.
   */
  function flush(r: Round): void {
    r.stall = stopTimer(r.stall);
    if (r.settled || r.buffer.length === 0) return;

    const sentences = r.buffer.splice(0, r.buffer.length);
    streamSeq += 1;
    r.queue.push({
      id: `s${streamSeq}`,
      // One space: the sentences arrive already sanitized and terminated, and this is the whole turn read as one utterance.
      text: sentences.map((sentence) => sentence.text).join(' '),
      language: r.sawCyrillic ? 'ru' : 'en',
      sentences,
    });
    pump(r);
  }

  /** Armed on the first sentence into an empty buffer and left alone after: the window is measured from the moment the room had something sayable, not from the newest sentence, or a reply dribbling out a sentence at a time would push it forever. */
  function armStall(r: Round): void {
    if (r.stall === null) {
      r.stall = setTimeout(() => {
        r.stall = null;
        logger.debug(LOG, `A sentence has been buffered for ${STALL_FLUSH_MS}ms with the reply unfinished — speaking it now`);
        flush(r);
      }, STALL_FLUSH_MS);
      r.stall.unref();
    }
  }

  /** Start frame carries the API key — never log it. `text_end` rides with the text: the flush is the whole of what this stream will speak, so an open stream would only earn a `request_timeout`. */
  function pump(r: Round): void {
    if (r.settled || r.active !== null) return;

    const next = r.queue.shift();
    if (next === undefined) {
      if (r.ending) {
        settleRound(r);
      }
      return;
    }

    r.active = next;
    if (r.firstTextAt === null) r.firstTextAt = Date.now();
    send({
      api_key: cfg.sonioxApiKey,
      model: TTS_MODEL,
      voice: TTS_VOICE,
      language: next.language,
      audio_format: AUDIO_FORMAT,
      sample_rate: SAMPLE_RATE,
      stream_id: next.id,
    });
    send({ text: next.text, text_end: true, stream_id: next.id });
    armWatchdog(r);
  }

  function handleAudio(r: Round, msg: SonioxMessage): void {
    const encoded = msg.audio;
    if (encoded === undefined || encoded.length === 0) return;

    const pcm = Buffer.from(encoded, 'base64');
    if (pcm.length === 0) return;

    if (r.awaitingFirstChunk) {
      r.awaitingFirstChunk = false;
      r.msToFirstByte = r.firstTextAt === null ? null : Date.now() - r.firstTextAt;
    }
    r.bytes += pcm.length;
    armWatchdog(r);
    guarded('speech chunk', () => r.onPcm(pcm));
  }

  function handleMessage(raw: string): void {
    let msg: SonioxMessage;
    try {
      msg = JSON.parse(raw) as SonioxMessage;
    } catch {
      logger.warn(LOG, `Soniox sent an unparseable frame: ${safeForLog(raw, cfg, 120)}`);
      return;
    }

    const r = round;
    // Audio accepted only for the stream on the wire — that check alone makes barge-in safe without replacing the socket. Cancel is a true discard: at most one non-active chunk arrives after (29-51ms, in flight), owned by nobody.
    const active = r === null || r.settled ? null : r.active;
    const mine = active !== null && msg.stream_id === active.id;

    if (msg.error_code !== undefined) {
      const detail = safeForLog(
        `${msg.error_type ?? ''} ${msg.error_message ?? ''}`.trim() || String(msg.error_code),
        cfg,
      );
      if (msg.error_code === LIMIT_EXCEEDED) {
        // Org-wide cap: three concurrent TTS streams, one held per meeting — a 429 means someone else is synthesizing, not a leak here. Named explicitly: the fix is raising the cap, not debugging us.
        logger.warn(LOG, `Soniox refused the stream: concurrency limit reached (${detail})`);
      } else {
        logger.warn(LOG, `Soniox error ${msg.error_code}: ${detail}`);
      }
      if (r !== null && mine) {
        // Room heard a truncated answer from here — fail the round with a reason; the caller already handles it, no quiet path.
        settleRound(r, `Soniox error ${msg.error_code}: ${detail}`);
      }
      return;
    }

    if (r !== null && mine && msg.audio !== undefined) {
      handleAudio(r, msg);
    }

    if (msg.terminated === true && r !== null && mine) {
      // `terminated` means every sentence in this stream is now wholly behind us, so each one completes here, in hand-over order — `meeting.ts` reads the byte count at that moment and pairs offsets with sentences by index, so the order is the contract (see D11).
      // What one stream per turn costs is resolution, not truth: the synthesizer cannot say where sentence one ended inside a single stream, so the sentences of a turn share its end offset. `answerRoom`'s own estimate covers the rest, and it errs towards crediting the room with less than it heard — never more.
      const finished = r.active;
      r.active = null;
      r.watchdog = stopTimer(r.watchdog);
      if (finished !== null) {
        for (const sentence of finished.sentences) {
          guarded('sentence complete', sentence.onComplete);
        }
      }
      pump(r);
    }
  }

  function connect(): void {
    if (closed) return;

    const startedAt = Date.now();
    const ws = new WebSocket(SONIOX_URL);
    link = ws;
    state = 'connecting';

    ws.on('open', () => {
      if (link !== ws) return;

      state = 'ready';
      // Recorded, not acted on: Soniox has an undocumented route lottery — ~1/3 draw a path ~105ms slower lifelong; handshake time predicts which, no overlap (301-325ms fast vs 428-481ms slow, measured). Redraw-on-reconnect was cut (costs more than it saves); logged to show how often the slow route bites.
      logger.debug(LOG, `Soniox socket open in ${Date.now() - startedAt}ms`);
      drainQueue();
      keepalive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ keep_alive: true }));
          } catch (error) {
            logger.warn(LOG, 'Soniox keepalive failed', error);
          }
        }
      }, KEEPALIVE_MS);
      // unref: a forgotten keepalive must not hold the process open.
      keepalive.unref();
    });

    ws.on('message', (raw) => {
      try {
        if (link !== ws) return; // a frame from a socket we have already replaced
        handleMessage(raw.toString());
      } catch (error) {
        logger.error(LOG, 'Soniox frame handling failed', error);
      }
    });

    // ws hands a non-101 response here without emitting further — must destroy it manually.
    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0;
      res.destroy();
      if (link === ws) retire(`upgrade rejected with HTTP ${status}`);
    });

    ws.on('error', (error) => {
      if (link === ws) retire(safeForLog(error.message, cfg, 200));
    });

    ws.on('close', () => {
      if (link === ws) retire('socket closed');
    });
  }

  /** Cost hinges on whether a stream was on the lost socket: one in flight fails with a reason; none is an ordinary idle close (~182s quiet, or ~10.4s pre-configure), free — next frame reconnects via `send`/`ensureLink`. Failing the round here too turns silence into breakage. */
  function retire(why: string): void {
    if (closed || state === 'dead') return;
    state = 'dead';
    stopKeepalive();

    const ws = link;
    link = null;
    if (ws !== null) {
      try {
        ws.close();
      } catch (error) {
        logger.warn(LOG, 'Closing the Soniox socket failed', error);
      }
    }

    const r = round;
    if (r !== null && !r.settled && (r.active !== null || r.bytes > 0)) {
      settleRound(r, `Soniox socket lost: ${why}`);
    } else {
      logger.debug(LOG, `Soniox socket down while idle (${why}); the next sentence reconnects`);
    }
  }

  return {
    speak(onPcm: (pcm: Buffer) => void): SpeechStream {
      const previous = round;
      if (previous !== null && !previous.settled) {
        abortRound(previous);
      }

      const r: Round = {
        onPcm,
        firstTextAt: null,
        bytes: 0,
        msToFirstByte: null,
        awaitingFirstChunk: true,
        buffer: [],
        stall: null,
        queue: [],
        active: null,
        ending: false,
        sawCyrillic: false,
        settled: false,
        resolve: () => {},
        watchdog: null,
      };
      const done = new Promise<SpeechResult>((resolve) => {
        r.resolve = resolve;
      });
      round = r;
      // Started here rather than at session creation; see {@link ensureLink}.
      ensureLink();

      return {
        say(text: string, onSentenceComplete: () => void): void {
          // Sent as-is: the sentence emitter already sanitized it; a second pass here is just another place to get it wrong.
          const spoken = text.trim();
          if (spoken.length === 0 || r.settled) return;

          r.sawCyrillic = r.sawCyrillic || hasCyrillic(spoken);
          r.buffer.push({ text: spoken, onComplete: onSentenceComplete });
          if (r.ending) {
            // Nothing left to wait for: a sentence arriving after `end()` has no turn to be buffered into.
            flush(r);
          } else {
            armStall(r);
          }
        },

        end(): Promise<SpeechResult> {
          if (!r.settled) {
            r.ending = true;
            // The turn is whole, so this is where it goes out — one stream carrying all of it, or the remainder if the stall guard already spoke the front.
            flush(r);
            // Everything may already have been spoken if the audio outran the caller, or there may have been nothing to say at all.
            pump(r);
          }
          return done;
        },

        abort(): void {
          abortRound(r);
        },
      };
    },

    close(): void {
      if (closed) return;
      closed = true;
      const r = round;
      if (r !== null) {
        cancelActive(r);
        settleRound(r);
      }
      stopKeepalive();
      queue.length = 0;
      state = 'dead';

      const ws = link;
      link = null;
      if (ws !== null) {
        try {
          ws.close();
        } catch (error) {
          logger.warn(LOG, 'Closing the Soniox socket failed', error);
        }
      }
    },
  };

  function cancelActive(r: Round): void {
    const active = r.active;
    if (active === null) return;

    const ws = link;
    if (state === 'ready' && ws !== null && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ stream_id: active.id, cancel: true }));
      } catch (error) {
        logger.warn(LOG, 'Sending cancel to the Soniox socket failed', error);
      }
    }
  }

  /**
   * `cancel` stops the server generating, not just stops us playing — measured 105ms to termination.
   * Socket kept rather than replaced: a cancelled stream's id is never active again, so a straggler can't reach the next answer, saving a handshake per barge-in.
   */
  function abortRound(r: Round): void {
    if (r.settled) return;
    cancelActive(r);
    settleRound(r);
  }
}
