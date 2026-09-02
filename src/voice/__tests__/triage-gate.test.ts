// This file pins the gate's own null-safety; the caller's side (meeting.ts on a null verdict) is pinned in room-silence.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';

let promptUnreadable = false;

vi.mock('../../utils/prompt-loader.js', () => ({
  loadPrompt: async () => {
    if (promptUnreadable) {
      throw new Error('ENOENT: no such file or directory');
    }
    return 'TRIAGE PROMPT';
  },
}));

import { logger } from '../../system/logger.js';
import { assembleSpeakingRequest, buildSpeakingUserMessage, runTriageGate } from '../comprehension.js';
import type { VoiceConfig } from '../types.js';

const cfg: VoiceConfig = {
  deepgramApiKey: 'd',
  anthropicApiKey: 'anthropic-key',
  botName: 'Archie',
};

/** The other provider — proves the one deadline really is one deadline. */
const cerebrasCfg: VoiceConfig = {
  ...cfg,
  modelProvider: 'cerebras',
  cerebrasApiKey: 'cerebras-key',
};

const TRANSCRIPT = [
  'Ann: the billing service went red again around noon.',
  'Ann: Archie, who owns it now?',
].join('\n');

interface SeenCall {
  url: string;
  body: Record<string, unknown>;
}
const seen: SeenCall[] = [];

function stubReply(text: string): void {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return {
      ok: true,
      status: 200,
      async json() {
        return { content: [{ type: 'text', text }] };
      },
      async text() {
        return text;
      },
    };
  });
}

function stubStatus(status: number): void {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return {
      ok: false,
      status,
      async json() {
        return {};
      },
      async text() {
        return '{"error":{"type":"authentication_error"}}';
      },
    };
  });
}

/** The wire dying, or our own deadline expiring — the same shape either way. */
function stubThrow(name: string, message: string): void {
  vi.stubGlobal('fetch', async () => {
    const error = new Error(message);
    error.name = name;
    throw error;
  });
}

function stubReplyFromEither(text: string): void {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const payload = url.includes('cerebras')
      ? { choices: [{ message: { content: text } }] }
      : { content: [{ type: 'text', text }] };
    return {
      ok: true,
      status: 200,
      async json() {
        return payload;
      },
      async text() {
        return text;
      },
    };
  });
}

// A wire that never answers — rejects via the real AbortSignal, exactly as a hung fetch would.
function stubHang(): void {
  vi.stubGlobal(
    'fetch',
    (url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        seen.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        init.signal?.addEventListener('abort', () =>
          reject((init.signal as AbortSignal).reason),
        );
      }),
  );
}

// Only `AbortSignal.timeout` exposes the deadline, so it's spied on, not read from source — fetch keeps a real signal; lapse() rejects like the real timer.
// Proves the number production actually spends, not one someone typed — tools/voice-cases/triage.test.ts, in another language, can't.
function stubDeadline(): { asked: number[]; lapse: () => void } {
  const asked: number[] = [];
  const pending: AbortController[] = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    asked.push(ms);
    const controller = new AbortController();
    pending.push(controller);
    return controller.signal;
  });
  return {
    asked,
    lapse: () => {
      for (const controller of pending) {
        controller.abort(
          new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
        );
      }
    },
  };
}

function triage(consults?: { id: string; question: string; answer?: string }[]) {
  return runTriageGate(cfg, { transcript: TRANSCRIPT, consults });
}

// Prompt load precedes the deadline, so there's no synchronous moment to lapse it — yield until the request is on the wire.
async function untilRequestSent(): Promise<void> {
  for (let tick = 0; tick < 100 && seen.length === 0; tick += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  seen.length = 0;
});

