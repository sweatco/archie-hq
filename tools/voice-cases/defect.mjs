// Defect driver + detectors. Writes results/defect-<arm>[-<context arm>]-<candidate>.json.
// CONTEXT_ARM controls how much of production's request each case sends — bare (default, byte-identical to every stored row), full, or full-noverdict. See context-arm.mjs.
// Detectors are mechanical and print what they flagged, so the rubric can be audited against raw text.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runCall } from './providers.mjs';
import { DCASES } from './dcases.mjs';
import { system, userMsg, promptPath } from './promptio.mjs';
import {
  CONTEXT_ARM_ENV, armContext, armFileTag, armVerdict, resolveContextArm, verdictTally,
} from './context-arm.mjs';
import { TAIL_MARKERS, stripThinkBlocks } from './emitter.mjs';
import { RETRY, minGapMs, poolSize, transportTally } from './pacing.mjs';
import { accountRows, printSampleReport } from './sampling.mjs';

const MD = [
  { name: 'star', re: /\*/ },
  { name: 'underscore-emph', re: /(^|\s)_[^_]+_(\s|$)/ },
  { name: 'backtick', re: /`/ },
  { name: 'heading', re: /^\s*#{1,6}\s/m },
  { name: 'bullet', re: /^\s*[-+•]\s+/m },
  { name: 'numbered-list', re: /^\s*\d+[.)]\s+/m },
  { name: 'table-pipe', re: /\|/ },
];

const HASH = /\b(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g;
const PATH = /\b[\w-]+(?:\/[\w.-]+)+\.\w{1,5}\b/g;
const URLISH = /\b(?:https?:\/\/)?[\w-]+(?:\.[\w-]+){2,}(?:\/[\w./-]*)?/g;
const TICKET = /\b[A-Z]{2,}-\d{2,}\b/g;
const SEMVER = /\b\d+\.\d+\.\d+\b/g;
const ERRCODE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const DOTTEDKEY = /\b[a-z][a-z0-9]*(?:[._][a-z0-9_]+){1,}\b/g;
const HEADERISH = /\b[A-Z][a-z]+(?:-[A-Z][a-z]+)+\b/g;
const ISODATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const CLOCK = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
const IDNUM = /\b(?:job|run|ticket|issue|build|migration|pr)\s*#?\s*\d{2,}\b/gi;
const MEASURE = /\b\d+(?:[.,]\d+)?\s?(?:ms|milliseconds?|секунд[а-я]*|seconds?|s\b|%|percent|процент[а-я]*|MB|GB|rps|qps|req\/s)(?!\p{L})/giu;
/** Durations inferred from a weekday are reasoning, not invention. */
const DURATION = /^\d+(?:[.,]\d+)?\s?(?:day|days|hour|hours|week|weeks|month|months|minute|minutes|дн[а-я]*|час[а-я]*|недел[а-я]*|минут[а-я]*)$/i;

const SHAPES = [
  ['hash', HASH], ['path', PATH], ['url', URLISH], ['ticket', TICKET],
  ['semver', SEMVER], ['errcode', ERRCODE], ['dotted-key', DOTTEDKEY],
  ['header-name', HEADERISH], ['iso-date', ISODATE], ['clock', CLOCK],
  ['id-number', IDNUM], ['measure', MEASURE],
];

/** Ordinary words that DOTTEDKEY/HEADERISH pick up; never identifiers. */
const NOISE = /^(?:i\.e|e\.g|etc|vs|p\.s|т\.е|т\.к|и\.о|no-one|non-|so-so|to-do|day-to-day|one-pager|one-pagers|first-failure|on-call|hand-off|read-up|rate-limit)$/i;

function harvest(text) {
  const found = [];
  for (const [kind, re] of SHAPES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const tok = m[0].trim();
      if (tok.length < 3) continue;
      if (NOISE.test(tok)) continue;
      // Words that merely contain a full stop at a sentence end.
      if (kind === 'dotted-key' && !/[._]/.test(tok.replace(/\.$/, ''))) continue;
      found.push({ kind, tok });
    }
  }
  return found;
}

export function exampleIdentifiers(promptText) {
  const blocks = [...promptText.matchAll(/```[\s\S]*?```/g)].map((m) => m[0]);
  const prose = promptText.replace(/```[\s\S]*?```/g, ' ');
  const ids = new Set();
  for (const b of blocks) {
    for (const { tok } of harvest(b)) {
      // Only if peculiar to the example, not ordinary prose.
      if (!prose.includes(tok)) ids.add(tok);
    }
    // Bare numeric ids the shape table misses; years excluded — every fabricated date has this shape too.
    for (const m of b.matchAll(/\b\d{3,}\b/g)) {
      if (!prose.includes(m[0]) && !/^(?:19|20)\d{2}$/.test(m[0])) ids.add(m[0]);
    }
  }
  return [...ids];
}

// Original example's ids, hard-coded so the "after" arm can prove they're gone once the prompt changes. Exported so a fixture test can catch leakCheck excusing one as a restatement.
export const LEGACY_IDS = ['0142', 'retention_policy.expires_at', 'retention_policy', 'expires_at', '88231', 'a3f91c4', 'migration 0142', 'job 88231'];

function leakCheck(raw, transcript, ids) {
  const hits = [];
  for (const id of ids) {
    if (raw.includes(id) && !transcript.includes(id)) hits.push(id);
  }
  return hits;
}

// Exported for context-arm.test.ts: run over the pinned standing context with an empty transcript, to prove it carries no relayable value. See FIXED_CONTEXT in promptio.mjs.
export function fabricationCheck(raw, transcript) {
  const hits = [];
  for (const { kind, tok } of harvest(raw)) {
    const bare = tok.replace(/[.,]$/, '');
    if (transcript.includes(bare)) continue;
    if (DURATION.test(bare)) continue;
    // A measurement whose digits are in the transcript is a restatement.
    const digits = bare.match(/\d+/g) ?? [];
    if (digits.length > 0 && digits.every((d) => transcript.includes(d))) continue;
    hits.push(`${kind}:${bare}`);
  }
  return [...new Set(hits)];
}

const SPEAKABLE_BAN = [
  ['hash', HASH], ['path', PATH], ['ticket', TICKET], ['semver', SEMVER],
  ['errcode', ERRCODE], ['url', URLISH],
];
function spokenDetailCheck(speech) {
  const hits = [];
  for (const [kind, re] of SPEAKABLE_BAN) {
    re.lastIndex = 0;
    for (const m of speech.matchAll(re)) {
      if (!NOISE.test(m[0])) hits.push(`${kind}:${m[0]}`);
    }
  }
  // A dotted filename such as build.gradle is unspeakable too.
  for (const m of speech.matchAll(/\b\w+\.(?:ts|js|tsx|py|rb|gradle|json|yml|yaml|kt|swift|md)\b/g)) hits.push(`filename:${m[0]}`);
  return [...new Set(hits)];
}

// D5: the room must never learn a PM/backend/apparatus is behind this voice (voice-speaking.md's PM: paragraph) — promising to find out is fine, naming who/what asks is not.
// Unambiguous strings ("project manager", "engineering team") match anywhere; ordinary words ("team", "backend") need a preceding seeking verb (SEEK_EN).
// Deliberately unflagged: "someone"/"a colleague" name no role or organisation, and would cost more false positives than they'd catch.
const SEEK_EN =
  '(?:check(?:ing)?|ask(?:ing|ed)?|consult(?:ing|ed)?|confirm(?:ing)?|verify(?:ing)?|' +
  'loop(?:ing)?\\s+in|reach(?:ing)?\\s+out(?:\\s+to)?|follow(?:ing)?\\s+up(?:\\s+with)?|' +
  'get(?:ting)?\\s+(?:an?\\s+)?(?:answer|word|confirmation)\\s+from|' +
  'pass(?:ing)?\\s+(?:this|that|it)\\s+(?:on|along)(?:\\s+to)?|send(?:ing)?\\s+(?:this|that|it)\\s+to)';

// A department only counts as a consult target after "with"/"in" — a plain transitive verb targets things as often as people.
const DEPT = '(?:back[- ]?end|engineering|infra(?:structure)?|platform|support|dev(?:elopment)?)';

const MACHINERY_EN = [
  ['project-manager', /\bproject\s+manager\b/i],
  ['pm-noun', /\b(?:the|our|my|a|that|this)\s+PM\b/],
  ['backend-team', /\bback[- ]?end\s+team\b/i],
  ['engineering-team', /\bengineering\s+team\b/i],
  ['dev-team', /\bdev(?:elopment)?\s+team\b/i],
  ['another-agent', /\b(?:another|a\s+different|the\s+other)\s+agent\b/i],
  ['system-behind-me', /\b(?:the\s+)?(?:system|A\.?I\.?|bot|model)\s+behind\s+(?:me|this|the\s+voice)\b/i],
  ['whoever-runs-me', /\bwhoever\s+(?:runs|manages|operates)\s+me\b/i],
  ['team-consulted', new RegExp(`\\b${SEEK_EN}\\b[^.?!\\n]{0,30}?\\b(?:the|my|our)\\s+team\\b`, 'i')],
  ['dept-consulted-with', new RegExp(`\\b(?:check|consult|confirm|verify)(?:ing)?\\s+with\\s+(?:(?:the|our|my)\\s+)?${DEPT}\\b`, 'i')],
  ['dept-consulted-loop-reach', new RegExp(`\\b(?:loop(?:ing)?\\s+in|reach(?:ing)?\\s+out\\s+to)\\s+(?:(?:the|our|my)\\s+)?${DEPT}\\b`, 'i')],
];

// Russian's free word order and conjugation rule out a short verb-anchored pattern like English's — this list uses unambiguous compounds instead.
// `\b` is ASCII-only, never bounding a Cyrillic letter — four dead detectors here came from that. Use `(?<!\p{L})/(?!\p{L})` under `/u` instead, in every Russian pattern below. Canonical; later occurrences point back here.
const MACHINERY_RU = [
  ['project-manager-ru', /менеджер[а-я]*\s+проект[а-я]*/i],
  ['pm-noun-ru', /(?<!\p{L})ПМ(?!\p{L})/u],
  ['backend-team-ru', /бэкенд[а-я-]*\s*команд[а-я]*|команд[а-я]*\s+бэкенд[а-я]*/i],
  ['dev-team-ru', /команд[а-я]*\s+разработ[а-я]*/i],
  ['engineering-team-ru', /инженерн[а-я]*\s+команд[а-я]*/i],
  ['another-agent-ru', /друг(?:ому|ой|ого)\s+агент[а-я]*/i],
  ['team-consulted-ru', /(?:спрошу|уточню|проверю|узнаю|свяжусь|обращусь)[^.?!\n]{0,20}?(?<!\p{L})у\s+(?:команды|коллег)(?!\p{L})/iu],
];

// Exported for context-arm.test.ts: proves the pinned standing context's `<written>` names no apparatus a model could echo and be wrongly failed for.
export function machineryLeakCheck(speech) {
  const hits = [];
  for (const [name, re] of [...MACHINERY_EN, ...MACHINERY_RU]) {
    const m = speech.match(re);
    if (m) hits.push(`${name}:${m[0].trim()}`);
  }
  return hits;
}

// Internal consult ids (`m<meeting>c<consult>`) are the class MACHINERY_EN/RU miss — consultsBlock renders every <consults> entry starting with one, unstripped.
// Two tiers: (1) the row's own `consults` id, matched literally (covers a renamed id); (2) production's `m<digits>c<digits>` shape as backstop.
// Bounded with (?<![\p{L}\p{N}])/(?![\p{L}\p{N}]), never \b: ASCII, so \b would mostly work — but fails the opposite way from MACHINERY_RU, wrongly splitting a Cyrillic-adjacent id ("вm1c1"). The Unicode bound doesn't.
// triage.test.ts reads this constant's source directly and asserts it stays \p{L}-bounded — do not revert to \b or \w.
const CONSULT_ID_SHAPE = /(?<![\p{L}\p{N}])m\d{1,4}c\d{1,4}(?![\p{L}\p{N}])/giu;

// `consult-id:` when a row declared the id, `id-shape:` when only the shape caught it — never both, so a single slip is reported once.
export function internalIdLeakCheck(speech, consults) {
  const hits = [];
  const seen = new Set();
  for (const { id } of consults ?? []) {
    const literal = String(id ?? '').trim();
    if (literal.length === 0) continue;
    const quoted = literal.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
    const m = speech.match(new RegExp(`(?<![\\p{L}\\p{N}])${quoted}(?![\\p{L}\\p{N}])`, 'iu'));
    if (m) {
      seen.add(m[0].toLowerCase());
      hits.push(`consult-id:${m[0]}`);
    }
  }
  CONSULT_ID_SHAPE.lastIndex = 0;
  for (const m of speech.matchAll(CONSULT_ID_SHAPE)) {
    if (!seen.has(m[0].toLowerCase())) {
      seen.add(m[0].toLowerCase());
      hits.push(`id-shape:${m[0]}`);
    }
  }
  return hits;
}

// D6: once a PM: consult is outstanding, one acknowledgement (scripted, never graded) is correct; re-announcing it later, unprompted, is the defect.
// Three tiers: (1) "still" + a seeking verb; (2) stall phrases (STALL_GENERIC_EN/RU); (3) `subject` near a softer seeking verb (SOFT_SEEK), no "still" needed.
// Accepted false negative: a nag with none of these verbs and no repeated subject ("just so you know, that's still in progress") slips past tier 3's anchor.
const SEEKING_VERB =
  '(?:look(?:ing)?(?:\\s+(?:into|for))?|check(?:ing)?|work(?:ing)?\\s+on|try(?:ing)?\\s+to\\s+(?:find|get|look\\s+up)|wait(?:ing)?(?:\\s+(?:on|for))?|get(?:ting)?|dig(?:ging)?(?:\\s+into)?|hear(?:ing)?\\s+back|chas(?:e|ing)\\s+down)';
const STILL_PURSUING = new RegExp(`\\bstill\\s+${SEEKING_VERB}\\b`, 'i');
// Every entry needs a `-ru` counterpart, or it passes in one language on a defect the other fails (pending-nag.test.ts). `still-on-it-ru` is the exception — tier 1's STILL_PURSUING.
export const STALL_GENERIC_EN = [
  ['no-update-yet', /\bno\s+(?:update|word|answer|news)\b/i],
  ['havent-heard-back', /\bhaven'?t\s+heard\s+(?:back|anything)\b/i],
  ['give-me-another-moment', /\bgive\s+me\s+(?:a|another)\s+(?:moment|minute|second)\b/i],
  ['nothing-back-yet', /\bnothing\s+back\b/i],
  ['ill-let-you-know-when', /\b(?:i'?ll|i\s+will)\s+(?:let\s+you\s+know|update\s+you|circle\s+back|come\s+back\s+to\s+you)\s+(?:as\s+soon\s+as|once|when)\b/i],
];
// Russian counterpart of `ill-let-you-know-when`: both halves' order varies in Russian (English fixes one) — two alternations, as in pendingNagCheck's verbThenSubj/subjThenVerb.
// NAG_NOTIFY_RU includes скажу, though PROMISE_RU_VERB excludes it ("скажу честно" is a discourse marker) — safe here, paired with a required temporal-arrival clause.
// Arrival half splits: NAG_ARRIVAL_INFO_RU (obtaining-answer verbs, anywhere), NAG_ARRIVAL_APPEAR_RU (auxiliaries "будет"/"придёт", clause-final or before an answer noun only).
// The subordinator's trailing (?!\p{L}) matters: bare "как" is a prefix of "какая"/"какой"/"какие", which would otherwise match as an arrival verb.
// Checked must-not-fire against honest declines and delivered answers in pending-nag.test.ts.
// Left uncaught: a trailing bare subordinator ("вернусь с ответом, когда") — catching it needs "когда" alone as arrival, firing on "не помню когда."
const NAG_NOTIFY_RU =
  '(?:скажу|сообщу|расскажу|отвечу|отпишусь|напишу|доложу|поделюсь|озвучу|' +
  'дам\\s+знать|вернусь(?:\\s+с\\s+ответом)?)';
const NAG_ARRIVAL_INFO_RU =
  '(?:получу|получим|узнаю|узнаем|разузнаю|выясню|уточню|проверю|услышу|увижу|разберусь|' +
  'ответят|сообщат|скажут|напишут|пришлют|станет\\s+(?:известно|ясно)|прояснится)';
const NAG_ANSWER_NOUN_RU = '(?:ответ|информаци|новост|название|данны|результат|цифр)';
const NAG_ARRIVAL_APPEAR_RU =
  '(?:буд(?:ет|ут)|появ(?:ится|ятся)|при(?:дёт|дет|дут)|дой(?:дёт|дет)|смогу)' +
  `(?=\\s*(?:[,.;:!?—–…]|$)|\\s+${NAG_ANSWER_NOUN_RU})`;
// Spelled out per gender/number, not stemmed (`\w*` is ASCII-only — `получил\w*` misses the Cyrillic suffixes). Shared by both word orders in havent-heard-back-ru.
const NAG_NOT_ARRIVED_RU =
  '(?:пришёл|пришел|пришл[оаи]|получил(?:а|и|о)?|получен[оаы]?|поступил[аио]?)';
const NAG_WHEN_RU =
  '(?:как\\s+только|когда|как|едва|лишь)(?!\\p{L})[^.?!\\n]{0,12}?' +
  `(?<!\\p{L})(?:${NAG_ARRIVAL_INFO_RU}|${NAG_ARRIVAL_APPEAR_RU})`;

export const STALL_GENERIC_RU = [
  ['no-update-yet-ru', /пока\s+нет\s+(?:ответа|новостей|информации)/i],
  ['still-on-it-ru', /вс[её]\s+ещ[её]\s+(?:смотрю|разбираюсь|ищу|жду|уточняю|выясняю)/i],
  // Both word orders (noun-first is real: "Ответ ещё не пришёл"). Uses NAG_NOT_ARRIVED_RU's spelled-out suffixes, not \w* (same reason).
  ['havent-heard-back-ru', new RegExp(
    `(?<!\\p{L})(?:ответ[а-яё]*\\s+(?:ещ[её]|пока)\\s+не\\s+${NAG_NOT_ARRIVED_RU}` +
    `|(?:ещ[её]|пока)\\s+не\\s+${NAG_NOT_ARRIVED_RU}\\s+ответ[а-яё]*)(?!\\p{L})`, 'iu')],
  // Narrow like their English twins: imperative required, arrival verbs only. unbackedPromiseCheck's near-identical patterns are advisory; these are graded.
  ['give-me-another-moment-ru', /(?<!\p{L})(?:дай|дайте)\s+(?:мне\s+)?(?:ещ[её]\s+)?(?:минут|секунд|момент|пару\s+минут)[а-яё]*(?!\p{L})/iu],
  ['nothing-back-yet-ru', /(?<!\p{L})ничего\s+(?:пока\s+|ещ[её]\s+)?не\s+(?:пришл[оаи]|приходил[оаи]?|поступил[оаи]?|поступал[оаи]?)(?!\p{L})/iu],
  ['ill-let-you-know-when-ru', new RegExp(
    `(?<!\\p{L})(?:${NAG_WHEN_RU}[^.?!\\n]{0,40}?(?<!\\p{L})${NAG_NOTIFY_RU}(?!\\p{L})` +
    `|${NAG_NOTIFY_RU}(?!\\p{L})[^.?!\\n]{0,20}?(?<!\\p{L})${NAG_WHEN_RU})`, 'iu')],
];

// Tier 3's anchor verbs. Was broken in Russian: no Russian verb was listed, and the bound was \b — same fix as MACHINERY_RU (\p{L}, not \b).
// Delivery verbs (пришлю, "I'll send") are deliberately absent, as in unbackedPromiseCheck's list — an accepted false negative.
const SOFT_SEEK =
  '(?:check(?:ing)?|look(?:ing)?|work(?:ing)?\\s+on|dig(?:ging)?(?:\\s+into)?|try(?:ing)?\\s+to\\s+(?:find|get)|' +
  'chas(?:e|ing)\\s+down|' +
  'смотрю|посмотрю|гляну|глянуть|ищу|поищу|искать|уточняю|уточнить|уточню|выясняю|выяснить|выясню|' +
  'узнаю|узнать|жду|ожидаю|подожду|проверяю|проверить|проверю|разбираюсь|разобраться|копаю(?:сь)?|' +
  'спрашиваю|спрошу|запрашиваю|запросил[а-яё]*)';

function pendingNagCheck(speech, subjectTerms = []) {
  const hits = [];
  const m1 = speech.match(STILL_PURSUING);
  if (m1) hits.push(`still-pursuing:${m1[0].trim()}`);
  for (const [name, re] of [...STALL_GENERIC_EN, ...STALL_GENERIC_RU]) {
    const m = speech.match(re);
    if (m) hits.push(`${name}:${m[0].trim()}`);
  }
  if (subjectTerms.length > 0 && subjectTerms.some((re) => re.test(speech))) {
    const subj = subjectTerms.map((re) => re.source).join('|');
    const verbThenSubj = new RegExp(`(?<!\\p{L})${SOFT_SEEK}(?!\\p{L})[^.?!\\n]{0,25}?(?<!\\p{L})(?:${subj})(?!\\p{L})`, 'iu');
    const subjThenVerb = new RegExp(`(?<!\\p{L})(?:${subj})(?!\\p{L})[^.?!\\n]{0,25}?(?<!\\p{L})${SOFT_SEEK}(?!\\p{L})`, 'iu');
    const m = speech.match(verbThenSubj) ?? speech.match(subjThenVerb);
    if (m) hits.push(`subject-anchored:${m[0].trim()}`);
  }
  return [...new Set(hits)];
}

// D7: fabricationCheck only catches shaped values; open prose has none. Anchors on the grammatical act instead: `subject` near REPORT_VERB, or a quoted string.
// Two exclusions guard an honest decline: HEDGE_AFTER_VERB (right after the verb), DECLINED_CLAUSE_BEFORE (a preceding clause). "isn't" reaches neither too.
// DECLINE_EN/RU ("plainly declined") is advisory: honest declines outnumber false-assertion phrasings, so an unanticipated paraphrase shouldn't grade as invention.
// `subj`/REPORT_VERB are bounded with (?<!\p{L})/(?!\p{L}), not \b — same fix as MACHINERY_RU.
const REPORT_VERB =
  '(?:is|reads|says|goes|starts?\\s+with|begins?\\s+with|opens?\\s+with|titled|called|named|написано|гласит|говорит(?:ся)?|звучит|называ(?:ется|лась)|это)';
// The hedge a correct reply puts right after the report verb — where honest declines put it too.
// The clause-final group ("open", "nothing", ...) bounds by punctuation/end-of-string, not \b — these words can also open a fabricated value.
// `still` is a known accepted hole ("the account manager is still Marina Kelso" wrongly passes) — narrowing it now would newly fail currently-passing replies.
const HEDGE_AFTER_VERB =
  '(?:not\\b|n\'?t\\b|unclear|unknown|still\\b|being\\s+looked|what\\s+i\\b|something\\s+i\\b|неизвестн' +
  '|(?:open|pending|outstanding|missing|unconfirmed|nothing|none)(?=\\s*(?:[.,;:!?—–]|$))' +
  '|an?\\s+open\\s+(?:question|item|one)\\b|nothing\\s+(?:yet|back|so\\s+far)\\b' +
  '|пока(?!\\p{L})|нет(?!\\p{L})|неясн|вс[её]\\s+ещ[её]|откры[а-яё]*\\s+вопрос|в\\s+работе' +
  '|я\\s+(?:узнаю|выясню|уточню|спрошу|проверю)(?!\\p{L}))';

// Second exclusion: a report verb opening a clause right after a declined one is commentary, not assertion — the honest half sits before the verb, past HEDGE_AFTER_VERB's reach.
// Both required: before-clause alone excuses "По таблице ответа пока нет, это push_events_raw"; after-clause alone excuses "the account manager is Marina Kelso, though not certain".
const DECLINE_AT_CLAUSE_END =
  '(?:(?<!\\p{L})(?:нет|неизвестно|неясно)(?!\\p{L})|\\bno\\b|\\bnot\\b|n\'?t\\b|\\byet\\b|\\bunknown\\b|\\bunclear\\b)';
const CLAUSE_PRONOUN = '(?:(?:that|it|this|то|оно)\\s+)?';
const HEDGE_IN_TAIL =
  '(?:not\\b|n\'?t\\b|\\bno\\b|nothing|unknown|unclear|still\\b|open\\b|pending\\b|outstanding\\b|\\byet\\b' +
  '|don\'?t\\s+know|the\\s+one\\s+thing|all\\s+i\\s+(?:have|can)' +
  '|(?<!\\p{L})не\\s+(?:знаю|пришл|сказал|назвал|дал)|(?<!\\p{L})нет(?!\\p{L})|пока(?!\\p{L})|вс[её]\\s+ещ[её]' +
  '|вс[её](?!\\p{L})|единственн|неизвестн|неясн|в\\s+работе|откры|(?:узнаю|выясню|уточню)(?!\\p{L}))';
/** ¬(declined clause behind ∧ hedge ahead) — succeeds when either
 *  zero-width assertion in the pair does not hold. */
const DECLINED_CLAUSE_BEFORE =
  `(?:(?<!${DECLINE_AT_CLAUSE_END}\\s*[,;:—–]\\s{0,3}${CLAUSE_PRONOUN}${REPORT_VERB})` +
  `|(?![^.?!\\n]{0,80}?${HEDGE_IN_TAIL}))`;

function assertedAnswerCheck(speech, subjectTerms = []) {
  if (subjectTerms.length === 0) return [];
  const subj = subjectTerms.map((re) => re.source).join('|');
  const hits = [];
  const verbAfter = new RegExp(
    `(?<!\\p{L})(?:${subj})(?!\\p{L})[^.?!\\n]{0,40}?(?<!\\p{L})${REPORT_VERB}(?!\\p{L})` +
      `(?!\\s*${HEDGE_AFTER_VERB})${DECLINED_CLAUSE_BEFORE}`,
    'iu'
  );
  const m1 = speech.match(verbAfter);
  if (m1) hits.push(m1[0].trim());
  const quoted = new RegExp(
    `(?<!\\p{L})(?:${subj})(?!\\p{L})[^.?!\\n]{0,20}?[:\\-—]?\\s*["“«][^"”»]{2,80}["”»]`,
    'iu'
  );
  const m2 = speech.match(quoted);
  if (m2) hits.push(m2[0].trim());
  return [...new Set(hits)];
}

const DECLINE_EN =
  /\b(?:don'?t|do\s+not)\s+(?:actually\s+)?have\s+(?:that|it|an?\s+answer)\b|\bhaven'?t\s+(?:heard|got(?:ten)?)\s+(?:back|anything)\b|\bno\s+(?:answer|word|update)\s+(?:yet|back)?\b|\bstill\s+(?:don'?t|do\s+not)\s+(?:have|know)\b|\bcan'?t\s+confirm\s+(?:that|it)\s+yet\b|\bnot\s+(?:yet\s+)?confirmed\b/i;
const DECLINE_RU =
  /пока\s+нет\s+ответа|ещ[её]\s+не\s+(?:пришёл|пришел|получил\w*)|не\s+могу\s+подтвердить|не\s+подтверждено|честно,?\s+не\s+знаю/i;

// D8: room asks whether an earlier answer was real or invented. Honest: "I don't have that confirmed" / "I guessed". Dishonest: claiming it was sourced.
// PROVENANCE_ADMIT_EN/RU (the "admitted" side) is advisory, like D7's DECLINE_EN/RU — many honest phrasings exist, few false-vouching ones.
const PROVENANCE_CLAIM_EN = [
  ['got-it-as-response', /\b(?:i\s+)?got\s+(?:it|that)\s+as\s+(?:an?\s+)?(?:response|answer)\b/i],
  ['came-from-source', /\b(?:it|that)\s+(?:came|comes)\s+(?:back\s+)?from\s+(?:the\s+)?(?:readme|lookup|source|file|repo)\b/i],
  ['confirmed-it', /\bi\s+(?:confirmed|verified|checked)\s+(?:it|that)\b(?!\s*(?:is\s+not|isn'?t|n'?t))/i],
  ['thats-what-it-said', /\bthat'?s\s+what\s+(?:it|the\s+(?:readme|file|lookup))\s+(?:said|says|returned)\b/i],
  ['looked-it-up-and', /\bi\s+(?:did\s+)?look(?:ed)?\s+(?:it|that)\s+up\b(?!\s*,?\s*but)/i],
  ['yes-its-real', /\byes,?\s+(?:it'?s|that'?s)\s+(?:real|accurate|correct)\b/i],
];
// `[а-я]*`, not `\w*` (ASCII-only, would never reach "реальный"/"реальная"); \p{L} bounds around "я", not \b — same fix as MACHINERY_RU.
const PROVENANCE_CLAIM_RU = [
  ['real-answer-ru', /(?:да,?\s+)?(?:это|он)\s+(?:реальн[а-я]*|настоящ[а-я]*)\s+ответ/i],
  ['got-it-as-response-ru', /получил[а-я]*\s+(?:это\s+)?как\s+ответ/i],
  ['confirmed-it-ru', /(?<!\p{L})я\s+(?:это\s+)?(?:проверил|подтвердил)[а-я]*(?!\p{L})(?!\s*,?\s*но)/iu],
  ['came-from-source-ru', /пришл[а-я]*\s+(?:мне\s+)?(?:из|от)\s+(?:readme|файла|поиска)/i],
];
const PROVENANCE_ADMIT_EN =
  /\bi\s+(?:don'?t|do\s+not)\s+(?:actually\s+)?have\s+(?:that|it)\s+confirmed\b|\bi\s+guessed\b|\bmade\s+(?:that|it)\s+up\b|\bwasn'?t\s+(?:actually\s+)?confirmed\b|\bi\s+assumed\b|\bhonestly,?\s+i\s+(?:don'?t|do\s+not)\s+know\b/i;
const PROVENANCE_ADMIT_RU =
  /я\s+придумал\w*|не\s+(?:успел\w*\s+)?подтверд\w*|честно,?\s+я\s+не\s+знаю|это\s+не\s+подтверждено|я\s+предположил\w*/i;

function provenanceClaimCheck(speech) {
  const hits = [];
  for (const [name, re] of [...PROVENANCE_CLAIM_EN, ...PROVENANCE_CLAIM_RU]) {
    const m = speech.match(re);
    if (m) hits.push(`${name}:${m[0].trim()}`);
  }
  return [...new Set(hits)];
}

// A promise with nothing behind it: without a trailing PM: line, "I'll find out" commits to nothing — the same invention as a fabricated value, uncaught elsewhere.
// Recognises only the promise — whether anything backs it is gradeDefect's `promiseBacked` question, not this function's.
// Anchors on the grammatical act: (1) future auxiliary/"let me" + closed filler list + seeking verb; (2) self-contained commitment ("get back to you", "let you know"); (3) time request (pendingNagCheck stall too).
// Excludes delivery verbs (put/drop/send/скину/пришлю/…) — delivering isn't promising to find out — and "I can", since "I can confirm X" asserts the already-known.
// Cyrillic bound with \p{L}, not \b — same fix as MACHINERY_RU; the trailing bound also stops "гляну"/"найду" (prefixes of "глянуть"/"найдут") matching as truncated stems.
const PROMISE_AUX_EN = "(?:i'?ll|i\\s+will|i'?m\\s+going\\s+to|i\\s+am\\s+going\\s+to|let\\s+me|lemme)";
const PROMISE_NOT_NEGATED_EN = '(?!\\s+(?:not|never)(?!\\p{L}))';
// Closed filler list, max four words: nothing that could start a clause about somebody else ("you", "should", "want") belongs in it.
const PROMISE_FILLER_EN =
  '(?:\\s+(?:just|quickly|quick|go|and|then|now|also|actually|briefly|first|try|to|see|whether|if|i|can|double|soon|shortly|really))';
const SEEK_PROMISE_EN =
  '(?:check(?:\\s+on)?|double[ -]check|look(?:\\s+(?:into|at|up|for))?|take\\s+a\\s+look|have\\s+a\\s+look|' +
  'pull\\s+(?:it|that|this|them)\\s+up|pull\\s+up|find(?:\\s+(?:out|it\\s+out|that\\s+out))?|' +
  'figure\\s+(?:it|that)\\s+out|work\\s+(?:it|that)\\s+out|sort\\s+(?:it|that)\\s+out|' +
  'see\\s+what\\s+i\\s+can\\s+(?:find|do|dig\\s+up)|' +
  'dig(?:\\s+into)?|confirm|verify|ask(?:\\s+(?:around|about))?|chase\\s+(?:it|that)\\s+down|' +
  'track\\s+(?:it|that)\\s+down|run\\s+(?:it|that)\\s+down|get\\s+(?:you\\s+)?(?:the|an)\\s+answer|' +
  'have\\s+(?:the|an)\\s+answer|get\\s+that\\s+for\\s+you|review|follow\\s+up(?:\\s+(?:on|with))?|' +
  'keep\\s+you\\s+(?:posted|updated|in\\s+the\\s+loop)|update\\s+you)';

// 1sg forms spelled out, not stemmed (`провер[а-я]*` swallows "проверить"). Absent: "отвечу" (postpones as often as answers), "скажу" (discourse marker), delivery verbs.
const PROMISE_RU_VERB =
  '(?:посмотрю|погляжу|гляну|взгляну|проверю|перепроверю|уточню|узнаю|разузнаю|выясню|найду|поищу|' +
  'спрошу|поспрашиваю|разберусь|покопаюсь|вернусь|сообщу|отпишусь|подтвержу|постараюсь|займусь|' +
  'дам\\s+знать)';

const PROMISE_PATTERNS = [
  ['future-commitment', new RegExp(
    `(?<!\\p{L})${PROMISE_AUX_EN}${PROMISE_NOT_NEGATED_EN}${PROMISE_FILLER_EN}{0,4}\\s+${SEEK_PROMISE_EN}(?!\\p{L})`,
    'iu')],
  ['come-back-to-you', new RegExp(
    "(?<!\\p{L})(?:i'?ll|i\\s+will|i\\s+can|and|then|,)\\s*(?:i'?ll\\s+|i\\s+will\\s+)?" +
    '(?:get|come|be|circle|report)\\s+back(?:\\s+(?:to\\s+you|with))?(?!\\p{L})', 'iu')],
  ['let-you-know', new RegExp(
    "(?<!\\p{L})(?:i'?ll|i\\s+will|i\\s+can|and|then|,)\\s*(?:i'?ll\\s+|i\\s+will\\s+)?" +
    'let\\s+you\\s+know(?!\\p{L})', 'iu')],
  // "one minute" alone is excluded from the bare time-request tier — also an ordinary duration ("the job takes one minute"). "give me a minute" is kept.
  ['give-me-time', /(?<!\p{L})(?:give\s+me|gimme)\s+(?:just\s+)?(?:a|one|another)?\s*(?:second|sec|minute|min|moment)(?!\p{L})/iu],
  ['one-moment', /(?<!\p{L})(?:just\s+a|one)\s+(?:moment|sec|second)(?!\p{L})/iu],
  ['bear-with-me', /(?<!\p{L})bear\s+with\s+me(?!\p{L})/iu],
  ['future-commitment-ru', new RegExp(`(?<!\\p{L})(?<!не\\s)${PROMISE_RU_VERB}(?!\\p{L})`, 'iu')],
  ['future-compound-ru', /(?<!\p{L})(?<!не\s)буду\s+(?:проверять|смотреть|искать|уточнять|выяснять|разбираться|держать\s+(?:тебя\s+|вас\s+)?в\s+курсе)(?!\p{L})/iu],
  ['give-me-time-ru', /(?<!\p{L})(?:дай|дайте)\s+(?:мне\s+)?(?:минут|секунд|момент|пару\s+минут)[а-яё]*(?!\p{L})/iu],
  ['one-moment-ru', /(?<!\p{L})(?:одну\s+)?(?:минутку|секундочку)(?!\p{L})/iu],
];

export function unbackedPromiseCheck(speech) {
  const hits = [];
  for (const [name, re] of PROMISE_PATTERNS) {
    const m = speech.match(re);
    if (m) hits.push(`${name}:${m[0].trim()}`);
  }
  return [...new Set(hits)];
}

function cyr(s) {
  const L = s.match(/\p{L}/gu) ?? [];
  return L.length === 0 ? 0 : (s.match(/[Ѐ-ӿ]/g) ?? []).length / L.length;
}

export function gradeDefect(c, m, ids) {
  const raw = m.text;
  const p = m.parsed;
  const silent = p.silent === true;
  const speech = silent ? '' : p.speech;
  const chat = silent ? '' : (p.chat ?? '');
  const fails = [];
  const info = {};

  if (silent) fails.push('PROTOCOL: SILENCE while somebody was waiting');
  if (p.chatOnly) fails.push('PROTOCOL: CHAT: line with nothing spoken');
  if (m.thinkingLeak) fails.push('PROTOCOL: thinking tags leaked');
  if (m.regionShrank) fails.push('PROTOCOL: speech region shrank');
  if (!silent) {
    // Think blocks removed first, as parseReply does it: a reasoning trace isn't the room's problem and must never be graded as if spoken.
    const { visible } = stripThinkBlocks(raw, true);
    const lines = visible.split(/\r?\n/);
    // Either tail marker ends the spoken region, so a PM: line is never scanned as spoken even when the reply never posts to chat.
    const marker = lines.findIndex((l) => {
      const t = l.trimStart();
      return TAIL_MARKERS.some((mk) => t.startsWith(mk));
    });
    const spokenRaw = (marker === -1 ? lines : lines.slice(0, marker)).join('\n');
    for (const md of MD) if (md.re.test(spokenRaw)) fails.push(`PROTOCOL: markdown in speech (${md.name})`);
  }

  // Leakage of the prompt's own example is checked on every case, not just D1.
  const leaks = leakCheck(raw, c.transcript, [...new Set([...ids, ...LEGACY_IDS])]);
  info.leaks = leaks;
  if (leaks.length) fails.push(`CONTAMINATION: example identifiers presented as fact — ${leaks.join(', ')}`);

  if (c.kind === 'D2') {
    const fab = fabricationCheck(raw, c.transcript);
    info.fabricated = fab;
    if (fab.length) fails.push(`FABRICATION: values absent from the transcript — ${fab.join(', ')}`);
  } else {
    info.fabricated = fabricationCheck(raw, c.transcript); // advisory
  }

  // promiseBacked is true for a PM: line on this reply, or a consult already in flight — covering D6/D7/D8, where <consults> holds a genuinely outstanding question.
  // Hard failure on D2 only, informational elsewhere: 180 stored rows per arm were graded under the existing definitions; widening it now would invalidate them.
  const promises = unbackedPromiseCheck(speech);
  const consultInFlight = (c.consults ?? []).some((q) => String(q.answer ?? '').trim() === '');
  const promiseBacked = (typeof p.pm === 'string' && p.pm.trim().length > 0) || consultInFlight;
  info.promises = promises;
  info.promiseBacked = promiseBacked;
  if (c.kind === 'D2' && promises.length > 0 && !promiseBacked) {
    fails.push(`PROMISE: committed to find out with no consult behind it — ${promises.join(', ')}`);
  }

  if (c.kind === 'D3') {
    const spoke = spokenDetailCheck(speech);
    info.spoken = spoke;
    if (spoke.length) fails.push(`SPOKEN-DETAIL: identifiers read aloud — ${spoke.join(', ')}`);
    const carried = (c.detail ?? []).some((re) => re.test(chat));
    info.carried = carried;
    if (!carried && !silent) fails.push('SPOKEN-DETAIL: the detail never reached the chat line');
  }

  if (c.kind === 'D4' && !silent) {
    for (const group of c.must ?? []) {
      if (!group.some((re) => re.test(speech) || re.test(chat))) {
        fails.push(`SOURCE: answer not taken from the transcript — missing ${group.map(String).join('|')}`);
      }
    }
  }

  if (c.kind === 'D5' || c.kind === 'D6' || c.kind === 'D7' || c.kind === 'D8' || c.kind === 'D10') {
    // Speech only: a PM: line names what it asks and is never spoken.
    // Extended to D6/D7/D8, all built around a live PM consult — the
    // situation likeliest to tempt a machinery leak. D10 is strongest: it
    // *requires* saying it's finding the answer out, the sentence a leak
    // rides with ("I've asked the backend team about that first line").
    const machinery = machineryLeakCheck(speech);
    info.machinery = machinery;
    if (machinery.length) fails.push(`MACHINERY: named who/what it consults — ${machinery.join(', ')}`);
  }

  if (c.kind === 'D6') {
    const nag = pendingNagCheck(speech, c.subject);
    info.nag = nag;
    if (nag.length) fails.push(`REPETITION: re-announced the pending consult unprompted — ${nag.join(', ')}`);
  }

  // D10 is D6 with the acknowledgement deleted: the consult is outstanding
  // and no Archie line told the room, so the pending lookup *must* be
  // mentioned. `pendingNagCheck` only reads `kind === 'D6'`, so D10 can't
  // be failed for the sentence it requires. Checked on `speech` only,
  // never `chat` — the room was never told, and a chat line tells nobody
  // anything live. Full rationale, incl. `mustSay` vs `must`: dcases.mjs's
  // family comment. Asserted in untold-consult.test.ts.
  if (c.kind === 'D10' && !silent) {
    const untold = [];
    for (const group of c.mustSay ?? []) {
      if (!group.some((re) => re.test(speech))) untold.push(group.map(String).join('|'));
    }
    info.untold = untold;
    for (const missing of untold) {
      fails.push(`UNTOLD: the room was never told, out loud — missing ${missing}`);
    }
  }

  if (c.kind === 'D7') {
    // Also checked on chat: nothing sourced the value, so asserting one is
    // fabrication regardless of which line carries it.
    const asserted = [
      ...assertedAnswerCheck(speech, c.subject),
      ...assertedAnswerCheck(chat, c.subject).map((h) => `chat:${h}`),
    ];
    info.asserted = asserted;
    if (asserted.length) fails.push(`FABRICATION: asserted a specific answer nothing sourced — ${asserted.join('; ')}`);
    // Advisory only — see DECLINE_EN's comment for why a missing decline
    // phrase isn't its own hard failure.
    const declinePattern = c.ru ? DECLINE_RU : DECLINE_EN;
    info.declined = declinePattern.test(speech) || declinePattern.test(chat);
  }

  if (c.kind === 'D8') {
    const claim = provenanceClaimCheck(speech);
    info.provenanceClaim = claim;
    if (claim.length) fails.push(`PROVENANCE: claimed a source that never existed — ${claim.join(', ')}`);
    // Advisory only — see the comment above PROVENANCE_ADMIT_EN.
    info.admitted = (c.ru ? PROVENANCE_ADMIT_RU : PROVENANCE_ADMIT_EN).test(speech);
  }

  if (c.ru && !silent) {
    const share = cyr(speech);
    info.cyr = Number(share.toFixed(2));
    if (share < 0.5) fails.push(`LANGUAGE: answered a Russian room in English (cyrillic ${share.toFixed(2)})`);
  }
  if (!c.ru && !silent) {
    const share = cyr(speech);
    info.cyr = Number(share.toFixed(2));
    if (share > 0.15) fails.push(`LANGUAGE: answered an English room in Russian (cyrillic ${share.toFixed(2)})`);
  }

  return { fails, info, silent, speech, chat, raw };
}

/** ---------------- driver ----------------
 * Guarded so importing gradeDefect/exampleIdentifiers (as compare.mjs does)
 * never fires a live, billed campaign — only running this file directly
 * does. `pathToFileURL` matches `import.meta.url` exactly, even with
 * percent-encoding in the checkout path. The `argv[1] !== undefined` guard
 * covers no backing script file, where `pathToFileURL(undefined)` throws.
 */
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const OUT = new URL('./results/', import.meta.url).pathname;
  fs.mkdirSync(OUT, { recursive: true });

  const candidate = process.argv[2] ?? 'haiku-4.5';
  const reps = Number(process.argv[3] ?? 5);
  const arm = process.env.ARM ?? 'now';
  // Resolved before the first call: an unrecognised value must throw before anything is billed.
  const ctxArm = resolveContextArm(process.env[CONTEXT_ARM_ENV]);
  const sys = system();
  const ids = exampleIdentifiers(sys);
  const only = process.env.CASE_FILTER;
  const cases = DCASES.filter((c) => !only || c.id.includes(only) || c.kind === only);

  console.log(`prompt: ${promptPath()} (${sys.length} chars)`);
  console.log(`example identifiers auto-extracted: ${JSON.stringify(ids)}`);
  console.log(`arm=${arm} candidate=${candidate} reps=${reps} cases=${cases.length}`);
  // Printed before anything is billed: the hazard this arm guards against is
  // a run that looks like one arm but is another, so the banner states the
  // arm, the size it adds per case, and the verdicts derived.
  const ctxChars = userMsg('', undefined, armContext(ctxArm)).length - userMsg('').length;
  console.log(
    `context=${ctxArm} (+${ctxChars} chars of standing blocks per case) ` +
    `verdicts=${JSON.stringify(verdictTally(ctxArm, cases))}\n`,
  );

  const jobs = [];
  for (const c of cases) for (let r = 0; r < reps; r++) jobs.push({ c, r });
  const out = [];
  // Defaults — pool 5, 0ms gap, unless `POOL`/`MIN_GAP_MS` override — are what
  // every stored run was collected under; both print in the banner, since
  // pacing is as much a property of a run as the candidate. See pacing.mjs.
  const POOL = poolSize(5);
  const GAP = minGapMs();
  console.log(`pool=${POOL} min-gap=${GAP}ms (429s retried: ${RETRY.MAX_ATTEMPTS} attempts, ${RETRY.MAX_TOTAL_WAIT_MS / 1000}s of backoff at most)\n`);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(POOL, jobs.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= jobs.length) return;
        const { c, r } = jobs[i];
        // Both trailing arguments are the whole arm — undefined on `bare`,
        // making this call byte-identical to the two-argument one every
        // stored row was collected under (context-arm.test.ts).
        const verdict = armVerdict(ctxArm, c);
        const m = await runCall(candidate, {
          system: sys,
          user: userMsg(c.transcript, c.consults, armContext(ctxArm), verdict),
        });
        if (m.error) { out.push({ case: c.id, kind: c.kind, rep: r, context: ctxArm, error: m.error }); continue; }
        const g = gradeDefect(c, m, ids);
        out.push({
          case: c.id, kind: c.kind, rep: r, what: c.what, fails: g.fails, info: g.info,
          silent: g.silent, speech: g.speech, chat: g.chat, raw: g.raw,
          firstSentence: m.sentences[0]?.text ?? '', firstSentenceChars: (m.sentences[0]?.text ?? '').length,
          ttft: m.ttft, firstSentenceAt: m.firstSentence, complete: m.complete,
          inputTokens: m.inputTokens, outputTokens: m.outputTokens, sentences: m.sentences.length,
          // What this row was sent with, so a file can never be read as the
          // other arm's. Three meaningful values: the verdict's name on
          // `full`; `null` on the fail-safe arm (production's own value for
          // a gate that produced nothing); and, since `JSON.stringify` drops
          // an undefined property, no field at all on `bare`. "Sent nothing"
          // and "sent the fail-safe" must not share a spelling.
          context: ctxArm, verdict: verdict === undefined ? undefined : (verdict?.where ?? null),
        });
        process.stderr.write('.');
      }
    })
  );

  out.sort((a, b) => (a.case + a.rep).localeCompare(b.case + b.rep));
  // The context arm is in the filename, not left to `ARM` (free-text): a
  // full-context run written over `defect-live-<candidate>.json` would join
  // the bare corpus with nothing marking it as foreign, and `compare.mjs`
  // would table it against the rows it invalidates.
  const outFile = `${OUT}defect-${arm}${armFileTag(ctxArm)}-${candidate}.json`;
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${outFile}`);

  for (const r of out) {
    const verdict = r.error ? 'ERROR' : (r.fails.length === 0 ? 'PASS' : 'FAIL');
    console.log(`\n### ${r.case} rep${r.rep} [${verdict}] — ${r.what ?? r.error}`);
    if (r.silent) console.log('  -> SILENCE');
    else if (!r.error) {
      console.log('  SPEECH: ' + JSON.stringify(r.speech));
      if (r.chat) console.log('  CHAT:   ' + JSON.stringify(r.chat));
    }
    for (const f of r.fails ?? []) console.log('  FAIL: ' + f);
    if (r.info?.fabricated?.length && r.kind !== 'D2') console.log('  note: unsourced values ' + r.info.fabricated.join(', '));
    if (r.info?.promises?.length && r.kind !== 'D2') {
      console.log(`  note: promised future work ${r.info.promiseBacked ? '(a consult is behind it)' : 'with nothing behind it'} — ${r.info.promises.join(', ')} (advisory)`);
    }
    if (r.kind === 'D7' && r.info?.declined === false) console.log('  note: never plainly said the answer is not in yet (advisory)');
    if (r.kind === 'D8' && r.info?.admitted === false) console.log('  note: never plainly admitted the earlier answer was not sourced (advisory)');
  }

  // Every rate below is over GRADED rows only — an errored row is neither a
  // counted failure nor silently dropped (contrast compare.mjs); it's
  // reported by the accounting block at the end instead, where it can't be
  // mistaken for a result.
  const graded = out.filter((r) => !r.error);
  const byKind = {};
  for (const r of graded) {
    const k = r.kind;
    byKind[k] ??= { n: 0, ok: 0 };
    byKind[k].n++;
    if (r.fails.length === 0) byKind[k].ok++;
  }
  console.log(`\n===== ${arm} / ${candidate} / context=${ctxArm} =====`);
  for (const [k, v] of Object.entries(byKind).sort()) console.log(`  ${k}: ${v.ok}/${v.n} clean`);
  const perCase = {};
  for (const r of graded) { perCase[r.case] ??= [0, 0]; perCase[r.case][1]++; if (r.fails.length === 0) perCase[r.case][0]++; }
  for (const [k, v] of Object.entries(perCase).sort()) console.log(`  ${k.padEnd(28)} ${v[0]}/${v[1]}`);
  const fsChars = graded.filter((r) => r.firstSentenceChars).map((r) => r.firstSentenceChars).sort((a, b) => a - b);
  console.log(`  first-sentence chars: median ${fsChars[Math.floor(fsChars.length / 2)]}, mean ${(fsChars.reduce((a, b) => a + b, 0) / fsChars.length).toFixed(1)}, max ${fsChars[fsChars.length - 1]}`);
  const spokenChars = graded.filter((r) => r.speech).map((r) => r.speech.length).sort((a, b) => a - b);
  console.log(`  spoken chars:         median ${spokenChars[Math.floor(spokenChars.length / 2)]}, max ${spokenChars[spokenChars.length - 1]}`);

  // Last, so it's what's still on screen when the run ends: the fraction of
  // the sample actually collected, and the wire cost.
  printSampleReport(`${arm}${armFileTag(ctxArm)}/${candidate}`, accountRows(out), { tally: transportTally() });
}
