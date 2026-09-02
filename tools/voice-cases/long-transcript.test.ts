import { describe, it, expect } from 'vitest';
import {
  LONG,
  POSITIONS,
  approxTokens,
  fillerOnly,
  longTranscript,
} from './long-transcripts.mjs';
import { DCASES } from './dcases.mjs';
import { exampleIdentifiers, gradeDefect, LEGACY_IDS } from './defect.mjs';
import { replyFromRaw } from './turns.mjs';
import { system } from './promptio.mjs';

type Fixture = {
  lang: string;
  filler: string[];
  supplying: string;
  ask: string;
  must: RegExp[][];
  banned: RegExp[];
  at: Record<string, number>;
};

type Case = {
  id: string;
  kind: string;
  transcript: string;
  ru: boolean;
  must?: RegExp[][];
  mirror?: string;
};

const EN = LONG.en as Fixture;
const RU = LONG.ru as Fixture;
const LANGS: [string, Fixture][] = [
  ['en', EN],
  ['ru', RU],
];

/** `absent` is a control, not a fourth position. */
const TRIPLE = ['start', 'middle', 'end'] as const;

function caseById(id: string): Case {
  const c = (DCASES as Case[]).find((x) => x.id === id);
  if (c === undefined) throw new Error(`fixture renamed or removed: ${id}`);
  return c;
}

const LONG_CASES: { id: string; lang: string; position: (typeof TRIPLE)[number] }[] = [
  { id: 'D4g-en-long-start', lang: 'en', position: 'start' },
  { id: 'D4h-en-long-middle', lang: 'en', position: 'middle' },
  { id: 'D4i-en-long-end', lang: 'en', position: 'end' },
  { id: 'D4j-ru-long-start', lang: 'ru', position: 'start' },
  { id: 'D4k-ru-long-middle', lang: 'ru', position: 'middle' },
  { id: 'D4l-ru-long-end', lang: 'ru', position: 'end' },
];

const IDS = exampleIdentifiers(system()) as string[];

describe('the fixtures are the length they are supposed to be', () => {
  // Floor 8k tokens (~1hr): below, not today's production case.
  // Ceiling 12k tokens (~2hr): Liu et al.'s position-effect range.
  // Lines matter too: a model can pattern-match repetition — 500 varied lines isn't 12k tokens of forty paragraphs.
  it.each(LANGS)('%s: 400-600 lines and 8k-12k tokens', (lang, fixture) => {
    for (const position of TRIPLE) {
      const transcript = longTranscript(lang, position);
      const lines = transcript.split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(400);
      expect(lines.length).toBeLessThanOrEqual(600);
      expect(approxTokens(transcript)).toBeGreaterThanOrEqual(8000);
      expect(approxTokens(transcript)).toBeLessThanOrEqual(12000);
      // "Speaker: text" per line, matching production and the token-estimate calibration.
      for (const line of lines) expect(line).toMatch(/^[^\s:][^:]*: \S/u);
    }
    expect(fixture.filler.length).toBeGreaterThan(0);
  });

  it('the sizes in the dcases.mjs family comment are the sizes on disk', () => {
    // Pins the four numbers dcases.mjs's family comment states, so it can't rot.
    const en = caseById('D4h-en-long-middle').transcript;
    const ru = caseById('D4k-ru-long-middle').transcript;
    expect(en.split('\n').length).toBe(490);
    expect(en.length).toBe(30268);
    expect(approxTokens(en)).toBe(9548);
    expect(ru.split('\n').length).toBe(430);
    expect(ru.length).toBe(24738);
    expect(approxTokens(ru)).toBe(10180);
  });

  it('every case in the triple is the same size as its siblings', () => {
    // Equal size, or a length difference could look like a position effect.
    for (const [lang] of LANGS) {
      const sizes = TRIPLE.map((p) => longTranscript(lang, p).length);
      expect(new Set(sizes).size).toBe(1);
      const counts = TRIPLE.map((p) => longTranscript(lang, p).split('\n').length);
      expect(new Set(counts).size).toBe(1);
    }
  });
});

