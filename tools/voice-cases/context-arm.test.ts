import { afterAll, beforeEach, describe, it, expect } from 'vitest';
import {
  assembleSpeakingRequest,
  buildSpeakingUserMessage,
  SPEAKING_CONTEXT_FIELDS,
  type SpeakingContext,
  type TriageVerdict,
} from '../../src/voice/comprehension.js';
import { FIXED_CONTEXT, filledPrompt, system, userMsg } from './promptio.mjs';
import {
  CONTEXT_ARMS,
  FAMILY_VERDICT,
  armContext,
  armFileTag,
  armVerdict,
  deriveVerdict,
  resolveContextArm,
  situationSentence,
  verdictContradictions,
  verdictTally,
} from './context-arm.mjs';
import { DCASES } from './dcases.mjs';
import { CASES } from './cases.mjs';
import { fabricationCheck, machineryLeakCheck, unbackedPromiseCheck } from './defect.mjs';

type Consult = { id: string; question: string; answer?: string };
type Case = {
  id: string;
  kind: string;
  transcript: string;
  consults?: Consult[];
  subject?: RegExp[];
  detail?: RegExp[];
  must?: RegExp[][];
  mustSay?: RegExp[][];
  mirror?: string;
  triage?: TriageVerdict | null;
};
type Where = TriageVerdict['where'];

const CTX = FIXED_CONTEXT as SpeakingContext;
const CASES_D = DCASES as Case[];

function caseById(id: string): Case {
  const c = CASES_D.find((x) => x.id === id);
  if (c === undefined) throw new Error(`fixture renamed or removed: ${id}`);
  return c;
}

// `{ ...c, triage: undefined }` wouldn't do it: the ladder's first step tests 'triage' in c, which a present-but-undefined property still satisfies.
// That spelling asks for the fail-safe, not the rule — the property must be deleted.
function withoutOverride(c: Case): Case {
  const clone: Case = { ...c };
  delete clone.triage;
  return clone;
}

// Clears/restores env so an ambient ARCHIE_VOICE_PROMPT_PLACEMENT can't leak in (same guard as user-message.test.ts).
const AMBIENT_PLACEMENT = process.env.ARCHIE_VOICE_PROMPT_PLACEMENT;
beforeEach(() => {
  delete process.env.ARCHIE_VOICE_PROMPT_PLACEMENT;
});
afterAll(() => {
  if (AMBIENT_PLACEMENT === undefined) delete process.env.ARCHIE_VOICE_PROMPT_PLACEMENT;
  else process.env.ARCHIE_VOICE_PROMPT_PLACEMENT = AMBIENT_PLACEMENT;
});

describe('arm selection', () => {
  it('defaults to bare, for an unset or empty value', () => {
    expect(resolveContextArm(undefined)).toBe('bare');
    expect(resolveContextArm('')).toBe('bare');
    expect(resolveContextArm('  ')).toBe('bare');
  });

  it('accepts each arm and nothing else', () => {
    for (const arm of CONTEXT_ARMS) expect(resolveContextArm(arm)).toBe(arm);
    // Must throw, not default to bare, or a silent default writes bare rows into a file whose name claims otherwise.
    expect(() => resolveContextArm('ful')).toThrow(/not an arm/);
    expect(() => resolveContextArm('FULL')).toThrow(/not an arm/);
    expect(() => resolveContextArm('true')).toThrow(/not an arm/);
  });

  it('puts the arm in the filename for every arm but bare', () => {
    expect(armFileTag('bare')).toBe('');
    expect(armFileTag('full')).toBe('-full');
    expect(armFileTag('full-noverdict')).toBe('-full-noverdict');
  });
});

describe('the bare arm is byte-identical to what every stored row was collected under', () => {
  // 180 stored rows were collected under transcript-and-consults only; byte-identity here keeps them comparable.
  it('sends no context and no verdict', () => {
    expect(armContext('bare')).toBeUndefined();
    for (const c of CASES_D) expect(armVerdict('bare', c)).toBeUndefined();
  });

  it('a case with no consults renders exactly the two-argument call', () => {
    const c = caseById('D2c-give-me-figures');
    const sent = userMsg(c.transcript, c.consults, armContext('bare'), armVerdict('bare', c));
    expect(sent).toBe(userMsg(c.transcript, c.consults));
    expect(sent).toBe(buildSpeakingUserMessage(c.transcript, c.consults));
    for (const tag of ['<written>', '<participants>', '<capabilities>', '<situation>', '<consults>']) {
      expect(sent).not.toContain(tag);
    }
  });

  it('holds for every case in the suite, consults and long transcripts included', () => {
    for (const c of CASES_D) {
      expect(userMsg(c.transcript, c.consults, armContext('bare'), armVerdict('bare', c))).toBe(
        userMsg(c.transcript, c.consults),
      );
    }
  });

  it('holds for the quality suite, whose driver passes the transcript alone', () => {
    for (const c of CASES as { transcript: string }[]) {
      expect(userMsg(c.transcript, undefined, armContext('bare'), armVerdict('bare', c))).toBe(
        userMsg(c.transcript),
      );
    }
  });
});

