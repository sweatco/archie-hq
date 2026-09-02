import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PRODUCTION_TRIAGE_DEADLINE_MS,
  PRODUCTION_TRIAGE_MAX_TOKENS,
  TRIAGE_WHERE,
  addressedInRussian,
  answerLeakCheck,
  gradeTriage,
  printTriageReport,
  readVerdict,
  resolveTriageContextArm,
  runTriage,
} from './triage.mjs';
import { CAPABILITY_ANSWER, TRIAGE_CASES, expectedFor, fromCapabilityList } from './triage-cases.mjs';
import { LONG } from './long-transcripts.mjs';
import { FIXED_CONTEXT, triageSystem, triageUserMsg } from './promptio.mjs';
import { armContext } from './context-arm.mjs';
import { internalIdLeakCheck, machineryLeakCheck } from './defect.mjs';
import { buildSpeakingUserMessage } from '../../src/voice/comprehension.js';

type Case = {
  id: string;
  /** A string, or a map keyed by context arm — see `expectedFor`. */
  expect: string | Record<string, string>;
  length: string;
  ru: boolean;
  what: string;
  transcript: string;
  consults?: { id: string; question: string; answer?: string }[];
  answer?: RegExp[][];
};

type Row = {
  case: string;
  rep: number;
  expect: string;
  context: string;
  where: string | null;
  fails: string[];
  info: Record<string, unknown>;
  elapsedMs: number | null;
  error?: string;
};

const CASES = TRIAGE_CASES as Case[];
const caseById = (id: string): Case => {
  const c = CASES.find((x) => x.id === id);
  if (c === undefined) throw new Error(`fixture renamed or removed: ${id}`);
  return c;
};

const COMPREHENSION = fs.readFileSync(
  fileURLToPath(new URL('../../src/voice/comprehension.ts', import.meta.url)),
  'utf8',
);

async function canned(
  cases: Case[],
  replies: Record<string, string>,
  elapsedMs = 300,
  contextArm = 'bare',
) {
  const sent: { id: string; system: string; user: string }[] = [];
  const rows = (await runTriage(cases, {
    call: async ({ system, user, case: c }: { system: string; user: string; case: Case }) => {
      sent.push({ id: c.id, system, user });
      return { text: replies[c.id] ?? '(no canned reply)', complete: elapsedMs };
    },
    sys: 'system prompt is irrelevant to a canned transport',
    reps: 1,
    contextArm,
  })) as Row[];
  return { rows, sent };
}

const ROOM = '{"where": "room"}';
const OUTSIDE_EN = '{"where": "outside", "preamble": "Let me find that out."}';
const OUTSIDE_RU = '{"where": "outside", "preamble": "Сейчас узнаю."}';
// Keyed on the arm and the addressed language, not c.ru — voice-triage.md's rule; the capability pair's answer moves with the arm.
// TGq is a Russian room whose correct preamble is English; c.ru would give a helper the wrong language, failing for the reason this file exists.
const correctReplies = (arm = 'bare'): Record<string, string> =>
  Object.fromEntries(
    CASES.map((c) => [
      c.id,
      expectedFor(c, arm) === 'room' ? ROOM : addressedInRussian(c.transcript) ? OUTSIDE_RU : OUTSIDE_EN,
    ]),
  );

const INCIDENT_MACHINERY = 'Let me check with the PM.';
const INCIDENT_ANSWERED =
  'I can look up numbers in the analytics warehouse, read the code in the team repositories, ' +
  'check crash reports, edit campaigns in the admin panel and read tickets in Jira.';
const INCIDENT_ANSWERED_RU =
  'Я могу смотреть цифры в хранилище, читать код в репозиториях, разбираться с крашами и читать тикеты в Jira.';
const CORRECT_PREAMBLES = [
  'Let me check that for you.',
  'Сейчас проверю.',
  'I will find out who is currently responsible for the Icelandic localisation and its status.',
  'Сейчас посмотрю, кто отвечает за исландскую локализацию и на каком она этапе.',
];
const outsideWith = (preamble: string) => JSON.stringify({ where: 'outside', preamble });

// null, not a literal: a literal like 300 would make exact-failure-list assertions below silently depend on TRIAGE_TIMEOUT_MS staying above it.
// gradeTriage with no timing grades placement and preamble alone; DEADLINE has its own suites that pass the number on purpose.
const UNTIMED = null;

// Relative to the constant, same reason UNTIMED is null — the deadline is production's and it moves.
// The literal once here (1400) was safely past the old 800ms deadline but silently inside the new 1500ms, inverting the assertion instead of failing it.
const SLOW = PRODUCTION_TRIAGE_DEADLINE_MS + 400;

describe('the copies of production\'s constants still match production', () => {
  it('the four verdicts are the four verdicts', () => {
    const declared = COMPREHENSION.match(/const TRIAGE_WHERE = \[([^\]]+)\]/);
    expect(declared).not.toBeNull();
    const fromSource = [...String(declared?.[1]).matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(fromSource).toEqual(TRIAGE_WHERE);
  });

  it('the deadline and the token cap are production\'s', () => {
    // Read off comprehension.ts's source, not imported — a copy could measure against a stale deadline. It moved once already: 800 → 1500.
    // [\d_] not \d: TRIAGE_TIMEOUT_MS may be written 1_500 like its neighbor 5_000; a bare \d+ would capture only "1", passing against nothing.
    const literal = (name: string): number => {
      const found = COMPREHENSION.match(new RegExp(`const ${name} = ([\\d_]+)`));
      expect({ name, found: found?.[1] }).not.toMatchObject({ found: undefined });
      return Number(String(found?.[1]).replaceAll('_', ''));
    };
    expect(literal('TRIAGE_TIMEOUT_MS')).toBe(PRODUCTION_TRIAGE_DEADLINE_MS);
    expect(literal('TRIAGE_MAX_TOKENS')).toBe(PRODUCTION_TRIAGE_MAX_TOKENS);
    // The separator tolerance, tested directly — the source doesn't use one today, so the assertions above never exercise it.
    expect(String(5_000)).toBe('5000');
    expect(Number('1_500'.replaceAll('_', ''))).toBe(1500);
  });

  it('production still builds the gate\'s user message with the speaking builder', () => {
    // The premise of reusing triageUserMsg at all: if runTriageGate ever framed its own window, this would stop measuring the same context.
    const gate = COMPREHENSION.slice(COMPREHENSION.indexOf('export async function runTriageGate'));
    const body = gate.slice(0, gate.indexOf('\n}\n'));
    expect(body).toContain('user: buildSpeakingUserMessage(');
    expect(body).toContain("loadPrompt('voice-triage'");
  });
});

