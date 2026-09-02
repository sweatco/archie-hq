import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/prompt-loader.js', () => ({
  loadPrompt: async () => 'TRIAGE PROMPT',
}));

import {
  assembleSpeakingRequest,
  buildSpeakingUserMessage,
  runTriageGate,
  splitSpeakingPrompt,
  type SpeakingContext,
  type SpeakingPlacement,
  type TriageVerdict,
} from '../comprehension.js';
import type { VoiceConfig } from '../types.js';

const TRANSCRIPT = [
  'Ann: the billing service went red again around noon.',
  'Ann: Archie, who owns it now?',
].join('\n');

const PROMPT = [
  'You are Archie. You are sitting in a live voice meeting with your colleagues.',
  '',
  '## What that actually means',
  '',
  'There is one floor and you are sharing it.',
].join('\n');

const CONSULTS = [{ id: 'm1c1', question: 'who owns billing?' }];
const CONTEXT: SpeakingContext = {
  participants: [{ name: 'Ann Petrova', is_host: true, joined_at: null, left_at: null }],
  written: [{ speaker: 'Ann Petrova', text: 'can you join the 10am?' }],
  capabilities: '- read the repos',
};

const WHERES = ['room', 'outside', 'pending', 'elsewhere'] as const;

function request(triage: TriageVerdict | null | undefined, placement: SpeakingPlacement = 'guidance-first') {
  return assembleSpeakingRequest({
    prompt: PROMPT,
    transcript: TRANSCRIPT,
    consults: CONSULTS,
    context: CONTEXT,
    triage,
    placement,
  });
}

function situation(user: string): string | null {
  const open = user.indexOf('<situation>\n');
  if (open === -1) {
    return null;
  }
  return user.slice(open + '<situation>\n'.length, user.indexOf('\n</situation>'));
}

// Only `line` is pinned against the render; `shape`/`contradictedBy`/`whenWrong` are semantic, not checkable — a forcing function for editors. Taxonomy: SITUATION in comprehension.ts; measured only in tools/voice-cases/.
// tools/voice-cases/context-arm.test.ts substring-matches "nothing you could go and find out would settle it" (elsewhere, must render on D6a-en-weather) and "nothing has come back yet" (pending, must not) — drop either and it passes while testing nothing.
const CLAIMS: Record<
  TriageVerdict['where'],
  { line: string; shape: string; contradictedBy: string; whenWrong: string }
> = {
  room: {
    line: 'Whatever there is to go on is already in front of you, and what you have just been asked does not have to be looked up anywhere.',
    shape: 'a quantifier that holds over nothing, then "you need not do X" — both safe; the clause that deadlocked was the "you have X" this replaced ("has already come up in front of you")',
    contradictedBy: '<transcript>, which is a haystack: not finding a fact in it never settles that the fact is absent',
    whenWrong: 'an "I do not have that", plus a question that could have left the room and did not',
  },
  outside: {
    line: 'Nobody here has supplied what you have just been asked, and it is something you can go and find out.',
    shape: '"you do not have X" — safe — plus one residual "you have X" about a capability, checkable against a short list rather than a haystack',
    contradictedBy: '<transcript> supplying it after all, or <capabilities> not covering it',
    whenWrong: 'one wasted question, and a preamble the room heard before this call even ran',
  },
  pending: {
    line: 'What you have just been asked is already one of the questions you have out, and nothing has come back yet.',
    shape: '"you did X", made safe by naming the list the act is recorded in — "you have already sent it onward" named nothing and pointed at nothing',
    contradictedBy: '<consults>, which is a handful of numbered lines and settles it either way at a glance',
    whenWrong: 'the worst of the four: a fresh question reported as already sent, and then never sent',
  },
  elsewhere: {
    line: 'Nobody here has supplied what you have just been asked, and nothing you could go and find out would settle it.',
    shape: 'two "you do not have X" clauses — both safe, so this line is unchanged',
    contradictedBy: '<transcript> supplying it, or <capabilities> covering it',
    whenWrong: 'one unnecessary "I cannot settle that", which somebody pushes back on',
  },
};

