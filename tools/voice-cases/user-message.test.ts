import { describe, it, expect } from 'vitest';
import {
  buildSpeakingUserMessage,
  type SpeakingContext,
} from '../../src/voice/comprehension.js';
import { FIXED_CONTEXT, filledPrompt, promptPath, system, userMsg } from './promptio.mjs';
import { DCASES } from './dcases.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

type Consult = { id: string; question: string; answer?: string };

/**
 * The fields `SpeakingContext` declares, read out of comprehension.ts's own source.
 *
 * Production used to export this list (`SPEAKING_CONTEXT_FIELDS`, exhaustive by a compile-time check) and does not any more, so it is read rather than copied: a copy would go stale in exactly
 * the direction that matters — a block production fills that this arm omits renders in every live room and in no measurement of one, and a hand-written list would go on claiming otherwise.
 * Read from the interface body between its braces, taking each `name?:` at one level of indentation; doc comments and nested shapes carry no such line.
 */
function speakingContextFields(): string[] {
  const source = fs.readFileSync(
    fileURLToPath(new URL('../../src/voice/comprehension.ts', import.meta.url)),
    'utf8',
  );
  const at = source.indexOf('export interface SpeakingContext {');
  if (at === -1) throw new Error('SpeakingContext is no longer declared in comprehension.ts under that name');
  const body = source.slice(at, source.indexOf('\n}', at));
  return [...body.matchAll(/^  (\w+)\?:/gm)].map((m) => m[1]).sort();
}

/** Verbatim, unrefactored snapshot of the deleted hand-written copy: avoids a vacuous comparison. */
function OLD_CONSTRUCTION(transcript: string, consults?: Consult[]): string {
  function consultsBlock(cs?: Consult[]): string[] {
    if (cs === undefined || cs.length === 0) return [];
    const lines = cs.map((c) => `${c.id}. Q: ${c.question}\n   A: ${c.answer ?? '(no answer yet)'}`);
    return ['', '<consults>', ...lines, '</consults>'];
  }
  return [
    'Meeting transcript, one utterance per line, most recent last:',
    '',
    '<transcript>',
    transcript,
    '</transcript>',
    ...consultsBlock(consults),
  ].join('\n');
}

function caseById(id: string) {
  const c = DCASES.find((x: { id: string }) => x.id === id);
  if (c === undefined) throw new Error(`fixture renamed or removed: ${id}`);
  return c;
}

// Real fixtures, not invented strings — checked against stored measurements.
const NO_CONSULTS = caseById('D2a-owner-duration');
const PENDING = caseById('D6a-en-weather');
const ANSWERED_CONSULT: Consult[] = [
  { id: 'm1c1', question: 'What is the first line of the mobile repo README?', answer: 'Mobile client for the Meridian app.' },
];

describe('buildSpeakingUserMessage — byte-identical to the construction it replaced', () => {
  it('no consults: the shape every pre-consult case was measured under', () => {
    expect(userMsg(NO_CONSULTS.transcript, undefined)).toBe(OLD_CONSTRUCTION(NO_CONSULTS.transcript, undefined));
    expect(buildSpeakingUserMessage(NO_CONSULTS.transcript)).toBe(OLD_CONSTRUCTION(NO_CONSULTS.transcript));
    expect(userMsg(NO_CONSULTS.transcript, undefined)).not.toContain('<consults>');
    expect(userMsg(NO_CONSULTS.transcript, [])).toBe(OLD_CONSTRUCTION(NO_CONSULTS.transcript, undefined));
  });

  it('one pending consult', () => {
    expect(userMsg(PENDING.transcript, PENDING.consults)).toBe(OLD_CONSTRUCTION(PENDING.transcript, PENDING.consults));
    // Pinned independently of the snapshot, catching drift shared by both.
    expect(userMsg(PENDING.transcript, PENDING.consults)).toContain('   A: (no answer yet)');
  });

  it('one answered consult', () => {
    expect(userMsg(PENDING.transcript, ANSWERED_CONSULT)).toBe(OLD_CONSTRUCTION(PENDING.transcript, ANSWERED_CONSULT));
    expect(userMsg(PENDING.transcript, ANSWERED_CONSULT)).toContain('   A: Mobile client for the Meridian app.');
    expect(userMsg(PENDING.transcript, ANSWERED_CONSULT)).not.toContain('no answer yet');
  });

  it('the transcript is passed through untouched — no trimming in the assembly', () => {
    // decideResponse trims before speaking; this must not, or whitespace diverges from production.
    expect(buildSpeakingUserMessage('  Anna: hi  ')).toBe(OLD_CONSTRUCTION('  Anna: hi  '));
  });

  it('the new standing blocks are absent, so every stored row stays comparable', () => {
    // Defaults to undefined on purpose; would catch a default of FIXED_CONTEXT.
    const sent = userMsg(NO_CONSULTS.transcript, NO_CONSULTS.consults);
    expect(sent).toBe(OLD_CONSTRUCTION(NO_CONSULTS.transcript, NO_CONSULTS.consults));
    expect(sent).not.toContain('<written>');
    expect(sent).not.toContain('<participants>');
    expect(sent).not.toContain('<capabilities>');
  });
});