describe('the request the harness sends is the request production sends', () => {
  it('the user half is byte-identical to the production builder', async () => {
    const { sent } = await canned(CASES, correctReplies());
    for (const { id, user } of sent) {
      const c = caseById(id);
      expect(user).toBe(buildSpeakingUserMessage(c.transcript, c.consults, undefined));
      expect(user).toContain('<transcript>');
      // Absent and empty are different claims; the id pair's whole measurement is that the block is in front of the gate.
      // pending stays impossible by construction — the one consult in the set is answered, asserted in "the case set" below.
      expect(user.includes('<consults>')).toBe(c.consults !== undefined);
    }
  });

  it('deliberately NOT the speaking arm\'s user message, which can carry guidance', () => {
    // promptio.mjs's userMsg goes through assembleSpeakingRequest; under data-first it appends the speaking prompt's guidance to the user message.
    // The gate never carries that under either arm, so this seam stays separate.
    const t = caseById('TGi-en-short-room').transcript;
    expect(triageUserMsg(t, undefined, undefined)).toBe(buildSpeakingUserMessage(t, undefined, undefined));
  });

  it('the system half is the triage prompt, not the speaking one', () => {
    const sys = triageSystem();
    expect(sys).toContain('"where": "room"');
    expect(sys).toContain('"where": "pending"');
    expect(sys).toContain('Archie');
    expect(sys).not.toMatch(/{{[A-Z0-9_]+}}/);
  });
});

describe('gradeTriage reads a verdict and grades what it finds', () => {
  const room = caseById('TGb-en-long-mid-room');
  const outsideEn = caseById('TGd-en-long-absent-outside');
  const outsideRu = caseById('TGh-ru-long-absent-outside');

  it('the right verdict, in time, is clean', () => {
    expect(gradeTriage(room, ROOM, 300).fails).toEqual([]);
    expect(gradeTriage(outsideEn, OUTSIDE_EN, 300).fails).toEqual([]);
    expect(gradeTriage(outsideRu, OUTSIDE_RU, 300).fails).toEqual([]);
  });

  it('a wrong verdict is a PLACEMENT failure naming both sides', () => {
    const g = gradeTriage(room, '{"where": "outside", "preamble": "Let me check."}', 300);
    expect(g.fails.filter((f: string) => f.startsWith('PLACEMENT'))).toHaveLength(1);
    expect(g.fails[0]).toContain('said "outside"');
    expect(g.fails[0]).toContain('in the room');
    // The reverse direction too — the error the absent cases exist for: claiming the room supplied something it never said.
    const wrongWay = gradeTriage(outsideEn, ROOM, 300);
    expect(wrongWay.fails.filter((f: string) => f.startsWith('PLACEMENT'))).toHaveLength(1);
    expect(wrongWay.fails[0]).toContain('said "room"');
  });

  it('an unreadable reply is a PROTOCOL failure, not a wrong verdict', () => {
    // Production returns null here and runs the turn as if the gate didn't exist — never a placement error, since there's no placement.
    for (const raw of ['', 'The answer is in the room.', '{"where": "the room"}', '{"where":', '{}']) {
      const g = gradeTriage(room, raw, 300);
      expect({ raw, fails: g.fails.map((f: string) => f.split(':')[0]) }).toMatchObject({ fails: ['PROTOCOL'] });
      expect(g.verdict).toBeNull();
    }
  });

  it('prose around the JSON is tolerated exactly as production tolerates it', () => {
    // parseTriage takes the outermost braces, not a bare object, so a wrapped verdict reads — otherwise a reply production reads would overstate the defect as unreadable.
    expect(readVerdict('```json\n{"where": "room"}\n```')?.where).toBe('room');
    expect(readVerdict('Here you go: {"where": "pending"} — hope that helps')?.where).toBe('pending');
    expect(readVerdict('{"where": "outside", "preamble": "  Let me look.  "}')?.preamble).toBe('Let me look.');
    // An empty preamble is no preamble, as it is over there.
    expect(readVerdict('{"where": "outside", "preamble": "   "}')?.preamble).toBeUndefined();
  });

  it('outside with nothing to say is a PREAMBLE failure', () => {
    const g = gradeTriage(outsideEn, '{"where": "outside"}', 300);
    expect(g.fails.filter((f: string) => f.startsWith('PREAMBLE'))).toHaveLength(1);
    // The verdict itself was right, so placement must still be clean.
    expect(g.fails.filter((f: string) => f.startsWith('PLACEMENT'))).toEqual([]);
  });

  it('a preamble in the wrong language fails, in both directions', () => {
    const ru = gradeTriage(outsideRu, OUTSIDE_EN, 300);
    expect(ru.fails.filter((f: string) => f.startsWith('LANGUAGE'))).toHaveLength(1);
    const en = gradeTriage(outsideEn, OUTSIDE_RU, 300);
    expect(en.fails.filter((f: string) => f.startsWith('LANGUAGE'))).toHaveLength(1);
    // And the right language is clean, in both.
    expect(gradeTriage(outsideRu, OUTSIDE_RU, 300).fails).toEqual([]);
    expect(gradeTriage(outsideEn, OUTSIDE_EN, 300).fails).toEqual([]);
  });

  it('a verdict past the deadline fails on its own, without hiding the verdict', () => {
    const slow = gradeTriage(room, ROOM, SLOW);
    expect(slow.fails.filter((f: string) => f.startsWith('DEADLINE'))).toHaveLength(1);
    expect(slow.fails[0]).toContain(`${SLOW}ms`);
    expect(slow.verdict?.where).toBe('room');
    // Exactly on the deadline is inside it; one millisecond past is not.
    expect(gradeTriage(room, ROOM, PRODUCTION_TRIAGE_DEADLINE_MS).fails).toEqual([]);
    expect(gradeTriage(room, ROOM, PRODUCTION_TRIAGE_DEADLINE_MS + 1).fails).toHaveLength(1);
    // A wrong verdict that's also slow reports both, so latency and accuracy problems can't be mistaken for each other.
    const both = gradeTriage(room, '{"where": "elsewhere"}', SLOW);
    expect(both.fails.map((f: string) => f.split(':')[0])).toEqual(['PLACEMENT', 'DEADLINE']);
  });

  it('no timing at all grades on placement alone', () => {
    // A stored row from a transport that measured nothing mustn't silently count as inside or outside the deadline.
    const g = gradeTriage(room, ROOM, null);
    expect(g.fails).toEqual([]);
    expect(g.info.elapsedMs).toBeNull();
  });
});

