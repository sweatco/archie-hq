/**
 * Deepgram: Flux in, Aura out.
 *
 * Mono, one stream/participant — no Flux diarization; stream = speaker id.
 *
 * Never throws: audio-path failures (bad key, dropped socket, bad frame) log, not crash the engine.
 */

import WebSocket from 'ws';

import { logger } from '../system/logger.js';
import type { SpeechResult, SpeechSession, SpeechStream, VoiceConfig } from './types.js';

/**
 * Deepgram's default global endpoint; `DEEPGRAM_HOST` overrides.
 *
 * Don't default to EU unconfirmed — engine location is unresearched, and recording colleagues there is a privacy call, not just latency.
 */
const DEFAULT_DEEPGRAM_HOST = 'api.deepgram.com';

function deepgramHost(cfg: VoiceConfig): string {
  const host = cfg.deepgramHost?.trim();
  if (host === undefined || host.length === 0) {
    return DEFAULT_DEEPGRAM_HOST;
  } else {
    return host;
  }
}

const fluxUrl = (cfg: VoiceConfig): string => `wss://${deepgramHost(cfg)}/v2/listen`;
const speakUrl = (cfg: VoiceConfig): string => `wss://${deepgramHost(cfg)}/v1/speak`;

const TTS_MODEL = 'aura-2-orion-en';

/** Flux v2 has no `KeepAlive`; a ping holds an idle stream open (measured 20min zero-audio, no server close). */
const PING_MS = 20_000;

/** ~5s at 16kHz mono S16LE (32 kB/s); past that, oldest is dropped — recent audio beats complete audio live. */
const MAX_PENDING_BYTES = 160_000;

/** Watchdog on progress, not total length: a stalled answer settles, a merely long one doesn't. */
const AUDIO_WATCHDOG_MS = 6_000;

const SPEAK_PING_MS = 20_000;

/** Deepgram closes a speak socket at 60min, even mid-use — recycle at 55min idle, or the cap lands mid-answer. */
const SPEAK_RECYCLE_MS = 55 * 60_000;

/** Documented ceiling: 20 `Flush`/60s. A warm socket makes it per-meeting, not per-answer — spent deliberately (`mayFlushEarly`). */
const FLUSH_WINDOW_MS = 60_000;
const FLUSH_WINDOW_MAX = 20;

/** Left for the mandatory end-of-answer flushes when the budget runs low. */
const FLUSH_RESERVE = 3;



/** Consumer callbacks run inside socket handlers, where a throw would be fatal. */
function guarded(label: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    logger.error('voice', `Deepgram ${label} handler threw`, error);
  }
}

/** ws types binary frames as Buffer, but allows two other shapes. */
function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  } else if (Array.isArray(data)) {
    return Buffer.concat(data as Buffer[]);
  } else {
    return Buffer.from(data as ArrayBuffer);
  }
}

/** Token's in a header; an upstream echoing headers into an error body could leak it — scrub before truncating, or a key splits mid-cut. Secrets: {@link VoiceConfig.foreignSecrets}. */
function safeForLog(text: string, cfg: VoiceConfig, max = 500): string {
  let safe = text;
  for (const secret of [cfg.deepgramApiKey, cfg.anthropicApiKey, ...(cfg.foreignSecrets ?? [])]) {
    // Length floor: splitting on '' would mark every character.
    if (secret !== undefined && secret.length >= 8) {
      safe = safe.split(secret).join('[redacted]');
    }
  }
  return safe.length > max ? `${safe.slice(0, max)}...` : safe;
}

export type TurnEvent =
  | { kind: 'start' }
  | { kind: 'end'; transcript: string };

export interface TurnStream {
  /** Feed 16kHz mono S16LE PCM. Recall delivers exactly that, so nothing resamples on this path. */
  write(pcm: Buffer): void;
  /** True between a `start` and its `end` — this speaker has the floor. */
  isTurnOpen(): boolean;
  /** False once closed/died — meeting.ts reopens next packet. True while handshaking, so connecting isn't mistaken for dead. */
  isAlive(): boolean;
  close(): void;
}

/** The slice of Flux's v2 server messages this module acts on. */
interface FluxMessage {
  type?: string;
  event?: string;
  transcript?: string;
}

/**
 * Empty means Flux auto-detects. Deepgram rejects empty `language_hint` outright (HTTP 400 `INVALID_QUERY_PARAMETER`) — filtering empties is load-bearing, or a trailing comma kills every socket. Whitespace trimmed: people write "en, ru".
 */
function languageHints(cfg: VoiceConfig): string[] {
  return (cfg.languageHints ?? '')
    .split(',')
    .map((code) => code.trim())
    .filter((code) => code.length > 0);
}