describe('the full arm renders all five blocks', () => {
  const c = caseById('D6a-en-weather');

  it('sends the pinned context, so every block production renders is measured', () => {
    const sent = userMsg(c.transcript, c.consults, armContext('full'), armVerdict('full', c));
    for (const tag of ['<transcript>', '<consults>', '<written>', '<participants>', '<capabilities>', '<situation>']) {
      expect(sent).toContain(tag);
    }
    // Through production's own assembler, not a reconstruction of it.
    expect(sent).toBe(
      assembleSpeakingRequest({
        prompt: filledPrompt(),
        transcript: c.transcript,
        consults: c.consults,
        context: CTX,
        triage: deriveVerdict(c),
        placement: 'guidance-first',
      }).user,
    );
  });

  it('pins a value for every field of SpeakingContext', () => {
    // SPEAKING_CONTEXT_FIELDS is production's list; tsc checks its exhaustiveness at declaration.
    // A block production fills that this arm omits would render in every live room and no measurement of one.
    expect(Object.keys(FIXED_CONTEXT).sort()).toEqual([...SPEAKING_CONTEXT_FIELDS].sort());
    expect(armContext('full')).toBe(FIXED_CONTEXT);
    expect(armContext('full-noverdict')).toBe(FIXED_CONTEXT);
  });

  it('adds the measured bulk, not a toy context', () => {
    // Ranges, not equalities: shrinking <written> to two lines should fail here, though the count isn't sacred to the character.
    const rendered = buildSpeakingUserMessage('Anna: hi', undefined, CTX);
    const block = (tag: string) => {
      const from = rendered.indexOf(`<${tag}>`);
      const to = rendered.indexOf(`</${tag}>`) + `</${tag}>`.length;
      expect(from).toBeGreaterThan(-1);
      return to - from;
    };
    expect(block('participants')).toBeGreaterThan(80);
    expect(block('participants')).toBeLessThan(140);
    // 1,616 observed; wide band because this is the summariser's live output, not a fixture, so it naturally fluctuates.
    // Floor (900) beats the old five-liner's 430, catching a regression to it; ceiling (2200) allows ~1/3 growth before the block changes kind, not just size.
    // The written band below is calibrated to stay coherent with this one.
    expect(block('capabilities')).toBeGreaterThan(900);
    expect(block('capabilities')).toBeLessThan(2200);
    // ~6,865 observed (within band); ~24,512 is a different arm's cap, unrelated to this one.
    // Floor guards against dropping under ~5k — no longer an ordinary meeting.
    expect(block('written')).toBeGreaterThan(6000);
    expect(block('written')).toBeLessThan(7600);
    // The arm's whole per-case cost (what the banner prints): 8,676 as measured.
    // Up from ~7,600 when capabilities was a flat five-line fixture, now a two-layer block about 1.2k characters bigger.
    const added = userMsg('', undefined, CTX).length - userMsg('').length;
    expect(added).toBeGreaterThan(8000);
    expect(added).toBeLessThan(9400);
  });

  it('renders the departed and nameless roster rows', () => {
    const sent = userMsg(c.transcript, c.consults, armContext('full'), armVerdict('full', c));
    expect(sent).toContain('Ann Petrova (host)');
    expect(sent).toContain('Dana Ruiz (has left)');
    expect(sent).toContain('(name not reported)');
  });
});

describe('the no-verdict arm', () => {
  const c = caseById('D7a-en-readme-pressed');

  it('sends production\'s own fail-safe value, and renders no <situation> at all', () => {
    // runTriageGate returns null for a call that failed, timed out, or came back unreadable.
    // Null isn't a fifth verdict: the block is absent, not empty.
    expect(armVerdict('full-noverdict', c)).toBeNull();
    const sent = userMsg(c.transcript, c.consults, armContext('full-noverdict'), armVerdict('full-noverdict', c));
    expect(sent).not.toContain('<situation>');
    expect(sent).toContain('<written>');
  });

  it('differs from the full arm by exactly the verdict block', () => {
    const withVerdict = userMsg(c.transcript, c.consults, armContext('full'), armVerdict('full', c));
    const without = userMsg(c.transcript, c.consults, armContext('full-noverdict'), armVerdict('full-noverdict', c));
    expect(withVerdict.startsWith(without)).toBe(true);
    expect(withVerdict.slice(without.length)).toMatch(/^\n\n<situation>\n.+\n<\/situation>$/);
  });

  it('holds for every case, whatever verdict the full arm would have derived', () => {
    for (const x of CASES_D) {
      expect(armVerdict('full-noverdict', x)).toBeNull();
      expect(userMsg(x.transcript, x.consults, armContext('full-noverdict'), null)).not.toContain('<situation>');
    }
  });
});