describe('the driver', () => {
  it('runs every case once per rep and files a row for each', async () => {
    const { rows } = await canned(CASES, correctReplies());
    expect(rows).toHaveLength(CASES.length);
    expect(rows.flatMap((r) => r.fails)).toEqual([]);
    expect(new Set(rows.map((r) => r.case)).size).toBe(CASES.length);
  });

  it('a transport error files an error row and does not grade it', async () => {
    const rows = (await runTriage([caseById('TGa-en-long-start-room')], {
      call: async () => ({ error: 'HTTP 529: overloaded' }),
      sys: 'x',
      reps: 1,
    })) as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0].error).toContain('529');
    expect(rows[0].fails).toBeUndefined();
  });

  it('the report runs against canned rows, so it is not first exercised on a live run', async () => {
    const { rows } = await canned(CASES, { ...correctReplies(), 'TGb-en-long-mid-room': '{"where": "outside"}' }, SLOW);
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.join(' '));
    try {
      printTriageReport(rows, { arm: 'test', candidate: 'stub' });
    } finally {
      console.log = original;
    }
    const out = lines.join('\n');
    expect(out).toContain('placement (the answer was put where it actually is)');
    expect(out).toContain('long, expected room');
    // Read off the constant, not spelled out — a hard-coded copy is a second place for the figure to go stale, as this line was before 800 became 1500.
    expect(out).toContain(`production's ${PRODUCTION_TRIAGE_DEADLINE_MS}ms deadline`);
    expect(out).toContain('TGb-en-long-mid-room :: PLACEMENT');
    // Every row was slower than the deadline in this canned run, so the deadline line must say 0 were inside it.
    expect(out).toMatch(/long\s+0\/8 inside it/);
    // The two new checks' only appearance in a report — easy to add the check but forget to wire its report line.
    for (const label of ['there at all', 'language addressed in', 'named nothing internal', 'held the floor, no answer']) {
      expect(out).toContain(label);
    }
    // The id column is wide enough for every id in the set; an overrunning id runs into the next column, reading as a rendering bug in the failed row.
    for (const c of CASES) expect(out).toMatch(new RegExp(`^${c.id}\\s+\\S`, 'm'));
  });
});

describe('the case set', () => {
  it('every case declares a known verdict, under every arm, and both grouping axes', () => {
    for (const c of CASES) {
      // Both arms: a per-arm map is a different declaration per arm, so a typo in one half would otherwise only surface in a billed run.
      for (const arm of ['bare', 'full']) expect(TRIAGE_WHERE).toContain(expectedFor(c, arm));
      expect(['long', 'short']).toContain(c.length);
      expect(typeof c.ru).toBe('boolean');
      expect(c.transcript.length).toBeGreaterThan(0);
      expect(c.what.length).toBeGreaterThan(0);
      // pending is impossible by construction: the verdict needs an unanswered question, so every declared consult here must have an answer.
      // An unanswered consult would make a wrong pending the likely failure, and pending has no preamble — which is what TGr/TGs need to grade.
      for (const consult of (c.consults ?? []) as { id?: string; answer?: string }[]) {
        expect(String(consult.answer ?? '').trim().length).toBeGreaterThan(0);
        expect(String(consult.id ?? '').trim().length).toBeGreaterThan(0);
      }
    }
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
  });

  it('the 2x2 is actually a 2x2, in both languages and under both arms', () => {
    // Missing its outside half, a gate that always answers room scores full marks; missing its short half, a length effect can't be told from a broken prompt.
    for (const arm of ['bare', 'full']) {
      for (const length of ['long', 'short']) {
        for (const expected of ['room', 'outside']) {
          for (const ru of [true, false]) {
            const matching = CASES.filter(
              (c) => c.length === length && expectedFor(c, arm) === expected && c.ru === ru,
            );
            // Written as a `not.toMatchObject` so a failure names the empty cell.
            expect({ arm, length, expected, ru, n: matching.length }).not.toMatchObject({ n: 0 });
          }
        }
      }
    }
  });

  it('the long cases are the same meetings the D4 cases use', () => {
    // Reuse, not a second copy: the point is that both calls are measured over identical context.
    expect(caseById('TGa-en-long-start-room').transcript).toContain(LONG.en.supplying);
    expect(caseById('TGb-en-long-mid-room').transcript).toContain(LONG.en.supplying);
    expect(caseById('TGc-en-long-end-room').transcript).toContain(LONG.en.supplying);
    expect(caseById('TGe-ru-long-start-room').transcript).toContain(LONG.ru.supplying);
    // Same length, same content, one line moved.
    const lengths = ['TGa-en-long-start-room', 'TGb-en-long-mid-room', 'TGc-en-long-end-room'].map(
      (id) => caseById(id).transcript.length,
    );
    expect(new Set(lengths).size).toBe(1);
  });

  it('the outside cases are the same meeting with the answer genuinely gone', () => {
    // The controlled pair: if the answer were still reachable here, the expectation would be wrong and the case would measure nothing.
    for (const [id, fixture] of [
      ['TGd-en-long-absent-outside', LONG.en],
      ['TGh-ru-long-absent-outside', LONG.ru],
    ] as [string, { supplying: string; must: RegExp[][]; ask: string }][]) {
      const t = caseById(id).transcript;
      expect(t).not.toContain(fixture.supplying);
      for (const group of fixture.must) {
        for (const re of group) expect(re.test(t)).toBe(false);
      }
      // And it is still the same question being asked, or the pair is not a pair.
      expect(t.endsWith(fixture.ask)).toBe(true);
    }
  });

  it('the short cases are the existing fixtures, not retyped ones', async () => {
    const { DCASES } = await import('./dcases.mjs');
    const source = (id: string) =>
      (DCASES as { id: string; transcript: string }[]).find((c) => c.id === id)?.transcript;
    expect(caseById('TGi-en-short-room').transcript).toBe(source('D4d-en-owner'));
    expect(caseById('TGj-ru-short-room').transcript).toBe(source('D4a-ru-owner'));
    expect(caseById('TGk-en-short-outside').transcript).toBe(source('D5a-en-config-lookup'));
    expect(caseById('TGl-ru-short-outside').transcript).toBe(source('D5b-ru-config-lookup'));
  });
});