/**
 * `flux-general-multi` auto-detects when unhinted, and can misdetect an utterance's whole language (not per-word). `language_hint` narrows candidates; Deepgram documents hinted accuracy ≈ monolingual models.
 *
 * **MUST be a repeated key** (`language_hint=en&language_hint=ru`, verified on the wire) — comma-joined (`en,ru`) is silently echoed back as one bogus code, disabling detection and dropping capitalization/punctuation.
 *
 * Deepgram validates parameter *names* strictly (`language_hints` → HTTP 400 `INVALID_QUERY_PARAMETER`) but not values — `zz` passes silently. A typo is only caught via `TurnInfo.languages_hinted`, the server's echo of what applied.
 *
 * PRIVACY — DO NOT REMOVE `mip_opt_out`: this bot records colleagues who never agreed to Deepgram's Model Improvement Program.
 */
function fluxParams(cfg: VoiceConfig): URLSearchParams {
  const params = new URLSearchParams({
    model: 'flux-general-multi',
    encoding: 'linear16',
    sample_rate: '16000',
    mip_opt_out: 'true',
  });
  for (const code of languageHints(cfg)) {
    params.append('language_hint', code);
  }
  return params;
}

export function openTurnStream(
  cfg: VoiceConfig,
  opts: {
    label: string;
    onEvent: (e: TurnEvent) => void;
  },
): TurnStream {
  const url = `${fluxUrl(cfg)}?${fluxParams(cfg).toString()}`;

  let socket: WebSocket | null = null;
  let ping: NodeJS.Timeout | null = null;
  let dead = false;
  let turnOpen = false;
  const pending: Buffer[] = [];
  let pendingBytes = 0;
  let warnedAboutBacklog = false;

  function stopPing(): void {
    if (ping !== null) {
      clearInterval(ping);
      ping = null;
    }
  }

  /** `turnOpen` clear is load-bearing: room silence gates Archie speaking. A stream dying mid-turn must release the floor, or the bot stays muted forever. */
  function teardown(): void {
    dead = true;
    turnOpen = false;
    stopPing();
    pending.length = 0;
    pendingBytes = 0;

    const ws = socket;
    socket = null;
    if (ws !== null) {
      try {
        ws.close();
      } catch (error) {
        logger.warn('voice', `Closing the Flux stream for ${opts.label} failed`, error);
      }
    }
  }

  /** No reconnect here — meeting.ts lazily opens on the next packet; reconnecting here would race it. */
  function retire(why: string): void {
    if (dead) return;
    logger.warn('voice', `Flux stream for ${opts.label} ended (${why}); reopens on next audio`);
    teardown();
  }

  function flushPending(ws: WebSocket): void {
    const queued = pending.splice(0, pending.length);
    pendingBytes = 0;
    for (const chunk of queued) {
      try {
        ws.send(chunk);
      } catch (error) {
        logger.warn('voice', `Flux send failed for ${opts.label}`, error);
      }
    }
  }

  function handleMessage(raw: string): void {
    let msg: FluxMessage;
    try {
      msg = JSON.parse(raw) as FluxMessage;
    } catch {
      return; // Flux sends JSON only; an unparseable frame is not ours to fix
    }

    if (msg.type === 'TurnInfo') {
      // Only StartOfTurn/EndOfTurn matter; `Update` fires ~every 250ms, even pre-speech, empty transcript.
      // EagerEndOfTurn/TurnResumed can't arrive: no `eager_eot_threshold` set — Flux's eager lead measured only ~39ms, not worth a speculative transcript often discarded.
      if (msg.event === 'StartOfTurn') {
        turnOpen = true;
        guarded('turn start', () => opts.onEvent({ kind: 'start' }));
      } else if (msg.event === 'EndOfTurn') {
        turnOpen = false;
        // `TurnInfo.transcript`: full current-turn text, not incremental — later messages may revise it; replace, don't accumulate.
        const transcript = (msg.transcript ?? '').trim();
        guarded('turn end', () => opts.onEvent({ kind: 'end', transcript }));
      }
    } else if (msg.type === 'Connected') {
      logger.system(`Voice: Flux stream open for ${opts.label}`);
    } else if (msg.type === 'FatalError') {
      // Field names here are unverified, so the whole frame is the diagnostic.
      retire(safeForLog(raw, cfg, 300));
    }
    // ConfigureSuccess/Failure cannot arrive — we send no Configure message.
  }

  function connect(): void {
    const ws = new WebSocket(url, {
      headers: { Authorization: `Token ${cfg.deepgramApiKey}` },
    });
    socket = ws;

    ws.on('open', () => {
      flushPending(ws);
      ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.ping();
          } catch (error) {
            logger.warn('voice', `Flux ping failed for ${opts.label}`, error);
          }
        }
      }, PING_MS);
      // unref: a forgotten ping shouldn't hold the process open; meeting.ts does the same for its timers.
      ping.unref();
    });

    ws.on('message', (raw) => {
      try {
        handleMessage(raw.toString());
      } catch (error) {
        logger.error('voice', `Flux message handling failed for ${opts.label}`, error);
      }
    });

    // ws hands a non-101 response here without emitting further — must destroy it manually to surface the real rejection.
    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0;
      res.destroy();
      retire(`upgrade rejected with HTTP ${status}`);
    });

    ws.on('error', (error) => retire(safeForLog(error.message, cfg, 200)));
    ws.on('close', (code, reason) => retire(`closed ${code} ${safeForLog(reason.toString(), cfg, 200)}`.trim()));
  }

  connect();

  return {
    write(pcm: Buffer): void {
      if (dead) return;

      const ws = socket;
      if (ws !== null && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(pcm);
        } catch (error) {
          logger.warn('voice', `Flux send failed for ${opts.label}`, error);
        }
      } else {
        // Still handshaking: buffered, not dropped — may be the opening words naming the bot.
        pending.push(pcm);
        pendingBytes += pcm.length;
        while (pendingBytes > MAX_PENDING_BYTES && pending.length > 0) {
          const oldest = pending.shift();
          pendingBytes -= oldest?.length ?? 0;
          if (!warnedAboutBacklog) {
            warnedAboutBacklog = true;
            logger.warn('voice', `Flux backlog full for ${opts.label}; dropping the oldest buffered audio`);
          }
        }
      }
    },

    isTurnOpen(): boolean {
      return turnOpen;
    },

    isAlive(): boolean {
      return !dead;
    },

    close(): void {
      if (dead) return;
      teardown();
    },
  };
}

