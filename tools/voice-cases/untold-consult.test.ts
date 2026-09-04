// routeConsult always runs in answerRoom's finally, even if the answer was discarded pre-audio (a barge-in).
// The transcript gets only what the sink confirms — that branch writes nothing, so the room is never told.
import { describe, it, expect } from 'vitest';
import { gradeDefect, internalIdLeakCheck } from './defect.mjs';
import { DCASES } from './dcases.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseReply } from './emitter.mjs';

type Consult = { id: string; question: string; answer?: string };
type Case = {
  id: string;
  kind: string;
  what: string;
  transcript: string;
  consults?: Consult[];
  subject?: RegExp[];
  must?: RegExp[][];
  mustSay?: RegExp[][];
  mirror?: string;
  ru?: boolean;
};

/** compare.mjs's rehydrate() row shape. */
function reply(raw: string) {
  const parsed = parseReply(raw);
  return {
    text: raw,
    parsed,
    thinkingLeak: /<\/?think>/i.test(parsed.silent === true ? raw : parsed.speech),
    regionShrank: false,
  };
}

function caseById(id: string): Case {
  const c = (DCASES as Case[]).find((x) => x.id === id);
  if (c === undefined) throw new Error(`fixture renamed or removed: ${id}`);
  return c;
}

const D10 = (DCASES as Case[]).filter((c) => c.kind === 'D10');
const D10A = caseById('D10a-en-weather-untold');
const D10B = caseById('D10b-en-workingfrom-untold');
const D10C = caseById('D10c-ru-weather-untold');
const D10D = caseById('D10d-ru-workingfrom-untold');
const D6A = caseById('D6a-en-weather');
const D6B = caseById('D6b-en-workingfrom');
const D6C = caseById('D6c-ru-weather');

const fails = (c: Case, raw: string): string[] => gradeDefect(c, reply(raw), []).fails;
const untold = (c: Case, raw: string): string[] =>
  (gradeDefect(c, reply(raw), []).info.untold ?? []) as string[];
const untoldFails = (c: Case, raw: string): string[] => fails(c, raw).filter((f) => f.startsWith('UNTOLD:'));
const nagInfo = (c: Case, raw: string): unknown => gradeDefect(c, reply(raw), []).info.nag;

/** Fails D6a-en-weather (the observed defect); correct for D10a. */
const OBSERVED_EN =
  "I'm not sure about the weather, but I'll let you know as soon as I have that first line from the readme.";
/** Same inversion as OBSERVED_EN, on D6c-ru-weather / D10c. */
const OBSERVED_RU =
  'Я пока не знаю, какая там погода, но как только получу ответ по репозиторию, сразу скажу и то, и другое.';

const CORRECT = {
  D10A: "I don't have a weather feed, so I can't tell you that. I'm finding out that first line in the readme and I'll say when I have it.",
  D10B: "I'm working from the cloud. Separately, I'm finding out that first line in the readme for you.",
  D10C: 'Погоду я не вижу, извини. И заодно: я выясняю первую строку в readme, скажу, как узнаю.',
  D10D: 'Я работаю из облака. И ещё: первую строку в readme я сейчас выясняю.',
};
const QUESTION_ONLY = {
  D10A: "I don't have a weather feed, so I can't tell you that.",
  D10B: "I'm working from the cloud.",
  D10C: 'Погоду я не вижу, извини.',
  D10D: 'Я работаю из облака.',
};
const LOOKUP_ONLY = {
  D10A: "I'm finding out that first line in the readme and I'll say when I have it.",
  D10B: "I'm finding out that first line in the readme and I'll say when I have it.",
  D10C: 'Я выясняю первую строку в readme, скажу, как узнаю.',
  D10D: 'Я выясняю первую строку в readme, скажу, как узнаю.',
};