describe('the bare arm is byte-identical to what every stored row was collected under', () => {
  it('holds for every case in the set, through the driver itself', async () => {
    // The claim is about what went on the wire, read off the transport, not the builder — triage.mjs once called triageUserMsg with two arguments and no arm.
    // The twelve stored rows are the known-good the arm is compared against.
    const { sent } = await canned(CASES, correctReplies('bare'));
    expect(sent).toHaveLength(CASES.length);
    for (const { id, user } of sent) {
      const c = caseById(id);
      expect(user).toBe(triageUserMsg(c.transcript, c.consults));
      expect(user).toBe(buildSpeakingUserMessage(c.transcript, c.consults));
      for (const tag of ['<written>', '<participants>', '<capabilities>', '<situation>']) {
        expect(user).not.toContain(tag);
      }
      // <consults> is the one block the bare arm has always sent — the claim is that the arm is additive, not that the set is consult-free.
      // A stored row's bytes are the two-argument call's bytes — what the two assertions above pin.
      expect(user.includes('<consults>')).toBe(c.consults !== undefined);
    }
  });

  it('sends no context, so the third argument changes nothing', () => {
    expect(armContext('bare')).toBeUndefined();
    for (const c of CASES) {
      expect(triageUserMsg(c.transcript, c.consults, armContext('bare'))).toBe(
        triageUserMsg(c.transcript, c.consults),
      );
    }
  });

  it('is what an unset CONTEXT_ARM resolves to', () => {
    expect(resolveTriageContextArm(undefined)).toBe('bare');
    expect(resolveTriageContextArm('')).toBe('bare');
    expect(resolveTriageContextArm('bare')).toBe('bare');
  });
});

describe('the full arm sends the pinned standing context', () => {
  it('renders <capabilities> — the block whose contents caused the incident', async () => {
    const { sent } = await canned(CASES, correctReplies('full'), UNTIMED, 'full');
    for (const { id, user } of sent) {
      const c = caseById(id);
      expect(user).toBe(triageUserMsg(c.transcript, c.consults, FIXED_CONTEXT));
      for (const tag of ['<transcript>', '<written>', '<participants>', '<capabilities>']) {
        expect(user).toContain(tag);
      }
      // The capability list itself, not just the tag — the pair below is only a pair if the answer is genuinely in one request and not the other.
      expect(user).toContain(FIXED_CONTEXT.capabilities);
    }
  });

  it('never renders <situation>, under either arm — the gate produces one, it is not given one', () => {
    // Why resolveTriageContextArm refuses full-noverdict: triageUserMsg calls buildSpeakingUserMessage, not assembleSpeakingRequest, so no verdict reaches it.
    for (const arm of ['bare', 'full']) {
      for (const c of CASES) {
        expect(triageUserMsg(c.transcript, c.consults, armContext(arm))).not.toContain('<situation>');
      }
    }
  });

  it('refuses full-noverdict, because it would be a second name for full', () => {
    // Two arms that are actually one would make the comparison pure sampling noise — a typo here costs a process start, as in resolveContextArm.
    expect(() => resolveTriageContextArm('full-noverdict')).toThrow(/not an arm of the triage gate/);
    expect(() => resolveTriageContextArm('ful')).toThrow(/not an arm/);
    expect(resolveTriageContextArm('full')).toBe('full');
  });

  it('adds the measured bulk rather than a token block', () => {
    const added = triageUserMsg('', undefined, armContext('full')).length - triageUserMsg('').length;
    // 8,676 as measured — the figure both drivers' banners print, each off its own builder (triage.mjs's triageUserMsg, defect.mjs's userMsg), not a shared literal, so there's no third copy to go stale.
    // Excludes the <situation> verdict sentence: the banners pass no verdict, and the gate has no block to render one into — standing blocks alone.
    // Floor sits above 7,489 (what this arm added when capabilities was five flat hand-written lines) so reverting to that block fails here, not silently measuring 1,187 fewer characters than production sends.
    // Ceiling is deliberately coupled to context-arm.test.ts's 2,200-char capabilities ceiling, which asserts this quantity through the speaking builder — the two bands must stay coherent.
    expect(added).toBeGreaterThan(8000);
    expect(added).toBeLessThan(9400);
  });
});

