// The Cerebras wire, and the shared behaviour over it: silence bias, hold-back, Decision — all from live failures, exercised against the real frame shapes rather than assumed.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/prompt-loader.js', () => ({
  loadPrompt: async () => 'SYSTEM PROMPT',
}));

import { logger } from '../../system/logger.js';
import { decideResponse, wasAddressed } from '../comprehension.js';
import type { VoiceConfig } from '../types.js';

const onCerebras: VoiceConfig = {
  deepgramApiKey: 'd',
  botName: 'Archie',
  cerebrasApiKey: 'csk-test',
  sonioxApiKey: 'sx-test-key-long-enough',
};

const encoder = new TextEncoder();

/** One Cerebras `chat.completion.chunk` frame, as observed on the wire. */
function cerebrasDelta(text: string): string {
  const event = {
    id: 'chatcmpl-test',
    choices: [{ delta: { content: text }, index: 0 }],
    object: 'chat.completion.chunk',
  };
  return `data: ${JSON.stringify(event)}\n\n`;
}

interface SeenCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

const seen: SeenCall[] = [];

function record(url: string, init: RequestInit): void {
  seen.push({
    url,
    init,
    body: JSON.parse(String(init.body)) as Record<string, unknown>,
    headers: init.headers as Record<string, string>,
  });
}

function stubJson(payload: unknown, status = 200): void {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    record(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return payload;
      },
      async text() {
        return JSON.stringify(payload);
      },
    };
  });
}

function openStream(frame: (text: string) => string) {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    record(url, init);
    return { ok: true, status: 200, body, text: async () => '' };
  });
  return {
    push(text: string): void {
      controller?.enqueue(encoder.encode(frame(text)));
    },
    raw(line: string): void {
      controller?.enqueue(encoder.encode(line));
    },
    fail(why: string): void {
      controller?.error(new Error(why));
    },
    close(): void {
      controller?.close();
    },
  };
}