describe('the D10 fixtures put the model in the untold state', () => {
  it('is four cases, two per language, paired as mirrors', () => {
    expect(D10.map((c) => c.id)).toEqual([
      'D10a-en-weather-untold',
      'D10b-en-workingfrom-untold',
      'D10c-ru-weather-untold',
      'D10d-ru-workingfrom-untold',
    ]);
    expect(D10.filter((c) => c.ru === true).map((c) => c.id)).toEqual([D10C.id, D10D.id]);
    // Checked both ways: mirror pointers must agree, or one half could be edited unnoticed.
    for (const c of D10) {
      expect(caseById(c.mirror as string).mirror, c.id).toBe(c.id);
    }
  });

  it('holds no Archie line at all, which is the entire difference from D6', () => {
    // D6 scripts the acknowledgement into the transcript; deleting it produces D10's untold state.
    // Checked both sides, or a "fix" restoring D10's line while breaking D6's would still pass.
    for (const c of D10) {
      expect(c.transcript, c.id).not.toMatch(/^(?:Archie|Арчи):/m);
    }
    for (const c of [D6A, D6B, D6C]) {
      expect(c.transcript, c.id).toMatch(/^(?:Archie|Арчи):/m);
    }
  });

  it('D10a and D10c are their D6 twins with exactly that line deleted', () => {
    // D10a/D10c are pinned as D6's transcript minus Archie lines, not separate strings — any other edit fails loudly.
    const withoutArchie = (t: string) =>
      t.split('\n').filter((l) => !/^(?:Archie|Арчи):/.test(l)).join('\n');
    expect(D10A.transcript).toBe(withoutArchie(D6A.transcript));
    expect(D10C.transcript).toBe(withoutArchie(D6C.transcript));
    // D10b/D10d aren't a D6b prefix, so they're pinned on what matters: no reference to anything being looked into.
    for (const c of [D10B, D10D]) {
      expect(c.transcript, c.id).not.toMatch(/looking into|Пока смотришь|пока смотришь/);
    }
  });

  it('the consult is present, outstanding and unanswered', () => {
    // <consults> renders an unanswered question as "A: (no answer yet)"; that plus the missing Archie line is the whole state.
    // An answered consult would be D9c's delivery turn, not this family.
    for (const c of D10) {
      expect(c.consults, c.id).toHaveLength(1);
      const [q] = c.consults as Consult[];
      expect(q.id, c.id).toBe('m1c1');
      expect(String(q.answer ?? '').trim(), c.id).toBe('');
      expect(q.question, c.id).toMatch(/readme/i);
    }
  });

  it('declares `subject`, and it does not match the room\'s last line', () => {
    // Subject-guard also keeps D6a on elsewhere; a match on the room's last line would make it pending.
    // pending's sentence claims the last question is unanswered — true here, so a pass would be meaningless.
    for (const c of D10) {
      const subject = c.subject ?? [];
      expect(subject.length, c.id).toBeGreaterThan(0);
      const asked = c.transcript.trimEnd().split('\n').at(-1) as string;
      expect(subject.filter((re) => re.test(asked)).map(String), c.id).toEqual([]);
    }
  });

  it('declares two `mustSay` groups and no `must` at all', () => {
    // Group order (0 = room's question, 1 = lookup) is a reader convention, pinned for consistent failure lines.
    // must stays absent; see the mutation test at the bottom.
    for (const c of D10) {
      expect(c.mustSay, c.id).toHaveLength(2);
      expect(c.must, c.id).toBeUndefined();
      expect((c.mustSay as RegExp[][]).every((g) => g.length > 0), c.id).toBe(true);
    }
    expect((D10A.mustSay as RegExp[][])[0].map(String)).toContain('/weather/i');
    expect((D10A.mustSay as RegExp[][])[1].map(String)).toContain('/readme/i');
  });

  it('is the size the family comment says it is', () => {
    // Quoted in the family comment's prose, so pinned here too — same reason as long-transcript's figures.
    // Small is deliberate: testing <consults> against what the transcript omits; extra talk adds a second variable.
    expect(Object.fromEntries(D10.map((c) => [c.id, c.transcript.length]))).toEqual({
      'D10a-en-weather-untold': 141,
      'D10b-en-workingfrom-untold': 112,
      'D10c-ru-weather-untold': 126,
      'D10d-ru-workingfrom-untold': 118,
    });
    for (const c of D10) expect(c.transcript.split('\n'), c.id).toHaveLength(2);
  });

  it('says in `what` what state it puts the model in and why', () => {
    // The D6/D10 distinction is subtle enough to "fix" one into the other by reading only the transcripts.
    // So what must be a paragraph naming its D6 relationship or mirror's job, checked on length and content.
    for (const c of D10) {
      expect(c.what.length, c.id).toBeGreaterThan(200);
      expect(c.what, c.id).toMatch(/D6|D10|discriminat|mirror/);
    }
  });
});

