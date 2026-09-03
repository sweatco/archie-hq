// The wire adapter's two new jobs, both against a stubbed `fetch` on canned frames: zero model calls, zero cost.
//
// They exist for the reason every other test file here does. The reasoning channel is the one place in this harness where getting it wrong is *invisible* — reasoning that leaked into `m.text`
// would be graded as speech and fail rows for words no room heard, while reasoning that was silently dropped instead of counted would report a thinking arm as thinking zero tokens. Neither
// shows up as an error. And the `<think>` strip is a reimplementation of a function production deleted, which is exactly the kind of copy this directory has watched drift three times.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CANDIDATES, runCall, stripThinkBlocks, stripThinkEnabled, STRIP_THINK_ENV } from './providers.mjs';

const enc = new TextEncoder();

function streamOf(chunks: string[]) {
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (i >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: enc.encode(chunks[i++]) };
        },
        async cancel() {},
      };
    },
  };
}

type Frame = Record<string, unknown>;
function sse(frames: Frame[]): string[] {
  return [...frames.map((f) => `data: ${JSON.stringify(f)}\n\n`), 'data: [DONE]\n\n'];
}

const contentFrame = (text: string): Frame => ({ choices: [{ index: 0, delta: { content: text } }] });
const reasoningFrame = (text: string): Frame => ({ choices: [{ index: 0, delta: { reasoning: text } }] });
const usageFrame = (completion: number, reasoning?: number): Frame => ({
  choices: [],
  usage: {
    prompt_tokens: 1234,
    completion_tokens: completion,
    ...(reasoning === undefined ? {} : { completion_tokens_details: { reasoning_tokens: reasoning } }),
  },
});
const stopFrame = (): Frame => ({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });

/** The last body handed to `fetch`, so a request's shape can be asserted rather than assumed. */
let lastBody: Record<string, unknown> = {};

function stubStream(frames: Frame[]) {
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    lastBody = JSON.parse(init.body) as Record<string, unknown>;
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: streamOf(sse(frames)),
      async text() {
        return '';
      },
    };
  });
}

const AMBIENT_STRIP = process.env[STRIP_THINK_ENV];
beforeEach(() => {
  delete process.env[STRIP_THINK_ENV];
  lastBody = {};
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (AMBIENT_STRIP === undefined) delete process.env[STRIP_THINK_ENV];
  else process.env[STRIP_THINK_ENV] = AMBIENT_STRIP;
});

const call = (candidate: string) => runCall(candidate, { system: 'sys', user: 'user' });

describe('the two Cerebras arms send the two request shapes production sent', () => {
  it('the thinking arm is production at HEAD, field for field', async () => {
    stubStream([contentFrame('Noon.'), stopFrame()]);
    await call('cerebras-gemma-4-31b-thinking');
    // requestBody's own field set, in its own order: model, cap, temperature, stream, messages, then reasoning_effort appended last.
    expect(Object.keys(lastBody)).toEqual([
      'model', 'max_completion_tokens', 'temperature', 'stream', 'messages', 'reasoning_effort',
    ]);
    expect(lastBody).toMatchObject({
      model: 'gemma-4-31b',
      max_completion_tokens: 2000,
      temperature: 0,
      stream: true,
      reasoning_effort: 'medium',
    });
    // The system half is a message with the system role, never a top-level field.
    expect(lastBody.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'user' },
    ]);
    // Never sent by production, so never sent here: a body that carried it would be measuring a request no meeting makes.
    expect(lastBody).not.toHaveProperty('reasoning_format');
    expect(lastBody).not.toHaveProperty('max_tokens');
  });

  it('the baseline arm is the shape production sent one commit earlier', async () => {
    stubStream([contentFrame('Noon.'), stopFrame()]);
    await call('cerebras-gemma-4-31b');
    // No reasoning_effort key at all — absent, not set to a falsy value — and the 600-token cap that was SPEAKING_MAX_TOKENS then.
    expect(Object.keys(lastBody)).toEqual(['model', 'max_completion_tokens', 'temperature', 'stream', 'messages']);
    expect(lastBody.max_completion_tokens).toBe(600);
    expect(lastBody).not.toHaveProperty('reasoning_effort');
  });

  it('the candidate owns its cap, so a driver cannot make the two arms the same request', async () => {
    stubStream([contentFrame('Noon.'), stopFrame()]);
    await runCall('cerebras-gemma-4-31b-thinking', { system: 's', user: 'u', maxTokens: 600 });
    expect(lastBody.max_completion_tokens).toBe(2000);
    expect(CANDIDATES['cerebras-gemma-4-31b'].maxTokens).toBe(600);
    expect(CANDIDATES['cerebras-gemma-4-31b-thinking'].maxTokens).toBe(2000);
  });
});