describe('the triple differs in the position of one line and nothing else', () => {
  it.each(LANGS)('%s: removing the supplying line leaves the identical meeting', (lang, fixture) => {
    for (const position of TRIPLE) {
      const lines = longTranscript(lang, position).split('\n');
      const removed = lines.filter((l) => l !== fixture.supplying);
      expect(removed.join('\n')).toBe(fillerOnly(lang));
      // Exactly once — not stated twice.
      expect(lines.filter((l) => l === fixture.supplying)).toHaveLength(1);
    }
  });

  it.each(LANGS)('%s: the ask is the last line, in every variant including absent', (lang, fixture) => {
    for (const position of POSITIONS as string[]) {
      const lines = longTranscript(lang, position).split('\n');
      expect(lines[lines.length - 1]).toBe(fixture.ask);
      // Production's window ends on the addressing utterance; a buried ask measures something else.
      expect(lines.filter((l) => l === fixture.ask)).toHaveLength(1);
    }
  });

  it.each(LANGS)('%s: start is in the first 5%%, middle within 45-55%%, end past 95%%', (lang, fixture) => {
    const depth = (position: string) => {
      const lines = longTranscript(lang, position).split('\n');
      return lines.indexOf(fixture.supplying) / lines.length;
    };
    expect(depth('start')).toBeLessThan(0.05);
    expect(depth('middle')).toBeGreaterThan(0.45);
    expect(depth('middle')).toBeLessThan(0.55);
    expect(depth('end')).toBeGreaterThan(0.95);
    // Also clear of the ask: an answer right above it is really the short-fixture case, not "end" at its easiest.
    const endLines = longTranscript(lang, 'end').split('\n');
    expect(endLines.length - 1 - endLines.indexOf(fixture.supplying)).toBeGreaterThanOrEqual(3);
  });

  it('absent is the same meeting with the answer never said', () => {
    for (const [lang, fixture] of LANGS) {
      expect(fillerOnly(lang)).not.toContain(fixture.supplying);
      for (const group of fixture.must) {
        for (const re of group) expect(re.test(fillerOnly(lang))).toBe(false);
      }
    }
  });

  it('an unknown language or position throws rather than building a wrong fixture', () => {
    expect(() => longTranscript('de', 'start')).toThrow(/unknown language/);
    expect(() => longTranscript('en', 'somewhere')).toThrow(/unknown position/);
  });
});

describe('every must regex matches the supplying line and nothing else', () => {
  it.each(LANGS)('%s: each group is non-empty and every regex in it matches the answer', (lang, fixture) => {
    expect(fixture.must.length).toBeGreaterThan(0);
    for (const group of fixture.must) {
      expect(group.length).toBeGreaterThan(0);
      for (const re of group) {
        expect(re).toBeInstanceOf(RegExp);
        expect({ lang, re: String(re), matches: re.test(fixture.supplying) }).toMatchObject({ matches: true });
      }
    }
  });

  it.each(LANGS)('%s: zero matches in the filler alone — line by line', (lang, fixture) => {
    // Per line, not joined, so a failure names the offending utterance.
    for (const group of fixture.must) {
      for (const re of group) {
        const hits = fixture.filler.filter((line) => re.test(line));
        expect({ lang, re: String(re), hits }).toMatchObject({ hits: [] });
      }
    }
  });

  it.each(LANGS)('%s: zero matches in the ask, so restating the question cannot pass', (lang, fixture) => {
    for (const group of fixture.must) {
      for (const re of group) {
        expect({ lang, re: String(re), inAsk: re.test(fixture.ask) }).toMatchObject({ inAsk: false });
      }
    }
  });

  it.each(LANGS)('%s: the supplying line is the only line in the whole transcript that matches', (lang, fixture) => {
    for (const position of TRIPLE) {
      const lines = longTranscript(lang, position).split('\n');
      for (const group of fixture.must) {
        for (const re of group) {
          expect(lines.filter((line) => re.test(line))).toEqual([fixture.supplying]);
        }
      }
    }
  });

  it.each(LANGS)('%s: the banned near-miss terms appear nowhere in the filler', (lang, fixture) => {
    // Wider than must: catches contradicting filler (different owner/blocker) — easy to miss at line 310/490.
    for (const re of fixture.banned) {
      const hits = fixture.filler.filter((line) => re.test(line));
      expect({ lang, re: String(re), hits }).toMatchObject({ hits: [] });
    }
    // Not vacuous: the answer must trip a banned regex, or the all-clear means nothing.
    expect(fixture.banned.some((re) => re.test(fixture.supplying))).toBe(true);
  });
});