describe('the triage gate', () => {
  it('reads each of the three verdicts that carry nothing else', async () => {
    for (const where of ['room', 'pending', 'elsewhere'] as const) {
      stubReply(`{"where": "${where}"}`);
      expect(await triage()).toEqual({ where });
    }
  });

  it('reads an outside verdict and carries its preamble', async () => {
    stubReply('{"where": "outside", "preamble": "Let me find out who has it now."}');
    expect(await triage()).toEqual({
      where: 'outside',
      preamble: 'Let me find out who has it now.',
    });
  });

  it('carries a Russian preamble unchanged', async () => {
    stubReply('{"where": "outside", "preamble": "Сейчас узнаю."}');
    expect(await triage()).toEqual({ where: 'outside', preamble: 'Сейчас узнаю.' });
  });

  it('sanitises the preamble for speech, since it is spoken and nothing else re-reads it', async () => {
    // An asterisk read aloud is the word "star" — parseReply sanitizes spoken sentences, but the preamble bypasses that path, needing its own.
    stubReply('{"where": "outside", "preamble": "**Let me check.**"}');
    expect(await triage()).toEqual({ where: 'outside', preamble: 'Let me check.' });
  });

  it('leaves the preamble off when there is nothing left of it', async () => {
    // `preamble !== undefined` alone would let a whitespace-only string through as speech.
    stubReply('{"where": "outside", "preamble": "   "}');
    expect(await triage()).toEqual({ where: 'outside' });
  });

  it('tolerates the code fence the model emits despite being told not to', async () => {
    // Observed in testing — a fenced verdict unambiguously means what it says; reading it as no verdict throws away a correct answer.
    stubReply('```json\n{"where": "room"}\n```');
    expect(await triage()).toEqual({ where: 'room' });
  });

  it('tolerates surrounding whitespace and a trailing remark', async () => {
    stubReply('\n\n  {"where": "outside", "preamble": "One moment."}  \n\nThat is my read.\n');
    expect(await triage()).toEqual({ where: 'outside', preamble: 'One moment.' });
  });

  it('is null when the where is not one of the four, rather than coercing it', async () => {
    const warnings = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // Coercing to the nearest verdict guesses where a fail-safe belongs — the caller handles no verdict correctly, not a wrong one.
    stubReply('{"where": "ROOM"}');
    expect(await triage()).toBeNull();
    stubReply('{"where": "somewhere else"}');
    expect(await triage()).toBeNull();
    stubReply('{"where": null}');
    expect(await triage()).toBeNull();
    stubReply('{"preamble": "One moment."}');
    expect(await triage()).toBeNull();

    // Silent failure here would be indistinguishable from a gate stuck saying `room` by mistake.
    expect(warnings.mock.calls.filter((call) => String(call[1]).includes('Triage gate')).length).toBe(4);
  });

  it('is null when the reply looks like JSON but does not parse', async () => {
    const warnings = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // Separate path from the test above: braces found, JSON.parse reached, throws.
    stubReply('{where: outside, preamble: hold on}');
    expect(await triage()).toBeNull();
    // And a truncated reply, which is what a max-tokens cap set too low produces.
    stubReply('{"where": "outside", "preamble": "Let me find');
    expect(await triage()).toBeNull();
    expect(warnings.mock.calls.some((call) => String(call[1]).includes('unusable reply'))).toBe(true);
  });

  it('is null when the reply carries no JSON at all', async () => {
    stubReply('The answer is in the room — Ann named the owner two lines up.');
    expect(await triage()).toBeNull();
  });

  it('is null when the call fails outright, naming the consequence in the log', async () => {
    const warnings = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    stubStatus(401);
    expect(await triage()).toBeNull();
    // callModel logs the cause; this is the consequence a reader needs — no verdict didn't break the turn, it ran as always.
    expect(
      warnings.mock.calls.some(
        (call) => String(call[1]).includes('no verdict') && String(call[1]).includes('no triage at all'),
      ),
    ).toBe(true);
  });

  it('is null when the deadline expires, and does not throw', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    // Most likely production failure (critical path, live room) — must cost only the refinement.
    stubThrow('TimeoutError', 'The operation was aborted due to timeout');
    expect(await triage()).toBeNull();
    // The transport dying part-way presents the same way.
    stubThrow('TypeError', 'fetch failed');
    expect(await triage()).toBeNull();
  });

  it('is null when the prompt file cannot be read, without a request', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    stubReply('{"where": "room"}');
    promptUnreadable = true;
    try {
      expect(await triage()).toBeNull();
    } finally {
      promptUnreadable = false;
    }
    expect(seen.length).toBe(0);
  });

  it('spends no round trip on an empty window', async () => {
    stubReply('{"where": "room"}');
    expect(await runTriageGate(cfg, { transcript: '   ' })).toBeNull();
    expect(seen.length).toBe(0);
  });

  it('asks with the speaking call own user message, consult exchange included', async () => {
    // Shares the speaking builder — its own would be a second conversation; reasoning on a different window than the answer is worse than no gate.
    const consults = [
      { id: 'm1c1', question: 'who owns billing?', answer: undefined },
      { id: 'm1c2', question: 'is the release blocked?', answer: 'no, all green' },
    ];
    stubReply('{"where": "pending"}');
    expect(await triage(consults)).toEqual({ where: 'pending' });

    expect(seen.length).toBe(1);
    expect(seen[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(seen[0].body.system).toBe('TRIAGE PROMPT');
    expect(seen[0].body.messages).toEqual([
      { role: 'user', content: buildSpeakingUserMessage(TRANSCRIPT, consults) },
    ]);
    // A verdict is a few dozen tokens of JSON, unusable until complete — asked for whole, not streamed.
    expect(seen[0].body.stream).toBe(false);
    expect(seen[0].body.max_tokens).toBe(96);
    expect(seen[0].body.temperature).toBe(0);
  });
});