describe('reasoning arrives on its own channel and never reaches the room', () => {
  it('is accumulated apart from the reply, and is not in the reply', async () => {
    stubStream([
      reasoningFrame('The owner is probably Sergey. '),
      reasoningFrame('Anna said Tuesday.'),
      contentFrame('Sergey owns it. '),
      contentFrame('It has been failing since Tuesday.'),
      stopFrame(),
      usageFrame(162, 145),
    ]);
    const m = await call('cerebras-gemma-4-31b-thinking');
    expect(m.text).toBe('Sergey owns it. It has been failing since Tuesday.');
    expect(m.reasoning).toBe('The owner is probably Sergey. Anna said Tuesday.');
    // The load-bearing half: nothing of the reasoning is in what would be spoken, or in what the emitter handed over.
    expect(m.text).not.toContain('probably');
    expect(m.sentences.map((s: { text: string }) => s.text).join(' ')).not.toContain('probably');
    expect(m.parsed.speech).toBe('Sergey owns it. It has been failing since Tuesday.');
  });

  it('counts the provider`s own reasoning tokens off the usage frame', async () => {
    stubStream([reasoningFrame('...'), contentFrame('Noon.'), stopFrame(), usageFrame(162, 145)]);
    const m = await call('cerebras-gemma-4-31b-thinking');
    expect(m.reasoningTokens).toBe(145);
    expect(m.outputTokens).toBe(162);
    expect(m.inputTokens).toBe(1234);
    expect(m.finishReason).toBe('stop');
  });

  it('says "never reported" and "none" differently, because they are different facts', async () => {
    // A thinking arm whose usage frame carries no reasoning_tokens has not reported zero — nothing was said. Collapsing the two would report a thinking run as thinking nothing.
    stubStream([reasoningFrame('...'), contentFrame('Noon.'), usageFrame(162)]);
    expect((await call('cerebras-gemma-4-31b-thinking')).reasoningTokens).toBeNull();
    // A candidate that asked for no reasoning is a genuine zero, whatever the usage frame says.
    stubStream([contentFrame('Noon.'), usageFrame(30)]);
    expect((await call('cerebras-gemma-4-31b')).reasoningTokens).toBe(0);
  });

  it('times the first content token, not the first reasoning token', async () => {
    // The comparable quantity across the two arms: one spends its reasoning on the content channel and the other does not, and that difference is the measurement.
    stubStream([reasoningFrame('thinking'), contentFrame('Noon.'), stopFrame()]);
    const m = await call('cerebras-gemma-4-31b-thinking');
    expect(m.reasoningAt).not.toBeNull();
    expect(m.ttft).not.toBeNull();
    expect(m.reasoningAt).toBeLessThanOrEqual(m.ttft);
    expect(m.reasoningChars).toBe('thinking'.length);
  });

  it('a reply that is all reasoning and no content parses as silence, not as an error', async () => {
    // Production treats it as a failed turn; here it is a graded row, because "the room heard nothing" is the thing being measured and an error row would be dropped from the sample instead.
    stubStream([reasoningFrame('at length'), stopFrame(), usageFrame(2000, 2000)]);
    const m = await call('cerebras-gemma-4-31b-thinking');
    expect(m.error).toBeNull();
    expect(m.text).toBe('');
    expect(m.parsed.silent).toBe(true);
    expect(m.outputTokens).toBe(2000);
  });
});

