/**
 * Deepgram Flux: listening, and nothing else — speech out is Soniox's (soniox.ts).
 *
 * Mono, one stream/participant — no Flux diarization; stream = speaker id.
 *
 * Never throws: audio-path failures (bad key, dropped socket, bad frame) log, not crash the engine.
 */

import WebSocket from 'ws';

import { logger } from '../system/logger.js';
import type { VoiceConfig } from './types.js';

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

/** Flux v2 has no `KeepAlive`; a ping holds an idle stream open (measured 20min zero-audio, no server close). */
const PING_MS = 20_000;

/** ~5s at 16kHz mono S16LE (32 kB/s); past that, oldest is dropped — recent audio beats complete audio live. */
const MAX_PENDING_BYTES = 160_000;

/** Consumer callbacks run inside socket handlers, where a throw would be fatal. */
function guarded(label: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    logger.error('voice', `Deepgram ${label} handler threw`, error);
  }
}

/** Token's in a header; an upstream echoing headers into an error body could leak it — scrub before truncating, or a key splits mid-cut. Secrets: {@link VoiceConfig.foreignSecrets}. */
function safeForLog(text: string, cfg: VoiceConfig, max = 500): string {
  let safe = text;
  for (const secret of [cfg.deepgramApiKey, ...(cfg.foreignSecrets ?? [])]) {
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