describe('a per-arm expectation is resolved, never guessed', () => {
  const pair = caseById('TGm-en-caps-pair');

  it('the pair expects a different verdict under each arm', () => {
    expect(expectedFor(pair, 'bare')).toBe('outside');
    expect(expectedFor(pair, 'full')).toBe('room');
    expect(expectedFor(caseById('TGo-ru-caps-pair'), 'bare')).toBe('outside');
    expect(expectedFor(caseById('TGo-ru-caps-pair'), 'full')).toBe('room');
  });

  it('throws rather than defaulting when the arm is missing or unknown', () => {
    // A guess here would grade a full row against the bare expectation, reporting the harness's own choice as the gate's error.
    expect(() => expectedFor(pair, undefined)).toThrow(/graded with no arm named/);
    expect(() => expectedFor(pair, 'full-noverdict')).toThrow(/declares no expectation/);
    expect(() => gradeTriage(pair, ROOM, UNTIMED)).toThrow(/graded with no arm named/);
  });

  it('a string expectation ignores the arm entirely', () => {
    const plain = caseById('TGk-en-short-outside');
    for (const arm of ['bare', 'full', 'full-noverdict', undefined]) {
      expect(expectedFor(plain, arm)).toBe('outside');
    }
  });

  it('the stored row carries the resolved expectation and the arm', async () => {
    // So a file can never be read as the other arm's, and an offline regrade has what it needs to grade the pair correctly.
    const { rows } = await canned([pair], correctReplies('full'), UNTIMED, 'full');
    expect(rows[0]).toMatchObject({ case: pair.id, expect: 'room', context: 'full' });
    const bare = await canned([pair], correctReplies('bare'), UNTIMED, 'bare');
    expect(bare.rows[0]).toMatchObject({ case: pair.id, expect: 'outside', context: 'bare' });
    expect(bare.rows[0].fails).toEqual([]);
  });
});

describe('the preamble is graded for what it says, not only that it exists', () => {
  const pairEn = caseById('TGm-en-caps-pair');
  const pairRu = caseById('TGo-ru-caps-pair');
  const longEn = caseById('TGd-en-long-absent-outside');
  const longRu = caseById('TGh-ru-long-absent-outside');
  const prefixes = (fails: string[]) => fails.map((f) => f.split(':')[0]);

  it('fires on the real incident\'s machinery preamble', () => {
    // The sentence voice-triage.md names as the exact slip this rule stops — and the sentence this harness once scored clean.
    const g = gradeTriage(longEn, outsideWith(INCIDENT_MACHINERY), UNTIMED);
    expect(g.fails.filter((f) => f.startsWith('MACHINERY'))).toHaveLength(1);
    expect(g.fails.find((f) => f.startsWith('MACHINERY'))).toContain('the PM');
    // The verdict was right, so placement stays clean: a separate failure with a separate cause, not a placement error in disguise.
    expect(prefixes(g.fails)).toEqual(['MACHINERY']);
  });

  it('fires on the real incident\'s answering preamble, in both languages', () => {
    // The other half: the gate answered outside about a question its own capabilities block answers, and the preamble read the list out.
    // Graded under full, where the wrong verdict and the delivered answer are both visible on one row.
    const en = gradeTriage(pairEn, outsideWith(INCIDENT_ANSWERED), UNTIMED, 'full');
    expect(prefixes(en.fails)).toEqual(['PLACEMENT', 'ANSWERED']);
    expect(en.fails.find((f) => f.startsWith('ANSWERED'))).toContain('warehouse');
    const ru = gradeTriage(pairRu, outsideWith(INCIDENT_ANSWERED_RU), UNTIMED, 'full');
    expect(prefixes(ru.fails)).toEqual(['PLACEMENT', 'ANSWERED']);
    // The Russian half can't lean on English anchors: an answering preamble in Russian says хранилище, nowhere in the pinned English list.
    expect(ru.fails.find((f) => f.startsWith('ANSWERED'))).toMatch(/[Ѐ-ӿ]/);
  });

  it('fires with the list absent too, where answering is inventing', () => {
    // Under bare the request carried no capability list, so the same preamble answers a question nothing in front of the gate could — verdict is right, ANSWERED is the only failure.
    const g = gradeTriage(pairEn, outsideWith(INCIDENT_ANSWERED), UNTIMED, 'bare');
    expect(prefixes(g.fails)).toEqual(['ANSWERED']);
  });

  it('fires when a long-transcript preamble delivers the answer the meeting never said', () => {
    const g = gradeTriage(longRu, outsideWith('Сейчас уточню — этим занимается Руслан.'), UNTIMED);
    expect(g.fails.find((f) => f.startsWith('ANSWERED'))).toContain('Руслан');
  });

  it('stays silent on all four preambles the last real run produced', () => {
    // The must-NOT-fire half: two restate the question at length, which is what holding the floor looks like — a check confusing that with answering would fail a correct gate.
    // Graded on every outside case, including the three that declare no answer.
    const outsideCases = CASES.filter((c) => expectedFor(c, 'bare') === 'outside');
    expect(outsideCases.length).toBeGreaterThan(4);
    for (const c of outsideCases) {
      for (const preamble of CORRECT_PREAMBLES) {
        const g = gradeTriage(c, outsideWith(preamble), UNTIMED, 'bare');
        // LANGUAGE is expected on the mismatched pairs and is a different check; this suite is about MACHINERY and ANSWERED.
        expect({
          case: c.id,
          preamble,
          fails: g.fails.filter((f) => f.startsWith('MACHINERY') || f.startsWith('ANSWERED')),
        }).toMatchObject({ fails: [] });
      }
    }
  });

  it('a case that declares no answer is not checked, and the twin is why', () => {
    // TGn/TGp ask for the crash numbers, on the capability list — the correct preamble restates it, so a suite-wide ban would fail it; hence the field is per case.
    const twin = caseById('TGn-en-caps-overreach-outside');
    expect(twin.answer).toBeUndefined();
    const g = gradeTriage(twin, outsideWith('Let me pull the crash numbers for last week.'), UNTIMED);
    expect(g.fails).toEqual([]);
    // The mutation proving the exemption works: the same sentence would be banned had the twin borrowed the pair's declaration.
    expect(answerLeakCheck('Let me pull the crash numbers for last week.', CAPABILITY_ANSWER)).toHaveLength(1);
  });

  it('is reached only on outside, and reports what it found on the row', () => {
    // A room verdict produces no preamble, so neither check runs — grading absence as clean is right; grading it a fault would fail every correct room.
    const g = gradeTriage(pairEn, ROOM, UNTIMED, 'full');
    expect(g.fails).toEqual([]);
    expect(g.info.machinery).toBeUndefined();
    expect(g.info.answered).toBeUndefined();
    const bad = gradeTriage(longEn, outsideWith(INCIDENT_MACHINERY), UNTIMED);
    expect(bad.info.machinery).toEqual(machineryLeakCheck(INCIDENT_MACHINERY));
    expect(bad.info.answered).toEqual([]);
  });
});