describe('the <think> strip, which is one arm`s and not production`s', () => {
  it('is off unless asked for, and refuses a value it cannot read', () => {
    expect(stripThinkEnabled()).toBe(false);
    for (const off of ['', '0', 'false']) {
      process.env[STRIP_THINK_ENV] = off;
      expect(stripThinkEnabled()).toBe(false);
    }
    for (const on of ['1', 'true']) {
      process.env[STRIP_THINK_ENV] = on;
      expect(stripThinkEnabled()).toBe(true);
    }
    // Not a silent default either way: read as off it fails a whole arm on words nobody heard, read as on it hides a real leak.
    process.env[STRIP_THINK_ENV] = 'yes';
    expect(() => stripThinkEnabled()).toThrow(/not a switch/);
  });

  it('keeps both of the mid-stream verdicts production`s own version had', () => {
    // A trailing partial opening tag is held back mid-stream and kept at the end, because by then it was never going to become a tag.
    expect(stripThinkBlocks('Noon.<thi', false).visible).toBe('Noon.');
    expect(stripThinkBlocks('Noon.<thi', true).visible).toBe('Noon.<thi');
    // An unclosed block withholds everything after it, in both passes — nothing after an opening tag is speech until the tag closes.
    expect(stripThinkBlocks('Noon.<think>who owns', false).visible).toBe('Noon.');
    expect(stripThinkBlocks('Noon.<think>who owns', true).visible).toBe('Noon.');
    // A closed one is removed and reported.
    const done = stripThinkBlocks('<think>who owns it</think>Sergey does.', true);
    expect(done.visible).toBe('Sergey does.');
    expect(done.thought).toBe('who owns it');
    // Blocks do not nest: the first close ends the block.
    expect(stripThinkBlocks('<think>a<think>b</think>c', true).visible).toBe('c');
    // And the visible text only ever grows as a prefix, which is what makes streaming it to the emitter safe.
    const whole = '<think>plan</think>Noon. <think>more</think>And Tuesday.';
    let previous = '';
    for (let i = 1; i <= whole.length; i++) {
      const now = stripThinkBlocks(whole.slice(0, i), false).visible;
      expect(now.startsWith(previous), `at ${i}: ${JSON.stringify(now)} after ${JSON.stringify(previous)}`).toBe(true);
      previous = now;
    }
    expect(stripThinkBlocks(whole, true).visible).toBe('Noon. And Tuesday.');
  });

  it('removes a streamed block from the reply and from the emitter, under the arm', async () => {
    process.env[STRIP_THINK_ENV] = '1';
    stubStream([
      contentFrame('<think>The owner is prob'),
      contentFrame('ably Sergey.</think>Sergey owns it.'),
      stopFrame(),
    ]);
    const m = await call('cerebras-gemma-4-31b');
    expect(m.text).toBe('Sergey owns it.');
    expect(m.thought).toBe('The owner is probably Sergey.');
    expect(m.strippedThink).toBe(true);
    expect(m.sentences.map((s: { text: string }) => s.text)).toEqual(['Sergey owns it.']);
    expect(m.thinkingLeak).toBe(false);
    // ttft is still the first CONTENT token, which on this arm is the `<` of the block: that is the honest reading of when this arm starts producing.
    expect(m.ttft).not.toBeNull();
  });

  it('leaves the same reply alone with the arm off, and flags the tag as spoken', async () => {
    // Production at HEAD strips nothing, so a literal tag on the content channel is read out to the room — a defect, not a no-op.
    stubStream([contentFrame('<think>plan</think>Sergey owns it.'), stopFrame()]);
    const m = await call('cerebras-gemma-4-31b-thinking');
    expect(m.text).toBe('<think>plan</think>Sergey owns it.');
    expect(m.thought).toBe('');
    expect(m.strippedThink).toBe(false);
    expect(m.thinkingLeak).toBe(true);
  });

  it('flags a malformed tag the strip could not pair, even under the arm', async () => {
    // The failure the strip cannot fix: a closing tag with no opening one is left in the visible text, and it would be spoken.
    process.env[STRIP_THINK_ENV] = '1';
    stubStream([contentFrame('Sergey owns it.</think>'), stopFrame()]);
    const m = await call('cerebras-gemma-4-31b');
    expect(m.text).toContain('</think>');
    expect(m.thinkingLeak).toBe(true);
  });
});