/** One warm Aura socket/meeting: a fresh connection costs ~390ms (DNS+TCP+TLS+upgrade), most of the old 534ms TTFB — paid every answer otherwise. (Soniox can't; see `ensureLink`.) */
type LinkState = 'connecting' | 'ready' | 'dead';

interface Round {
  onPcm: (pcm: Buffer) => void;
  firstTextAt: number | null;
  bytes: number;
  msToFirstByte: number | null;
  awaitingFirstChunk: boolean;
  /** True once the final Flush is out and we are waiting for `Flushed`. */
  ending: boolean;
  /** Confirmations needed before round-end: sentence + closing flush can overlap — the first `Flushed` alone cuts this short; a stale one cuts the next. */
  needConfirmed: number | null;
  settled: boolean;
  resolve: (r: SpeechResult) => void;
  watchdog: NodeJS.Timeout | null;
}

export function createSpeechSession(cfg: VoiceConfig): SpeechSession {
  const url = `${speakUrl(cfg)}?${speakParams().toString()}`;

  let link: WebSocket | null = null;
  let state: LinkState = 'connecting';
  let closed = false;
  let round: Round | null = null;
  const queue: string[] = [];
  let flushes: number[] = [];
  let flushesSent = 0;
  let flushesConfirmed = 0;
  let ping: NodeJS.Timeout | null = null;
  let recycle: NodeJS.Timeout | null = null;

  function stopTimer(t: NodeJS.Timeout | null): null {
    if (t !== null) clearTimeout(t);
    return null;
  }

  function send(frame: Record<string, unknown>): void {
    if (closed) return;

    const text = JSON.stringify(frame);
    const ws = link;
    if (state === 'ready' && ws !== null && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(text);
      } catch (error) {
        logger.warn('voice', 'Sending to the Aura socket failed', error);
      }
    } else if (state === 'connecting') {
      // Held, not dropped: an answer starting while the socket warms (incl. a barge-in re-warm) must still be spoken.
      queue.push(text);
    } else {
      // Dead: re-warm and hold the frame, so a stale socket costs a handshake rather than silence.
      queue.push(text);
      connect();
    }
  }

  function drainQueue(): void {
    const ws = link;
    if (state !== 'ready' || ws === null) return;
    for (const text of queue.splice(0, queue.length)) {
      try {
        ws.send(text);
      } catch (error) {
        logger.warn('voice', 'Sending a queued frame to the Aura socket failed', error);
      }
    }
  }

  /** Nothing synthesizes until `Flush` (SDK "auto-flush" is a client timer, not server-side) — flush per sentence to stream audio incrementally. Docs warn frequent flushes hurt quality; skipped near budget so the end-of-answer flush fits. */
  function mayFlushEarly(): boolean {
    const now = Date.now();
    flushes = flushes.filter((t) => now - t < FLUSH_WINDOW_MS);
    return flushes.length < FLUSH_WINDOW_MAX - FLUSH_RESERVE;
  }

  function flush(): void {
    flushes.push(Date.now());
    flushesSent += 1;
    send({ type: 'Flush' });
    armWatchdog();
  }

  function armWatchdog(): void {
    const r = round;
    if (r === null) return;
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
   * `why`: set only when synthesis stopped early (stall, lost socket) — surfaces via {@link SpeechResult.incomplete}, so the caller knows the transcript outran what was heard.
   * `abort`/`close` settle with no `why`: the caller's own stop, already tracked.
   */
  function settleRound(r: Round, why?: string): void {
    if (r.settled) return;
    r.settled = true;
    r.watchdog = stopTimer(r.watchdog);
    if (why !== undefined) {
      logger.warn('voice', `Aura synthesis ended after ${r.bytes} bytes (${why})`);
    }
    if (round === r) round = null;
    r.resolve({ bytes: r.bytes, msToFirstByte: r.msToFirstByte, incomplete: why ?? null });
  }

  function handleAudio(raw: unknown): void {
    const r = round;
    // Audio still in flight from an abandoned answer belongs to nobody.
    if (r === null || r.settled) return;

    let pcm = toBuffer(raw);
    if (r.awaitingFirstChunk) {
      r.awaitingFirstChunk = false;
      r.msToFirstByte = r.firstTextAt === null ? null : Date.now() - r.firstTextAt;
      // A WAV header, if present, can only be on the first chunk.
      pcm = stripWavContainer(pcm);
    }
    if (pcm.length > 0) {
      r.bytes += pcm.length;
      armWatchdog();
      guarded('speech chunk', () => r.onPcm(pcm));
    }
  }

  function handleControl(raw: string): void {
    let msg: { type?: string; description?: string; code?: string };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      // Audio should only arrive as binary frames; surfaces it if that changes, instead of silently producing nothing.
      logger.warn('voice', `Aura sent an unparseable text frame: ${safeForLog(raw, cfg, 120)}`);
      return;
    }

    if (msg.type === 'Flushed') {
      flushesConfirmed += 1;
      const r = round;
      if (r !== null && r.ending && r.needConfirmed !== null && flushesConfirmed >= r.needConfirmed) {
        settleRound(r);
      }
    } else if (msg.type === 'Warning') {
      logger.warn(
        'voice',
        `Aura warning: ${safeForLog(`${msg.code ?? ''} ${msg.description ?? ''}`.trim(), cfg, 200)}`,
      );
    }
    // Metadata carries nothing this module acts on.
  }

  function stopTimers(): void {
    if (ping !== null) {
      clearInterval(ping);
      ping = null;
    }
    recycle = stopTimer(recycle);
  }

  function connect(): void {
    if (closed) return;

    const ws = new WebSocket(url, { headers: { Authorization: `Token ${cfg.deepgramApiKey}` } });
    link = ws;
    state = 'connecting';
    // Flush confirmations are per-socket, so a new socket starts the count over.
    flushesSent = 0;
    flushesConfirmed = 0;

    ws.on('open', () => {
      if (link !== ws) return;
      state = 'ready';
      drainQueue();
      ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.ping();
          } catch (error) {
            logger.warn('voice', 'Aura socket ping failed', error);
          }
        }
      }, SPEAK_PING_MS);
      // unref, as with the Flux ping: a forgotten keep-alive must not hold the process open.
      ping.unref();
      recycle = setTimeout(() => {
        // Only while idle: cycling under an answer would cut it off.
        if (round === null && !closed) {
          logger.system('Voice: recycling the Aura socket before its 60-minute cap');
          retire('recycled before the 60-minute cap', true);
        }
      }, SPEAK_RECYCLE_MS);
      recycle.unref();
    });

    ws.on('message', (raw, isBinary) => {
      try {
        if (link !== ws) return; // a frame from a socket we have already replaced
        if (isBinary) {
          handleAudio(raw);
        } else {
          handleControl(raw.toString());
        }
      } catch (error) {
        logger.error('voice', 'Aura frame handling failed', error);
      }
    });

    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0;
      res.destroy();
      if (link === ws) retire(`upgrade rejected with HTTP ${status}`, false);
    });

    ws.on('error', (error) => {
      if (link === ws) retire(safeForLog(error.message, cfg, 200), false);
    });

    ws.on('close', () => {
      if (link === ws) retire('socket closed', false);
    });
  }

  /** `rewarm`: reopens immediately (barge-in, 55min recycle) to skip a handshake; else dead till `speak()` reconnects — so a rejected key can't loop-reconnect all meeting. */
  function retire(why: string, rewarm: boolean): void {
    if (closed || state === 'dead') return;
    state = 'dead';
    stopTimers();

    const ws = link;
    link = null;
    if (ws !== null) {
      try {
        ws.close();
      } catch (error) {
        logger.warn('voice', 'Closing the Aura socket failed', error);
      }
    }

    const r = round;
    if (r !== null) settleRound(r, `Aura socket lost: ${why}`);

    if (rewarm) {
      connect();
    } else {
      logger.warn('voice', `Aura socket down (${why}); the next answer will reconnect`);
    }
  }

  connect();

  return {
    speak(onPcm: (pcm: Buffer) => void): SpeechStream {
      // A previous answer still in flight is abandoned, not interleaved — the server has one text buffer; two live answers would blend.
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
        ending: false,
        needConfirmed: null,
        settled: false,
        resolve: () => {},
        watchdog: null,
      };
      const done = new Promise<SpeechResult>((resolve) => {
        r.resolve = resolve;
      });
      round = r;

      return {
        say(text: string): void {
          const chunk = text.trim();
          if (chunk.length === 0 || r.settled) return;

          if (r.firstTextAt === null) r.firstTextAt = Date.now();
          send({ type: 'Speak', text: chunk });
          // Skipped when the budget is low; rides along with the next mandatory flush instead.
          if (mayFlushEarly()) {
            flush();
          }
        },

        end(): Promise<SpeechResult> {
          if (!r.settled) {
            r.ending = true;
            // Always flush here, budget or not — guarantees the tail of the answer is spoken.
            flush();
            r.needConfirmed = flushesSent;
            // May already be confirmed if the audio outran the caller.
            if (flushesConfirmed >= r.needConfirmed) settleRound(r);
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
      if (r !== null) settleRound(r);
      stopTimers();
      queue.length = 0;
      state = 'dead';

      const ws = link;
      link = null;
      if (ws !== null) {
        try {
          ws.send(JSON.stringify({ type: 'Close' }));
        } catch {
          // Socket already gone; the close below is all that is left to do.
        }
        try {
          ws.close();
        } catch (error) {
          logger.warn('voice', 'Closing the Aura socket failed', error);
        }
      }
    },
  };

  /**
   * `Clear` tells the server to drop buffers and stop generating, not just stop us playing.
   * Socket replaced, not reused: flush-confirm-after-`Clear` ordering (vs `Cleared`) is undocumented — reuse risks a stale `Flushed` truncating the next answer. Cost is off the critical path.
   */
  function abortRound(r: Round): void {
    if (r.settled) return;

    settleRound(r);
    const ws = link;
    if (state === 'ready' && ws !== null && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'Clear' }));
      } catch (error) {
        logger.warn('voice', 'Sending Clear to the Aura socket failed', error);
      }
    }
    retire('barge-in', true);
  }
}

