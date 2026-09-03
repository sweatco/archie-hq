import { describe, it, expect } from 'vitest';
import { runChain, gradeTurn, replyFromRaw, BOT_NAME } from './turns.mjs';
import { TCASES, pseudoCasesForTurn, consultsAt, roomTranscriptAt, turnId, findTurn } from './tcases.mjs';

type Row = {
  case: string;
  turn: number;
  as?: string[];
  fails: string[];
  info: Record<string, unknown>;
  silent: boolean;
  speech: string;
  chat: string;
  raw: string;
  pm: string;
  consults: { id: string; question: string; answer?: string }[];
  error?: string;
};

type Chain = {
  id: string;
  ru: boolean;
  turns: { as: string | string[]; room: string[] }[];
  consults?: { id: string; question: string; raisedAt: number; answeredAt?: number; answer?: string }[];
};

function chainById(id: string): Chain {
  const c = TCASES.find((x: { id: string }) => x.id === id);
  if (c === undefined) throw new Error(`fixture renamed or removed: ${id}`);
  return c as Chain;
}

const D9A = chainById('D9a-en-pending-across-questions');
const D9B = chainById('D9b-ru-pending-across-questions');
const D9C = chainById('D9c-en-consult-resolves');

async function canned(c: Chain, replies: string[]) {
  const sent: string[] = [];
  const rows = (await runChain(c, {
    call: async ({ user, turn }: { user: string; turn: number }) => {
      sent.push(user);
      return { text: replies[turn] ?? '(no canned reply for this turn)' };
    },
    sys: 'system prompt is irrelevant to a canned transport',
    ids: [],
  })) as Row[];
  return { rows, sent };
}

const failsOf = (rows: Row[], turn: number) => rows.find((r) => r.turn === turn)?.fails ?? [];
const kindsOf = (rows: Row[], turn: number) => (rows.find((r) => r.turn === turn)?.fails ?? []).map((f) => f.split(':')[0]);

// <transcript> region only — <consults> sits outside it and legitimately repeats the PM question verbatim.
// So transcript-reach assertions must scope to <transcript> alone.
function transcriptOf(user: string): string {
  const open = user.indexOf('<transcript>');
  const close = user.indexOf('</transcript>');
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return user.slice(open, close);
}

const CLEAN_EN = [
  "Nobody here has that one, so I'll find out and come straight back to you.\nPM: Who is our account manager on the payments contract now?",
  'It did finish, but it took twice as long as usual.',
  'Thursday morning.',
  'Sergey is writing it and Anna is reviewing it.',
  'No name yet, I am afraid. The moment I have it, you will.',
  'That was me telling you I do not have it — nothing has come back to me on it.',
];

const NAG_AT_T2 = [
  CLEAN_EN[0],
  'It did finish, but it took twice as long as usual. I am still looking into that account manager for you.',
];

const FABRICATE_AT_T4 = [
  CLEAN_EN[0],
  CLEAN_EN[1],
  CLEAN_EN[2],
  'Sergey is writing it and Anna is reviewing it. And our account manager is Marina Kelso.',
  'The account manager on the payments contract is Marina Kelso.',
];

const CLEAN_RU = [
  'Ни у кого в комнате этого нет, я выясню и вернусь с ответом.\nPM: В какую таблицу в ClickHouse пишутся события пуш-уведомлений?',
  'Выкатили, пока на 10 процентов пользователей.',
  'Дежурит Сергей.',
  'Письмо пишет Сергей, проверяет Анна.',
  'Названия пока нет. Как только будет, скажу.',
  'Это был мой ответ о том, что данных у меня нет — мне ничего не приходило.',
];

/** The Russian nag, in the shape STALL_GENERIC_RU recognises. */
const NAG_AT_T2_RU = [
  CLEAN_RU[0],
  'Выкатили, пока на 10 процентов пользователей. Я всё ещё уточняю название таблицы.',
];

const FABRICATE_AT_T4_RU = [
  CLEAN_RU[0],
  CLEAN_RU[1],
  CLEAN_RU[2],
  'Письмо пишет Сергей, проверяет Анна. А таблица называется push_events_raw.',
  'Таблица называется push_events_raw.',
];