describe('a reply is graded on what it said out loud', () => {
  it('a correct reply grades completely clean, in both languages', () => {
    // Zero failures, not just "no UNTOLD": catches other tripped checks here, not as a later false regression.
    for (const [c, raw] of [
      [D10A, CORRECT.D10A],
      [D10B, CORRECT.D10B],
      [D10C, CORRECT.D10C],
      [D10D, CORRECT.D10D],
    ] as [Case, string][]) {
      expect(fails(c, raw), c.id).toEqual([]);
      expect(untold(c, raw), c.id).toEqual([]);
    }
  });

  it('answering only the room\'s question fails on the untold lookup', () => {
    for (const [c, raw] of [
      [D10A, QUESTION_ONLY.D10A],
      [D10B, QUESTION_ONLY.D10B],
      [D10C, QUESTION_ONLY.D10C],
      [D10D, QUESTION_ONLY.D10D],
    ] as [Case, string][]) {
      const hits = untoldFails(c, raw);
      expect(hits, c.id).toHaveLength(1);
      expect(hits[0], c.id).toContain((c.mustSay as RegExp[][])[1].map(String).join('|'));
    }
  });

  it('announcing only the lookup fails on the question it ignored', () => {
    for (const [c, raw] of [
      [D10A, LOOKUP_ONLY.D10A],
      [D10B, LOOKUP_ONLY.D10B],
      [D10C, LOOKUP_ONLY.D10C],
      [D10D, LOOKUP_ONLY.D10D],
    ] as [Case, string][]) {
      const hits = untoldFails(c, raw);
      expect(hits, c.id).toHaveLength(1);
      expect(hits[0], c.id).toContain((c.mustSay as RegExp[][])[0].map(String).join('|'));
    }
  });

  it('a silent reply fails on the protocol check and is not double-counted', () => {
    // mustSay is gated on !silent: a SILENCE reply carries only the protocol reason, not three for one behavior.
    for (const c of D10) {
      const g = gradeDefect(c, reply('SILENCE'), []);
      expect(g.silent, c.id).toBe(true);
      expect(g.fails, c.id).toEqual(['PROTOCOL: SILENCE while somebody was waiting']);
      expect(g.info.untold, c.id).toBeUndefined();
    }
  });

  it('the chat line does not tell a room anything', () => {
    // Unlike D4's identical loop over must, which accepts either speech or chat, this one doesn't.
    // The defect here is the room wasn't told; a CHAT: line isn't spoken — mid-call, nobody's reading that channel.
    const chatOnly = "I don't have a weather feed, so I can't tell you that.\n\nCHAT: Still to come: the first line of the mobile repo readme.";
    expect(parseReply(chatOnly).speech).not.toMatch(/readme/i);
    const hits = untoldFails(D10A, chatOnly);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('/readme/i');
    // Same for the PM: tail marker.
    const pmOnly = "I don't have a weather feed, so I can't tell you that.\n\nPM: What is the first line of the mobile repo readme?";
    expect(untoldFails(D10A, pmOnly)).toHaveLength(1);
  });

  it('still names who or what it consults as a machinery leak', () => {
    // This family requires saying the answer is being found out, exactly where a machinery leak (who/what) rides along.
    // D5's leak check applies here too; also covered by the empty fails(...) above, checked from the other side.
    const leak = "I don't have a weather feed. I've asked the backend team about that first line in the readme.";
    expect(fails(D10A, leak).filter((f) => f.startsWith('MACHINERY:'))).toHaveLength(1);
    expect(untoldFails(D10A, leak)).toEqual([]);
  });

  it('answers a Russian room in Russian, or fails for that too', () => {
    const english = "I'm finding out that first line in the readme, and I can't see the weather.";
    expect(fails(D10C, english).some((f) => f.startsWith('LANGUAGE:'))).toBe(true);
  });
});

