import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/prompt-loader.js', () => ({
  loadPrompt: async () => 'SYSTEM PROMPT',
}));

import { decideResponse } from '../comprehension.js';

const cfg = {
  recallApiKey: 'recall-key',
  recallRegion: 'eu-central-1',
  deepgramApiKey: 'd',
  sonioxApiKey: 'soniox-key',
  cerebrasApiKey: 'cerebras-key',
  publicUrl: 'https://archie.example',
};

const encoder = new TextEncoder();

/** One `chat.completion.chunk` frame, newline-terminated per SSE. */
function sseDelta(text: string): string {
  const event = { choices: [{ delta: { content: text }, index: 0 }] };
  return `data: ${JSON.stringify(event)}\n`;
}

/** The same frame carrying native reasoning instead of content — a separate field, never mixed into the text. */
function sseReasoning(text: string): string {
  const event = { choices: [{ delta: { reasoning: text }, index: 0 }] };
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
    think(text: string): void {
      controller?.enqueue(encoder.encode(sseReasoning(text)));
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

  // Reasoning arrives on its own field, wholly ahead of the first content token — nothing in the spoken text has to be recognised or removed.

  it('never hands a reasoning frame to the synthesizer, and carries it on the spoken decision instead', async () => {
    const reply = openReply();
    const sentences: string[] = [];
    const pending = start((text) => sentences.push(text));

    for (const ch of 'I bet it is Ann but should verify. ') {
      reply.think(ch);
      await settle();
      // Reasoning is not speech at any length: no prefix of it may reach the room.
      expect(sentences).toEqual([]);
    }

    for (const ch of 'It was John who deployed it.') {
      reply.push(ch);
      await settle();
    }
    reply.close();
    const decision = await pending;

    expect(sentences).toEqual(['It was John who deployed it.']);
    expect(decision).toEqual({
      outcome: 'speak',
      response: {
        speech: 'It was John who deployed it.',
        thought: 'I bet it is Ann but should verify.',
      },
    });
  });

  it('does not let a marker-looking line in the reasoning open a section', async () => {
    const reply = openReply();
    const sentences: string[] = [];
    const pending = start((text) => sentences.push(text));

    reply.think('maybe I should use CHAT: for this');
    reply.push('Sure, here is the summary.');
    await settle();
    reply.close();
    const decision = await pending;

    // Markers are looked for in the spoken text alone — the reasoning channel never reaches the parser.
    expect(decision).toEqual({
      outcome: 'speak',
      response: {
        speech: 'Sure, here is the summary.',
        thought: 'maybe I should use CHAT: for this',
      },
    });
    expect(sentences).toEqual(['Sure, here is the summary.']);
  });

  it('reports reasoning with no answer behind it as failed, not as silence', async () => {
    const reply = openReply();
    const sentences: string[] = [];
    const pending = start((text) => sentences.push(text));

    reply.think('there is not enough in the transcript to answer this yet');
    await settle();
    reply.close();
    const decision = await pending;

    // A turn that thought and then said nothing at all ran out; choosing silence is a spoken `SILENCE`, and the two must not read the same.
    expect(decision.outcome).toBe('failed');
    if (decision.outcome === 'failed') {
      expect(decision.handedOver).toBe(0);
    }
    expect(sentences).toEqual([]);
  });

  it('still delivers a PM: question when the reply is reasoning and that line alone, and keeps the thought too', async () => {
    const reply = openReply();
    const sentences: string[] = [];
    const pending = start((text) => sentences.push(text));

    reply.think('I should ask the PM before guessing');
    for (const ch of 'PM: is the sprint scope still frozen?') {
      reply.push(ch);
      await settle();
      expect(sentences).toEqual([]);
    }
    reply.close();
    const decision = await pending;

    // PM: is fire-and-forget, surviving an empty spoken region — reasoning in front must not change that (parseReply's doc).
    expect(decision).toEqual({
      outcome: 'silence',
      pm: 'is the sprint scope still frozen?',
      thought: 'I should ask the PM before guessing',
    });
    expect(sentences).toEqual([]);
  });

  it('keeps the thought on a decision to say nothing at all', async () => {
    const reply = openReply();
    const sentences: string[] = [];
    const pending = start((text) => sentences.push(text));

    reply.think('nothing has changed since last time');
    for (const ch of 'SILENCE') {
      reply.push(ch);
      await settle();
      expect(sentences).toEqual([]);
    }
    reply.close();
    const decision = await pending;

    // Unlike CHAT:/LEAVE:, thought survives nothing spoken — `Decision.silence`'s own field, like `pm`'s.
    expect(decision).toEqual({
      outcome: 'silence',
      thought: 'nothing has changed since last time',
    });
    expect(sentences).toEqual([]);
  });

  it('agrees between the streamed sentences and the final parse when reasoning precedes CHAT/PM/LEAVE', async () => {
    const reply = openReply();
    const sentences: string[] = [];
    const pending = start((text) => sentences.push(text));

    reply.think('could be either Ann or John');
    const text = [
      'Let me check. It was John.',
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