// Delegation proves structural identity, not populated values; these tests do.
describe('the harness renders every standing block production does', () => {
  const t = PENDING.transcript;

  it('is byte-identical to production for the same context, block for block', () => {
    expect(userMsg(t, PENDING.consults, FIXED_CONTEXT as SpeakingContext)).toBe(
      buildSpeakingUserMessage(t, PENDING.consults, FIXED_CONTEXT as SpeakingContext),
    );
    // Each block alone too, so identity requiring all three can't slip through.
    for (const key of ['participants', 'written', 'capabilities'] as const) {
      const one = { [key]: FIXED_CONTEXT[key] } as SpeakingContext;
      expect(userMsg(t, undefined, one)).toBe(buildSpeakingUserMessage(t, undefined, one));
    }
  });

  it('pins a value for every field of SpeakingContext, so none can go unmeasured', () => {
    // Production's own declaration, read out of its source; see speakingContextFields above for why it is read and not copied.
    expect(speakingContextFields()).toEqual(['capabilities', 'participants', 'written']);
    expect(Object.keys(FIXED_CONTEXT).sort()).toEqual(speakingContextFields());

    const rendered = userMsg(t, undefined, FIXED_CONTEXT as SpeakingContext);
    expect(rendered).toContain('<participants>');
    expect(rendered).toContain('<written>');
    expect(rendered).toContain('<capabilities>');
    expect(rendered).toContain('Dana Ruiz (has left)');
    expect(rendered).toContain('(name not reported)');
    expect(rendered).toContain('Ann Petrova (host)');
  });

  it('the pinned values are fixed, not derived from a live system', () => {
    expect(userMsg(t, undefined, FIXED_CONTEXT as SpeakingContext)).toBe(
      userMsg(t, undefined, FIXED_CONTEXT as SpeakingContext),
    );
  });
});

describe('the harness system prompt', () => {
  it('is the whole filled prompt, which is what decideResponse sends', () => {
    // One call, one system message: the prompt goes in whole, with no splitting and no placement switch — production removed both, so a harness that still split one would measure a request no room sends.
    expect(system()).toBe(filledPrompt());
    expect(system()).not.toContain('<transcript>');
    expect(system()).not.toContain('<situation>');
  });

  it('substitutes every prompt variable the real prompt carries', () => {
    // loadPrompt passes {{FOO}} through unsubstituted; system() throws so a missing var isn't silently measured.
    expect(() => system()).not.toThrow();
    expect(system()).not.toMatch(/{{[A-Z0-9_]+}}/);
    expect(system()).toContain('Archie');
    const tmp = `${promptPath()}.harness-check.md`;
    fs.writeFileSync(tmp, 'You are {{BOT_NAME}}. Your team can reach {{INTEGRATIONS}}.\n');
    const previous = process.env.PROMPT_FILE;
    process.env.PROMPT_FILE = tmp;
    try {
      expect(() => system()).toThrow(/INTEGRATIONS/);
    } finally {
      if (previous === undefined) delete process.env.PROMPT_FILE;
      else process.env.PROMPT_FILE = previous;
      fs.rmSync(tmp, { force: true });
    }
  });
});