describe('the fixtures do not disarm the always-on checks', () => {
  it('no worked-example identifier is anywhere in the transcript', () => {
    // leakCheck excuses identifiers already in the transcript as restatements; one in 490 lines of filler would silently disarm this check.
    // Asserted via the detector, not a string search: every identifier must still flag.
    const ids = [...new Set([...IDS, ...(LEGACY_IDS as string[])])];
    expect(ids.length).toBeGreaterThan(0);
    for (const { id } of LONG_CASES) {
      const c = caseById(id);
      for (const identifier of ids) {
        const g = gradeDefect(c, replyFromRaw(`It came in with ${identifier}.`), ids);
        expect({ id, identifier, flagged: g.fails.some((f: string) => f.startsWith('CONTAMINATION')) })
          .toMatchObject({ flagged: true });
      }
    }
  });

  it('the language check is live on both halves', () => {
    // Confirms a Russian-room case fails an English reply despite 490 lines of English pressure.
    const ru = caseById('D4k-ru-long-middle');
    const inEnglish = gradeDefect(ru, replyFromRaw('It is Ruslan, and it is waiting on the glossary sign-off.'), IDS);
    expect(inEnglish.fails.join(' ')).toContain('LANGUAGE');

    const en = caseById('D4h-en-long-middle');
    const inRussian = gradeDefect(en, replyFromRaw('Этим занимается Руслан, ждём согласования глоссария.'), IDS);
    expect(inRussian.fails.join(' ')).toContain('LANGUAGE');
  });
});

describe('gradeDefect actually grades these cases', () => {
  const FAITHFUL: Record<string, string> = {
    en: "That is Ruslan's now, and it is waiting on the glossary sign-off.",
    ru: 'Этим теперь занимается Руслан, и ждём мы согласования глоссария.',
  };
  const NOT_FOUND: Record<string, string> = {
    en: 'I do not have that from the conversation, I am afraid.',
    ru: 'Из разговора я этого не вижу, к сожалению.',
  };
  const HALF: Record<string, string> = {
    en: "That one is Ruslan's now.",
    ru: 'Этим теперь занимается Руслан.',
  };

  it.each(LONG_CASES)('$id: a faithful answer grades completely clean', ({ id, lang }) => {
    const g = gradeDefect(caseById(id), replyFromRaw(FAITHFUL[lang]), IDS);
    // Fully empty, not just SOURCE-clean: an unrelated failure is easy to miss at this size.
    expect({ id, fails: g.fails }).toMatchObject({ fails: [] });
  });

  it.each(LONG_CASES)('$id: not finding the answer fails once per fact', ({ id, lang }) => {
    const g = gradeDefect(caseById(id), replyFromRaw(NOT_FOUND[lang]), IDS);
    const source = g.fails.filter((f: string) => f.startsWith('SOURCE'));
    expect({ id, source: source.length }).toMatchObject({ source: 2 });
  });

  it.each(LONG_CASES)('$id: finding half of it fails once, which is what makes the table readable', ({ id, lang }) => {
    // Two must groups grade separately: the table can tell half-found from fully lost.
    const g = gradeDefect(caseById(id), replyFromRaw(HALF[lang]), IDS);
    const source = g.fails.filter((f: string) => f.startsWith('SOURCE'));
    expect({ id, source: source.length }).toMatchObject({ source: 1 });
    // Confirms the blocker group specifically: the message names the missing regex.
    expect(source[0]).toContain(String(LONG[lang as 'en' | 'ru'].must[1][0]));
  });

  it('the answer counts whether it is spoken or written to chat', () => {
    const g = gradeDefect(
      caseById('D4i-en-long-end'),
      replyFromRaw("Got it — I have put the details in the chat.\nCHAT: Icelandic localisation: owner Ruslan, waiting on the glossary sign-off."),
      IDS,
    );
    expect(g.fails.filter((f: string) => f.startsWith('SOURCE'))).toEqual([]);
  });

  it('every long case is wired as D4 with a non-empty must and a live mirror', () => {
    const ids = new Set((DCASES as Case[]).map((c) => c.id));
    for (const { id, lang } of LONG_CASES) {
      const c = caseById(id);
      expect(c.kind).toBe('D4');
      expect(c.ru).toBe(lang === 'ru');
      // gradeDefect iterates c.must ?? [] for D4: no must grades any wrong answer clean, unnoticed.
      expect(Array.isArray(c.must)).toBe(true);
      expect((c.must ?? []).length).toBeGreaterThan(0);
      expect(c.must).toBe(LONG[lang as 'en' | 'ru'].must);
      expect(ids.has(String(c.mirror))).toBe(true);
    }
  });
});

