import { describe, it, expect } from 'vitest';
import { buildSpeakingUserMessage, type SpeakingContext } from '../../src/voice/comprehension.js';
import { FIXED_CONTEXT, userMsg } from './promptio.mjs';
import { CONTEXT_ARMS, armContext, armFileTag, resolveContextArm } from './context-arm.mjs';
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
};

const CTX = FIXED_CONTEXT as SpeakingContext;
const CASES_D = DCASES as Case[];

function caseById(id: string): Case {
  const c = CASES_D.find((x) => x.id === id);
  if (c === undefined) throw new Error(`fixture renamed or removed: ${id}`);
  return c;
}

describe('arm selection', () => {
  it('defaults to bare, for an unset or empty value', () => {
    expect(resolveContextArm(undefined)).toBe('bare');
    expect(resolveContextArm('')).toBe('bare');
    expect(resolveContextArm('  ')).toBe('bare');
  });

  it('accepts each arm and nothing else', () => {
    expect(CONTEXT_ARMS).toEqual(['bare', 'full']);
    for (const arm of CONTEXT_ARMS) expect(resolveContextArm(arm)).toBe(arm);
    // Must throw, not default to bare, or a silent default writes bare rows into a file whose name claims otherwise.
    expect(() => resolveContextArm('ful')).toThrow(/not an arm/);
    expect(() => resolveContextArm('FULL')).toThrow(/not an arm/);
    expect(() => resolveContextArm('true')).toThrow(/not an arm/);
    // The third arm is refused by name, not merely absent: a campaign script carried over from before the triage gate was removed must fail rather than collect a `full` run under a name claiming
    // it sent no verdict — the two are byte-identical now, and only the filename would say otherwise.
    expect(() => resolveContextArm('full-noverdict')).toThrow(/not an arm/);
  });

  it('puts the arm in the filename for every arm but bare', () => {
    expect(armFileTag('bare')).toBe('');
    expect(armFileTag('full')).toBe('-full');
  });
});

describe('the bare arm is byte-identical to what every stored row was collected under', () => {
  // 180 stored rows were collected under transcript-and-consults only; byte-identity here keeps them comparable.
  it('sends no context at all', () => {
    expect(armContext('bare')).toBeUndefined();
  });

  it('a case with no consults renders exactly the two-argument call', () => {
    const c = caseById('D2c-give-me-figures');
    const sent = userMsg(c.transcript, c.consults, armContext('bare'));
    expect(sent).toBe(userMsg(c.transcript, c.consults));
    expect(sent).toBe(buildSpeakingUserMessage(c.transcript, c.consults));
    for (const tag of ['<written>', '<participants>', '<capabilities>', '<situation>', '<consults>']) {
      expect(sent).not.toContain(tag);
    }
  });

  it('holds for every case in the suite, consults and long transcripts included', () => {
    for (const c of CASES_D) {
      expect(userMsg(c.transcript, c.consults, armContext('bare'))).toBe(userMsg(c.transcript, c.consults));
    }
  });

  it('holds for the quality suite, whose driver passes the transcript alone', () => {
    for (const c of CASES as { transcript: string }[]) {
      expect(userMsg(c.transcript, undefined, armContext('bare'))).toBe(userMsg(c.transcript));
    }
  });
});

describe('the full arm renders every standing block production sends', () => {
  const c = caseById('D6a-en-weather');

  it('sends the pinned context, so every block production renders is measured', () => {
    const sent = userMsg(c.transcript, c.consults, armContext('full'));
    for (const tag of ['<transcript>', '<consults>', '<written>', '<participants>', '<capabilities>']) {
      expect(sent).toContain(tag);
    }
    // Through production's own assembler, not a reconstruction of it.
    expect(sent).toBe(buildSpeakingUserMessage(c.transcript, c.consults, CTX));
    // There were five blocks while a triage gate ran, the fifth being a per-turn `<situation>` verdict. There is no gate and no such block, and nothing here may send one.
    expect(sent).not.toContain('<situation>');
  });

  it('pins a value for every field of SpeakingContext', () => {
    // A block production fills that this arm omits would render in every live room and in no measurement of one. The field list is read out of production's source in user-message.test.ts.
    expect(armContext('full')).toBe(FIXED_CONTEXT);
    expect(Object.keys(FIXED_CONTEXT).sort()).toEqual(['capabilities', 'participants', 'voiceFailed', 'written']);
    // Pinned false on purpose — see promptio.mjs. It is the one field whose live value is a failure state, so the arm pins the value an ordinary room sends and renders no block for it.
    expect(FIXED_CONTEXT.voiceFailed).toBe(false);
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
    const sent = userMsg(c.transcript, c.consults, armContext('full'));
    expect(sent).toContain('Ann Petrova (host)');
    expect(sent).toContain('Dana Ruiz (has left)');
    expect(sent).toContain('(name not reported)');
  });

  it('is exactly the bare arm plus the standing blocks, for every case in the suite', () => {
    // What `full` claims to be: additive, and additive is a claim about bytes. It is the whole reason `bare` rows stay comparable after this arm existed.
    for (const x of CASES_D) {
      const bare = userMsg(x.transcript, x.consults, armContext('bare'));
      const full = userMsg(x.transcript, x.consults, armContext('full'));
      expect(full.startsWith(bare), x.id).toBe(true);
      expect(full.slice(bare.length), x.id).toBe(
        buildSpeakingUserMessage('', undefined, CTX).slice(buildSpeakingUserMessage('').length),
      );
    }
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
