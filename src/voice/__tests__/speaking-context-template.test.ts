/**
 * The speaking request is assembled from `prompts/voice-speaking-context.md`, and these are the bytes it must produce.
 *
 * Every expectation below was recorded from the builder as it stood before that template existed — string concatenation inside `buildSpeakingUserMessage` — so a failure here reads as a difference from what production has been sending, not as a fresh reading of the new code. That matters twice over: moving the message into a file was a transparency change with no behavioural half, and `tools/voice-cases/results/` holds measurements collected against exactly these bytes, which a silent shift would invalidate without invalidating the stored rows.
 *
 * The grid covers all thirty-two combinations of the five optional blocks, so "renders when present, disappears with its tags when absent" is checked for each one alone, for every pair, and for everything in between. The two ends of it — nothing present, everything present — are spelled out as whole recorded strings rather than assembled, so the assembly helper cannot agree with a mistake it also made.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSpeakingUserMessage, type SpeakingContext } from '../comprehension.js';
import type { RosterEntry, WrittenLine } from '../types.js';

const TEMPLATE_PATH = fileURLToPath(new URL('../../../prompts/voice-speaking-context.md', import.meta.url));

const TRANSCRIPT = ['Ann: the billing service went red again.', 'Ann: Archie, who owns it now?'].join('\n');

type Consult = { id: string; question: string; answer?: string };

/** One answered and one still out, which is the pair that renders both answer shapes. */
const CONSULTS: Consult[] = [
  { id: 'm1c1', question: 'who owns billing?', answer: 'Bob Chen' },
  { id: 'm1c2', question: 'since when?' },
];

const WRITTEN: WrittenLine[] = [
  { speaker: 'Ann Petrova', text: 'can you join the 10am?' },
  { speaker: 'Archie', text: 'joining now' },
];

/** A host, a plain attendee, someone who has left and someone with no name reported — the four row shapes. */
const PARTICIPANTS: RosterEntry[] = [
  { name: 'Ann Petrova', is_host: true, joined_at: 'j', left_at: null },
  { name: 'Bob Chen', is_host: false, joined_at: 'j', left_at: null },
  { name: 'Dana Ruiz', is_host: false, joined_at: 'j', left_at: 'l' },
  { name: null, is_host: null, joined_at: null, left_at: null },
];

const CAPABILITIES = ['- Engineering & QA: software development', '  - read the repos'].join('\n');

/** Recorded: the whole message with none of the five optional blocks present. */
const RECORDED_NONE = [
  'Meeting transcript, one utterance per line, most recent last:',
  '',
  '<transcript>',
  'Ann: the billing service went red again.',
  'Ann: Archie, who owns it now?',
  '</transcript>',
].join('\n');

/** Recorded: the whole message with all five present. Written out in full, so the helper below is anchored at both ends of the grid. */
const RECORDED_ALL = [
  'Meeting transcript, one utterance per line, most recent last:',
  '',
  '<transcript>',
  'Ann: the billing service went red again.',
  'Ann: Archie, who owns it now?',
  '</transcript>',
  '',
  '<consults>',
  'm1c1. Q: who owns billing?',
  '   A: Bob Chen',
  'm1c2. Q: since when?',
  '   A: (no answer yet)',
  '</consults>',
  '',
  '<written>',
  'Ann Petrova: can you join the 10am?',
  'Archie: joining now',
  '</written>',
  '',
  '<participants>',
  'Ann Petrova (host)',
  'Bob Chen',
  'Dana Ruiz (has left)',
  '(name not reported)',
  '</participants>',
  '',
  '<capabilities>',
  '- Engineering & QA: software development',
  '  - read the repos',
  '</capabilities>',
  '',
  '<voice>',
  'Your voice is not working: synthesis has been failing, so the last answer you gave went to the meeting chat as text and nobody in the room heard it.',
  '</voice>',
].join('\n');

/** The five optional blocks in the order the recorded message shows them, which is also the order the template lists. */
const BLOCKS = ['consults', 'written', 'participants', 'capabilities', 'voice'] as const;
type Block = (typeof BLOCKS)[number];

/** Recorded: what each optional block contributes, tags included. Each is preceded by one blank line and by nothing else. */
const RECORDED_BLOCK: Record<Block, string[]> = {
  consults: [
    '<consults>',
    'm1c1. Q: who owns billing?',
    '   A: Bob Chen',
    'm1c2. Q: since when?',
    '   A: (no answer yet)',
    '</consults>',
  ],
  written: ['<written>', 'Ann Petrova: can you join the 10am?', 'Archie: joining now', '</written>'],
  participants: [
    '<participants>',
    'Ann Petrova (host)',
    'Bob Chen',
    'Dana Ruiz (has left)',
    '(name not reported)',
    '</participants>',
  ],
  capabilities: ['<capabilities>', '- Engineering & QA: software development', '  - read the repos', '</capabilities>'],
  voice: [
    '<voice>',
    'Your voice is not working: synthesis has been failing, so the last answer you gave went to the meeting chat as text and nobody in the room heard it.',
    '</voice>',
  ],
};