/** Let the reader drain whatever is queued and the emitter act on it. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

function speak(cfg: VoiceConfig, onSentence?: (text: string) => void) {
  return decideResponse(cfg, {
    transcript: 'Ann: Archie, what happened with the deploy?',
    onSentence,
  });
}

function gate(cfg: VoiceConfig) {
  return wasAddressed(cfg, {
    transcript: 'Ann: did the deploy finish?',
    utterance: 'did the deploy finish?',
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  seen.length = 0;
});

describe('the request Cerebras is sent', () => {
  it('carries the key, the model and the system prompt as a message', async () => {
    stubJson({ choices: [{ message: { content: '{"addressed": true}' } }] });
    expect(await gate(onCerebras)).toBe(true);

    expect(seen.length).toBe(1);
    expect(seen[0].url).toBe('https://api.cerebras.ai/v1/chat/completions');
    expect(seen[0].headers.authorization).toBe('Bearer csk-test');
    expect(seen[0].body.model).toBe('gemma-4-31b');
    // A message with the system role, not a top-level field — the OpenAI-compatible shape.
    expect(seen[0].body.system).toBeUndefined();
    expect(seen[0].body.messages).toEqual([
      { role: 'system', content: 'SYSTEM PROMPT' },
      { role: 'user', content: expect.any(String) },
    ]);
    // The current field name; `max_tokens` is the deprecated alias.
    expect(seen[0].body.max_completion_tokens).toBe(64);
  });

  it('asks for native reasoning on the speaking call and on nothing else', async () => {
    stubJson({ choices: [{ message: { content: '{"addressed": true}' } }] });
    await gate(onCerebras);
    // Absent, not `none`: the gate's request has to stay byte-for-byte what it was before reasoning existed anywhere here.
    expect('reasoning_effort' in seen[0].body).toBe(false);

    const reply = openStream(cerebrasDelta);
    const pending = speak(onCerebras);
    reply.push('Done.');
    await settle();
    reply.close();
    await pending;

    expect(seen[1].body.reasoning_effort).toBe('medium');
    // Reasoning tokens are spent out of this cap, so it has to clear a whole reasoning pass and the answer behind it.
    expect(seen[1].body.max_completion_tokens).toBe(2000);
  });

  it('keeps both model calls on the one endpoint', async () => {
    // Splitting the two calls would make the log's latency figures unreadable — a slow turn could be either call.
    stubJson({ choices: [{ message: { content: '{"addressed": false}' } }] });
    await gate(onCerebras);
    const gateUrl = seen[0].url;

    const reply = openStream(cerebrasDelta);
    const pending = speak(onCerebras);
    reply.push('Done.');
    await settle();
    reply.close();
    await pending;

    expect(seen[1].url).toBe(gateUrl);
  });
});

describe('the addressing gate on Cerebras', () => {
  it('reads the verdict out of the OpenAI-shaped reply', async () => {
    stubJson({ choices: [{ message: { content: '{"addressed": true}' } }] });
    expect(await gate(onCerebras)).toBe(true);
  });

  it('is false when the reply carries no JSON object at all', async () => {
    // Bias is deliberate: a wrong yes interrupts a room; a wrong no costs one repeated sentence.
    stubJson({ choices: [{ message: { content: 'I think they were talking to you!' } }] });
    expect(await gate(onCerebras)).toBe(false);
  });

  it('is false when the reply looks like JSON but does not parse', async () => {
    // Separate path from the test above: braces are found, JSON.parse is reached and throws — both shapes must mean no.
    stubJson({ choices: [{ message: { content: '{addressed: yes}' } }] });
    expect(await gate(onCerebras)).toBe(false);
  });

  it('is false when the JSON parses but says something other than true', async () => {
    // Only an explicit boolean true counts — hedges (string "true", a 1, a missing field) must not read as agreeing.
    stubJson({ choices: [{ message: { content: '{"addressed": "true"}' } }] });
    expect(await gate(onCerebras)).toBe(false);
    stubJson({ choices: [{ message: { content: '{"verdict": true}' } }] });
    expect(await gate(onCerebras)).toBe(false);
  });

  it('is false when the reply says no, and when the call fails outright', async () => {
    stubJson({ choices: [{ message: { content: '{"addressed": false}' } }] });
    expect(await gate(onCerebras)).toBe(false);

    // Cerebras gives a real HTTP status for every failure provoked, even streaming.
    stubJson({ message: 'Model does not exist', code: 'model_not_found' }, 404);
    expect(await gate(onCerebras)).toBe(false);
  });

  it('is false when a 200 carries no text content', async () => {
    stubJson({ choices: [{ message: {} }] });
    expect(await gate(onCerebras)).toBe(false);
  });
});

describe('the speaking decision on Cerebras', () => {
  it('speaks: hands the sentence over and returns it whole', async () => {
    const reply = openStream(cerebrasDelta);
    const sentences: string[] = [];
    const pending = speak(onCerebras, (t) => sentences.push(t));

    reply.push('The deploy finished at noon.');
    await settle();
    expect(sentences).toEqual(['The deploy finished at noon.']);

    reply.close();
    expect(await pending).toEqual({
      outcome: 'speak',
      response: { speech: 'The deploy finished at noon.' },
    });
  });

  it('stays silent: the token never reaches the synthesizer, one character at a time', async () => {
    const reply = openStream(cerebrasDelta);
    const sentences: string[] = [];
    const pending = speak(onCerebras, (t) => sentences.push(t));

    for (const ch of 'SILENCE') {
      reply.push(ch);
      await settle();
      // Hold-back is correctness, not latency — must work even though the whole reply lands ~55ms after the first token.
      expect(sentences).toEqual([]);
    }

    reply.close();
    expect(await pending).toEqual({ outcome: 'silence' });
    expect(sentences).toEqual([]);
  });

  it('stays silent when the token arrives with a full stop, which is the case that bites', async () => {
    const reply = openStream(cerebrasDelta);
    const sentences: string[] = [];
    const pending = speak(onCerebras, (t) => sentences.push(t));

    // Unlike the bare-token case (the drain would catch it even without hold-back), a full stop completes mid-stream — hold-back alone stops "silence" aloud.
    // isSilenceToken tolerates the trailing period deliberately — a model told to emit one bare word often adds one.
    for (const ch of 'SILENCE.') {
      reply.push(ch);
      await settle();
      expect(sentences).toEqual([]);
    }

    reply.close();
    expect(await pending).toEqual({ outcome: 'silence' });
    expect(sentences).toEqual([]);
  });

  it('withholds the CHAT payload from speech, one character at a time', async () => {
    const reply = openStream(cerebrasDelta);
    const sentences: string[] = [];
    const pending = speak(onCerebras, (t) => sentences.push(t));

    for (const ch of 'It is done.\nCHAT: sha 9f2a1c and path a_b/c.md') {
      reply.push(ch);
      await settle();
    }
    reply.close();
    const decision = await pending;

    // A hash aloud is noise, and the sanitiser would mangle a file path — CHAT: content is written to be read, not spoken.
    expect(sentences).toEqual(['It is done.']);
    expect(decision).toEqual({
      outcome: 'speak',
      response: { speech: 'It is done.', chat: 'sha 9f2a1c and path a_b/c.md' },
    });
  });

  it('withholds a PM payload from speech exactly like CHAT, one character at a time', async () => {
    const reply = openStream(cerebrasDelta);
    const sentences: string[] = [];
    const pending = speak(onCerebras, (t) => sentences.push(t));

    for (const ch of 'Checking on that now.\nPM: is the release still blocked on QA?') {
      reply.push(ch);
      await settle();
    }
    reply.close();
    const decision = await pending;

    expect(sentences).toEqual(['Checking on that now.']);
    expect(decision).toEqual({
      outcome: 'speak',
      response: { speech: 'Checking on that now.', pm: 'is the release still blocked on QA?' },
    });
  });

  it('agrees on a reply carrying both a CHAT and a PM section, streamed and parsed', async () => {
    const reply = openStream(cerebrasDelta);
    const sentences: string[] = [];
    const pending = speak(onCerebras, (t) => sentences.push(t));

    // Character at a time so the emitter withholds both markers structurally — a partial marker (`CHA`, `P`) must never look safe.
    for (const ch of 'It is done.\nCHAT: sha 9f2a1c\nPM: is the release still blocked on QA?') {
      reply.push(ch);
      await settle();
    }
    reply.close();
    const decision = await pending;

    // Streaming emitter and `parseReply` must agree where speech ends — sections correctly attributed, never merged or swapped.
    expect(sentences).toEqual(['It is done.']);
    expect(decision).toEqual({
      outcome: 'speak',
      response: {
        speech: 'It is done.',
        chat: 'sha 9f2a1c',
        pm: 'is the release still blocked on QA?',
      },
    });
  });

  // PM: is fire-and-forget and never reaches the room, unlike CHAT: (speech-only) — must not be lost when nothing is said.
  it('delivers a PM: question even when nothing is spoken before it', async () => {
    const reply = openStream(cerebrasDelta);
    const sentences: string[] = [];
    const pending = speak(onCerebras, (t) => sentences.push(t));

    for (const ch of 'PM: is the release still blocked on QA?') {
      reply.push(ch);
      await settle();
      expect(sentences).toEqual([]);
    }
    reply.close();

    expect(await pending).toEqual({
      outcome: 'silence',
      pm: 'is the release still blocked on QA?',
    });
  });

  it('still delivers the PM: question when it follows the bare SILENCE token', async () => {
    const reply = openStream(cerebrasDelta);
    const sentences: string[] = [];
    const pending = speak(onCerebras, (t) => sentences.push(t));

    for (const ch of 'SILENCE\nPM: is the release still blocked on QA?') {
      reply.push(ch);
      await settle();
      expect(sentences).toEqual([]);
    }
    reply.close();

    // "Say nothing" governs speech, not whether a separately-decided question still reaches the PM.
    expect(await pending).toEqual({
      outcome: 'silence',
      pm: 'is the release still blocked on QA?',
    });
  });

  it('drops a CHAT: section when nothing is spoken, unlike a PM: question', async () => {
    const warnings = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const reply = openStream(cerebrasDelta);
    const sentences: string[] = [];
    const pending = speak(onCerebras, (t) => sentences.push(t));

    for (const ch of 'CHAT: sha 9f2a1c') {
      reply.push(ch);
      await settle();
    }
    reply.close();

    // CHAT: needs speech to accompany — nothing said aloud means it's discarded, as before PM: existed.
    expect(sentences).toEqual([]);
    expect(await pending).toEqual({ outcome: 'silence' });
    expect(
      warnings.mock.calls.some((call) => String(call[1]).includes('CHAT:')),
    ).toBe(true);
  });

  it('delivers the PM: question and drops the CHAT: section when a reply carrying both has nothing spoken', async () => {
    const reply = openStream(cerebrasDelta);
    const sentences: string[] = [];
    const pending = speak(onCerebras, (t) => sentences.push(t));

    for (const ch of 'CHAT: sha 9f2a1c\nPM: is the release still blocked on QA?') {
      reply.push(ch);
      await settle();
    }
    reply.close();

    expect(sentences).toEqual([]);
    expect(await pending).toEqual({
      outcome: 'silence',
      pm: 'is the release still blocked on QA?',
    });
  });

  it('reports a stream that died mid-reply as failed, with what already went out', async () => {
    const reply = openStream(cerebrasDelta);
    const sentences: string[] = [];
    const pending = speak(onCerebras, (t) => sentences.push(t));

    reply.push('The deploy finished at noon. ');
    await settle();
    expect(sentences).toEqual(['The deploy finished at noon.']);

    // A mid-stream death must not read as `silence`, losing words already heard.
    reply.fail('socket hung up');
    const decision = await pending;

    expect(decision.outcome).toBe('failed');
    if (decision.outcome === 'failed') {
      expect(decision.handedOver).toBe(1);
      expect(decision.why).toContain('socket hung up');
      expect(decision.why).toContain('cerebras');
    }
  });

  it('reports a non-200 as failed, naming the vendor', async () => {
    stubJson({ message: 'Wrong API Key', code: 'wrong_api_key' }, 401);
    const decision = await speak(onCerebras);

    expect(decision.outcome).toBe('failed');
    if (decision.outcome === 'failed') {
      // Naming the vendor in `why` lets a run of failures read as a vendor problem, not a prompt one.
      expect(decision.why).toBe('cerebras returned 401');
      expect(decision.handedOver).toBe(0);
    }
  });

  it('reports a 200 that streamed no text as failed, not as silence', async () => {
    const reply = openStream(cerebrasDelta);
    const pending = speak(onCerebras);
    reply.raw('data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n');
    reply.raw('data: [DONE]\n\n');
    await settle();
    reply.close();

    const decision = await pending;
    expect(decision.outcome).toBe('failed');
  });

  it('ignores the frames around the text: role, finish, usage and [DONE]', async () => {
    const reply = openStream(cerebrasDelta);
    const sentences: string[] = [];
    const pending = speak(onCerebras, (t) => sentences.push(t));

    // Exactly the frame sequence observed on the wire, in order.
    reply.raw('data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n');
    reply.push('Six hours.');
    reply.raw('data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n');
    reply.raw('data: {"choices":[],"usage":{"total_tokens":32}}\n\n');
    reply.raw('data: [DONE]\n\n');
    await settle();
    reply.close();

    expect(sentences).toEqual(['Six hours.']);
    expect(await pending).toEqual({
      outcome: 'speak',
      response: { speech: 'Six hours.' },
    });
  });

  it('logs an in-band error frame, which is the only way it is observable', async () => {
    // Never observed (every provoked Cerebras failure came back as an HTTP status), but OpenAI-compatible streams permit an in-band error frame.
    // Can't change the outcome (no `choices` means no text, already a failure); the branch's whole effect is the log line asserted here.
    const errors = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const reply = openStream(cerebrasDelta);
    const pending = speak(onCerebras);

    reply.raw('data: {"message":"upstream overloaded","code":"too_many_requests"}\n\n');
    await settle();
    reply.close();

    expect((await pending).outcome).toBe('failed');
    expect(
      errors.mock.calls.some(
        (call) =>
          String(call[1]).includes('Cerebras stream error') &&
          String(call[1]).includes('upstream overloaded'),
      ),
    ).toBe(true);
  });
});