describe('D10 is not D6, and the same sentence proves it', () => {
  it('the observed nag fails D6 and passes D10, in English', () => {
    expect(fails(D6A, OBSERVED_EN)).toEqual([
      "REPETITION: re-announced the pending consult unprompted — ill-let-you-know-when:I'll let you know as soon as",
    ]);
    expect(fails(D10A, OBSERVED_EN)).toEqual([]);
  });

  it('and in Russian, on the row that passed for three runs before its detector existed', () => {
    expect(fails(D6C, OBSERVED_RU)).toEqual([
      'REPETITION: re-announced the pending consult unprompted — ' +
        'ill-let-you-know-when-ru:как только получу ответ по репозиторию, сразу скажу',
    ]);
    expect(fails(D10C, OBSERVED_RU)).toEqual([]);
  });

  it('`pendingNagCheck` is not applied to a D10 case at all', () => {
    // gradeDefect reads pendingNagCheck only for kind D6, so D10 rows have no info.nag key, not just an empty list.
    // Checked on every reply shape this file uses, including phrases tiers 1-3 fire on.
    for (const raw of [OBSERVED_EN, CORRECT.D10A, LOOKUP_ONLY.D10A, 'I am still looking into that readme for you.']) {
      expect(nagInfo(D10A, raw), raw).toBeUndefined();
      expect(nagInfo(D6A, raw), raw).toBeDefined();
    }
    for (const raw of [OBSERVED_RU, CORRECT.D10C, LOOKUP_ONLY.D10C, 'Я всё ещё уточняю первую строку.']) {
      expect(nagInfo(D10C, raw), raw).toBeUndefined();
      expect(nagInfo(D6C, raw), raw).toBeDefined();
    }
  });

  it('the existing D6 cases grade exactly as they did', () => {
    // D6's rows are the known-good corpus; this family adds to it, so they must still grade as before.
    expect(fails(D6A, "I don't have a weather feed, so I can't tell you that.")).toEqual([]);
    expect(fails(D6B, "I'm working from the cloud today.")).toEqual([]);
    expect(fails(D6A, "I don't have a weather feed, so I can't tell you that. I'm still looking for that first line in the readme.")).toEqual([
      'REPETITION: re-announced the pending consult unprompted — still-pursuing:still looking for, ' +
        'subject-anchored:looking for that first line',
    ]);
    // No D6 case grew an UNTOLD failure or a `mustSay` field.
    for (const c of [D6A, D6B, D6C]) {
      expect(c.mustSay, c.id).toBeUndefined();
      expect(gradeDefect(c, reply('SILENCE'), []).info.untold, c.id).toBeUndefined();
    }
  });
});