describe('the four sentences themselves', () => {
  it('renders each byte-for-byte, so an edit is deliberate and shows in a diff', () => {
    // Prompt text: the last line the model reads before answering. Edits here have moved unrelated cases before, hence the byte-for-byte pin.
    for (const where of WHERES) {
      expect(situation(request({ where }).user)).toBe(CLAIMS[where].line);
    }
  });

  it('accounts for exactly the four verdicts, so a fifth cannot arrive unexamined', () => {
    expect(Object.keys(CLAIMS).sort()).toEqual([...WHERES].sort());
    for (const where of WHERES) {
      expect(CLAIMS[where].shape.length).toBeGreaterThan(0);
      expect(CLAIMS[where].contradictedBy.length).toBeGreaterThan(0);
      expect(CLAIMS[where].whenWrong.length).toBeGreaterThan(0);
    }
  });

  it('hedges nothing and names none of the machinery that produced it', () => {
    // Ability modals ("can go and find out") aren't hedges, hence excluded — "may be wrong" costs tokens and is ignored under pressure.
    for (const where of WHERES) {
      const line = CLAIMS[where].line;
      expect(line).not.toMatch(/\b(may|might|possibly|probably|likely|perhaps|presumably|apparently|seems?|appears?)\b/i);
      expect(line).not.toMatch(/\b(triage|gate|verdict|classifier|confidence|situation|placement|model)\b/i);
    }
  });
});

describe('the one situation that is not a verdict', () => {
  // From the `routeConsult` cap, not a model guess — "survives being wrong" doesn't apply, but still asserts nothing refutable: a numbered `<consults>` line.
  const BLOCKED =
    'A question is already out and has not come back, so a second one cannot leave this room yet — answer from what is already here, or say plainly that you are still waiting on the first.';

  function blocked(triage: TriageVerdict | null | undefined) {
    return assembleSpeakingRequest({
      prompt: PROMPT,
      transcript: TRANSCRIPT,
      consults: CONSULTS,
      context: CONTEXT,
      triage,
      consultBlocked: true,
      placement: 'guidance-first',
    });
  }

  it('renders in place of the outside line, byte-for-byte', () => {
    // `outside`'s line claims "you can go and find out" — false when nothing can leave the room, hence the swap.
    expect(situation(blocked({ where: 'outside', preamble: 'Let me find out.' }).user)).toBe(BLOCKED);
    expect(situation(blocked({ where: 'outside' }).user)).toBe(BLOCKED);
    expect(situation(blocked({ where: 'outside' }).user)).not.toBe(CLAIMS.outside.line);
    expect(BLOCKED.split('\n')).toHaveLength(1);
    expect(blocked({ where: 'outside', preamble: 'Let me find out.' }).user).not.toContain('Let me find out.');
  });

  it('leaves the other three verdicts exactly as they are', () => {
    // `pending` already says this more specifically; `room`/`elsewhere` never had a question out — nothing for the modifier to change.
    for (const where of ['room', 'pending', 'elsewhere'] as const) {
      expect(situation(blocked({ where }).user)).toBe(CLAIMS[where].line);
    }
  });

  it('changes nothing at all when nothing is out', () => {
    // Absent and `false` are the same claim — both byte-for-byte the pre-flag request, same rule as the null verdict.
    const plain = request({ where: 'outside' }).user;
    expect(
      assembleSpeakingRequest({
        prompt: PROMPT,
        transcript: TRANSCRIPT,
        consults: CONSULTS,
        context: CONTEXT,
        triage: { where: 'outside' },
        consultBlocked: false,
        placement: 'guidance-first',
      }).user,
    ).toBe(plain);
    expect(situation(plain)).toBe(CLAIMS.outside.line);
  });

  it('cannot resurrect the block a null verdict suppressed', () => {
    // consultBlocked only picks which line renders; the gate's null fail-safe outranks it — no verdict means no block regardless.
    const bare = buildSpeakingUserMessage(TRANSCRIPT, CONSULTS, CONTEXT);
    expect(blocked(null).user).toBe(bare);
    expect(blocked(undefined).user).toBe(bare);
    expect(blocked(null).user).not.toContain('<situation>');
  });

  it('hedges nothing and names none of the machinery, like the four', () => {
    // Unlike the four, this names two routes — a "cannot leave" fact alone leaves the turn nowhere to go.
    expect(BLOCKED).not.toMatch(/\b(may|might|possibly|probably|likely|perhaps|presumably|apparently|seems?|appears?)\b/i);
    expect(BLOCKED).not.toMatch(/\b(triage|gate|verdict|classifier|confidence|situation|placement|model)\b/i);
    // Checks for "outside", the verdict it replaces — "this room" is voice-speaking.md's term for the meeting, not a `room` leak.
    expect(BLOCKED.toLowerCase()).not.toContain('outside');
  });
});

