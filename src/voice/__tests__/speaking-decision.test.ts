import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/prompt-loader.js', () => ({
  loadPrompt: async () => 'SYSTEM PROMPT',
}));

import { logger } from '../../system/logger.js';
import { decideResponse } from '../comprehension.js';

const cfg = {
  deepgramApiKey: 'd',
  botName: 'Archie',
  cerebrasApiKey: 'cerebras-key',
  sonioxApiKey: 'soniox-key',
};

const encoder = new TextEncoder();

/** One `chat.completion.chunk` frame, newline-terminated per SSE. */
function sseDelta(text: string): string {
  const event = { choices: [{ delta: { content: text }, index: 0 }] };
  return `data: ${JSON.stringify(event)}\n`;
}

// Stub stands in for `fetch` only; the real SSE reader runs over a real stream — the only way timing assertions mean anything.
function openReply() {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, body, text: async () => '' }));
  return {
    push(text: string): void {
      controller?.enqueue(encoder.encode(sseDelta(text)));
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

function start(onSentence: (text: string) => void) {
  return decideResponse(cfg, {
    transcript: 'Ann: Archie, what happened with the deploy?',
    onSentence,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the speaking decision', () => {
  it('hands over a one-sentence reply before the stream closes', async () => {
    const reply = openReply();
    const sentences: string[] = [];
    const pending = start((text) => sentences.push(text));

    const text = 'The deploy finished at noon.';
    for (let i = 0; i < text.length; i++) {
      reply.push(text[i]);
      await settle();
      // The full stop alone is enough — no trailing space here, ever; requiring one would defer to finish(), i.e. no streaming.
      expect(sentences.length).toBe(i === text.length - 1 ? 1 : 0);
    }
    expect(sentences).toEqual(['The deploy finished at noon.']);

    reply.close();
    const decision = await pending;
    expect(decision).toEqual({
      outcome: 'speak',
      response: { speech: 'The deploy finished at noon.' },
    });
    // Closing the stream must not resend the same sentence as a settled remainder.
    expect(sentences).toEqual(['The deploy finished at noon.']);
  });

  it('holds back a full stop that could still be a decimal point', async () => {
    const reply = openReply();
    const sentences: string[] = [];
    const pending = start((text) => sentences.push(text));

    for (const ch of 'It took 3.') {
      reply.push(ch);
      await settle();
    }
    // "3." with the next char unknown; end-of-buffer as end-of-sentence would speak "three", then "five seconds" — wrong aloud.
    expect(sentences).toEqual([]);

    for (const ch of '5 seconds.') {
      reply.push(ch);
      await settle();
    }
    expect(sentences).toEqual(['It took 3.5 seconds.']);

    reply.close();
    await pending;
  });

  it('keeps an ellipsis whole rather than splitting on its first dot', async () => {
    const reply = openReply();
    const sentences: string[] = [];
    const pending = start((text) => sentences.push(text));

    // A run of dots is trailing off; breaking there puts a hard gap where the model asked for a pause.
    reply.push('Well... it finished.');
    await settle();
    expect(sentences).toEqual(['Well... it finished.']);

    reply.close();
    await pending;
  });

  it('never hands over an utterance with nothing to say in it', async () => {
    const reply = openReply();
    const sentences: string[] = [];
    const pending = start((text) => sentences.push(text));

    reply.push('Well.');
    await settle();
    // Accepted limitation: buffer can end mid-ellipsis, sending early — 1 char in 90, vs. holding every full stop for another delta.
    expect(sentences).toEqual(['Well.']);

    reply.push('..');
    await settle();
    reply.close();
    await pending;

    // Leftover dots must never go out as their own utterance — a wasted synthesis round trip for nothing audible.
    expect(sentences).toEqual(['Well.']);
  });

  it('reports a stream that died mid-reply as a failure, with what went out', async () => {
    const reply = openReply();
    const sentences: string[] = [];
    const pending = start((text) => sentences.push(text));

    reply.push('The deploy finished at noon. ');
    await settle();
    expect(sentences).toEqual(['The deploy finished at noon.']);

    reply.fail('socket hung up');
    const decision = await pending;

    expect(decision.outcome).toBe('failed');
    if (decision.outcome === 'failed') {
      // `handedOver`'s count distinguishes "died before anything" from "room heard half an answer" — a single null couldn't.
      expect(decision.handedOver).toBe(1);
      expect(decision.why).toContain('socket hung up');
    }
  });

  it('never hands over the silence token, one character at a time or otherwise', async () => {
    const reply = openReply();
    const sentences: string[] = [];
    const pending = start((text) => sentences.push(text));

    for (const ch of 'SILENCE') {
      reply.push(ch);
      await settle();
      // Emitting any prefix would have the bot say "silence" to the meeting.
      expect(sentences).toEqual([]);
    }

    reply.close();
    const decision = await pending;
    expect(decision).toEqual({ outcome: 'silence' });
    expect(sentences).toEqual([]);
  });

  // `parseReply` (whole) and `SentenceEmitter.speechRegion` (streaming) must agree where speech ends — hence checking both below.

  it('splits speech, CHAT:, PM: and LEAVE: into their own sections, and the streamed sentences agree with the final parse', async () => {
    const reply = openReply();
    const sentences: string[] = [];
    const pending = start((text) => sentences.push(text));

    const text = [
      'The deploy finished at noon.',
      'CHAT: run 4471, commit 1a2b3c4',
      'PM: should we notify customer success?',
      'LEAVE:',
    ].join('\n');
    for (const ch of text) {
      reply.push(ch);
      await settle();
    }
    reply.close();
    const decision = await pending;

    // SentenceEmitter stops streaming at the first marker line (any of the three); only the spoken line reaches onSentence.
    expect(sentences).toEqual(['The deploy finished at noon.']);

    // parseReply: reaches the same boundary from the whole reply, and splits every section out.
    expect(decision).toEqual({
      outcome: 'speak',
      response: {
        speech: 'The deploy finished at noon.',
        chat: 'run 4471, commit 1a2b3c4',
        pm: 'should we notify customer success?',
        leave: true,
      },
    });
  });

  it('carries a LEAVE: marker on the response once the farewell in front of it is complete', async () => {
    const reply = openReply();
    const sentences: string[] = [];
    const pending = start((text) => sentences.push(text));

    reply.push("Sure, I'll drop off now — take care.\nLEAVE:");
    await settle();
    reply.close();
    const decision = await pending;

    expect(decision).toEqual({
      outcome: 'speak',
      response: { speech: "Sure, I'll drop off now — take care.", leave: true },
    });
    expect(sentences).toEqual(["Sure, I'll drop off now — take care."]);
  });

  it('discards a LEAVE: marker when nothing is spoken, the same way it discards CHAT:', async () => {
    const reply = openReply();
    const sentences: string[] = [];
    const pending = start((text) => sentences.push(text));

    reply.push('SILENCE\nLEAVE:');
    await settle();
    reply.close();
    const decision = await pending;

    // Unlike PM:, LEAVE: has nothing to attach to with no farewell in front — dropped, not carried onto the silence outcome.
    expect(decision).toEqual({ outcome: 'silence' });
    expect(sentences).toEqual([]);
  });

  // <think> can appear anywhere, not just the start — the agent may say something short first ("let me check") while reasoning plays.
  // Both parsers share `stripThinkBlocks`, like `markerOf` for CHAT:/PM:/LEAVE: — checked for agreement here too.

  it('never speaks what is inside a think block, and joins the text around it into one utterance', async () => {
    const reply = openReply();
    const sentences: string[] = [];
    const pending = start((text) => sentences.push(text));

    const text = 'Let me check. <think>I bet it is Ann but should verify</think>It was John who deployed it.';
    for (const ch of text) {
      reply.push(ch);
      await settle();
    }
    reply.close();
    const decision = await pending;

    // Must act like it isn't there — no gap, boundary, or trace of the reasoning in streamed or final speech.
    expect(sentences).toEqual(['Let me check.', 'It was John who deployed it.']);
    expect(decision).toEqual({
      outcome: 'speak',
      response: {
        speech: 'Let me check. It was John who deployed it.',
        thought: 'I bet it is Ann but should verify',
      },
    });
  });

  it('does not leak a partial <think> opening tag while more of it could still arrive', async () => {
    const reply = openReply();
    const sentences: string[] = [];
    const pending = start((text) => sentences.push(text));

    for (const ch of 'Let me check. <thi') {
      reply.push(ch);
      await settle();
    }
    // A partial `<thi` might be one character from a real `<think>`; must never leak, like a partial CHAT:/PM:/LEAVE: line.
    expect(sentences).toEqual(['Let me check.']);

    for (const ch of 'nk>a guess, but which one</think> Here it is.') {
      reply.push(ch);
      await settle();
    }
    reply.close();
    const decision = await pending;

    expect(sentences).toEqual(['Let me check.', 'Here it is.']);
    expect(decision).toEqual({
      outcome: 'speak',
      response: {
        speech: 'Let me check. Here it is.',
        thought: 'a guess, but which one',
      },
    });
  });

  it('does not let a marker-looking line inside a think block open a section', async () => {
    const reply = openReply();
    const sentences: string[] = [];
    const pending = start((text) => sentences.push(text));

    const text = '<think>maybe I should use CHAT: for this</think>Sure, here is the summary.';
    for (const ch of text) {
      reply.push(ch);
      await settle();
    }
    reply.close();
    const decision = await pending;

    // A marker-looking line inside the block must never open a section.
    expect(decision).toEqual({
      outcome: 'speak',
      response: {
        speech: 'Sure, here is the summary.',
        thought: 'maybe I should use CHAT: for this',
      },
    });
    expect(sentences).toEqual(['Sure, here is the summary.']);
  });

  it('discards an unclosed think block at the end of the reply, with a warning, instead of speaking it', async () => {
    const warnings = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const reply = openReply();
    const sentences: string[] = [];
    const pending = start((text) => sentences.push(text));

    const text = "Here's what I found. <think>but wait, the numbers do not add up, let me reconsider";
    for (const ch of text) {
      reply.push(ch);
      await settle();
    }
    reply.close();
    const decision = await pending;

    // Half-formed reasoning aloud is worse than a shorter answer — dangling block dropped outright, not carried onto `thought`.
    expect(sentences).toEqual(["Here's what I found."]);
    expect(decision).toEqual({
      outcome: 'speak',
      response: { speech: "Here's what I found." },
    });
    expect(warnings.mock.calls.some((call) => String(call[1]).includes('unclosed <think>'))).toBe(true);
  });

  it('resolves to silence, with a warning, when the whole reply is an unclosed think block', async () => {
    const warnings = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const reply = openReply();
    const sentences: string[] = [];
    const pending = start((text) => sentences.push(text));

    for (const ch of '<think>I am not actually sure this is even the right question') {
      reply.push(ch);
      await settle();
      expect(sentences).toEqual([]);
    }
    reply.close();
    const decision = await pending;

    // Unclosed means discarded — no `thought` carried either, unlike the closed-block cases below.
    expect(decision).toEqual({ outcome: 'silence' });
    expect(sentences).toEqual([]);
    expect(warnings.mock.calls.some((call) => String(call[1]).includes('unclosed <think>'))).toBe(true);
  });

  it('carries the thought onto a silence outcome when the reply is only a (closed) think block', async () => {
    const reply = openReply();
    const sentences: string[] = [];
    const pending = start((text) => sentences.push(text));

    for (const ch of '<think>there is not enough in the transcript to answer this yet</think>') {
      reply.push(ch);
      await settle();
      expect(sentences).toEqual([]);
    }
    reply.close();
    const decision = await pending;

    // Unlike CHAT:/LEAVE:, thought survives nothing spoken — `Decision.silence`'s own field, like `pm`'s.
    expect(decision).toEqual({
      outcome: 'silence',
      thought: 'there is not enough in the transcript to answer this yet',
    });
    expect(sentences).toEqual([]);
  });

  it('still delivers a PM: question when the only thing before it is a think block, and keeps the thought too', async () => {
    const reply = openReply();
    const sentences: string[] = [];
    const pending = start((text) => sentences.push(text));

    const text = '<think>I should ask the PM before guessing</think>PM: is the sprint scope still frozen?';
    for (const ch of text) {
      reply.push(ch);
      await settle();
      expect(sentences).toEqual([]);
    }
    reply.close();
    const decision = await pending;

    // PM: is fire-and-forget, surviving an empty spoken region — a think block in front must not change that (parseReply's doc).
    expect(decision).toEqual({
      outcome: 'silence',
      pm: 'is the sprint scope still frozen?',
      thought: 'I should ask the PM before guessing',
    });
    expect(sentences).toEqual([]);
  });

  it('keeps withholding correctly for a SILENCE token that follows a closed think block, and still keeps the thought', async () => {
    const reply = openReply();
    const sentences: string[] = [];
    const pending = start((text) => sentences.push(text));

    for (const ch of '<think>nothing has changed since last time</think>SILENCE') {
      reply.push(ch);
      await settle();
      expect(sentences).toEqual([]);
    }
    reply.close();
    const decision = await pending;

    expect(decision).toEqual({
      outcome: 'silence',
      thought: 'nothing has changed since last time',
    });
    expect(sentences).toEqual([]);
  });

  it('agrees between the streamed sentences and the final parse when a think block sits among CHAT/PM/LEAVE', async () => {
    const reply = openReply();
    const sentences: string[] = [];
    const pending = start((text) => sentences.push(text));

    const text = [
      'Let me check. <think>could be either Ann or John</think>It was John.',
      'CHAT: confirmed via commit 1a2b3c4',
      'PM: should we notify customer success?',
      'LEAVE:',
    ].join('\n');
    for (const ch of text) {
      reply.push(ch);
      await settle();
    }
    reply.close();
    const decision = await pending;

    expect(sentences).toEqual(['Let me check.', 'It was John.']);
    expect(decision).toEqual({
      outcome: 'speak',
      response: {
        speech: 'Let me check. It was John.',
        chat: 'confirmed via commit 1a2b3c4',
        pm: 'should we notify customer success?',
        leave: true,
        thought: 'could be either Ann or John',
      },
    });
  });
});