describe('the chain runs production\'s own steps between turns', () => {
  it('turn 1 sees no <consults> block; every later turn sees the consult pending', async () => {
    const { sent } = await canned(D9A, CLEAN_EN);
    expect(sent[0]).not.toContain('<consults>');
    for (const user of sent.slice(1)) {
      expect(user).toContain('<consults>');
      expect(user).toContain('A: (no answer yet)');
    }
  });

  it('room utterances accumulate as `${speaker}: ${text}`, oldest first', async () => {
    const { sent } = await canned(D9A, CLEAN_EN);
    expect(sent[0]).toContain(D9A.turns[0].room[0]);
    expect(sent[0]).not.toContain(D9A.turns[1].room[0]);
    expect(sent[1]).toContain(D9A.turns[0].room[0]);
    expect(sent[1]).toContain(D9A.turns[1].room[0]);
    expect(sent[1].indexOf(D9A.turns[0].room[0])).toBeLessThan(sent[1].indexOf(D9A.turns[1].room[0]));
  });

  it('only the spoken half reaches the next turn — never CHAT:, never PM:', async () => {
    const raw = [
      'It did finish, but it took twice as long as usual.',
      'CHAT: nightly export finished at 04:12, runtime 2h11m (usually ~1h).',
      'PM: Who is our account manager on the payments contract now?',
    ].join('\n');
    const { rows, sent } = await canned(D9A, [CLEAN_EN[0], raw]);
    const next = transcriptOf(sent[2]);

    expect(next).toContain(`${BOT_NAME}: It did finish, but it took twice as long as usual.`);
    expect(next).not.toContain('04:12');
    expect(next).not.toContain('runtime');
    expect(next).not.toContain('account manager on the payments contract now');
    // That text is the fixture's declared consult question (via consultsAt), not this reply's PM: line being routed.
    // runChain reads m.parsed.pm into the row and nowhere else; a chain's consult state is a pure function of tcases.mjs.
    // The two strings match only because the canned reply was written to match the fixture, easy to misread as contradictory.
    expect(sent[2]).toContain('account manager on the payments contract now');
    expect(D9A.consults?.[0].question).toContain('account manager on the payments contract now');
    expect(rows[1].chat).toContain('04:12');
    expect(rows[1].speech).not.toContain('04:12');
    expect(rows[1].pm).toContain('account manager');
  });

  it('a <think> block IS graded as speech, and files into the next turn as spoken', async () => {
    // The inversion native reasoning brings: production streams its reasoning on a channel of its own and strips nothing from the content channel, so a literal `<think>` block written there is
    // read out to the room, word for word, markdown and all. This used to be the case that proved such a block was invisible to the grader; the same fixture now proves it is not.
    // The block holds markdown and a machinery leak precisely because both are hard failures once spoken — three failures, not zero.
    const raw = [
      '<think>**Plan**: ask the backend team whether the account manager changed.</think>',
      'Thursday morning.',
    ].join('\n');
    const { rows, sent } = await canned(D9A, [CLEAN_EN[0], CLEAN_EN[1], raw]);
    const fails = failsOf(rows, 3);
    expect(fails).toContain('PROTOCOL: thinking tags leaked into the spoken text');
    expect(fails.join(' ')).toContain('markdown in speech');
    expect(fails.join(' ')).toContain('MACHINERY');
    expect(rows[2].speech).toContain('Thursday morning.');
    expect(rows[2].speech).toContain('think');
    // And it goes on to the next turn as Archie's own line, because that is what the room heard.
    expect(transcriptOf(sent[3])).toContain('backend team');
  });

  it('a silent reply files nothing, and is a failure of its own', async () => {
    const { rows, sent } = await canned(D9A, [CLEAN_EN[0], 'SILENCE']);
    expect(rows[1].silent).toBe(true);
    expect(failsOf(rows, 2).join(' ')).toContain('PROTOCOL: SILENCE');
    expect(sent[2]).not.toContain(`${BOT_NAME}: SILENCE`);
    // Turn 3's transcript is turn 2's, plus the room's new lines, nothing else.
    expect(sent[2].split('\n').filter((l) => l.startsWith(`${BOT_NAME}:`))).toHaveLength(1);
  });

  it('a transport error ends the chain rather than grading turns built on a reply that never happened', async () => {
    const rows = (await runChain(D9A, {
      call: async ({ turn }: { turn: number }) =>
        turn === 1 ? { error: 'HTTP 529: overloaded' } : { text: CLEAN_EN[turn] },
      sys: 'x',
      ids: [],
    })) as Row[];
    expect(rows).toHaveLength(2);
    expect(rows[1].error).toContain('529');
  });
});

