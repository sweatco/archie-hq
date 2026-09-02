/**
 * speech.ts — which synthesizer speaks, nothing else.
 *
 * Aura-2 ids are language-specific (`aura-2-orion-en`), no Russian one; Soniox takes language separately.
 */

import { logger } from '../system/logger.js';
import { createSpeechSession as createDeepgramSpeechSession } from './deepgram.js';
import { createSonioxSpeechSession } from './soniox.js';
import type { SpeechSession, TtsProviderName, VoiceConfig } from './types.js';

const LOG = 'voice-speech';

const ttsFallbackWarned = new Set<string>();

function warnOnce(message: string): void {
  if (!ttsFallbackWarned.has(message)) {
    ttsFallbackWarned.add(message);
    logger.warn(LOG, message);
  }
}

// src/index.ts already rejects a bad env var, but a connector-built VoiceConfig bypasses that — this validates again.
export function ttsProviderName(cfg: VoiceConfig): TtsProviderName {
  const named = cfg.ttsProvider;
  if (named === undefined) {
    return 'deepgram';
  } else if (named === 'deepgram') {
    return 'deepgram';
  } else if (named !== 'soniox') {
    warnOnce(`"${String(named)}" is not a known voice synthesizer — using deepgram`);
    return 'deepgram';
  } else if ((cfg.sonioxApiKey ?? '').trim().length > 0) {
    return 'soniox';
  } else {
    warnOnce('SONIOX_API_KEY is not set, so the voice synthesizer stays on Deepgram');
    return 'deepgram';
  }
}

export function createSpeechSession(cfg: VoiceConfig): SpeechSession {
  if (ttsProviderName(cfg) === 'soniox') {
    return createSonioxSpeechSession(cfg);
  } else {
    return createDeepgramSpeechSession(cfg);
  }
}