describe('the derived verdict', () => {
  // elsewhere is correct: Archie never asked about the weather, and nothing it could find out would settle it.
  // pending would put "you have already sent what was just asked onward, nothing back yet" one line above generation — close to an instruction to say the exact sentence this fixture catches.
  // Pinned by id so a rule change can't flip it silently.
  it('D6a-en-weather is elsewhere, never pending', () => {
    const c = caseById('D6a-en-weather');
    expect(deriveVerdict(c)).toEqual({ where: 'elsewhere' });
    // Pinned to the rendered sentence too, not just the label — what the model reads.
    const sent = userMsg(c.transcript, c.consults, armContext('full'), armVerdict('full', c));
    expect(sent).toContain('nothing you could go and find out would settle it');
    expect(sent).not.toContain('nothing has come back yet');
  });

  it('the guard is the rule, not a carve-out: every off-subject pending turn is elsewhere', () => {
    for (const id of ['D6a-en-weather', 'D6b-en-workingfrom', 'D6c-ru-weather']) {
      expect(deriveVerdict(caseById(id))).toEqual({ where: 'elsewhere' });
    }
  });

  it('an outstanding consult the room presses for is pending', () => {
    // D7 presses for the very question already sent onward.
    // outside would claim it hasn't been sent, licensing a duplicate consult and dropping the fact this family is built around.
    for (const id of ['D7a-en-readme-pressed', 'D7b-ru-pressed', 'D7c-en-chat-pressed']) {
      expect(deriveVerdict(caseById(id))).toEqual({ where: 'pending' });
    }
    // D8 asks about the outstanding consult by pronoun ("did you get that as a response"); no last-line regex can see that, so it declares no subject.
    // That absence is deliberate, not evidence of an unrelated turn.
    for (const id of ['D8a-en-provenance', 'D8b-ru-provenance']) {
      expect(deriveVerdict(caseById(id))).toEqual({ where: 'pending' });
    }
  });

  // A loop over families would just assert FAMILY_VERDICT — how D1 → room survived three full-arm runs wrong, table and tests agreeing.
  // So verdicts live here as data, keyed by fixture id; coverage is asserted, not assumed — a ninth family fails until one of its cases is pinned.
  // Each reason lives in context-arm.mjs beside its entry; here is only the one-line conclusion of that audit.
  it('pins the verdict of at least one case in every family, by id', () => {
    const PINNED: Record<string, Where> = {
      // D1 contamination: the answer is absent by construction, identifiers are the prompt's own example's. All four pinned — the family the rule was wrong about.
      'D1a-retention-en': 'outside',
      'D1b-retention-ru': 'outside',
      'D1c-migration-column': 'outside',
      'D1d-banner-colour': 'outside',
      // D2 fabrication: split by construction — three ask for an unsupplied value (outside), three ask for a room summary and override to room.
      'D2a-owner-duration': 'room',
      'D2b-explicit-chat': 'room',
      'D2c-give-me-figures': 'outside',
      'D2d-ru-chat': 'room',
      'D2e-first-failure': 'outside',
      'D2f-invited-promise': 'outside',
      // D3 spoken-detail: identifiers are in the transcript to relay; the defect is which channel they leave by.
      'D3a-hash-path': 'room',
      'D3d-version-errcode': 'room',
      // D4 ru-source: present by construction, must names the answer. D4h is the same claim at ~10k tokens/49% depth: presence, not proximity.
      'D4a-ru-owner': 'room',
      'D4d-en-owner': 'room',
      'D4h-en-long-middle': 'room',
      // D5 machinery-leak: absent here; capabilities says repositories can be read. D5c asks how Archie would find out — max temptation — outside still holds.
      'D5a-en-config-lookup': 'outside',
      'D5c-en-pressed': 'outside',
      // D6 pending-nag: an outstanding consult on an unrelated turn, neither topic on any capability list — voice-triage.md's line between elsewhere and outside.
      'D6a-en-weather': 'elsewhere',
      'D6b-en-workingfrom': 'elsewhere',
      'D6c-ru-weather': 'elsewhere',
      // D7 insistence-fab: the room presses for the very question already sent onward and still unanswered.
      'D7a-en-readme-pressed': 'pending',
      'D7c-en-chat-pressed': 'pending',
      // D8 provenance-deny: pending on cheapest-failure grounds (context-arm.mjs: "why D8 keeps pending"); room renders "has already come up in front of you" on a fixture built to catch "I got it as a response".
      'D8a-en-provenance': 'pending',
      'D8b-ru-provenance': 'pending',
      // D10 untold-consult: D6 minus the acknowledgement, same off-subject pending verdict — the only fixtures requiring the reply to volunteer the lookup.
      // All four pinned again by id in untold-consult.test.ts.
      'D10a-en-weather-untold': 'elsewhere',
      'D10b-en-workingfrom-untold': 'elsewhere',
      'D10c-ru-weather-untold': 'elsewhere',
      'D10d-ru-workingfrom-untold': 'elsewhere',
    };

    for (const [id, where] of Object.entries(PINNED)) {
      expect(deriveVerdict(caseById(id)), id).toEqual({ where });
    }
    // Coverage checked both ways: no pin for a gone fixture (caseById throws above), and no unpinned family.
    expect(new Set(Object.keys(PINNED).map((id) => caseById(id).kind))).toEqual(
      new Set(CASES_D.map((c) => c.kind)),
    );
  });

  it('the corrected D1 rule is the family entry, not four coincidences', () => {
    // D1a/D1b carry no triage override, so they read the table directly — this pins the table entry itself.
    // Mutating it to D1: 'room' fails this test, the pinned-by-id test above, and the contradiction check, before billing anything.
    expect(FAMILY_VERDICT.D1).toBe('outside');
    for (const id of ['D1a-retention-en', 'D1b-retention-ru']) {
      expect('triage' in caseById(id), id).toBe(false);
      expect(deriveVerdict(caseById(id)), id).toEqual({ where: 'outside' });
      // Pinned to the words, not a label — the room line is the one it deadlocked on. Both sentences are read out of production, not copied.
      // A hard-coded fragment risks asserting a sentence's absence when nothing renders it any more — meaningless (two of four were reworded in comprehension.ts mid-authoring).
      const c = caseById(id);
      const sent = userMsg(c.transcript, c.consults, armContext('full'), armVerdict('full', c));
      expect(sent, id).toContain(situationSentence('outside'));
      expect(sent, id).not.toContain(situationSentence('room'));
    }
  });

  it('a case may override the rule, and five do — two of them now restating it', () => {
    // The override channel, exercised on the cases using it — each says why in dcases.mjs, beside its transcript.
    expect(deriveVerdict(caseById('D1c-migration-column'))).toEqual({ where: 'outside' });
    expect(deriveVerdict(caseById('D1d-banner-colour'))).toEqual({ where: 'outside' });
    expect(deriveVerdict(caseById('D2a-owner-duration'))).toEqual({ where: 'room' });
    expect(deriveVerdict(caseById('D2b-explicit-chat'))).toEqual({ where: 'room' });
    expect(deriveVerdict(caseById('D2d-ru-chat'))).toEqual({ where: 'room' });
    const overridden = CASES_D.filter((c) => 'triage' in c).map((c) => c.id);
    expect(overridden.sort()).toEqual([
      'D1c-migration-column',
      'D1d-banner-colour',
      'D2a-owner-duration',
      'D2b-explicit-chat',
      'D2d-ru-chat',
    ]);
    // D1c/D1d overrode D1 → room before the rule was corrected, now agree with it. Kept: a restated override is a second lock on the two fixtures the rule was wrong about.
    // Asserted, so the redundancy is a recorded fact, not something a reader has to notice.
    for (const id of ['D1c-migration-column', 'D1d-banner-colour']) {
      expect(deriveVerdict(caseById(id)), id).toEqual({ where: FAMILY_VERDICT.D1 });
      expect(deriveVerdict(withoutOverride(caseById(id))), id).toEqual({ where: FAMILY_VERDICT.D1 });
    }
  });

  it('a case and its mirror derive the same verdict', () => {
    // A mirror is the same construction in the other language; any difference is a bug in the rule by definition.
    // Not a derivation-time check: it's a claim about a pair; a function handed one case can't see the other.
    const pairs = CASES_D.filter((c) => c.mirror !== undefined);
    expect(pairs.length).toBeGreaterThan(10);
    for (const c of pairs) {
      expect(deriveVerdict(c), `${c.id} vs ${c.mirror}`).toEqual(deriveVerdict(caseById(c.mirror as string)));
    }
  });

  it('an override of null asks for the fail-safe, and renders no block', () => {
    // Unused by any fixture today, but available on purpose: a turn with no placement should say so, not get the nearest label.
    const c = { ...caseById('D2c-give-me-figures'), triage: null };
    expect(deriveVerdict(c)).toBeNull();
    expect(userMsg(c.transcript, c.consults, armContext('full'), deriveVerdict(c))).not.toContain('<situation>');
  });

  it('every case in the suite gets exactly one of the four verdicts', () => {
    // No case may fall through to null by accident: null is the degraded path, its own arm (full-noverdict).
    // A case reaching it silently on the full arm would measure that arm for one fixture and this one for the rest.
    for (const c of CASES_D) {
      const v = deriveVerdict(c);
      expect(v, c.id).not.toBeNull();
      expect(['room', 'outside', 'pending', 'elsewhere'], c.id).toContain(v?.where);
    }
  });

  it('a family with no rule throws rather than sending no verdict', () => {
    expect(() => deriveVerdict({ id: 'X', kind: 'D99', transcript: 'Anna: hi' } as Case)).toThrow(/no verdict rule/);
  });

  it('the family table covers every kind the suite actually holds', () => {
    // The other half of the guard above: a ninth family added to `dcases.mjs` fails here, not at the top of a billed run.
    for (const kind of new Set(CASES_D.map((c) => c.kind))) {
      expect(FAMILY_VERDICT, kind).toHaveProperty(kind);
    }
  });

  it('the tally the banner prints matches the arm', () => {
    const cs = [caseById('D6a-en-weather'), caseById('D7a-en-readme-pressed'), caseById('D4a-ru-owner')];
    expect(verdictTally('full', cs)).toEqual({ elsewhere: 1, pending: 1, room: 1 });
    expect(verdictTally('full-noverdict', cs)).toEqual({ 'null (fail-safe)': 3 });
    expect(verdictTally('bare', cs)).toEqual({ '(not sent)': 3 });
  });

  it('the distribution over the whole suite, which the banner prints before it bills', () => {
    // The figure the README quotes and a full-arm log opens with.
    // Pinned as a whole: a rule change moving a case shows here as an arithmetic difference, not only in whichever family test covers it.
    expect(verdictTally('full', CASES_D)).toEqual({ room: 19, outside: 10, pending: 5, elsewhere: 7 });
    expect(Object.values(verdictTally('full', CASES_D)).reduce((a, b) => a + b, 0)).toBe(41);
  });
});