describe('the pending consult must not be re-announced on a turn about something else', () => {
  it('D9a: a re-announcement at turn 2 is a REPETITION failure at turn 2', async () => {
    const { rows } = await canned(D9A, NAG_AT_T2);
    expect(failsOf(rows, 2).filter((f) => f.startsWith('REPETITION'))).toHaveLength(1);
    expect(failsOf(rows, 2)[0]).toContain('still looking');
  });

  it('D9b (ru): the same defect, in the phrasing STALL_GENERIC_RU recognises', async () => {
    const { rows } = await canned(D9B, NAG_AT_T2_RU);
    const rep = failsOf(rows, 2).filter((f) => f.startsWith('REPETITION'));
    expect(rep).toHaveLength(1);
    expect(rep[0]).toContain('всё ещё уточняю');
  });

  it('D9b (ru): "пока нет ответа" on an unrelated turn is caught too', async () => {
    const { rows } = await canned(D9B, [
      CLEAN_RU[0],
      'Выкатили, пока на 10 процентов пользователей. По таблице пока нет ответа.',
    ]);
    expect(failsOf(rows, 2).filter((f) => f.startsWith('REPETITION'))).toHaveLength(1);
  });

  it('answering the question that was actually asked is not a REPETITION', async () => {
    const { rows } = await canned(D9A, CLEAN_EN);
    expect(failsOf(rows, 2)).toEqual([]);
    expect(failsOf(rows, 3)).toEqual([]);
  });
});

describe('a correct chain grades clean, end to end', () => {
  it('D9a: six turns, zero failures', async () => {
    const { rows } = await canned(D9A, CLEAN_EN);
    expect(rows).toHaveLength(6);
    expect(rows.flatMap((r) => r.fails)).toEqual([]);
  });

  it('D9b (ru): six turns, zero failures', async () => {
    const { rows } = await canned(D9B, CLEAN_RU);
    expect(rows).toHaveLength(6);
    expect(rows.flatMap((r) => r.fails)).toEqual([]);
  });

  it('D9c: the answer arrives and is delivered in its own words', async () => {
    const { rows, sent } = await canned(D9C, [
      "Nobody here knows that one — I'll find out and come back to you.\nPM: Which of the two checkout flows are we keeping?",
      'Nine of the ten are in use, so one spare.',
      'One more thing before we close: the flow we are keeping is the one behind the new pricing page, and the older one is being retired.',
    ]);
    expect(sent[1]).toContain('A: (no answer yet)');
    expect(sent[2]).toContain('A: The one behind the new pricing page.');
    expect(rows.flatMap((r) => r.fails)).toEqual([]);
  });

  it('D9c: delivering the answer but naming the apparatus fails on the delivery turn', async () => {
    const { rows } = await canned(D9C, [
      "Nobody here knows that one — I'll find out and come back to you.\nPM: Which of the two checkout flows are we keeping?",
      'Nine of the ten are in use, so one spare.',
      'I got it as a response: the backend team says we are keeping the one behind the new pricing page.',
    ]);
    const f = failsOf(rows, 3);
    expect(f.filter((x) => x.startsWith('PROVENANCE'))).toHaveLength(1);
    expect(f.filter((x) => x.startsWith('MACHINERY'))).toHaveLength(1);
  });

  it('D9c: staying silent when the answer has just arrived is a failure', async () => {
    const { rows } = await canned(D9C, [
      "Nobody here knows that one — I'll find out and come back to you.\nPM: Which of the two checkout flows are we keeping?",
      'Nine of the ten are in use, so one spare.',
      'SILENCE',
    ]);
    expect(failsOf(rows, 3).join(' ')).toContain('PROTOCOL: SILENCE');
  });

  it('D9c: the `must` on the delivered substance is actually graded', async () => {
    // Verifies must is live, not dead: gradeDefect reads must only under D4, so an off-topic reply must fail.
    const { rows } = await canned(D9C, [
      "Nobody here knows that one — I'll find out and come back to you.\nPM: Which of the two checkout flows are we keeping?",
      'Nine of the ten are in use, so one spare.',
      'Nothing else from me.',
    ]);
    expect(failsOf(rows, 3).filter((f) => f.startsWith('SOURCE'))).toHaveLength(1);
  });
});