// A detector nobody has watched fire isn't evidence, so this suite states known-bad and known-good side by side, in English and Russian.
// The \b mutation other files use doesn't apply here: the id token is ASCII, so \b does bound it correctly inside Cyrillic prose.
// \b is wrong here in the opposite direction: it treats в and m as equally non-word, so it sees a boundary inside a word and fires where the Unicode bound correctly doesn't.
describe('a preamble that reads out the id its own request rendered', () => {
  const idEn = caseById('TGr-en-idleak-outside');
  const idRu = caseById('TGs-ru-idleak-outside');
  const declaredId = String(idEn.consults?.[0].id);
  const prefixes = (fails: string[]) => fails.map((f) => f.split(':')[0]);

  it('fires on a leak, and stays silent on the correct preamble — English', () => {
    // Known-bad and known-good, one line apart, so neither can be read without the other.
    expect(internalIdLeakCheck(`Let me go and find that out under ${declaredId}.`, idEn.consults))
      .toEqual([`consult-id:${declaredId}`]);
    expect(internalIdLeakCheck('Let me go and find that out.', idEn.consults)).toEqual([]);
  });

  it('fires on a leak, and stays silent on the correct preamble — Russian', () => {
    // The id is ASCII inside Cyrillic prose — exactly the arrangement an ASCII-only bound gets wrong.
    expect(internalIdLeakCheck(`Сейчас узнаю, это по ${declaredId}.`, idRu.consults))
      .toEqual([`consult-id:${declaredId}`]);
    expect(internalIdLeakCheck('Сейчас узнаю.', idRu.consults)).toEqual([]);
  });

  it('catches an id no row declared, by production\'s shape', () => {
    // Backstop tier: m<digits>c<digits> matches whether or not a fixture filed that consult; reported as id-shape to tell an invented id from a rendered one.
    expect(internalIdLeakCheck('Let me check on m13c4 and come back.', undefined)).toEqual(['id-shape:m13c4']);
    expect(internalIdLeakCheck('Сейчас посмотрю по m13c4.', [])).toEqual(['id-shape:m13c4']);
    // One entry per leaked token, never one per tier, so a single slip is reported once.
    expect(internalIdLeakCheck(`by ${declaredId}`, idEn.consults)).toHaveLength(1);
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
    // And it does fire when the id stands as its own token in the same prose.
    expect(internalIdLeakCheck('в m1c1 в отчёте', [{ id: 'm1c1', question: 'q' }])).toHaveLength(1);
  });

  it('stays silent on every correct preamble and on the pinned context', () => {
    // The must-NOT-fire half: the same four sentences the machinery check uses, plus the full arm's ~8k standing characters — a false positive here would fail a correct gate.
    for (const preamble of CORRECT_PREAMBLES) {
      expect({ preamble, hits: internalIdLeakCheck(preamble, idEn.consults) }).toMatchObject({ hits: [] });
    }
    expect(internalIdLeakCheck(FIXED_CONTEXT.capabilities, idEn.consults)).toEqual([]);
    expect(internalIdLeakCheck(FIXED_CONTEXT.written.map((w) => w.text).join(' '), idEn.consults)).toEqual([]);
  });

  it('grades as MACHINERY on the row, through the driver, in both languages', async () => {
    // The wiring, not just the function: an uncalled detector grades everything clean, invisible to a unit test of the detector alone.
    for (const c of [idEn, idRu]) {
      const leak = addressedInRussian(c.transcript)
        ? `Сейчас узнаю, это по ${declaredId}.`
        : `Let me go and find that out under ${declaredId}.`;
      const { rows } = await canned([c as Case], { [c.id]: outsideWith(leak) }, UNTIMED);
      expect(prefixes(rows[0].fails)).toEqual(['MACHINERY']);
      expect(rows[0].fails[0]).toContain(declaredId);
      expect(rows[0].info.machinery).toEqual([`consult-id:${declaredId}`]);
    }
  });

  it('and the same two rows grade clean on a correct preamble', async () => {
    const { rows } = await canned([idEn as Case, idRu as Case], correctReplies('bare'), UNTIMED);
    expect(rows.flatMap((r) => r.fails)).toEqual([]);
  });

  it('the id is genuinely in front of the gate, in the block production renders it in', async () => {
    // Only a leak if the thing leaked was actually sent; consultsBlock puts the id first on the entry's line, the exact string the gate reads.
    const { sent } = await canned([idEn as Case, idRu as Case], correctReplies('bare'), UNTIMED);
    for (const { user } of sent) {
      expect(user).toContain('<consults>');
      expect(user).toContain(`${declaredId}. Q: `);
    }
  });
});

