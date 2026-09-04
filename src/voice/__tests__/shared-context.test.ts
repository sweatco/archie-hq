import { describe, expect, it } from 'vitest';
import { buildSpeakingUserMessage, type SpeakingContext } from '../comprehension.js';
import type { RosterEntry } from '../types.js';

const TRANSCRIPT = ['Ann: the billing service went red again around noon.', 'Ann: Archie, who owns it now?'].join('\n');

/** What the builder rendered before the three new blocks existed. */
const BASELINE = [
  'Meeting transcript, one utterance per line, most recent last:',
  '',
  '<transcript>',
  TRANSCRIPT,
  '</transcript>',
].join('\n');

const ROSTER: RosterEntry[] = [
  { name: 'Ann Petrova', is_host: true, joined_at: '2026-09-01T09:00:00.000Z', left_at: null },
  { name: 'Bob Chen', is_host: false, joined_at: '2026-09-01T09:01:00.000Z', left_at: null },
];

function build(context?: SpeakingContext): string {
  return buildSpeakingUserMessage(TRANSCRIPT, undefined, context);
}

describe('the shared speaking context — absent rather than empty', () => {
  it('renders exactly the pre-context message when there is no context at all', () => {
    expect(build(undefined)).toBe(BASELINE);
    expect(build({})).toBe(BASELINE);
    expect(build({ participants: undefined, written: undefined, capabilities: undefined })).toBe(BASELINE);
    expect(buildSpeakingUserMessage(TRANSCRIPT)).toBe(BASELINE);
  });

  it('omits each block when its own field is empty, not just when it is missing', () => {
    // Type allows `[]`, unused by meeting.ts today; only the renderer guarantees omission.
    const empty = build({ participants: [], written: [], capabilities: '', voiceFailed: false });
    expect(empty).toBe(BASELINE);
    expect(empty).not.toContain('<participants>');
    expect(empty).not.toContain('<written>');
    expect(empty).not.toContain('<capabilities>');
    expect(empty).not.toContain('<voice>');
  });

  it('treats a whitespace-only capability summary as no summary', () => {
    // capabilities is a free string; "empty" has more than one spelling (e.g. a lone newline).
    expect(build({ capabilities: '   \n  ' })).toBe(BASELINE);
  });

  it('renders one block and only that block when only one has content', () => {
    expect(build({ participants: ROSTER })).toBe(
      [BASELINE, '', '<participants>', 'Ann Petrova (host)', 'Bob Chen', '</participants>'].join('\n'),
    );
    expect(build({ written: [{ speaker: 'Ann Petrova', text: 'joining now' }] })).toBe(
      [BASELINE, '', '<written>', 'Ann Petrova: joining now', '</written>'].join('\n'),
    );
    expect(build({ capabilities: '- read the repos' })).toBe(
      [BASELINE, '', '<capabilities>', '- read the repos', '</capabilities>'].join('\n'),
    );
  });
});

describe('the voice block', () => {
  it('says the voice is not working, without saying what to do about it', () => {
    // The live failure: with synthesis 503ing every turn, the fallback was announced to the room and never to the model, which then explained its text output as a choice ("a detailed list is a lot to listen to") and claimed to be speaking aloud. Stated as a fact so the model reasons from it; scripting the reply here would put words in a prompt's mouth from code.
    const rendered = build({ voiceFailed: true });
    expect(rendered).toBe(
      [
        BASELINE,
        '',
        '<voice>',
        'Your voice is not working: synthesis has been failing, so the last answer you gave went to the meeting chat as text and nobody in the room heard it.',
        '</voice>',
      ].join('\n'),
    );
  });

  it('is absent, not false, when speech is working', () => {
    // The property that keeps a healthy meeting unchanged: no block, so the request is byte-for-byte what it was before this existed.
    expect(build({ voiceFailed: false })).toBe(BASELINE);
    expect(build({})).toBe(BASELINE);
  });

  it('comes last, after every standing block', () => {
    // Nearest the reply it has to bear on, and appended rather than inserted — so nothing above it moves on the turn it appears.
    const rendered = buildSpeakingUserMessage(TRANSCRIPT, [{ id: 'm1c1', question: 'who owns billing?' }], {
      participants: ROSTER,
      written: [{ speaker: 'Ann Petrova', text: 'can you join?' }],
      capabilities: '- read the repos',
      voiceFailed: true,
    });
    expect(rendered.indexOf('<voice>')).toBeGreaterThan(rendered.indexOf('</capabilities>'));
    expect(rendered.slice(0, rendered.indexOf('\n\n<voice>'))).toBe(
      buildSpeakingUserMessage(TRANSCRIPT, [{ id: 'm1c1', question: 'who owns billing?' }], {
        participants: ROSTER,
        written: [{ speaker: 'Ann Petrova', text: 'can you join?' }],
        capabilities: '- read the repos',
      }),
    );
  });
});