/** The recorded message for one combination: the transcript block, then each present block behind one blank line. */
function recorded(present: readonly Block[]): string {
  return [RECORDED_NONE, ...present.flatMap((block) => ['', ...RECORDED_BLOCK[block]])].join('\n');
}

/** Builds the request for one combination, through the arguments `meeting.ts` actually passes. */
function build(present: readonly Block[]): string {
  const context: SpeakingContext = {};
  if (present.includes('written')) {
    context.written = WRITTEN;
  }
  if (present.includes('participants')) {
    context.participants = PARTICIPANTS;
  }
  if (present.includes('capabilities')) {
    context.capabilities = CAPABILITIES;
  }
  if (present.includes('voice')) {
    context.voiceFailed = true;
  }
  return buildSpeakingUserMessage(TRANSCRIPT, present.includes('consults') ? CONSULTS : undefined, context);
}

/** All thirty-two subsets of the five optional blocks, each in the template's own order. */
const COMBINATIONS: Block[][] = Array.from({ length: 32 }, (_, mask) =>
  BLOCKS.filter((_block, i) => (mask & (1 << i)) !== 0),
);

const name = (present: readonly Block[]): string => (present.length === 0 ? 'nothing present' : present.join(' + '));

describe('the speaking request, block by block', () => {
  it('is the recorded message when no optional block has content', () => {
    expect(build([])).toBe(RECORDED_NONE);
    expect(buildSpeakingUserMessage(TRANSCRIPT)).toBe(RECORDED_NONE);
    expect(buildSpeakingUserMessage(TRANSCRIPT, undefined, undefined)).toBe(RECORDED_NONE);
  });

  it('is the recorded message when every optional block has content', () => {
    expect(build([...BLOCKS])).toBe(RECORDED_ALL);
  });

  it('agrees with the recorded blocks at both ends, so the assembled expectations are anchored', () => {
    // Guards the helper itself: were its separator or its order wrong, every case below would agree with it and none with production.
    expect(recorded([])).toBe(RECORDED_NONE);
    expect(recorded([...BLOCKS])).toBe(RECORDED_ALL);
  });

  for (const present of COMBINATIONS) {
    it(`renders exactly the recorded bytes for ${name(present)}`, () => {
      expect(build(present)).toBe(recorded(present));
    });
  }

  it('drops the tags along with the content of every absent block', () => {
    // The reason absence is not emptiness: an empty `<participants>` claims the room is empty, which an absent block does not claim.
    for (const present of COMBINATIONS) {
      const rendered = build(present);
      for (const block of BLOCKS) {
        if (present.includes(block)) {
          expect(rendered).toContain(`<${block}>`);
          expect(rendered).toContain(`</${block}>`);
        } else {
          expect(rendered).not.toContain(`<${block}>`);
          expect(rendered).not.toContain(`</${block}>`);
        }
      }
    }
  });

  it('renders a different message for every combination', () => {
    // Cheap guard against a grid that varies its name and not its input.
    expect(new Set(COMBINATIONS.map((present) => build(present))).size).toBe(COMBINATIONS.length);
  });

  it('never ends with a newline, whichever block came last', () => {
    for (const present of COMBINATIONS) {
      expect(build(present)).not.toMatch(/\n$/);
    }
  });
});

