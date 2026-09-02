/**
 * Triage-gate case set — the third call production makes on a turn.
 *
 * prompts/voice-triage.md: `room` — the room already has the answer; `outside` — ask someone not here; `pending` — Archie already asked, no answer yet; `elsewhere` — small talk or unrecorded.
 *
 * Belongs here because the `room` verdict is the same judgement D4 grades on the speaking call, over the same context (both built by buildSpeakingUserMessage). The two degrade independently: a wrong `outside` sends Archie externally for something the room already said, unrecoverable by the speaking prompt.
 *
 * Twelve cases, both languages, length x verdict: long+room (6), long+outside (2), short+room (2), short+outside (2) — `outside` uses the same meeting (longTranscript(lang, 'absent')), so a gate that always says `room` can't score 100%. Short cases reuse D4/D5 by id: 3.4k tokens vs. 10k, itself the length control.
 *
 * `pending`/`elsewhere` are absent — neither depends on transcript length — and belong in a case set of their own.
 *
 * Five later cases measure the request, not the transcript: the capability pair (TGm/TGo), its over-reach twin (TGn/TGp), and the language case (TGq) — see each case's `what`.
 *
 * TGr/TGs are the only cases that send a `<consults>` block — see below for why.
 */
import { DCASES } from './dcases.mjs';
import { LONG, longTranscript } from './long-transcripts.mjs';
import { FIXED_CONTEXT } from './promptio.mjs';

function transcriptOf(id) {
  const c = DCASES.find((x) => x.id === id);
  if (c === undefined) throw new Error(`triage-cases: fixture renamed or removed: ${id}`);
  return c.transcript;
}

// `expect` is a string when the answer doesn't depend on the request, else a map keyed by arm — see the thrown messages for why a guessed arm isn't safe.
export function expectedFor(c, arm) {
  if (typeof c.expect === 'string') {
    return c.expect;
  } else if (arm === undefined) {
    throw new Error(
      `triage-cases: ${c.id} expects a different verdict per context arm ` +
      `(${Object.keys(c.expect).join(' / ')}) and was graded with no arm named. It is one transcript ` +
      `under two requests with two different right answers, so grading it against a guess would report ` +
      `the harness's choice as the gate's error.`,
    );
  } else if (arm in c.expect) {
    return c.expect[arm];
  } else {
    throw new Error(
      `triage-cases: ${c.id} declares no expectation for the "${arm}" arm — only ` +
      `${Object.keys(c.expect).join(', ')}. Add it, with the reason beside the transcript: a case whose ` +
      `right answer depends on the request has a different right answer under every arm, and there is ` +
      `no safe default to fall back to.`,
    );
  }
}

// `gradeTriage`'s answer check reads `answer` (must-shaped, like gradeDefect's) — a preamble containing it means the room hears the answer twice, forbidden by voice-triage.md. Capability cases use CAPABILITY_ANSWER below.
// Per case, not suite-wide: TGn/TGp's correct preamble restates the question, so a global ban would fail a good reply. TGk/TGl have no `answer` — D5a/D5b's value exists nowhere to ban.

// One group per capability in the pinned list, checked at load against FIXED_CONTEXT.capabilities — a reading of that list, so a rewrite fails loudly here rather than banning an obsolete phrase. See fromCapabilityList.
// Each group carries the English anchor and Russian rendering — a Russian preamble answers in Russian, and no English regex covers that.
// Bounded with (?<!\p{L})/(?!\p{L}) under `u`, never \b — same reason as elsewhere in this directory.
export const CAPABILITY_ANSWER = fromCapabilityList([
  [/(?<!\p{L})warehouse(?!\p{L})/iu, /(?<!\p{L})хранилищ[а-яё]*(?!\p{L})/iu],
  // `репозитори[а-яё]*` is kept beside `код[а-яё]*` — a Russian room could name this capability either way.
  [/(?<!\p{L})code(?!\p{L})/iu, /(?<!\p{L})код[а-яё]*(?!\p{L})/iu, /(?<!\p{L})репозитори[а-яё]*(?!\p{L})/iu],
  [/(?<!\p{L})crash(?:es)?(?!\p{L})/iu, /(?<!\p{L})краш[а-яё]*(?!\p{L})/iu],
  // Two Russian renderings — no reason to prefer either name.
  [/(?<!\p{L})admin panel(?!\p{L})/iu, /(?<!\p{L})админк[а-яё]*(?!\p{L})/iu, /(?<!\p{L})админ[- ]?панел[а-яё]*(?!\p{L})/iu],
  [/(?<!\p{L})(?:Jira|Notion|Figma)(?!\p{L})/iu],
]);