describe('the mustSay groups', () => {
  const allPatterns: [string, RegExp][] = D10.flatMap((c) =>
    (c.mustSay as RegExp[][]).flatMap((g) => g.map((re) => [c.id, re] as [string, RegExp])),
  );

  it('breaking a group makes a correct reply fail — the assertions are live', () => {
    // Mutation check: an unsatisfiable group must fail, or "clean" above could be right for the wrong reason.
    const broken = { ...D10A, mustSay: [[/nothing a reply would ever say/i], D10A.mustSay?.[1] ?? []] } as Case;
    expect(untoldFails(broken, CORRECT.D10A)).toHaveLength(1);
    expect(fails(D10A, CORRECT.D10A)).toEqual([]);
    // Reverse mutation too: an unsatisfiable second group, so neither position alone is checked.
    const brokenTwo = { ...D10A, mustSay: [D10A.mustSay?.[0] ?? [], [/nor this/i]] } as Case;
    expect(untoldFails(brokenTwo, CORRECT.D10A)).toHaveLength(1);
  });

  it('no Cyrillic pattern reaches for `\\b` or `\\w`', () => {
    // \b is defined over [A-Za-z0-9_]; a Cyrillic letter counts as non-word on both sides, so it never bounds one.
    // \w is narrower: an ASCII-only suffix class that only matches empty after a Cyrillic stem.
    const cyrillic = allPatterns.filter(([, re]) => /[Ѐ-ӿ]/.test(re.source));
    expect(cyrillic.length).toBeGreaterThan(8);
    for (const [id, re] of cyrillic) {
      expect({ id, source: re.source }).toMatchObject({ source: expect.not.stringContaining('\\b') });
      expect({ id, source: re.source }).toMatchObject({ source: expect.not.stringContaining('\\w') });
    }
    // Every pattern with a Unicode bound also carries the `u` flag it needs.
    for (const [id, re] of allPatterns) {
      if (re.source.includes('\\p{L}')) expect({ id, flags: re.flags }).toMatchObject({ flags: expect.stringContaining('u') });
    }
  });

  it('the shipped Russian patterns go dead if their bounds are rewritten as `\\b`', () => {
    // Swaps each shipped pattern's Unicode bounds for \b; agreement means the bounds were reverted.
    const SENTENCES = [
      'Погоду я не вижу, извини.',
      'Я работаю из облака.',
      'Я выясняю первую строку в readme.',
      'Как только получу ответ по репозиторию, скажу.',
      'Сегодня солнечно.',
      'Первую строчку я ещё не знаю.',
      'У меня нет физического места.',
      'Местоположения у меня никакого нет.',
      'Это крутится на сервере.',
      'Прогноза у меня нет.',
      'Скажу, как только будет ридми.',
      'Дождя вроде нет.',
    ];
    const bounded = allPatterns.filter(([, re]) => re.source.includes('\\p{L}'));
    expect(bounded.length).toBeGreaterThan(8);
    for (const [id, live] of bounded) {
      const ascii = new RegExp(
        live.source.replace(/\(\?<!\\p\{L\}\)/g, '\\b').replace(/\(\?!\\p\{L\}\)/g, '\\b'),
        live.flags.replace('u', ''),
      );
      // Per pattern, not aggregated, or an averaged pass rate could hide one dead regex.
      const fires = SENTENCES.filter((s) => live.test(s));
      expect({ id, source: live.source, fires }, `${id} matches nothing ordinary`).toMatchObject({
        fires: expect.arrayContaining([expect.any(String)]),
      });
      for (const s of fires) expect(ascii.test(s), `${id} with \\b bounds, on "${s}"`).toBe(false);
    }
  });

  it('every group fires on the ordinary phrasings a reply actually uses', () => {
    const CASES: [Case, number, string[]][] = [
      [D10A, 0, ['I have no weather feed.', "I can't see the forecast.", 'It is sunny here, apparently.']],
      [D10A, 1, ['that first line in the readme', 'the readme line', 'the mobile repo question']],
      [D10B, 0, ['I run in the cloud.', 'I have no physical location.', 'I am working from a server.']],
      [D10C, 0, ['Погоду не вижу.', 'Прогноза нет.', 'Сегодня солнечно.', 'Дождь вроде.']],
      [D10C, 1, ['выясняю первую строку', 'жду ответ по репозиторию', 'строку из ридми', 'первую строчку']],
      [D10D, 0, ['Я в облаке.', 'Физического места у меня нет.', 'Работаю из облака.', 'Крутится на сервере.']],
    ];
    for (const [c, group, phrasings] of CASES) {
      for (const s of phrasings) {
        const g = (c.mustSay as RegExp[][])[group];
        expect(g.some((re) => re.test(s)), `${c.id} group ${group} on "${s}"`).toBe(true);
      }
    }
  });
});