describe('the answer declarations are readings of something that already exists', () => {
  it('the long cases reuse the long fixture\'s own groups', () => {
    expect(caseById('TGd-en-long-absent-outside').answer).toBe(LONG.en.must);
    expect(caseById('TGh-ru-long-absent-outside').answer).toBe(LONG.ru.must);
  });

  it('every capability group matches the pinned <capabilities> list', () => {
    for (const group of CAPABILITY_ANSWER as RegExp[][]) {
      expect({
        group: group.map(String),
        hit: group.some((re) => re.test(FIXED_CONTEXT.capabilities)),
      }).toMatchObject({ hit: true });
    }
  });

  it('and the check that ties them to it refuses a group that does not', () => {
    // The guard, not just the property — with the declaration correct, the test above passes whether or not fromCapabilityList does anything.
    // The mutation that matters is a group the pinned list doesn't contain: it must cost a module load, not quietly ban a phrase the room can't be told.
    expect(() => fromCapabilityList([[/(?<!\p{L})not in the pinned list(?!\p{L})/iu]])).toThrow(
      /matches nothing in the pinned <capabilities> list/,
    );
    // A group with one live and one dead alternative is fine — the Russian renderings are dead against an English block by construction.
    const groups = [[/(?<!\p{L})warehouse(?!\p{L})/iu, /(?<!\p{L})хранилищ[а-яё]*(?!\p{L})/iu]];
    expect(fromCapabilityList(groups)).toBe(groups);
  });

  it('and matches neither of the other two standing blocks — so the pair varies only the list', () => {
    // The full arm sends three blocks, so the pair varies the whole context; closed mechanically since written/participants say nothing about what Archie can do — capabilities is the only relevant block.
    // A capabilities-only arm would be a fourth arm and a second pinned context — deliberately not kept.
    const written = (FIXED_CONTEXT.written as { speaker: string; text: string }[])
      .map((w) => `${w.speaker}: ${w.text}`)
      .join('\n');
    const roster = (FIXED_CONTEXT.participants as { name: string | null }[])
      .map((p) => p.name ?? '')
      .join('\n');
    for (const group of CAPABILITY_ANSWER as RegExp[][]) {
      for (const re of group) {
        expect({ re: String(re), inWritten: re.test(written), inRoster: re.test(roster) }).toMatchObject({
          inWritten: false,
          inRoster: false,
        });
      }
    }
  });

  it('no case\'s declared answer appears in its own transcript', () => {
    // Otherwise the room supplied it, the verdict would be room, and there'd be no preamble to grade — generalizing the check above for the long absent pair.
    for (const c of CASES.filter((x) => x.answer !== undefined)) {
      for (const group of c.answer as RegExp[][]) {
        for (const re of group) {
          expect({ case: c.id, re: String(re), inTranscript: re.test(c.transcript) }).toMatchObject({
            inTranscript: false,
          });
        }
      }
    }
  });

  it('an unsatisfiable declaration makes a correct preamble fail', () => {
    // The mutation stopping the suite above passing for the wrong reason: a quietly-broken answerLeakCheck would let a ban on the correct preamble's own words change nothing.
    const c = { ...caseById('TGk-en-short-outside'), answer: [[/(?<!\p{L})check(?!\p{L})/iu]] };
    const g = gradeTriage(c, outsideWith('Let me check that for you.'), UNTIMED);
    expect(g.fails.filter((f) => f.startsWith('ANSWERED'))).toHaveLength(1);
  });
});

describe('the Russian capability anchors are bounded the Unicode way', () => {
  it('the shipped groups go dead if their bounds are rewritten as \\b', () => {
    // Swaps the shipped patterns' Unicode bounds for the ASCII ones a first draft reaches for — watches an ordinary Russian sentence stop matching.
    const live = (CAPABILITY_ANSWER as RegExp[][]).flat().filter((re) => /[Ѐ-ӿ]/.test(re.source));
    expect(live.length).toBeGreaterThan(0);
    let liveHits = 0;
    let asciiHits = 0;
    for (const re of live) {
      const ascii = new RegExp(
        re.source.replace(/\(\?<!\\p\{L\}\)/g, '\\b').replace(/\(\?!\\p\{L\}\)/g, '\\b'),
        re.flags.replace('u', ''),
      );
      if (re.test(INCIDENT_ANSWERED_RU)) liveHits++;
      if (ascii.test(INCIDENT_ANSWERED_RU)) asciiHits++;
    }
    expect(liveHits).toBeGreaterThan(0);
    expect(asciiHits).toBe(0);
  });

  it('no Russian anchor reaches for \\b or \\w', () => {
    for (const re of (CAPABILITY_ANSWER as RegExp[][]).flat()) {
      if (!/[Ѐ-ӿ]/.test(re.source)) continue;
      expect({ re: String(re), b: re.source.includes('\\b'), w: re.source.includes('\\w') }).toMatchObject({
        b: false,
        w: false,
      });
    }
  });
});

