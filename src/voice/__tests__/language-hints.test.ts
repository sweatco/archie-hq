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

import { openTurnStream } from '../deepgram.js';
import type { VoiceConfig } from '../types.js';

const base: VoiceConfig = {
  recallApiKey: 'recall-key',
  recallRegion: 'eu-central-1',
  deepgramApiKey: 'dg-key',
  sonioxApiKey: 'soniox-key',
  cerebrasApiKey: 'cerebras-key',
  publicUrl: 'https://archie.example',
};

function dial(cfg: VoiceConfig): { flux: string } {
  const stream = openTurnStream(cfg, { label: 'Ann', onEvent: () => undefined });
  const [flux] = dialled;
  stream.close();
  return { flux };
}

function hintsOn(url: string): string[] {
  return new URLSearchParams(url.slice(url.indexOf('?') + 1)).getAll('language_hint');
}

beforeEach(() => {
  dialled.length = 0;
});

afterEach(() => {
  dialled.length = 0;
});

describe('Flux language hints', () => {
  it('dials the global endpoint with the whole fixed query, byte for byte', () => {
    const { flux } = dial(base);
    expect(flux).toBe(
      'wss://api.deepgram.com/v2/listen?model=flux-general-multi&encoding=linear16' +
        '&sample_rate=16000&mip_opt_out=true&language_hint=en&language_hint=ru',
    );
  });

  it('sends one repeated key per language rather than a comma-joined value', () => {
    // Deepgram honours only repeated keys; `en%2Cru` is silently accepted and then ignored, so both forms are checked.
    const { flux } = dial(base);
    expect(hintsOn(flux)).toEqual(['en', 'ru']);
    expect(flux).not.toContain('language_hint=en%2Cru');
    expect(flux).not.toContain('language_hint=en,ru');
  });

  it('keeps the model-improvement opt-out on', () => {
    // Separate from the exact-URL test so a dropped opt-out fails on its own.
    const { flux } = dial(base);
    expect(flux).toContain('mip_opt_out=true');
  });
});