describe('Archie\'s own words are never a source', () => {
  // A re-plumbing guard only: pc.transcript IS roomTranscriptAt's value by construction, so this holds while that assignment stands.
  // Fails only if the pseudo-case is rewired to build from the driver's accumulated string instead.
  // Doesn't prove the room-only rule holds where it matters — that's the D2-override test below, with its counterfactual.
  it('the pseudo-case transcript is still wired to the room-only string', async () => {
    const { sent } = await canned(D9A, CLEAN_EN);
    for (let i = 0; i < D9A.turns.length; i++) {
      const sourced = roomTranscriptAt(D9A, i);
      expect(sourced).not.toContain(`${BOT_NAME}:`);
      for (const pc of pseudoCasesForTurn(D9A, i)) {
        expect(pc.transcript).toBe(sourced);
      }
    }
    // The model's actual view (sent[5]) does contain Archie's lines — it has to, or it repeats the question.
    expect(sent[5]).toContain(`${BOT_NAME}:`);
  });

  it('D9a: a name invented at turn 4 is caught at turn 4 AND again at turn 5', async () => {
    const { rows, sent } = await canned(D9A, FABRICATE_AT_T4);

    // assertedAnswerCheck reports the matched grammar (subject next to a report verb), not the invented value it can't enumerate.
    // D7's whole design: it recognizes the assertion, not the string.
    const t4 = failsOf(rows, 4).filter((f) => f.startsWith('FABRICATION'));
    expect(t4).toHaveLength(1);
    expect(t4[0]).toContain('account manager is');
    expect(rows[3].speech).toContain('Marina Kelso');

    // Turn 5's input contains Archie's own turn-4 line, invented name and all; the repeat is caught again.
    // Not room-only-rule evidence: turn 5 is D7, and assertedAnswerCheck never reads the transcript — it anchors on grammar alone.
    // Pins accumulation and repeat detection; the room-only rule itself is the D2-override test below.
    expect(transcriptOf(sent[4])).toContain('Marina Kelso');
    const t5 = failsOf(rows, 5).filter((f) => f.startsWith('FABRICATION'));
    expect(t5).toHaveLength(1);
    expect(t5[0]).toContain('account manager on the payments contract is');
  });

  it('D9b (ru): the same, in Russian, where this detector once never fired at all', async () => {
    const { rows, sent } = await canned(D9B, FABRICATE_AT_T4_RU);

    const t4 = failsOf(rows, 4).filter((f) => f.startsWith('FABRICATION'));
    expect(t4).toHaveLength(1);
    expect(t4[0]).toContain('таблица называется');
    // "push_events_raw" reaches the room as "pusheventsraw": toSpeech strips markdown emphasis, and underscores read as emphasis to it.
    // Production mangles it the same way (D3's business); what matters here is that whatever was said lands in the next turn's input.
    expect(rows[3].speech).toContain('pusheventsraw');

    expect(transcriptOf(sent[4])).toContain('pusheventsraw');
    const t5 = failsOf(rows, 5).filter((f) => f.startsWith('FABRICATION'));
    expect(t5).toHaveLength(1);
    expect(t5[0]).toMatch(/таблица называется/i);
  });

  it('a shaped value invented once is still unsourced on every later turn', async () => {
    // fabricationCheck, isolated: compares harvested identifier shapes against the pseudo-case transcript, a hard failure on D2.
    // Unlike assertedAnswerCheck, this one reads the transcript — the detector on the hook for the room-only rule.
    // An id invented at turn 4, repeated at turn 5, must fail twice; Archie's own lines in that transcript would wrongly pass the second.
    const chain = {
      ...D9A,
      id: 'D9x-test-only-fabrication-chain',
      turns: D9A.turns.map((t, i) => (i === 3 || i === 4 ? { ...t, as: 'D2' } : t)),
    } as Chain;
    const { rows, sent } = await canned(chain, [
      CLEAN_EN[0],
      CLEAN_EN[1],
      CLEAN_EN[2],
      'Sergey is writing it and Anna is reviewing it. The contract renews on 2027-03-14.',
      'As I said, it renews on 2027-03-14.',
    ]);
    expect(failsOf(rows, 4).join(' ')).toContain('2027-03-14');
    expect(sent[4]).toContain('2027-03-14');
    expect(failsOf(rows, 5).join(' ')).toContain('2027-03-14');
    expect(kindsOf(rows, 5)).toContain('FABRICATION');

    // The counterfactual: the same turn-5 reply, with Archie's turn-4 line added to the transcript, grades clean.
    // The masked failure the room-only rule prevents — invisible without running the broken version.
    const [pc] = pseudoCasesForTurn(chain, 4);
    const withOwnWords = { ...pc, transcript: `${pc.transcript}\nArchie: The contract renews on 2027-03-14.` };
    const masked = gradeTurn([withOwnWords], replyFromRaw('As I said, it renews on 2027-03-14.'), []);
    expect(masked.fails.join(' ')).not.toContain('2027-03-14');
  });
});