// Exported so the guard itself is testable, not just what it guards — a test asserting the declaration matches the list would pass even if this did nothing.
export function fromCapabilityList(groups) {
  for (const group of groups) {
    if (!group.some((re) => re.test(FIXED_CONTEXT.capabilities))) {
      throw new Error(
        `triage-cases: the capability-answer group ${group.map(String).join(' / ')} matches nothing in ` +
        `the pinned <capabilities> list. This declaration is a reading of that list rather than a list ` +
        `of its own, so a group that no longer matches it is banning a phrase the room can no longer be ` +
        `told — fix the group, or drop it with the line it was about.`,
      );
    }
  }
  return groups;
}

// Three lead-in lines shared by the pair and its twin, differing only in the last line — the basis of comparing them. Digit- and identifier-free, so nothing here reads as a supplied value.
const EN_CAPS_LEAD = [
  'Dmitry: Right, that is the release out of the way.',
  'Anna: Before everyone scatters — Archie has been sitting in these calls for a fortnight and I still do not know what to bring it.',
  'Sergey: Nor do I. I have been guessing.',
];
const EN_ASK_FOR_THE_LIST = 'Dmitry: Archie, what can you help us with?';
const EN_ASK_FOR_AN_ITEM = 'Dmitry: Archie, can you pull the crash numbers for last week?';

const RU_CAPS_LEAD = [
  'Дмитрий: Так, с релизом закончили.',
  'Анна: Пока не разбежались — Арчи уже которую неделю сидит на этих звонках, а я до сих пор не понимаю, с чем к нему приходить.',
  'Сергей: Я тоже. Просто угадываю.',
];
const RU_ASK_FOR_THE_LIST = 'Дмитрий: Арчи, чем ты можешь нам помочь?';
const RU_ASK_FOR_AN_ITEM = 'Дмитрий: Арчи, можешь достать цифры по крашам за прошлую неделю?';

// voice-triage.md bans naming anything internal in the preamble, including a consult's own id — sourced from the gate's own request, since consultsBlock renders every entry starting with it.
// TGr/TGs are the first cases to carry a `consults` block. Two properties keep it focused: the consult is answered, so `pending` (no preamble at all) can't happen; and it's about something else, so the question stays `outside` under both arms.
// No `answer`, same reason as TGn/TGp — nobody has the number, so the correct preamble restates the question; banning the question's own words would fail a good reply. Graded via internalIdLeakCheck (MACHINERY).
const EN_IDLEAK = [
  'Anna: Right, the nightly export went through on its own, so that is off the list.',
  'Dmitry: Good. Did anybody ever work out how many people are actually opening the new tab?',
  'Sergey: Not from me. Nobody has looked.',
  'Dmitry: Archie, can you find out how many people opened the new tab last week?',
].join('\n');

const RU_IDLEAK = [
  'Анна: Так, ночной экспорт прошёл сам, это больше не висит.',
  'Дмитрий: Хорошо. А кто-нибудь выяснил, сколько людей вообще открывает новую вкладку?',
  'Сергей: Не я. Никто не смотрел.',
  'Дмитрий: Арчи, можешь узнать, сколько людей открыло новую вкладку за прошлую неделю?',
].join('\n');