describe('the block cannot see the window it may contradict', () => {
  // `situationBlock` sees only the verdict, never the transcript — can't soften a wrong line; wording alone must survive being wrong.
  const CONTRADICTS_ROOM = [
    'Ann: something dropped a column in a migration last week and downstream broke.',
    'Ann: I do not remember which one.',
    'Ann: Archie, which migration was it?',
  ].join('\n');
  const CONTRADICTS_THE_REST = [
    'Ann: it was migration 0042 and it dropped the retention column.',
    'Ann: Archie, which migration was it?',
  ].join('\n');

  it('renders the same sentence whatever the transcript says', () => {
    for (const where of WHERES) {
      for (const transcript of [CONTRADICTS_ROOM, CONTRADICTS_THE_REST, 'Ann: hello.']) {
        const user = assembleSpeakingRequest({
          prompt: PROMPT,
          transcript,
          consults: CONSULTS,
          context: CONTEXT,
          triage: { where },
          placement: 'guidance-first',
        }).user;
        expect(situation(user)).toBe(CLAIMS[where].line);
      }
    }
  });

  it('renders the same sentence with no consults and no context at all', () => {
    // Matters most for `pending`: its line points at the questions-out list, absent here — renderer doesn't care, wording alone must resolve.
    for (const where of WHERES) {
      const user = assembleSpeakingRequest({
        prompt: PROMPT,
        transcript: TRANSCRIPT,
        triage: { where },
        placement: 'guidance-first',
      }).user;
      expect(situation(user)).toBe(CLAIMS[where].line);
    }
  });
});