// `internalIdLeakCheck` lived beside the triage grader, the only thing that ever called it, and production removed the gate that grader measured. The detector is kept — see its doc in
// defect.mjs for why the class it catches is real and why wiring it into `gradeDefect` is a rubric decision rather than a refactor — and it is tested here, in the file about the families
// whose `<consults>` blocks actually put one of those ids in front of the model. An untested detector and an uncalled one are two different problems; this file fixes the first.
describe('internalIdLeakCheck — the id class MACHINERY\'s word lists miss', () => {
  const withConsult = (DCASES as { id: string; consults?: { id: string; question: string; answer?: string }[] }[])
    .find((c) => (c.consults ?? []).length > 0);
  const consults = withConsult?.consults ?? [];
  const declaredId = String(consults[0]?.id ?? '');

  it('the fixtures really do carry an id of production\'s own shape', () => {
    // Otherwise every assertion below is about a string this suite never sends.
    expect(declaredId).toMatch(/^m\d{1,4}c\d{1,4}$/);
  });

  it('fires on a leak and stays silent on a clean sentence, in English and in Russian', () => {
    // The Russian half is the arrangement an ASCII-only bound gets wrong: an ASCII id inside Cyrillic prose.
    expect(internalIdLeakCheck(`Let me go and find that out under ${declaredId}.`, consults))
      .toEqual([`consult-id:${declaredId}`]);
    expect(internalIdLeakCheck('Let me go and find that out.', consults)).toEqual([]);
    expect(internalIdLeakCheck(`Сейчас узнаю, это по ${declaredId}.`, consults))
      .toEqual([`consult-id:${declaredId}`]);
    expect(internalIdLeakCheck('Сейчас узнаю.', consults)).toEqual([]);
  });

  it('catches an id no row declared, by production\'s shape', () => {
    // Backstop tier: m<digits>c<digits> matches whether or not a fixture filed that consult; reported as id-shape to tell an invented id from a rendered one.
    expect(internalIdLeakCheck('Let me check on m13c4 and come back.', undefined)).toEqual(['id-shape:m13c4']);
    expect(internalIdLeakCheck('Сейчас посмотрю по m13c4.', [])).toEqual(['id-shape:m13c4']);
    // One entry per leaked token, never one per tier, so a single slip is reported once.
    expect(internalIdLeakCheck(`by ${declaredId}`, consults)).toHaveLength(1);
  });

  it('is bounded for Unicode, and \\b would be wrong in the direction that exists here', () => {
    // Read off the shipped source, not retyped — a copy in the assertion would pass while the shipped pattern rots.
    const shipped = String(
      fs
        .readFileSync(fileURLToPath(new URL('./defect.mjs', import.meta.url)), 'utf8')
        .match(/const CONSULT_ID_SHAPE = (\/.+\/[a-z]*)/)?.[1],
    );
    expect(shipped).toContain('\\p{L}');
    expect(shipped).not.toContain('\\b');
    expect(shipped).not.toContain('\\w');
    // A Cyrillic letter glued to the id: \b sees a boundary between в and m (both non-word to it) and fires on a non-id word — the shipped bound doesn't.
    // Asserted, not argued — "mostly works" is exactly how a silently dead detector looks.
    expect('вm1c1 в отчёте'.match(/\bm1c1\b/gi)).not.toBeNull();
    expect(internalIdLeakCheck('вm1c1 в отчёте', [{ id: 'm1c1', question: 'q' }])).toEqual([]);
    expect(internalIdLeakCheck('в m1c1 в отчёте', [{ id: 'm1c1', question: 'q' }])).toHaveLength(1);
  });

  it('stays silent on the sentences these fixtures require a reply to say', () => {
    // The must-NOT-fire half, on real text rather than invented: a false positive here would fail a reply behaving exactly as D10 demands.
    for (const sentence of [
      "I have asked about the first line of the readme and I will tell you as soon as I hear back.",
      'Я уже спросил про первую строку из ридми и скажу, как только узнаю.',
    ]) {
      expect({ sentence, hits: internalIdLeakCheck(sentence, consults) }).toMatchObject({ hits: [] });
    }
  });

  it('is, as of this commit, called by nothing that grades a row', () => {
    // Asserted rather than left in a comment, because the comment is the thing a later reader skips. When somebody wires it into gradeDefect, this test is what tells them to delete it.
    const driver = fs.readFileSync(fileURLToPath(new URL('./defect.mjs', import.meta.url)), 'utf8');
    const inGrader = driver.slice(driver.indexOf('export function gradeDefect'));
    expect(inGrader).not.toContain('internalIdLeakCheck(');
  });
});