/**
 * PRIVACY — DO NOT REMOVE `mip_opt_out` (see `fluxParams`): assembled from what people said in the meeting.
 *
 * `container` is deliberately absent: streaming always sends raw audio.
 *
 * `language_hint` is deliberately absent too: listen-side; the Aura voice id already fixes output language. Sending it isn't rejected (`/v1/speak` returns 101 + ordinary audio) — a leak here is silent at runtime, so it's asserted in a test instead.
 */
function speakParams(): URLSearchParams {
  return new URLSearchParams({
    model: TTS_MODEL,
    encoding: 'linear16',
    sample_rate: '24000',
    mip_opt_out: 'true',
  });
}

/** Belt and braces: streaming always sends raw audio — shouldn't fire. Kept since the guarded failure (an offset header) reads as a hardware fault. */
function stripWavContainer(audio: Buffer): Buffer {
  if (audio.length < 12) return audio;
  if (audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
    return audio;
  }

  logger.warn('voice', 'Aura sent a WAV header on a raw stream; stripping it');

  let offset = 12;
  while (offset + 8 <= audio.length) {
    const chunkId = audio.toString('ascii', offset, offset + 4);
    const chunkSize = audio.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === 'data') {
      // A streamed WAV may declare 0 or 0xFFFFFFFF when it didn't know the length yet — trust the buffer over the header.
      const end = chunkSize === 0 || body + chunkSize > audio.length ? audio.length : body + chunkSize;
      return audio.subarray(body, end);
    }
    offset = body + chunkSize + (chunkSize % 2); // RIFF chunks are word-aligned
  }

  return audio;
}