describe('every verdict renders, as a fact rather than a label', () => {
  it('renders one sentence for each of the four, all different', () => {
    const lines = WHERES.map((where) => situation(request({ where }).user));
    for (const line of lines) {
      expect(line).not.toBeNull();
      // Single line, not a paragraph or list — paid on every turn with a verdict.
      expect(String(line).split('\n')).toHaveLength(1);
      expect(String(line).trim().length).toBeGreaterThan(0);
      expect(String(line).trim().endsWith('.')).toBe(true);
    }
    expect(new Set(lines).size).toBe(WHERES.length);
  });

  it('never ships the verdict name itself, so nothing has to be taught', () => {
    // Reading `pending` verbatim needs a defining paragraph in voice-speaking.md — costlier, one more thing to sync. If this needs relaxing, the line is wrong, not the check.
    for (const where of WHERES) {
      expect(situation(request({ where }).user)?.toLowerCase()).not.toContain(where);
    }
  });

  it('says nothing about what to say — no imperative opens any of them', () => {
    // A rule here would be a second author of a decision the prompt already owns.
    for (const where of WHERES) {
      const line = String(situation(request({ where }).user));
      expect(line).not.toMatch(/^(Do|Don't|Never|Always|Say|Ask|Tell|Answer|Reply|Avoid)\b/);
      expect(line).not.toMatch(/\byou (?:must|should|need to)\b/i);
    }
  });

  it('carries the preamble nowhere — that is spoken, not framed', () => {
    // The preamble is already said aloud and in the transcript by render time; repeating it here would duplicate it.
    const withPreamble = request({ where: 'outside', preamble: 'Let me find that out.' });
    expect(withPreamble.user).not.toContain('Let me find that out.');
    expect(withPreamble.user).toBe(request({ where: 'outside' }).user);
  });
});

describe('a null verdict is the fail-safe: no block at all', () => {
  const bare = buildSpeakingUserMessage(TRANSCRIPT, CONSULTS, CONTEXT);

  it('renders byte-for-byte the request a turn sent before this existed', () => {
    expect(request(null).user).toBe(bare);
    expect(request(undefined).user).toBe(bare);
    expect(
      assembleSpeakingRequest({
        prompt: PROMPT,
        transcript: TRANSCRIPT,
        consults: CONSULTS,
        context: CONTEXT,
        placement: 'guidance-first',
      }).user,
    ).toBe(bare);
    expect(request(null).user).not.toContain('<situation>');
  });

  it('holds under data-first too, where the guidance follows the data', () => {
    const guidance = splitSpeakingPrompt(PROMPT).guidance;
    expect(request(null, 'data-first').user).toBe(`${bare}\n\n${guidance}`);
    expect(request(null, 'data-first').user).not.toContain('<situation>');
  });

  it('holds with no consults and no context, which is the pre-everything request', () => {
    const plain = buildSpeakingUserMessage(TRANSCRIPT);
    expect(assembleSpeakingRequest({ prompt: PROMPT, transcript: TRANSCRIPT, triage: null, placement: 'guidance-first' }).user).toBe(plain);
    expect(assembleSpeakingRequest({ prompt: PROMPT, transcript: TRANSCRIPT, placement: 'guidance-first' }).user).toBe(plain);
  });
});

describe('where the block sits, under both arms', () => {
  it('appends after every standing block, separated the way they are', () => {
    // Blank-line separator is the convention `consultsBlock` set and the other blocks copied; joining differently reads unlike the rest.
    const user = request({ where: 'room' }).user;
    expect(user.indexOf('</capabilities>')).toBeLessThan(user.indexOf('<situation>'));
    expect(user.endsWith(`\n\n<situation>\n${situation(user)}\n</situation>`)).toBe(true);
  });

  it('is the last data under data-first, immediately before the guidance', () => {
    // A fact about this turn, not the meeting: belongs nearest the answer — after the standing blocks, ahead of guidance.
    const user = request({ where: 'pending' }, 'data-first').user;
    expect(user.indexOf('</capabilities>')).toBeLessThan(user.indexOf('<situation>'));
    expect(user.indexOf('</situation>')).toBeLessThan(user.indexOf('## '));
  });

  it('renders identically in both arms — the arm moves guidance, never this', () => {
    for (const where of WHERES) {
      expect(situation(request({ where }, 'data-first').user)).toBe(
        situation(request({ where }, 'guidance-first').user),
      );
      expect(request({ where }, 'data-first').user.startsWith(request({ where }).user)).toBe(true);
    }
  });

  it('leaves the system half alone in both arms', () => {
    // The verdict is per-turn data; must not reach the system half, which is identical on every turn.
    expect(request({ where: 'room' }).system).toBe(request(null).system);
    expect(request({ where: 'room' }, 'data-first').system).toBe(request(null, 'data-first').system);
  });
});

describe('the triage gate cannot be given a verdict — structurally, not by convention', () => {
  const cfg: VoiceConfig = { deepgramApiKey: 'd', anthropicApiKey: 'a', botName: 'Archie' };
  const seen: { user: string }[] = [];

  beforeEach(() => {
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { content: string }[] };
      seen.push({ user: body.messages[0].content });
      return {
        ok: true,
        status: 200,
        async json() {
          return { content: [{ type: 'text', text: '{"where": "pending"}' }] };
        },
        async text() {
          return '';
        },
      };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    seen.length = 0;
  });

  it('sends the shared builder output and nothing after it', async () => {
    expect(await runTriageGate(cfg, { transcript: TRANSCRIPT, consults: CONSULTS, context: CONTEXT })).toEqual({
      where: 'pending',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].user).toBe(buildSpeakingUserMessage(TRANSCRIPT, CONSULTS, CONTEXT));
    expect(seen[0].user).not.toContain('<situation>');
  });

  it('has no verdict-shaped parameter to be handed one through', () => {
    // Structural: 3 params exactly; `.length` catches a silent fourth — else a guarantee becomes a convention.
    expect(buildSpeakingUserMessage).toHaveLength(3);
    // Other half: only assembleSpeakingRequest renders the block, needing a speaking prompt the gate never holds (it loads voice-triage.md).
    for (const where of WHERES) {
      expect(request({ where }).user).toContain('<situation>');
    }
    expect(buildSpeakingUserMessage(TRANSCRIPT, CONSULTS, CONTEXT)).not.toContain('<situation>');
  });
});
