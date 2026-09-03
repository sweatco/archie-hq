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
  deepgramApiKey: 'dg-key',
  botName: 'Archie',
  cerebrasApiKey: 'cerebras-key',
  sonioxApiKey: 'soniox-key',
};

function dial(cfg: VoiceConfig): { flux: string } {
  const stream = openTurnStream(cfg, { label: 'Ann', onEvent: () => undefined });
  const [flux] = dialled;
  stream.close();
  return { flux };
}

beforeEach(() => {
  dialled.length = 0;
});

afterEach(() => {
  dialled.length = 0;
});

describe('the Deepgram host', () => {
  it('defaults to the global endpoint, preserving the URL exactly', () => {
    // An unset host must not change where audio goes.
    const { flux } = dial(base);
    expect(flux).toBe(
      'wss://api.deepgram.com/v2/listen?model=flux-general-multi&encoding=linear16&sample_rate=16000&mip_opt_out=true',
    );
  });

  it('moves the socket when a host is configured', () => {
    const { flux } = dial({ ...base, deepgramHost: 'api.eu.deepgram.com' });
    expect(flux).toBe(
      'wss://api.eu.deepgram.com/v2/listen?model=flux-general-multi&encoding=linear16&sample_rate=16000&mip_opt_out=true',
    );
  });

  it('keeps the model-improvement opt-out on whichever host is used', () => {
    // Separate from the exact-URL test so a dropped opt-out fails on its own.
    for (const host of [undefined, 'api.eu.deepgram.com']) {
      dialled.length = 0;
      const { flux } = dial({ ...base, deepgramHost: host });
      expect(flux).toContain('mip_opt_out=true');
    }
  });

  it('treats an empty or whitespace host as no opinion at all', () => {
    // Prevents `DEEPGRAM_HOST=` in .env producing `wss:///v2/listen`.
    for (const host of ['', '   ']) {
      dialled.length = 0;
      const { flux } = dial({ ...base, deepgramHost: host });
      expect(flux).toContain('wss://api.deepgram.com/v2/listen');
    }
  });

  it('trims a host that arrived with surrounding whitespace', () => {
    const { flux } = dial({ ...base, deepgramHost: ' api.eu.deepgram.com ' });
    expect(flux).toContain('wss://api.eu.deepgram.com/v2/listen');
  });
});