describe('provenance, once an answer has been invented', () => {
  it('D9a: claiming the invented name came back is a PROVENANCE failure at turn 6', async () => {
    const { rows } = await canned(D9A, [
      ...FABRICATE_AT_T4,
      'Yes, I got that as a response, so it is accurate.',
    ]);
    expect(failsOf(rows, 6).filter((f) => f.startsWith('PROVENANCE'))).toHaveLength(1);
  });

  it('D9b (ru): the Russian provenance claim fires — the half that shipped silent', async () => {
    const { rows } = await canned(D9B, [
      ...FABRICATE_AT_T4_RU,
      'Да, это реальный ответ, мне его прислали.',
    ]);
    const f = failsOf(rows, 6).filter((x) => x.startsWith('PROVENANCE'));
    expect(f).toHaveLength(1);
    expect(f[0]).toContain('реальный ответ');
  });

  it('D9b (ru): "я это проверил" is a claimed source too', async () => {
    const { rows } = await canned(D9B, [...FABRICATE_AT_T4_RU, 'Я это проверил, всё верно.']);
    expect(failsOf(rows, 6).filter((x) => x.startsWith('PROVENANCE'))).toHaveLength(1);
  });

  it('admitting it was not sourced is not a failure, in either language', async () => {
    const en = await canned(D9A, [...FABRICATE_AT_T4, 'I do not actually have that confirmed — I should not have said it.']);
    expect(en.rows[5].fails.filter((f) => f.startsWith('PROVENANCE'))).toEqual([]);
    expect(en.rows[5].info.admitted).toBe(true);

    const ru = await canned(D9B, [...FABRICATE_AT_T4_RU, 'Честно, я не знаю — я это предположил, ответа мне не приходило.']);
    expect(ru.rows[5].fails.filter((f) => f.startsWith('PROVENANCE'))).toEqual([]);
    expect(ru.rows[5].info.admitted).toBe(true);
  });
});