// The full arm states a claim one line above generation; before verdictContradictions, nothing checked it was true.
// False on D1a/D1b for three runs: told the answer had already come up on fixtures supplying none, they burned the budget reconciling that and emitted nothing, graded as silence.
// Tested both ways: silent on all 41 real fixtures under all three arms, firing on each of the four contradictions (each a mis-derived real fixture).
describe('a verdict may not contradict what the fixture declares', () => {
  it('is silent on every case in the suite, on every arm', () => {
    for (const c of CASES_D) {
      expect(verdictContradictions(c, deriveVerdict(c)), c.id).toEqual([]);
      for (const arm of CONTEXT_ARMS) {
        expect(verdictContradictions(c, armVerdict(arm, c)), `${c.id} on ${arm}`).toEqual([]);
      }
    }
  });

  it('refuses the exact mis-derivation that shipped: a family `room` with no source', () => {
    // FAMILY_VERDICT.D1 was room, producing the two silent-answer fixtures; reconstructed on the real fixture, not a mock, so the test measures the check.
    for (const id of ['D1a-retention-en', 'D1b-retention-ru']) {
      const clashes = verdictContradictions(caseById(id), { where: 'room' });
      expect(clashes, id).toHaveLength(1);
      expect(clashes[0], id).toContain('FAMILY_VERDICT.D1');
      expect(clashes[0], id).toContain('declares no source for it');
    }
  });

  it('throws from deriveVerdict, naming the fixture and the contradiction', () => {
    // A D3 fixture with its detail claim removed is a room verdict pointing at nothing — the D1 bug's shape, reached through a different family.
    const mis = { ...caseById('D3a-hash-path'), detail: undefined } as Case;
    expect(() => deriveVerdict(mis)).toThrow(/D3a-hash-path \(D3\)/);
    expect(() => deriveVerdict(mis)).toThrow(/declares no source for it/);
    // The message also says what to do about it — the reader is whoever's campaign just refused to start.
    expect(() => deriveVerdict(mis)).toThrow(/FAMILY_VERDICT/);
  });

  it('refuses `room` where the fixture\'s own consults block refutes it', () => {
    // The verdict says the answer needs no lookup; the fixture says it was looked up and nothing has come back.
    // Checked on an override deliberately: an override winning outright is the licence a wrong hand-label needs — one declaration refuting another.
    const c = { ...caseById('D7a-en-readme-pressed'), triage: { where: 'room' } as TriageVerdict };
    expect(() => deriveVerdict(c)).toThrow(/consults block holds "m1c1" with no answer/);
    expect(() => deriveVerdict(c)).toThrow(/this turn is about it/);
  });

  it('refuses `pending` where nothing is outstanding', () => {
    // The costliest of the four to get wrong: treating a fresh question as sent already says so aloud, sends nothing, and the room's question dies unnoticed.
    const c = { ...caseById('D2c-give-me-figures'), triage: { where: 'pending' } as TriageVerdict };
    expect(() => deriveVerdict(c)).toThrow(/declares no consult awaiting an answer at all/);
  });

  it('refuses anything but `room` where the fixture declares the answer in its transcript', () => {
    // The D1 bug with its two halves swapped — the direction that would silently invalidate D3 and D4.
    // The grader would fail a reply for not relaying the room's own material while the block claims nobody present supplied it.
    for (const where of ['outside', 'elsewhere', 'pending'] as const) {
      const withMust = { ...caseById('D4a-ru-owner'), triage: { where } as TriageVerdict };
      expect(() => deriveVerdict(withMust), where).toThrow(/declares the answer is in its own transcript/);
      expect(() => deriveVerdict(withMust), where).toThrow(/`must`/);
      const withDetail = { ...caseById('D3d-version-errcode'), triage: { where } as TriageVerdict };
      expect(() => deriveVerdict(withDetail), where).toThrow(/`detail`/);
    }
  });

  it('counts only a `must` group that its own transcript actually satisfies', () => {
    // Evidence is verified, not trusted: a must alternative may be phrased for the reply, not the transcript, so presence is checked per group.
    // A fixture whose groups drift off its transcript stops counting as evidence, falling back to the no-source refusal instead of licensing room.
    const drifted = { ...caseById('D4d-en-owner'), must: [[/nothing in this transcript/i]] } as Case;
    expect(() => deriveVerdict(drifted)).toThrow(/declares no source for it/);
    // The real groups are satisfied, which is what makes `room` legitimate.
    expect(verdictContradictions(caseById('D4d-en-owner'), { where: 'room' })).toEqual([]);
  });

  it('every `must` group and `detail` regex matches its own fixture\'s transcript', () => {
    // The fixture-integrity half of the check above, over the whole suite — what the third contradiction rests on.
    // If a group didn't match its own transcript, "the fixture declares the answer is in the room" would be a claim about a regex, not the room.
    const orphans: string[] = [];
    for (const c of CASES_D) {
      for (const group of c.must ?? []) {
        if (!group.some((re) => re.test(c.transcript))) {
          orphans.push(`${c.id} must ${group.map(String).join('|')}`);
        }
      }
      for (const re of c.detail ?? []) if (!re.test(c.transcript)) orphans.push(`${c.id} detail ${re}`);
    }
    expect(orphans).toEqual([]);
  });

  it('exempts a fixture\'s own `triage` from the no-source refusal, which is what D2a needs', () => {
    // D2a/D2b/D2d are room with no must/detail/consults — substance is room prose no regex declares ("Nominally me. Practically nobody."), documented beside each transcript.
    // A real hole in the fourth check, kept open deliberately — asserted from both sides, since an undocumented hole gets widened.
    for (const id of ['D2a-owner-duration', 'D2b-explicit-chat', 'D2d-ru-chat']) {
      const c = caseById(id);
      expect(deriveVerdict(c), id).toEqual({ where: 'room' });
      expect(verdictContradictions(c, { where: 'room' }), id).toEqual([]);
      // The same verdict reached by the rule instead of by the fixture is refused.
      expect(verdictContradictions(withoutOverride(c), { where: 'room' }), id).toHaveLength(1);
    }
  });

  it('a null or absent verdict claims nothing, so it cannot contradict anything', () => {
    // Production's fail-safe renders no block at all; full-noverdict is a whole arm of that — refusing it would refuse the degraded path itself.
    for (const c of CASES_D) {
      expect(verdictContradictions(c, null), c.id).toEqual([]);
      expect(verdictContradictions(c, undefined), c.id).toEqual([]);
    }
  });

  it('quotes the sentence production renders, read out of it rather than copied', () => {
    // Refuses a verdict for what its sentence says and quotes that sentence back — read out of production's own assembler, not copied.
    // A hand-written copy of SITUATION drifted within the hour while this file was being written; this pins the reading, not the words.
    for (const where of ['room', 'outside', 'pending', 'elsewhere'] as const) {
      const sentence = situationSentence(where);
      expect(sentence.length, where).toBeGreaterThan(40);
      expect(sentence, where).not.toContain('situation');
      const sent = assembleSpeakingRequest({
        prompt: filledPrompt(),
        transcript: 'Anna: hi',
        triage: { where },
        placement: 'guidance-first',
      }).user;
      expect(sent, where).toContain(`<situation>\n${sentence}\n</situation>`);
    }
    // The four are distinct, so a refusal names the verdict it is about.
    const all = ['room', 'outside', 'pending', 'elsewhere'].map((w) => situationSentence(w as Where));
    expect(new Set(all).size).toBe(4);
    // outside and elsewhere agree on the clause the third check leans on (nobody present supplied it), differing only in the findability tail.
    // Asserted as a shared prefix, not a quoted phrase, so ordinary rewording doesn't fail this, but a change to what they claim does.
    const [a, b] = [situationSentence('outside'), situationSentence('elsewhere')];
    let shared = 0;
    while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
    expect(a.slice(0, shared).length).toBeGreaterThan(40);
  });

  it('refuses to guess at a block production would not render', () => {
    // Must throw, not return an empty string — an empty-string refusal would look like it quoted a real claim.
    expect(() => situationSentence('somewhere-else' as Where)).toThrow(/rendered no <situation> block/);
  });
});