// `m2c1`, not `m1c1` — internalIdLeakCheck's first tier reads declared ids, its second knows production's shape; production's own example id would make the two indistinguishable. Otherwise digit- and identifier-free.
const ANSWERED_CONSULT_EN = [
  { id: 'm2c1', question: 'Did the nightly export go through?', answer: 'It went through, with nothing left in the queue.' },
];
const ANSWERED_CONSULT_RU = [
  { id: 'm2c1', question: 'Ночной экспорт прошёл?', answer: 'Прошёл, в очереди ничего не осталось.' },
];

// D5b's Russian room with D5a's English ask, built from the two fixtures — same meeting and question as TGl, only the address line's language changed. A grader keyed on room language, not address, would pass one and fail the other though both are correct.
function russianRoomAskedInEnglish() {
  const room = transcriptOf('D5b-ru-config-lookup').split('\n');
  const english = transcriptOf('D5a-en-config-lookup').split('\n');
  const speaker = room[room.length - 1].split(':')[0];
  const ask = english[english.length - 1].replace(/^[^:]*:\s*/, '');
  return [...room.slice(0, -1), `${speaker}: ${ask}`].join('\n');
}

// Each case: the transcript production would send, the verdict the prompt requires (string, or a map keyed by arm — see expectedFor), and report axes (`length`, `ru`).
// `ru` is the room's language only — it groups the placement table; the preamble's language is graded off the address (gradeTriage), not `ru`. TGq is where the two part company.
// `answer` is optional, for the preamble answer-check — see above.
export const TRIAGE_CASES = [
  {
    id: 'TGa-en-long-start-room',
    expect: 'room',
    length: 'long',
    ru: false,
    what: 'the answer is line 8 of 490 — an hour of meeting above the question',
    transcript: longTranscript('en', 'start'),
  },
  {
    id: 'TGb-en-long-mid-room',
    expect: 'room',
    length: 'long',
    ru: false,
    what: 'the same answer at 49% depth — the position with the measured prior for being lost',
    transcript: longTranscript('en', 'middle'),
  },
  {
    id: 'TGc-en-long-end-room',
    expect: 'room',
    length: 'long',
    ru: false,
    what: 'the same answer four lines above the question',
    transcript: longTranscript('en', 'end'),
  },
  {
    id: 'TGd-en-long-absent-outside',
    expect: 'outside',
    length: 'long',
    ru: false,
    what: 'the same 490-line meeting with the answer never said — the gate must not guess `room` from length alone',
    transcript: longTranscript('en', 'absent'),
    // Reused from the long fixture's `must`, not restated — triage.test.ts asserts neither group appears in this transcript.
    answer: LONG.en.must,
  },
  {
    id: 'TGe-ru-long-start-room',
    expect: 'room',
    length: 'long',
    ru: true,
    what: 'Russian: the answer is line 8 of 430',
    transcript: longTranscript('ru', 'start'),
  },
  {
    id: 'TGf-ru-long-mid-room',
    expect: 'room',
    length: 'long',
    ru: true,
    what: 'Russian: the same answer at 50% depth',
    transcript: longTranscript('ru', 'middle'),
  },
  {
    id: 'TGg-ru-long-end-room',
    expect: 'room',
    length: 'long',
    ru: true,
    what: 'Russian: the same answer ten lines above the question',
    transcript: longTranscript('ru', 'end'),
  },
  {
    id: 'TGh-ru-long-absent-outside',
    expect: 'outside',
    length: 'long',
    ru: true,
    what: 'Russian: the same meeting with the answer never said',
    transcript: longTranscript('ru', 'absent'),
    answer: LONG.ru.must,
  },

  // ---------------- the length control: the existing short fixtures ----------------
  {
    id: 'TGi-en-short-room',
    expect: 'room',
    length: 'short',
    ru: false,
    what: 'D4d-en-owner: the answer is two lines above the question, 3.4k tokens in total',
    transcript: transcriptOf('D4d-en-owner'),
  },
  {
    id: 'TGj-ru-short-room',
    // A length control by construction, and — Russian-only — a capability-list control by measurement: TGi, its English twin, is `room` in every stored full-arm row regardless, so an English check here shows nothing. Also needs `full`: without <capabilities>, this case is `room` regardless.
    expect: 'room',
    length: 'short',
    ru: true,
    what: 'D4a-ru-owner: the same, in Russian — and, under `full`, the case that moves when the arrangement paragraph re-describes the capability list',
    transcript: transcriptOf('D4a-ru-owner'),
  },
  {
    id: 'TGk-en-short-outside',
    expect: 'outside',
    length: 'short',
    ru: false,
    what: 'D5a-en-config-lookup: a config value nobody in the room has touched',
    transcript: transcriptOf('D5a-en-config-lookup'),
  },
  {
    id: 'TGl-ru-short-outside',
    expect: 'outside',
    length: 'short',
    ru: true,
    what: 'D5b-ru-config-lookup: the same, in Russian',
    transcript: transcriptOf('D5b-ru-config-lookup'),
  },

  // ---------------- the capability pair, its twin, and the language case ----------------
  {
    id: 'TGm-en-caps-pair',
    // The pair: with the list sent, what Archie can help with is in front of the gate; absent it, a question can still go outside this room (voice-triage.md allows `outside` with no list). Two requests, two right answers, one transcript.
    expect: { bare: 'outside', full: 'room' },
    length: 'short',
    ru: false,
    what: 'the real incident: asked what Archie can help with, with and without the <capabilities> list',
    transcript: [...EN_CAPS_LEAD, EN_ASK_FOR_THE_LIST].join('\n'),
    // The answer to *this* question is the list itself, so reading it out pre-delivers what the speaking call is about to say. Graded both ways: with the list sent, only beside a wrong `outside`; absent, it answers with nothing the request supplied.
    answer: CAPABILITY_ANSWER,
  },
  {
    id: 'TGn-en-caps-overreach-outside',
    // `expect` is a plain string because the answer doesn't move: with the list, this is one of the things ON it (fetch, don't recite); without, a question can still go out of this room. Both are `outside`, for different reasons — `room` under either arm is the over-reach this case exists to catch.
    expect: 'outside',
    length: 'short',
    ru: false,
    what: 'the over-reach guard: the same room and the same list, asked for one of the things ON the list',
    transcript: [...EN_CAPS_LEAD, EN_ASK_FOR_AN_ITEM].join('\n'),
    // No `answer`, deliberately — see the header on why per-case, not suite-wide.
  },
  {
    id: 'TGo-ru-caps-pair',
    expect: { bare: 'outside', full: 'room' },
    length: 'short',
    ru: true,
    what: 'Russian: the same pair — the Russian half of this suite has failed alone before',
    transcript: [...RU_CAPS_LEAD, RU_ASK_FOR_THE_LIST].join('\n'),
    answer: CAPABILITY_ANSWER,
  },
  {
    id: 'TGp-ru-caps-overreach-outside',
    expect: 'outside',
    length: 'short',
    ru: true,
    what: 'Russian: the over-reach guard, asked for one of the things on the list',
    transcript: [...RU_CAPS_LEAD, RU_ASK_FOR_AN_ITEM].join('\n'),
  },
  {
    id: 'TGq-ru-room-en-ask-outside',
    // Verdict is `outside` for D5's reason (an untouched config value); room and address language disagree, and a correct reply is an English preamble — which the old room-language rule failed.
    expect: 'outside',
    length: 'short',
    ru: true,
    what: 'a Russian room whose last line addresses Archie in English — the preamble must be English',
    transcript: russianRoomAskedInEnglish(),
  },

  // ---------------- the preamble against the id in its own request ----------------
  {
    id: 'TGr-en-idleak-outside',
    expect: 'outside',
    length: 'short',
    ru: false,
    what: 'a genuine lookup with an answered consult in the request — the preamble must name no id',
    transcript: EN_IDLEAK,
    consults: ANSWERED_CONSULT_EN,
  },
  {
    id: 'TGs-ru-idleak-outside',
    expect: 'outside',
    length: 'short',
    ru: true,
    what: 'Russian: the same, and the half of this suite that has failed alone before',
    transcript: RU_IDLEAK,
    consults: ANSWERED_CONSULT_RU,
  },
];