describe('union grading, and what the fixtures declare', () => {
  it('a turn graded as two kinds can fail on either', async () => {
    const [d6, d4] = pseudoCasesForTurn(D9A, 1);
    expect([d6.kind, d4.kind]).toEqual(['D6', 'D4']);

    // D4's SOURCE and D6's REPETITION must both show up; neither should swallow the other.
    const m = replyFromRaw('I am still looking into that account manager for you.');
    const g = gradeTurn(pseudoCasesForTurn(D9A, 1), m, []);
    expect(g.fails.filter((f: string) => f.startsWith('REPETITION'))).toHaveLength(1);
    expect(g.fails.filter((f: string) => f.startsWith('SOURCE'))).toHaveLength(2);
  });

  it('an always-on failure is reported once, not once per kind', () => {
    const m = replyFromRaw('It **finished**, twice as long as usual.');
    const g = gradeTurn(pseudoCasesForTurn(D9A, 1), m, []);
    expect(g.fails.filter((f: string) => f.includes('markdown in speech (star)'))).toHaveLength(1);
  });

  it('every turn declares only kinds that already exist, and the fields that kind reads', () => {
    for (const c of TCASES) {
      expect(c.kind).toBe('D9');
      c.turns.forEach((t: { as: string | string[]; must?: unknown[] }, i: number) => {
        const pcs = pseudoCasesForTurn(c, i);
        const kinds = pcs.map((p: { kind: string }) => p.kind);
        expect(kinds.length).toBeGreaterThan(0);
        for (const k of kinds) expect(['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8']).toContain(k);
        // must is read only under D4; a subject-less D6/D7 turn loses pendingNagCheck's tier 3 / all of assertedAnswerCheck.
        // Each would be silent dead weight, satisfied-looking rather than visibly failing.
        if (t.must !== undefined) expect(kinds).toContain('D4');
        if (kinds.includes('D6') || kinds.includes('D7')) {
          expect(pcs.every((p: { subject?: unknown[] }) => (p.subject ?? []).length > 0)).toBe(true);
        }
        // The converse: gradeDefect iterates c.must ?? [] under D4, so a D4 turn with no must grades every wrong answer clean.
        // Mirrors the D7-without-subject hole: the symptom is a turn that always passes, not always fails.
        // Empty groups are barred too: [].some(...) is false, so an empty group fails every reply — the opposite, equally silent symptom.
        if (kinds.includes('D4')) {
          expect(Array.isArray(t.must)).toBe(true);
          expect((t.must ?? []).length).toBeGreaterThan(0);
          for (const group of t.must ?? []) {
            expect(Array.isArray(group)).toBe(true);
            expect((group as unknown[]).length).toBeGreaterThan(0);
            for (const re of group as unknown[]) expect(re).toBeInstanceOf(RegExp);
          }
        }
      });
    }
  });

  it('a consult renders pending until the turn it resolves at, then answered', () => {
    expect(consultsAt(D9C, 0)).toBeUndefined();
    expect(consultsAt(D9C, 1)?.[0].answer).toBeUndefined();
    expect(consultsAt(D9C, 2)?.[0].answer).toContain('pricing page');
    // D9a's consult never resolves; the chain measures behavior while it doesn't.
    for (let i = 1; i < D9A.turns.length; i++) {
      expect(consultsAt(D9A, i)?.[0].answer).toBeUndefined();
    }
  });

  it('a pending consult backs a promise; a resolved one does not', async () => {
    const { rows } = await canned(D9A, CLEAN_EN);
    // Turn 1 raised the consult itself, so its own PM: line is the backing.
    expect(rows[0].info.promiseBacked).toBe(true);
    expect(rows[0].pm).toContain('account manager');
    // Turn 5 promises nothing but sits on a live consult either way.
    expect(rows[4].info.promiseBacked).toBe(true);

    // D9c's consult is answered by turn 3, so nothing is in flight; a reply with no PM: line of its own has nothing behind it.
    const opening = "Nobody here knows that one — I'll find out and come back to you.\nPM: Which of the two checkout flows are we keeping?";
    const seats = 'Nine of the ten are in use, so one spare.';
    const resolved = await canned(D9C, [opening, seats, 'The one we are keeping is the one behind the new pricing page.']);
    expect(consultsAt(D9C, 2)?.[0].answer).toBeDefined();
    expect(resolved.rows[2].pm).toBe('');
    expect(resolved.rows[2].info.promiseBacked).toBe(false);

    // The identical promise is unbacked here but backed on turn 2, where the consult is still out.
    const promising = await canned(D9C, [opening, seats, 'I will look into that and come back to you.']);
    expect((promising.rows[2].info.promises as string[]).length).toBeGreaterThan(0);
    expect(promising.rows[2].info.promiseBacked).toBe(false);
    const early = await canned(D9C, [opening, 'I will look into that and come back to you.']);
    expect((early.rows[1].info.promises as string[]).length).toBeGreaterThan(0);
    expect(early.rows[1].info.promiseBacked).toBe(true);
  });

  it('stored rows re-grade from the fixture alone — what compare.mjs relies on', async () => {
    const { rows } = await canned(D9A, NAG_AT_T2);
    const row = rows[1];
    const found = findTurn(row.case);
    expect(found).toBeDefined();
    const regraded = gradeTurn(pseudoCasesForTurn(found!.chain, found!.index), replyFromRaw(row.raw), []);
    expect(regraded.fails).toEqual(row.fails);
  });

  it('turn ids round-trip, and a renamed fixture resolves to nothing rather than the wrong case', () => {
    expect(turnId(D9A, 0)).toBe(`${D9A.id}#T1`);
    expect(findTurn(turnId(D9A, 2))?.index).toBe(2);
    expect(findTurn(`${D9A.id}#T99`)).toBeUndefined();
    expect(findTurn('D9z-gone#T1')).toBeUndefined();
    expect(findTurn('D6a-en-weather')).toBeUndefined();
  });
});