describe('the preamble\'s language is the one Archie was addressed in', () => {
  it('agrees with every single-language fixture\'s declared `ru`', () => {
    // Asserted against sixteen hand labels: where room and address language coincide, the derived flag must reproduce the declared one exactly.
    for (const c of CASES.filter((x) => x.id !== 'TGq-ru-room-en-ask-outside')) {
      expect({ case: c.id, addressed: addressedInRussian(c.transcript) }).toMatchObject({ addressed: c.ru });
    }
  });

  it('and differs on exactly the one mixed case', () => {
    const mixed = caseById('TGq-ru-room-en-ask-outside');
    expect(mixed.ru).toBe(true);
    expect(addressedInRussian(mixed.transcript)).toBe(false);
    const differ = CASES.filter((c) => addressedInRussian(c.transcript) !== c.ru).map((c) => c.id);
    expect(differ).toEqual(['TGq-ru-room-en-ask-outside']);
  });

  it('the mixed case is a Russian room with D5a\'s English ask, assembled from both fixtures', async () => {
    const { DCASES } = await import('./dcases.mjs');
    const source = (id: string) =>
      (DCASES as { id: string; transcript: string }[]).find((c) => c.id === id)?.transcript ?? '';
    const mixed = caseById('TGq-ru-room-en-ask-outside').transcript.split('\n');
    const room = source('D5b-ru-config-lookup').split('\n');
    // Everything above the address is D5b, verbatim.
    expect(mixed.slice(0, -1)).toEqual(room.slice(0, -1));
    // The address is D5a's question spoken by D5b's speaker.
    const ask = source('D5a-en-config-lookup').split('\n').at(-1)?.replace(/^[^:]*:\s*/, '');
    expect(mixed.at(-1)).toBe(`${room.at(-1)?.split(':')[0]}: ${ask}`);
    // A Cyrillic speaker name on an English line: the raw line would read as Russian, which is what the prefix strip is for.
    expect(mixed.at(-1)).toMatch(/^[Ѐ-ӿ]/);
  });

  it('an English preamble is correct there, and a Russian one fails', () => {
    const mixed = caseById('TGq-ru-room-en-ask-outside');
    expect(gradeTriage(mixed, OUTSIDE_EN, UNTIMED).fails).toEqual([]);
    const wrong = gradeTriage(mixed, OUTSIDE_RU, UNTIMED);
    expect(wrong.fails.filter((f) => f.startsWith('LANGUAGE'))).toHaveLength(1);
    expect(wrong.fails[0]).toContain('addressed in English');
    // The old rule is the mutation: keyed on the room, this fixture's correct English preamble fails and its wrong Russian one passes.
    // Both directions, so the assertion can't hold by accident.
    expect(mixed.ru).toBe(true);
    expect(gradeTriage(caseById('TGl-ru-short-outside'), OUTSIDE_RU, UNTIMED).fails).toEqual([]);
    expect(
      gradeTriage(caseById('TGl-ru-short-outside'), OUTSIDE_EN, UNTIMED)
        .fails.filter((f: string) => f.startsWith('LANGUAGE')),
    ).toHaveLength(1);
  });

  it('the speaker prefix never decides the language, even when it outweighs the words', () => {
    // The adversarial minimum, holding the prefix-strip in place: a long Cyrillic name in front of a short English address.
    // "Дмитрий" is 7 Cyrillic letters against 6 Latin — the raw line reads 0.54 Cyrillic and calls a short English address Russian, and addressed lines are often this short.
    // The longer phrasings below would survive an unstripped prefix by accident, the name being a small share of a long sentence — why they can't be the only cases.
    expect(addressedInRussian('Дмитрий: Archie?')).toBe(false);
    expect(addressedInRussian('Дмитрий: Archie, what can you help us with?')).toBe(false);
    expect(addressedInRussian('Dmitry: Арчи?')).toBe(true);
    expect(addressedInRussian('Dmitry: Арчи, чем ты можешь нам помочь?')).toBe(true);
    // No colon at all: the whole line is the utterance.
    expect(addressedInRussian('Арчи, а погода?')).toBe(true);
    // And only the last line counts, whatever came before it.
    expect(addressedInRussian('Анна: Всё готово.\nDmitry: Archie, and the rate limit?')).toBe(false);
  });
});

describe('the capability pair, its twin and the language case', () => {
  it('every new fixture\'s expected verdict, by id rather than by a loop', () => {
    // Same reason context-arm.test.ts pins one case per family by name: a loop over declarations asserts whatever they said — a wrong declaration is the mistake guarded against.
    expect(expectedFor(caseById('TGm-en-caps-pair'), 'full')).toBe('room');
    expect(expectedFor(caseById('TGm-en-caps-pair'), 'bare')).toBe('outside');
    expect(expectedFor(caseById('TGo-ru-caps-pair'), 'full')).toBe('room');
    expect(expectedFor(caseById('TGo-ru-caps-pair'), 'bare')).toBe('outside');
    expect(expectedFor(caseById('TGn-en-caps-overreach-outside'), 'full')).toBe('outside');
    expect(expectedFor(caseById('TGn-en-caps-overreach-outside'), 'bare')).toBe('outside');
    expect(expectedFor(caseById('TGp-ru-caps-overreach-outside'), 'full')).toBe('outside');
    expect(expectedFor(caseById('TGp-ru-caps-overreach-outside'), 'bare')).toBe('outside');
    expect(expectedFor(caseById('TGq-ru-room-en-ask-outside'), 'full')).toBe('outside');
    expect(expectedFor(caseById('TGq-ru-room-en-ask-outside'), 'bare')).toBe('outside');
  });

  it('the pair and its twin differ in exactly the last line', () => {
    // The whole basis of comparing them, and structural rather than a claim — both are built from one lead-in array.
    for (const [pair, twin] of [
      ['TGm-en-caps-pair', 'TGn-en-caps-overreach-outside'],
      ['TGo-ru-caps-pair', 'TGp-ru-caps-overreach-outside'],
    ]) {
      const a = caseById(pair).transcript.split('\n');
      const b = caseById(twin).transcript.split('\n');
      expect(a).toHaveLength(b.length);
      expect(a.slice(0, -1)).toEqual(b.slice(0, -1));
      expect(a.at(-1)).not.toBe(b.at(-1));
    }
  });

  it('the pair asks for the list and the twin asks for something on it', () => {
    // The distinction voice-triage.md's guard sentence draws, and the reason the two verdicts differ under the same request.
    expect(caseById('TGm-en-caps-pair').transcript).toMatch(/what can you help us with\?$/);
    expect(caseById('TGn-en-caps-overreach-outside').transcript).toMatch(/crash numbers for last week\?$/);
    expect(caseById('TGo-ru-caps-pair').transcript).toMatch(/чем ты можешь нам помочь\?$/);
    expect(caseById('TGp-ru-caps-overreach-outside').transcript).toMatch(/по крашам за прошлую неделю\?$/);
  });

  it('the pair\'s own transcript supplies nothing, under either arm', () => {
    // What makes it a pair, not two cases: the only thing changing between the two runs is whether the list was in the request.
    for (const id of ['TGm-en-caps-pair', 'TGo-ru-caps-pair']) {
      const c = caseById(id);
      expect(triageUserMsg(c.transcript, c.consults, armContext('bare'))).not.toContain(
        FIXED_CONTEXT.capabilities,
      );
      expect(triageUserMsg(c.transcript, c.consults, armContext('full'))).toContain(
        FIXED_CONTEXT.capabilities,
      );
    }
  });

  it('a clean run of the whole set grades clean, under both arms', async () => {
    for (const arm of ['bare', 'full']) {
      const { rows } = await canned(CASES, correctReplies(arm), UNTIMED, arm);
      expect(rows).toHaveLength(CASES.length);
      expect(rows.flatMap((r) => r.fails)).toEqual([]);
      expect(new Set(rows.map((r) => r.context))).toEqual(new Set([arm]));
    }
  });
});