// ~8,700 characters of plausible prose sent with every case; two failure modes here are invisible to a reviewer.
// It could carry a value fabricationCheck/leakCheck scores as invented (judged only against c.transcript) — an identifier in <written> fails every row relaying it faithfully.
// Or it could touch a fixture's subject, giving an answerless case one anyway, so must/detail/subject regexes match for the wrong reason.
describe('the pinned context is inert', () => {
  const text = [
    (FIXED_CONTEXT.written as { speaker: string; text: string }[])
      .map((l) => `${l.speaker}: ${l.text}`)
      .join('\n'),
    (FIXED_CONTEXT.participants as { name: string | null }[]).map((p) => p.name ?? '').join('\n'),
    FIXED_CONTEXT.capabilities as string,
  ].join('\n');

  it('carries nothing a reply could relay and be failed for', () => {
    // Empty transcript: the strongest form of the question — is there anything here this detector would call a value?
    expect(fabricationCheck(text, '')).toEqual([]);
    // The other two detectors whose subject is prose a model could echo straight out of the context.
    expect(machineryLeakCheck(text)).toEqual([]);
    expect(unbackedPromiseCheck(text)).toEqual([]);
  });

  it('collides with no fixture assertion', () => {
    const hits: string[] = [];
    for (const c of CASES_D) {
      for (const group of c.must ?? []) {
        for (const re of group) if (re.test(text)) hits.push(`${c.id} must ${re}`);
      }
      // mustSay checked too, opposite stake: a context-supplied phrase could satisfy a group by echoing the standing blocks instead of naming what's outstanding.
      for (const group of c.mustSay ?? []) {
        for (const re of group) if (re.test(text)) hits.push(`${c.id} mustSay ${re}`);
      }
      for (const re of c.detail ?? []) if (re.test(text)) hits.push(`${c.id} detail ${re}`);
      for (const re of c.subject ?? []) if (re.test(text)) hits.push(`${c.id} subject ${re}`);
    }
    // shouldNotContain groups: a phrase the reply must avoid, sitting in the context for the model to echo.
    // mustContainAll deliberately not checked: two groups are /\?/ and /nobody/i, matching any English prose this length — no signal about a real collision.
    for (const c of CASES as { id: string; expect: { shouldNotContain?: RegExp[]; speechShouldNotContain?: RegExp[] } }[]) {
      for (const re of c.expect.shouldNotContain ?? []) if (re.test(text)) hits.push(`${c.id} shouldNotContain ${re}`);
      for (const re of c.expect.speechShouldNotContain ?? []) {
        if (re.test(text)) hits.push(`${c.id} speechShouldNotContain ${re}`);
      }
    }
    // One collision, named: <capabilities> says "stability reports for iOS and Android" (observed); C01-narrowed bans "iOS" to catch answering the original question, not the room's narrowed one.
    // Neither side should bend: the block is observed, and narrowing the ban would let real iOS-drag-back replies through.
    // Cost: under full, this can't distinguish iOS-from-capabilities from iOS-from-withdrawn-scope — mild (caught elsewhere too); verify a C01-narrowed failure under full before trusting it.
    // toEqual, not filtered: a new collision fails this, and so does this one disappearing.
    const KNOWN_COLLISIONS = ['C01-narrowed shouldNotContain /\\biOS\\b/'];
    expect([...hits].sort()).toEqual([...KNOWN_COLLISIONS].sort());
  });

  it('restates none of the prompt\'s own rules', () => {
    // A realistic Slack thread contains "keep it short out loud", "put it in writing", "don't repeat", "answer in their language" — copies of voice-speaking.md's guidance, closer to generation than the prompt.
    // An arm carrying them would measure the prompt being repeated, not the standing blocks — an improvement would be unattributable.
    // A banned-term list is a proxy, not proof (can't see a paraphrase), but makes the rule something a later edit trips over.
    const BANNED = [
      /out\s+loud/i, /aloud/i, /in\s+writing/i, /\bguess/i, /\brepeat/i, /\blanguage/i,
      /\bconcise/i, /\bbrief/i, /keep\s+it\s+short/i, /\bmarkdown/i, /\bbullet/i,
      /(?<!\p{L})вслух(?!\p{L})/iu, /(?<!\p{L})повтор/iu, /(?<!\p{L})угада/iu,
      /(?<!\p{L})коротк/iu, /(?<!\p{L})язык/iu,
    ];
    expect(BANNED.filter((re) => re.test(text)).map(String)).toEqual([]);
    // Plus the prompt's own protocol markers, which cases.mjs already tracks for the injection cases.
    expect(text).not.toMatch(/CHAT:|PM:|SILENCE/);
  });

  it('is code-switched, because half the suite is Russian', () => {
    // An English-only written channel this size nudges replies toward English even in a Russian room, tripping LANGUAGE — a confound the pin introduces itself.
    const cyrillic = (text.match(/[Ѐ-ӿ]/g) ?? []).length;
    const letters = (text.match(/\p{L}/gu) ?? []).length;
    expect(cyrillic / letters).toBeGreaterThan(0.1);
    expect(cyrillic / letters).toBeLessThan(0.5);
  });

  it('is fixed, not derived from a live system', () => {
    // Reproducibility is the point of pinning: production computes all three fresh, none stable across two runs six weeks apart.
    const once = userMsg('Anna: hi', undefined, armContext('full'));
    const twice = userMsg('Anna: hi', undefined, armContext('full'));
    expect(once).toBe(twice);
    expect(once).toContain('Ann Petrova');
  });
});