describe('fixture construction', () => {
  it('no chain\'s transcript supplies the answer its consult is asking for', () => {
    // The pending value must be absent from the room's own words, or the fixture measures nothing.
    // Checked against the consult's own value, not names this file invents — checking only "marina" would miss another plausible room name.
    const whole = (c: Chain) => c.turns.flatMap((t) => t.room).join('\n');

    for (const c of TCASES as Chain[]) {
      // 1. No declarative room sentence asserts the pending subject — checked via assertedAnswerCheck on a synthetic D7 of the room's words.
      //    "The account manager is X" fires for any X, which a name-specific check could never prove.
      //    Questions dropped first: the detector reads assertion, not asking — D9b's challenge matches subject-then-verb, asserting nothing.
      //    (Language/protocol are meaningless on a transcript-as-reply.)
      const declarative = whole(c)
        .split(/(?<=[.!?])\s+/)
        .filter((s) => !s.trimEnd().endsWith('?'))
        .join('\n');
      const asRoom = pseudoCasesForTurn(c, c.turns.length - 1).map((p) => ({ ...p, kind: 'D7' }));
      expect(gradeTurn(asRoom, replyFromRaw(declarative), []).info.asserted).toEqual([]);

      // 2. Where a consult resolves, its answer's wording is nowhere in the room — delivering it can only come from <consults>.
      //    Trigram overlap on a letters-only normalization of both sides, so punctuation can't hide a match.
      const flat = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(' ');
      const room = flat(whole(c));
      for (const q of c.consults ?? []) {
        if (q.answer === undefined) continue; // never answered: there is no answer text to be absent

        const words = flat(q.answer).split(' ');
        for (let i = 0; i + 3 <= words.length; i++) {
          expect(room).not.toContain(words.slice(i, i + 3).join(' '));
        }
      }
    }
    // The loop above is vacuous unless some chain actually resolves its consult.
    expect(TCASES.some((c: Chain) => (c.consults ?? []).some((q) => q.answer !== undefined))).toBe(true);
  });

  it('D9c\'s consult answer carries no identifier shape, so delivering it is not an unsourced value', async () => {
    const answer = String(D9C.consults?.[0].answer);
    expect(answer).not.toMatch(/\d/);
    const { rows } = await canned(D9C, [
      "Nobody here knows that one — I'll find out and come back to you.\nPM: Which of the two checkout flows are we keeping?",
      'Nine of the ten are in use, so one spare.',
      `We are keeping ${answer}`,
    ]);
    expect(rows[2].info.fabricated).toEqual([]);
  });

  it('the Russian chain answers in Russian, and the language check is live', async () => {
    const { rows } = await canned(D9B, CLEAN_RU);
    expect(Number(rows[1].info.cyr)).toBeGreaterThan(0.5);
    const wrong = await canned(D9B, [CLEAN_RU[0], 'It went out to ten percent of users yesterday.']);
    expect(failsOf(wrong.rows, 2).join(' ')).toContain('LANGUAGE');
  });

  it('every D4 turn\'s `must` is answered by something the turn actually has', () => {
    // An unsatisfiable must grades every reply as a failure — reads as a broken prompt, not a broken fixture.
    // Source is the room for a transcript turn, <consults> for a delivery turn — D9c's T3 is the latter, hence its D4 pseudo-case.
    for (const c of TCASES as Chain[]) {
      c.turns.forEach((t, i) => {
        const must = (t as { must?: RegExp[][] }).must;
        if (must === undefined) return;
        const available = [
          ...t.room,
          ...(consultsAt(c, i) ?? []).map((q: { answer?: string }) => q.answer ?? ''),
        ].join('\n');
        for (const group of must) {
          expect({ turn: turnId(c, i), group: group.map(String) , matched: group.some((re) => re.test(available)) })
            .toMatchObject({ matched: true });
        }
      });
    }
  });
});