describe('the participants block', () => {
  it('marks the host and marks whoever has left, and leaves everyone else bare', () => {
    // Departed rows must stay marked, or Archie addresses an empty chair.
    const participants: RosterEntry[] = [
      { name: 'Ann Petrova', is_host: true, joined_at: 'x', left_at: null },
      { name: 'Bob Chen', is_host: false, joined_at: 'x', left_at: null },
      { name: 'Dana Ruiz', is_host: false, joined_at: 'x', left_at: 'y' },
      { name: 'Eve Solis', is_host: true, joined_at: 'x', left_at: 'y' },
    ];
    expect(build({ participants })).toContain(
      ['<participants>', 'Ann Petrova (host)', 'Bob Chen', 'Dana Ruiz (has left)', 'Eve Solis (host) (has left)', '</participants>'].join('\n'),
    );
  });

  it('keeps a nameless row rather than dropping it, and says the name is missing', () => {
    // Dropping the row under-reports attendance; inventing a name is worse.
    expect(build({ participants: [{ name: null, is_host: null, joined_at: null, left_at: null }] })).toContain(
      ['<participants>', '(name not reported)', '</participants>'].join('\n'),
    );
    expect(build({ participants: [{ name: '   ', is_host: null, joined_at: null, left_at: null }] })).toContain(
      '(name not reported)',
    );
  });

  it('carries a Cyrillic name through untouched', () => {
    expect(build({ participants: [{ name: 'Егор Хмелёв', is_host: true, joined_at: null, left_at: null }] })).toContain(
      'Егор Хмелёв (host)',
    );
  });

  it('does not treat a false is_host or a present left_at as missing', () => {
    // A truthiness check misreads `is_host: false` and `left_at: null` as "not reported".
    const rendered = build({ participants: [{ name: 'Bob Chen', is_host: false, joined_at: null, left_at: null }] });
    expect(rendered).toContain('\nBob Chen\n');
    expect(rendered).not.toContain('(host)');
    expect(rendered).not.toContain('(has left)');
  });
});

describe('the written block', () => {
  it('renders one Speaker: text line each, the same shape the transcript uses', () => {
    expect(
      build({
        written: [
          { speaker: 'Ann Petrova', text: 'can you join the 10am?' },
          { speaker: 'Archie', text: 'joining now' },
        ],
      }),
    ).toContain(['<written>', 'Ann Petrova: can you join the 10am?', 'Archie: joining now', '</written>'].join('\n'));
  });

  it('stays outside <transcript>, because Archie must never believe it said what it wrote', () => {
    // Mirrors `parseReply`, which excludes CHAT: text from the spoken transcript.
    const rendered = build({ written: [{ speaker: 'Archie', text: 'the hash is 4f2a91c' }] });
    const transcriptRegion = rendered.slice(rendered.indexOf('<transcript>'), rendered.indexOf('</transcript>'));
    expect(transcriptRegion).not.toContain('4f2a91c');
    expect(rendered).toContain('<written>\nArchie: the hash is 4f2a91c\n</written>');
  });
});

describe('block order and coexistence', () => {
  it('appends the blocks in one fixed order, running from the moment outward', () => {
    // Conversation content first, then room state, then meeting-fixed facts.
    // Order is pinned: tools/voice-cases/results/ holds measurements against it.
    const rendered = buildSpeakingUserMessage(
      TRANSCRIPT,
      [{ id: 'm1c1', question: 'who owns billing?', answer: 'Bob' }],
      {
        participants: ROSTER,
        written: [{ speaker: 'Ann Petrova', text: 'can you join?' }],
        capabilities: '- read the repos',
      },
    );
    expect(rendered).toBe(
      [
        BASELINE,
        '',
        '<consults>',
        'm1c1. Q: who owns billing?',
        '   A: Bob',
        '</consults>',
        '',
        '<written>',
        'Ann Petrova: can you join?',
        '</written>',
        '',
        '<participants>',
        'Ann Petrova (host)',
        'Bob Chen',
        '</participants>',
        '',
        '<capabilities>',
        '- read the repos',
        '</capabilities>',
      ].join('\n'),
    );
  });

  it('is unaffected by the order the fields were written in the object', () => {
    // Object key order isn't a wire format; two callers must produce identical bytes.
    const a: SpeakingContext = { participants: ROSTER, capabilities: '- x', written: [{ speaker: 'Ann', text: 'hi' }] };
    const b: SpeakingContext = { written: [{ speaker: 'Ann', text: 'hi' }], participants: ROSTER, capabilities: '- x' };
    expect(build(a)).toBe(build(b));
  });
});