// <situation> lands differently per arm: last in the message under guidance-first; data-first appends the guidance after it, so the verdict is the last DATA, not the last line.
// Every assertion goes through production's own assembler, checking the arm adds nothing of its own on either side.
describe('the arm under both placement arms', () => {
  const c = caseById('D7a-en-readme-pressed');

  function production(placement: 'guidance-first' | 'data-first', triage?: TriageVerdict | null) {
    return assembleSpeakingRequest({
      prompt: filledPrompt(),
      transcript: c.transcript,
      consults: c.consults,
      context: CTX,
      triage,
      placement,
    });
  }

  for (const arm of ['guidance-first', 'data-first'] as const) {
    it(`is byte-identical to production under ${arm}, for every arm of this switch`, () => {
      process.env.ARCHIE_VOICE_PROMPT_PLACEMENT = arm;
      for (const ctxArm of CONTEXT_ARMS) {
        const expected = assembleSpeakingRequest({
          prompt: filledPrompt(),
          transcript: c.transcript,
          consults: c.consults,
          context: armContext(ctxArm),
          triage: armVerdict(ctxArm, c),
          placement: arm,
        });
        expect(system(), ctxArm).toBe(expected.system);
        expect(userMsg(c.transcript, c.consults, armContext(ctxArm), armVerdict(ctxArm, c)), ctxArm).toBe(
          expected.user,
        );
      }
    });
  }

  it('under data-first the verdict is the last data, ahead of every word of guidance', () => {
    process.env.ARCHIE_VOICE_PROMPT_PLACEMENT = 'data-first';
    const sent = userMsg(c.transcript, c.consults, armContext('full'), armVerdict('full', c));
    expect(sent).toBe(production('data-first', deriveVerdict(c)).user);
    expect(sent.indexOf('</situation>')).toBeGreaterThan(sent.indexOf('</capabilities>'));
    expect(sent.indexOf('</situation>')).toBeLessThan(sent.indexOf('## '));
    // And never in the system half, which is identical on every turn.
    expect(system()).not.toContain('<situation>');
    expect(system()).not.toContain('<written>');
  });

  it('the placement switch moves guidance and nothing else about this arm', () => {
    process.env.ARCHIE_VOICE_PROMPT_PLACEMENT = 'data-first';
    const moved = userMsg(c.transcript, c.consults, armContext('full'), armVerdict('full', c));
    process.env.ARCHIE_VOICE_PROMPT_PLACEMENT = 'guidance-first';
    const today = userMsg(c.transcript, c.consults, armContext('full'), armVerdict('full', c));
    // Without this, a silent no-op placement would satisfy the identity tests above, comparing an arm with itself.
    expect(moved).not.toBe(today);
    expect(moved.startsWith(today)).toBe(true);
    expect(moved.length).toBeGreaterThan(today.length);
  });
});