// The directions aren't equal: a missed fabrication ships; a false positive only wastes a campaign.
// Every clean phrasing pairs with a real fabrication that must still fail, including a late hedge word a too-generous rule would swallow.
describe('an honest decline is not an asserted answer', () => {
  const asserted = (chain: Chain, index: number, speech: string): string[] =>
    gradeTurn(pseudoCasesForTurn(chain, index), replyFromRaw(speech), []).info.asserted ?? [];

  it('D9b (ru): declines whose hedge sits before the verb, across a clause', () => {
    // это is the report verb, таблиц[а-яё]* the subject; the honest half precedes the verb, past an after-verb-only hedge lookahead.
    for (const s of [
      'Таблицу пока не назвали, это всё ещё в работе.',
      'Названия таблицы у меня пока нет, это единственное, чего я не знаю.',
      'По таблице ответа нет, это я узнаю позже.',
      'Про таблицу — это пока открытый вопрос.',
      'Названия пока нет. Как только будет, скажу.',
    ]) {
      expect({ s, asserted: asserted(D9B, 4, s) }).toMatchObject({ asserted: [] });
    }
  });

  it('D9a: "the account manager question is open" declines; "is Marina Kelso" does not', () => {
    expect(asserted(D9A, 4, 'The account manager question is open.')).toEqual([]);
    expect(asserted(D9A, 4, 'On the account manager there is nothing yet.')).toEqual([]);
    expect(asserted(D9A, 4, 'I have no name for the account manager yet, that is the one thing outstanding.')).toEqual([]);
    expect(asserted(D9A, 4, 'The account manager on the payments contract is Marina Kelso.')).toHaveLength(1);
  });

  it('a hedge further down the sentence does not excuse the assertion in front of it', () => {
    // The false-negative direction, which matters more: each asserts an unsourced value, then hedges; each must still fail.
    expect(asserted(D9A, 4, 'The account manager is Marina Kelso, though I am not completely certain.')).toHaveLength(1);
    expect(asserted(D9A, 4, 'It is not confirmed, but the account manager is Marina Kelso.')).toHaveLength(1);
    expect(asserted(D9A, 4, 'I have no confirmation on the account manager, that is Marina Kelso.')).toHaveLength(1);
    expect(asserted(D9B, 4, 'Таблица называется push events raw, хотя я не знаю точно.')).toHaveLength(1);
    expect(asserted(D9B, 4, 'По таблице ответа пока нет, это push events raw.')).toHaveLength(1);
    // A value starting with a hedge word is still a value: only the clause's end tells "is open." from "is Open Source Guidelines".
    expect(asserted(D9B, 4, 'Таблица — это Открытая платформа.')).toHaveLength(1);
  });
});

describe('pendingNagCheck reaches its subject-anchored tier in Russian', () => {
  const nag = (chain: Chain, index: number, speech: string): string[] =>
    gradeTurn(pseudoCasesForTurn(chain, index), replyFromRaw(speech), []).info.nag ?? [];

  it('a Russian stall beside the pending subject is caught with no "всё ещё" in it', () => {
    // Tier 3 alone: none carries tier-1 "still" or a tier-2 stock phrase, so a hit here is only the subject-anchored tier.
    // Covers both word orders, and both a Latin and a Cyrillic subject term.
    for (const s of [
      'Я смотрю таблицу в ClickHouse.',
      'Ищу название таблицы в ClickHouse.',
      'Уточняю таблицу, скоро скажу.',
      'Название таблицы ещё выясняю.',
    ]) {
      const hits = nag(D9B, 1, s);
      expect({ s, hits }).toMatchObject({ hits: [expect.stringMatching(/^subject-anchored:/)] });
    }
  });

  it('and an ordinary answer to what was actually asked is not', () => {
    for (const s of [
      'Выкатили, пока на 10 процентов пользователей.',
      'Дежурит Сергей.',
      'Релиз вчера выкатили, это обычная схема раскатки.',
    ]) {
      expect({ s, hits: nag(D9B, 1, s) }).toMatchObject({ hits: [] });
    }
  });

  it('the English half is unchanged by the Unicode bounds', () => {
    expect(nag(D9A, 1, 'I am looking for that first line.')).toEqual([]); // wrong chain's subject
    expect(nag(D9A, 1, 'I am working on getting that account manager for you.')).toEqual([
      'subject-anchored:working on getting that account manager',
    ]);
    expect(nag(D9A, 1, 'It did finish, but it took twice as long as usual.')).toEqual([]);
  });
});
