import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dialled: string[] = [];

vi.mock('ws', () => {
  class FakeSocket {
    static readonly OPEN = 1;
    static readonly CONNECTING = 0;
    readonly readyState = 0;
    constructor(url: string) {
      dialled.push(url);
    }
    on(): this {
      return this;
    }
    once(): this {
      return this;
    }
    send(): void {}
    ping(): void {}
    close(): void {}
    terminate(): void {}
  }
  return { default: FakeSocket, WebSocket: FakeSocket };
});

import { createSpeechSession, openTurnStream } from '../deepgram.js';
import type { VoiceConfig } from '../types.js';

const base: VoiceConfig = {
  deepgramApiKey: 'dg-key',
  anthropicApiKey: 'a',
  botName: 'Archie',
};

function dial(cfg: VoiceConfig): { flux: string; speak: string } {
  const stream = openTurnStream(cfg, { label: 'Ann', onEvent: () => undefined });
  const speech = createSpeechSession(cfg);
  const [flux, speak] = dialled;
  stream.close();
  speech.close();
  return { flux, speak };
}

function hintsOn(url: string): string[] {
  return new URLSearchParams(url.slice(url.indexOf('?') + 1)).getAll('language_hint');
}

/** Flux URL before this option existed; nothing may perturb it. */
const BASELINE_FLUX =
  'wss://api.deepgram.com/v2/listen?model=flux-general-multi&encoding=linear16&sample_rate=16000&mip_opt_out=true';

beforeEach(() => {
  dialled.length = 0;
});

afterEach(() => {
  dialled.length = 0;
});

describe('Flux language hints', () => {
  it('sends no hint at all by default, preserving the URL exactly', () => {
    const { flux } = dial(base);
    expect(flux).toBe(BASELINE_FLUX);
    expect(flux).not.toContain('language_hint');
    expect(hintsOn(flux)).toEqual([]);
  });

  it('sends one repeated key per language, in the configured order', () => {
    // Deepgram honours only repeated keys; asserted as a parsed list, since comma-joined is silently accepted but ignored.
    const { flux } = dial({ ...base, languageHints: 'en,ru' });
    expect(hintsOn(flux)).toEqual(['en', 'ru']);
    expect(flux).toBe(`${BASELINE_FLUX}&language_hint=en&language_hint=ru`);
  });

  it('does not collapse the list into a single comma-joined value', () => {
    // Separate test: `en%2Cru` is silently accepted, so only checking the raw encoding catches the breakage.
    const { flux } = dial({ ...base, languageHints: 'en,ru' });
    expect(flux).not.toContain('language_hint=en%2Cru');
    expect(flux).not.toContain('language_hint=en,ru');
    expect(hintsOn(flux)).toHaveLength(2);
  });

  it('carries a single language, and a list of several', () => {
    expect(hintsOn(dial({ ...base, languageHints: 'ru' }).flux)).toEqual(['ru']);
    dialled.length = 0;
    expect(hintsOn(dial({ ...base, languageHints: 'en,es,ja' }).flux)).toEqual(['en', 'es', 'ja']);
  });

  it('treats an empty or whitespace value as no opinion at all', () => {
    // Guards against `ARCHIE_VOICE_LANGUAGE_HINTS=` in .env producing a malformed query.
    for (const hints of ['', '   ', ',', ' , , ']) {
      dialled.length = 0;
      const { flux } = dial({ ...base, languageHints: hints });
      expect(flux, `hints=${JSON.stringify(hints)}`).toBe(BASELINE_FLUX);
    }
  });

  it('never sends an empty code, which Deepgram rejects with a 400', () => {
    // Not cosmetic: empty `language_hint` gets a live 400 (INVALID_QUERY_PARAMETER), indistinguishable from a bad API key.
    for (const hints of ['en,ru,', ',en,ru', 'en,,ru', 'en, ,ru']) {
      dialled.length = 0;
      const { flux } = dial({ ...base, languageHints: hints });
      expect(hintsOn(flux), `hints=${JSON.stringify(hints)}`).not.toContain('');
      expect(flux, `hints=${JSON.stringify(hints)}`).not.toContain('language_hint=&');
      expect(flux.endsWith('language_hint='), `hints=${JSON.stringify(hints)}`).toBe(false);
    }
  });

  it('trims whitespace around codes, since `en, ru` is what a person writes', () => {
    expect(hintsOn(dial({ ...base, languageHints: ' en , ru ' }).flux)).toEqual(['en', 'ru']);
  });

  it('keeps hints off the Aura speak URL, where they do not belong', () => {
    // /v1/speak accepts `language_hint` (101, ignored) — a leak would be invisible at runtime but for this test.
    const { speak } = dial({ ...base, languageHints: 'en,ru' });
    expect(speak).not.toContain('language_hint');
    expect(speak).toBe(
      'wss://api.deepgram.com/v1/speak?model=aura-2-orion-en&encoding=linear16&sample_rate=24000&mip_opt_out=true',
    );
  });

  it('keeps the model-improvement opt-out on, hinted or not', () => {
    // Separate from the exact-URL tests so a dropped opt-out fails on its own.
    for (const hints of [undefined, '', 'en,ru']) {
      dialled.length = 0;
      const { flux, speak } = dial({ ...base, languageHints: hints });
      expect(flux, `hints=${JSON.stringify(hints)}`).toContain('mip_opt_out=true');
      expect(speak, `hints=${JSON.stringify(hints)}`).toContain('mip_opt_out=true');
    }
  });

  it('composes with a configured host rather than replacing either', () => {
    // Guards one knob's implementation from quietly dropping the other, invisible to the tests above.
    const { flux } = dial({
      ...base,
      deepgramHost: 'api.eu.deepgram.com',
      languageHints: 'en,ru',
    });
    expect(flux).toBe(
      'wss://api.eu.deepgram.com/v2/listen?model=flux-general-multi&encoding=linear16' +
        '&sample_rate=16000&mip_opt_out=true&language_hint=en&language_hint=ru',
    );
  });
});
