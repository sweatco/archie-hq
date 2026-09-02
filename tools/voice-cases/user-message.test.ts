import { afterAll, beforeEach, describe, it, expect } from 'vitest';
import {
  assembleSpeakingRequest,
  buildSpeakingUserMessage,
  SPEAKING_CONTEXT_FIELDS,
  type SpeakingContext,
  type TriageVerdict,
} from '../../src/voice/comprehension.js';
import { FIXED_CONTEXT, filledPrompt, promptPath, system, userMsg } from './promptio.mjs';
import { DCASES } from './dcases.mjs';
import fs from 'node:fs';

type Consult = { id: string; question: string; answer?: string };

// Clears/restores env so an ambient ARCHIE_VOICE_PROMPT_PLACEMENT can't leak in.
const AMBIENT_PLACEMENT = process.env.ARCHIE_VOICE_PROMPT_PLACEMENT;
beforeEach(() => {
  delete process.env.ARCHIE_VOICE_PROMPT_PLACEMENT;
});
afterAll(() => {
  if (AMBIENT_PLACEMENT === undefined) delete process.env.ARCHIE_VOICE_PROMPT_PLACEMENT;
  else process.env.ARCHIE_VOICE_PROMPT_PLACEMENT = AMBIENT_PLACEMENT;
});

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
    // SPEAKING_CONTEXT_FIELDS is production's list (tsc checks exhaustiveness at declaration); pinned here too since tsconfig.json's src/** include skips this dir.
    expect(Object.keys(FIXED_CONTEXT).sort()).toEqual([...SPEAKING_CONTEXT_FIELDS].sort());

    const rendered = userMsg(t, undefined, FIXED_CONTEXT as SpeakingContext);
    expect(rendered).toContain('<participants>');
    expect(rendered).toContain('<written>');
    expect(rendered).toContain('<capabilities>');
    expect(rendered).toContain('Dana Ruiz (has left)');
    expect(rendered).toContain('(name not reported)');
    expect(rendered).toContain('Ann Petrova (host)');
  });

  it('renders the triage verdict production renders, for every one of the four', () => {
    // <situation> is the triage verdict, not a SpeakingContext field — outside the check above.
    for (const where of ['room', 'outside', 'pending', 'elsewhere'] as const) {
      const triage = { where };
      expect(userMsg(t, PENDING.consults, FIXED_CONTEXT as SpeakingContext, triage)).toBe(
        assembleSpeakingRequest({
          prompt: filledPrompt(),
          transcript: t,
          consults: PENDING.consults,
          context: FIXED_CONTEXT as SpeakingContext,
          triage,
          placement: 'guidance-first',
        }).user,
      );
      expect(userMsg(t, PENDING.consults, FIXED_CONTEXT as SpeakingContext, triage)).toContain('<situation>');
    }
    // No verdict: unchanged from stored rows, same reasoning as the blocks above.
    expect(userMsg(t, PENDING.consults, FIXED_CONTEXT as SpeakingContext)).not.toContain('<situation>');
    expect(userMsg(t, PENDING.consults, FIXED_CONTEXT as SpeakingContext, null)).toBe(
      userMsg(t, PENDING.consults, FIXED_CONTEXT as SpeakingContext),
    );
  });

  it('the pinned values are fixed, not derived from a live system', () => {
    expect(userMsg(t, undefined, FIXED_CONTEXT as SpeakingContext)).toBe(
      userMsg(t, undefined, FIXED_CONTEXT as SpeakingContext),
    );
  });
});

describe('placement arms — the harness sends production bytes under both', () => {
  const t = PENDING.transcript;
  const ctx = FIXED_CONTEXT as SpeakingContext;

  function production(placement: 'guidance-first' | 'data-first', triage?: TriageVerdict | null) {
    return assembleSpeakingRequest({
      prompt: filledPrompt(),
      transcript: t,
      consults: PENDING.consults,
      context: ctx,
      triage,
      placement,
    });
  }

  it('is byte-identical to production under the default arm', () => {
    process.env.ARCHIE_VOICE_PROMPT_PLACEMENT = 'guidance-first';
    const expected = production('guidance-first');
    expect(system()).toBe(expected.system);
    expect(userMsg(t, PENDING.consults, ctx)).toBe(expected.user);
    expect(system()).toBe(filledPrompt());
    expect(userMsg(t, PENDING.consults, ctx)).toBe(buildSpeakingUserMessage(t, PENDING.consults, ctx));
  });

  it('is byte-identical to production under the data-first arm', () => {
    process.env.ARCHIE_VOICE_PROMPT_PLACEMENT = 'data-first';
    const expected = production('data-first');
    expect(system()).toBe(expected.system);
    expect(userMsg(t, PENDING.consults, ctx)).toBe(expected.user);
  });

  it('is byte-identical to production under both arms with a triage verdict present', () => {
    for (const where of ['room', 'outside', 'pending', 'elsewhere'] as const) {
      const triage: TriageVerdict = { where };
      for (const arm of ['guidance-first', 'data-first'] as const) {
        process.env.ARCHIE_VOICE_PROMPT_PLACEMENT = arm;
        const expected = production(arm, triage);
        expect(system()).toBe(expected.system);
        expect(userMsg(t, PENDING.consults, ctx, triage)).toBe(expected.user);
      }
    }
  });

  it('puts the verdict in the data half of both arms, never in the guidance', () => {
    const triage: TriageVerdict = { where: 'pending' };
    process.env.ARCHIE_VOICE_PROMPT_PLACEMENT = 'data-first';
    const moved = { system: system(), user: userMsg(t, PENDING.consults, ctx, triage) };
    expect(moved.user.indexOf('</situation>')).toBeLessThan(moved.user.indexOf('## '));
    expect(moved.system).not.toContain('<situation>');
    process.env.ARCHIE_VOICE_PROMPT_PLACEMENT = 'guidance-first';
    expect(system()).not.toContain('<situation>');
    expect(userMsg(t, PENDING.consults, ctx, triage).includes('<situation>')).toBe(true);
    expect(moved.user.startsWith(userMsg(t, PENDING.consults, ctx, triage))).toBe(true);
  });

  it('actually moves the guidance, so neither arm can pass as the other', () => {
    // Guards against a no-op placement passing the identity tests above.
    process.env.ARCHIE_VOICE_PROMPT_PLACEMENT = 'data-first';
    const moved = { system: system(), user: userMsg(t, PENDING.consults, ctx) };
    process.env.ARCHIE_VOICE_PROMPT_PLACEMENT = 'guidance-first';
    const today = { system: system(), user: userMsg(t, PENDING.consults, ctx) };

    expect(moved.system).not.toBe(today.system);
    expect(moved.system.length).toBeLessThan(today.system.length);
    expect(moved.user.length).toBeGreaterThan(today.user.length);
    expect(moved.user.startsWith(today.user)).toBe(true);
    expect(moved.user.indexOf('</capabilities>')).toBeLessThan(moved.user.indexOf('## '));
    // Approximate: moving blocks trims seam whitespace, so lengths match within a few characters.
    expect(moved.system.length + moved.user.length).toBeGreaterThanOrEqual(
      today.system.length + today.user.length - 4,
    );
    expect(moved.user).not.toContain(today.system);
  });
});

describe('the harness system prompt', () => {
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