describe('values the template has to carry through untouched', () => {
  it('passes an empty transcript through, leaving the blank line the tags held before', () => {
    // `<transcript>` is not one of the optional blocks: an empty one renders, and dropping it would change what a first turn sends.
    expect(buildSpeakingUserMessage('')).toBe(
      'Meeting transcript, one utterance per line, most recent last:\n\n<transcript>\n\n</transcript>',
    );
  });

  it('does not trim the transcript', () => {
    // `decideResponse` trims before it gets here; trimming again would diverge from what the harness measures.
    expect(buildSpeakingUserMessage('  Anna: hi  ')).toBe(
      'Meeting transcript, one utterance per line, most recent last:\n\n<transcript>\n  Anna: hi  \n</transcript>',
    );
  });

  it('keeps a blank line inside a value from splitting its block in two', () => {
    // A blank line separates blocks in the template, so a value carrying one must be substituted after the blocks are settled, never before.
    expect(buildSpeakingUserMessage('Ann: one\n\nBob: two')).toBe(
      'Meeting transcript, one utterance per line, most recent last:\n\n<transcript>\nAnn: one\n\nBob: two\n</transcript>',
    );
    expect(buildSpeakingUserMessage(TRANSCRIPT, undefined, { capabilities: '- one\n\n- two' })).toBe(
      `${RECORDED_NONE}\n\n<capabilities>\n- one\n\n- two\n</capabilities>`,
    );
    expect(
      buildSpeakingUserMessage(TRANSCRIPT, [{ id: 'm1c1', question: 'what did it say?', answer: 'first\n\nsecond' }]),
    ).toBe(`${RECORDED_NONE}\n\n<consults>\nm1c1. Q: what did it say?\n   A: first\n\nsecond\n</consults>`);
  });

  it('leaves a placeholder spoken in the room as text, and still fills the block it names', () => {
    // Meeting speech is untrusted input on a path ending in the bot talking aloud: `{{WRITTEN}}` said out loud must not become another block's substitution site.
    const rendered = buildSpeakingUserMessage('Ann: it printed {{WRITTEN}} literally', undefined, { written: WRITTEN });
    expect(rendered).toBe(
      [
        'Meeting transcript, one utterance per line, most recent last:',
        '',
        '<transcript>',
        'Ann: it printed {{WRITTEN}} literally',
        '</transcript>',
        '',
        '<written>',
        'Ann Petrova: can you join the 10am?',
        'Archie: joining now',
        '</written>',
      ].join('\n'),
    );
  });

  it('carries Cyrillic through every block untouched', () => {
    expect(
      buildSpeakingUserMessage('Егор: кто владелец биллинга?', [{ id: 'm1c1', question: 'кто?' }], {
        written: [{ speaker: 'Егор Хмелёв', text: 'подключаюсь' }],
        participants: [{ name: 'Егор Хмелёв', is_host: true, joined_at: null, left_at: null }],
        capabilities: '- читать репозитории',
        voiceFailed: true,
      }),
    ).toBe(
      [
        'Meeting transcript, one utterance per line, most recent last:',
        '',
        '<transcript>',
        'Егор: кто владелец биллинга?',
        '</transcript>',
        '',
        '<consults>',
        'm1c1. Q: кто?',
        '   A: (no answer yet)',
        '</consults>',
        '',
        '<written>',
        'Егор Хмелёв: подключаюсь',
        '</written>',
        '',
        '<participants>',
        'Егор Хмелёв (host)',
        '</participants>',
        '',
        '<capabilities>',
        '- читать репозитории',
        '</capabilities>',
        '',
        '<voice>',
        'Your voice is not working: synthesis has been failing, so the last answer you gave went to the meeting chat as text and nobody in the room heard it.',
        '</voice>',
      ].join('\n'),
    );
  });

  it('treats an empty collection and a whitespace-only summary as absent, exactly as a missing field', () => {
    expect(buildSpeakingUserMessage(TRANSCRIPT, [], { written: [], participants: [], capabilities: '', voiceFailed: false })).toBe(
      RECORDED_NONE,
    );
    expect(buildSpeakingUserMessage(TRANSCRIPT, undefined, { capabilities: '   \n  ' })).toBe(RECORDED_NONE);
  });
});

describe('the template file', () => {
  const template = readFileSync(TEMPLATE_PATH, 'utf8');

  it('shows the intro line, every block and the order they appear in', () => {
    // What the review asked for: the message is readable here rather than only as concatenation in comprehension.ts.
    expect(template).toContain('Meeting transcript, one utterance per line, most recent last:');
    expect(template.match(/<\/?[a-z]+>/g)).toEqual([
      '<transcript>',
      '</transcript>',
      '<consults>',
      '</consults>',
      '<written>',
      '</written>',
      '<participants>',
      '</participants>',
      '<capabilities>',
      '</capabilities>',
      '<voice>',
      '</voice>',
    ]);
  });

  it('carries one placeholder per block and nothing the builder does not fill', () => {
    // A placeholder with no value behind it would reach the model as its own literal text, which is the failure mode this pins.
    expect([...template.matchAll(/{{([A-Z0-9_]+)}}/g)].map((m) => m[1])).toEqual([
      'TRANSCRIPT',
      'CONSULTS',
      'WRITTEN',
      'PARTICIPANTS',
      'CAPABILITIES',
      'VOICE',
    ]);
    for (const present of COMBINATIONS) {
      expect(build(present)).not.toMatch(/{{[A-Z0-9_]+}}/);
    }
  });

  it('is where the bytes come from, not a second copy of them', () => {
    // Filled by hand here: if the builder held its own copy of the framing, this would disagree with it — and if the file is edited, this moves while the recorded expectations above do not.
    const filled = template
      .trim()
      .replace('{{TRANSCRIPT}}', () => TRANSCRIPT)
      .replace('{{CONSULTS}}', () => 'm1c1. Q: who owns billing?\n   A: Bob Chen\nm1c2. Q: since when?\n   A: (no answer yet)')
      .replace('{{WRITTEN}}', () => 'Ann Petrova: can you join the 10am?\nArchie: joining now')
      .replace('{{PARTICIPANTS}}', () => 'Ann Petrova (host)\nBob Chen\nDana Ruiz (has left)\n(name not reported)')
      .replace('{{CAPABILITIES}}', () => CAPABILITIES)
      .replace(
        '{{VOICE}}',
        () =>
          'Your voice is not working: synthesis has been failing, so the last answer you gave went to the meeting chat as text and nobody in the room heard it.',
      );
    expect(build([...BLOCKS])).toBe(filled);
  });
});