describe('the deadline, and what lapsing it produces', () => {
  /** Stands in for the speaking prompt; shape is irrelevant, it only needs to exist. */
  const PROMPT = 'You are Archie.\n\n## What that actually means\n\nThere is one floor.';

  it('is 1500ms, and exactly one deadline per call', async () => {
    // Derived, not arbitrary (TRIAGE_TIMEOUT_MS's note) — the 800ms it replaced discarded a correct verdict (and `<situation>`) on ~8% of turns.
    const deadline = stubDeadline();
    stubReply('{"where": "room"}');
    expect(await triage()).toEqual({ where: 'room' });
    expect(deadline.asked).toEqual([1500]);
  });

  it('is the same 1500ms whichever provider serves the call', async () => {
    // One shared deadline is deliberate — Anthropic's ~620ms floor (the only measured half) sets it; a second constant would mean inventing Cerebras's.
    const deadline = stubDeadline();
    stubReplyFromEither('{"where": "room"}');
    expect(await runTriageGate(cerebrasCfg, { transcript: TRANSCRIPT })).toEqual({ where: 'room' });
    expect(await runTriageGate(cfg, { transcript: TRANSCRIPT })).toEqual({ where: 'room' });
    expect(seen.map((call) => call.url)).toEqual([
      'https://api.cerebras.ai/v1/chat/completions',
      'https://api.anthropic.com/v1/messages',
    ]);
    expect(deadline.asked).toEqual([1500, 1500]);
  });

  it('is null when that deadline is what ends the request, and does not throw', async () => {
    const warnings = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    // Driven through real plumbing, not thrown at the door: the wire never answers; only production's own deadline ends the request.
    const deadline = stubDeadline();
    stubHang();
    const pending = triage();
    await untilRequestSent();
    expect(seen.length).toBe(1);
    expect(deadline.asked).toEqual([1500]);
    deadline.lapse();
    expect(await pending).toBeNull();
    expect(
      warnings.mock.calls.some(
        (call) => String(call[1]).includes('no verdict') && String(call[1]).includes('no triage at all'),
      ),
    ).toBe(true);
  });

  it('leaves the turn behind it byte-for-byte the turn it was before the gate existed', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    // Lapsed deadline → null → no `<situation>` block → the pre-gate request, byte for byte.
    // situation-block.test.ts pins null-to-no-block; this pins timeout-to-null — widening the deadline must not change where it leads.
    const deadline = stubDeadline();
    stubHang();
    const pending = triage();
    await untilRequestSent();
    deadline.lapse();
    const verdict = await pending;
    expect(verdict).toBeNull();

    const request = assembleSpeakingRequest({
      prompt: PROMPT,
      transcript: TRANSCRIPT,
      triage: verdict,
      placement: 'guidance-first',
    });
    expect(request.user).toBe(buildSpeakingUserMessage(TRANSCRIPT));
    expect(request.user).not.toContain('<situation>');
    expect(request).toEqual(
      assembleSpeakingRequest({
        prompt: PROMPT,
        transcript: TRANSCRIPT,
        placement: 'guidance-first',
      }),
    );
  });
});