// \b/\w are ASCII-only in JS; a dead regex here fails every correct Russian reply.
describe('the Russian must groups fire on plainly-phrased Russian answers', () => {
  const satisfies = (speech: string) =>
    RU.must.map((group) => group.some((re) => re.test(speech)));

  it('the owner group fires on every ordinary way of naming him', () => {
    for (const speech of [
      'Этим занимается Руслан.',
      'Локализация теперь на Руслане.',
      'Её ведёт Руслан, он забрал её в этом месяце.',
      'Спроси Руслана, это его часть.',
      'Отдали Руслану вместе с остальной очередью.',
      'руслан, судя по разговору.',
    ]) {
      expect({ speech, hit: RU.must[0].some((re) => re.test(speech)) }).toMatchObject({ hit: true });
    }
  });

  it('the blocker group fires on every ordinary way of naming it', () => {
    for (const speech of [
      'Ждёт согласования глоссария.',
      'Стоит на глоссарии.',
      'Не хватает подписи под глоссарием.',
      'Глоссарий ещё не согласован, поэтому стоит.',
    ]) {
      expect({ speech, hit: RU.must[1].some((re) => re.test(speech)) }).toMatchObject({ hit: true });
    }
  });

  it('a full Russian answer satisfies both groups at once', () => {
    expect(satisfies('Исландской локализацией теперь занимается Руслан, и она ждёт согласования глоссария.')).toEqual([
      true,
      true,
    ]);
    expect(satisfies('Это на Руслане, ждём глоссарий.')).toEqual([true, true]);
  });

  it('and an answer that never found it satisfies neither', () => {
    for (const speech of [
      'Из разговора я этого не вижу.',
      'В обсуждении этого не было, я не хочу гадать.',
      'Кто именно этим занимается, по записи не понять.',
      'Она чего-то ждёт, но чего именно, никто не сказал.',
    ]) {
      expect({ speech, groups: satisfies(speech) }).toMatchObject({ groups: [false, false] });
    }
  });

  it('the Russian regexes are bounded the Unicode way, never with \\b', () => {
    // Asserted, not convention: \b never bounds Cyrillic, so misuse looks correct while inert.
    for (const group of RU.must) {
      for (const re of group) {
        expect(String(re)).not.toContain('\\b');
        expect(String(re)).not.toContain('\\w');
        expect(re.flags).toContain('u');
        expect(re.source).toContain('(?<!\\p{L})');
        expect(re.source).toContain('(?!\\p{L})');
        // Suffix must be Cyrillic too: \w* stops at the ASCII stem, missing real case endings.
        expect(re.source).toContain('[а-яё]*');
      }
    }
    // Checks matched text: a \w* suffix still hits on the bare stem, which a boolean would hide.
    expect('Руслану'.match(RU.must[0][0])?.[0]).toBe('Руслану');
    expect('глоссария'.match(RU.must[1][0])?.[0]).toBe('глоссария');
    // The leading lookbehind requires the stem to open a word.
    // "хруслан"/"хглоссарий" are synthetic (no real word carries these stems); tests the bound, not real filler.
    expect(RU.must[0][0].test('хруслан')).toBe(false);
    expect(RU.must[1][0].test('хглоссарий')).toBe(false);
    // Deliberately unguarded: [а-яё]* also matches longer words sharing the stem — "Русланович" passes.
    // Accepted cost of the stem-plus-ending idiom, shared by dcases.mjs's README_SUBJECT_RU.
    expect(RU.must[0][0].test('Русланович')).toBe(true);
  });

  it('the English mirror is the control, and it fires the same way', () => {
    const satisfiesEn = (speech: string) => EN.must.map((group) => group.some((re) => re.test(speech)));
    expect(satisfiesEn("The Icelandic localisation is Ruslan's, waiting on the glossary sign-off.")).toEqual([true, true]);
    expect(satisfiesEn('That did not come up in the conversation.')).toEqual([false, false]);
  });
});
