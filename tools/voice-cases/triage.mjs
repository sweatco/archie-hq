/**
 * Triage-gate driver — runs triage-cases.mjs against prompts/voice-triage.md. Writes results/triage-<arm>[-<context arm>]-<candidate>.json, one row per case per rep.
 *
 * CONTEXT_ARM works as in defect.mjs — see resolveTriageContextArm for the one arm this driver refuses and why.
 *
 * Graded as five separate things, not one pass/fail:
 *   1. Placement — did the gate put the answer where it actually is?
 *   2. The deadline (PRODUCTION_TRIAGE_DEADLINE_MS) — guards a hung socket, not a latency knob: on `outside` the verdict carries the preamble spoken before the speaking call, so discarding a late one means more room silence, not less. Reported alone since it's the provider's admission latency, a deployment property, not the prompt's.
 *   3. The preamble exists at all — on `outside`, the one sentence spoken while the answer is fetched; without it the room is silent throughout the speaking call.
 *   4. The preamble's language — voice-triage.md wants the language Archie was addressed in, not the room's. See addressedInRussian.
 *   5. What the preamble says — must not name the apparatus, must not answer. See gradeTriage's own doc.
 *
 * readVerdict below is this harness's own parser, not production's — parseTriage isn't exported from comprehension.ts.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runCall } from './providers.mjs';
import { TRIAGE_CASES, expectedFor } from './triage-cases.mjs';
import { triageSystem, triageUserMsg, triagePromptPath } from './promptio.mjs';
import { CONTEXT_ARM_ENV, CONTEXT_ARMS, armContext, armFileTag, resolveContextArm } from './context-arm.mjs';
import { internalIdLeakCheck, machineryLeakCheck } from './defect.mjs';
import { RETRY, minGapMs, poolSize, transportTally } from './pacing.mjs';
import { accountRows, printSampleReport } from './sampling.mjs';

/** The four places an answer can come from — `TRIAGE_WHERE` in comprehension.ts. */
export const TRIAGE_WHERE = ['room', 'outside', 'pending', 'elsewhere'];

/**
 * `TRIAGE_TIMEOUT_MS` in comprehension.ts, past which production has no verdict. Copy — triage.test.ts reads that source and fails on drift; the check tolerates `_` separators (`[\d_]`).
 * A stored arm re-grades rather than re-collects when this moves: every row carries `raw` and `elapsedMs`, and gradeTriage is pure over them.
 */
export const PRODUCTION_TRIAGE_DEADLINE_MS = 1500;

/** `TRIAGE_MAX_TOKENS` in comprehension.ts. Copy, same drift check. A verdict is one short line of JSON. */
export const PRODUCTION_TRIAGE_MAX_TOKENS = 96;

// null is production's fail-safe, not a fifth verdict — the turn runs as if there were no gate; graded as its own failure class.
// `preamble` is taken verbatim, without production's toSpeech sanitising — this harness only needs whether there's a sentence and its language.
export function readVerdict(raw) {
  const text = raw ?? '';
  const open = text.indexOf('{');
  const close = text.lastIndexOf('}');
  if (open === -1 || close <= open) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(open, close + 1));
  } catch {
    return null;
  }
  const where = TRIAGE_WHERE.find((known) => known === parsed.where);
  if (where === undefined) return null;
  const verdict = { where };
  if (typeof parsed.preamble === 'string' && parsed.preamble.trim().length > 0) {
    verdict.preamble = parsed.preamble.trim();
  }
  return verdict;
}

// `bare`/`full` mean what they mean in defect.mjs; see the thrown message below for why `full-noverdict` is refused.
// Mirrors quality.mjs's rejection of `full`, for the opposite reason — it refuses what it can't grade, this refuses what it can't send.
export function resolveTriageContextArm(raw) {
  const arm = resolveContextArm(raw);
  if (arm === 'full-noverdict') {
    throw new Error(
      `${CONTEXT_ARM_ENV}=full-noverdict is not an arm of the triage gate. The gate never receives a ` +
      `<situation> verdict — it is the call that produces one — so this would send byte-identical ` +
      `requests to CONTEXT_ARM=full and store them under a name claiming otherwise, and a comparison ` +
      `between the two would be reading sampling noise as a difference. Use ` +
      `${CONTEXT_ARMS.filter((a) => a !== 'full-noverdict').join(' or ')}.`,
    );
  }
  return arm;
}

/** Cyrillic share of the letters in a string — the same measure `gradeDefect` uses. */
function cyr(s) {
  const letters = s.match(/\p{L}/gu) ?? [];
  return letters.length === 0 ? 0 : (s.match(/[Ѐ-ӿ]/g) ?? []).length / letters.length;
}

// Measured off the transcript, not declared by a fixture — voice-triage.md wants the address language, not the room's (they differ on TGq-ru-room-en-ask-outside), and a hand label could drift.
// The speaker prefix is stripped first — otherwise a Cyrillic name would make an English address count as Russian. triage.test.ts pins this against every fixture's `ru`.
export function addressedInRussian(transcript) {
  const lines = String(transcript).trimEnd().split(/\r?\n/);
  const addressed = (lines[lines.length - 1] ?? '').replace(/^[^:]*:\s*/, '');
  return cyr(addressed) >= 0.5;
}

// voice-triage.md: the preamble may hold the floor but must not include any of the answer.
// One entry per matched group, quoting the match, to show which part leaked. A case declaring nothing isn't checked — see triage-cases.mjs's `answer` section.
export function answerLeakCheck(preamble, groups) {
  const hits = [];
  for (const group of groups ?? []) {
    const matched = group.map((re) => preamble.match(re)).find((m) => m !== null && m !== undefined);
    if (matched) hits.push(JSON.stringify(matched[0]));
  }
  return hits;
}

// Pure — no model, no clock, no environment; a stored row re-grades offline from raw/elapsedMs/context alone.
// `arm` is needed because the capability pair's answer depends on whether <capabilities> was sent; expectedFor throws rather than guess when unnamed.
// Failure prefixes: PROTOCOL (unreadable), PLACEMENT (wrong verdict), DEADLINE (too slow for production), PREAMBLE (nothing said while it looks), LANGUAGE (wrong address language), MACHINERY (named the apparatus), ANSWERED (gave the answer).
// MACHINERY and ANSWERED are graded here because nothing else can: the preamble runs before the speaking call, so voice-speaking.md never applies, and toSpeech only strips punctuation/markup, not content.
// Reuses defect.mjs's D5 detector rather than a second list, avoiding duplicate Cyrillic-bounding logic. answerLeakCheck reads the case's own `answer`.
export function gradeTriage(c, raw, elapsedMs = null, arm = undefined) {
  const expected = expectedFor(c, arm);
  const verdict = readVerdict(raw);
  const fails = [];
  const info = { where: verdict?.where ?? null, expected, preamble: verdict?.preamble ?? null, elapsedMs };

  if (verdict === null) {
    fails.push(`PROTOCOL: no usable verdict — production would run this turn with no triage at all: ${JSON.stringify((raw ?? '').slice(0, 120))}`);
  } else if (verdict.where !== expected) {
    fails.push(`PLACEMENT: said "${verdict.where}", the answer was ${expected === 'room' ? 'in the room' : `"${expected}"`}`);
  }

  if (verdict?.where === 'outside') {
    if (verdict.preamble === undefined) {
      fails.push('PREAMBLE: outside with no sentence for the room to hear while it looks');
    } else {
      const share = cyr(verdict.preamble);
      // Address language, not the room's — see addressedInRussian. `c.ru` is a report axis only, unused here.
      const addressedRu = addressedInRussian(c.transcript);
      info.cyr = Number(share.toFixed(2));
      info.addressedRu = addressedRu;
      if (addressedRu && share < 0.5) fails.push(`LANGUAGE: preamble in English, and Archie was addressed in Russian (cyrillic ${share.toFixed(2)})`);
      if (!addressedRu && share > 0.15) fails.push(`LANGUAGE: preamble in Russian, and Archie was addressed in English (cyrillic ${share.toFixed(2)})`);

      // One failure class for both machineryLeakCheck (role/team/agent) and internalIdLeakCheck (an internal id) — voice-triage.md bans them together.
      const machinery = [
        ...machineryLeakCheck(verdict.preamble),
        ...internalIdLeakCheck(verdict.preamble, c.consults),
      ];
      info.machinery = machinery;
      if (machinery.length > 0) {
        fails.push(`MACHINERY: the preamble names the apparatus behind the voice, and the room hears it verbatim — ${machinery.join(', ')}`);
      }

      const delivered = answerLeakCheck(verdict.preamble, c.answer);
      info.answered = delivered;
      if (delivered.length > 0) {
        fails.push(`ANSWERED: the preamble delivered the answer instead of holding the floor, so the room hears it twice — ${delivered.join(', ')}`);
      }
    }
  }

  // Checked last, so a wrong verdict is never hidden behind a latency problem.
  if (elapsedMs !== null && elapsedMs > PRODUCTION_TRIAGE_DEADLINE_MS) {
    fails.push(`DEADLINE: ${Math.round(elapsedMs)}ms against production's ${PRODUCTION_TRIAGE_DEADLINE_MS}ms — this verdict would not be used`);
  }

  return { verdict, fails, info };
}

// `call({ system, user, case: c, rep })` is the injectable transport — triage.test.ts exercises this path against canned replies at zero cost.
// `pool` defaults to 4 via poolSize, reproducing every stored run when POOL is unset. `contextArm` defaults to `bare`, matching every stored row's original two-argument call — asserted in triage.test.ts.
export async function runTriage(cases, { call, sys, reps = 1, pool = poolSize(4), contextArm = 'bare' }) {
  const jobs = [];
  for (const c of cases) for (let rep = 0; rep < reps; rep++) jobs.push({ c, rep });
  const rows = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(pool, jobs.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= jobs.length) return;
        const { c, rep } = jobs[i];
        const user = triageUserMsg(c.transcript, c.consults, armContext(contextArm));
        const res = (await call({ system: sys, user, case: c, rep })) ?? {};
        // `expect` is stored resolved, not as declared — a per-arm declaration is a map; storing the map would force every reader to re-apply the arm.
        const expected = expectedFor(c, contextArm);
        const axes = { case: c.id, expect: expected, length: c.length, ru: c.ru, context: contextArm, rep };
        if (res.error) {
          rows.push({ ...axes, error: res.error });
          continue;
        }
        // `complete` (runCall's name for ms to end-of-stream) is what production's deadline covers — it waits for the whole reply before parsing. `ttft` is kept for reading, not grading.
        const elapsed = res.complete ?? null;
        const g = gradeTriage(c, res.text, elapsed, contextArm);
        rows.push({
          ...axes, what: c.what,
          fails: g.fails, info: g.info, where: g.verdict?.where ?? null,
          preamble: g.verdict?.preamble ?? '', raw: res.text ?? '',
          ttft: res.ttft ?? null, elapsedMs: elapsed,
          inputTokens: res.inputTokens ?? null, outputTokens: res.outputTokens ?? null,
        });
      }
    })
  );
  rows.sort((a, b) => `${a.case}${a.rep}`.localeCompare(`${b.case}${b.rep}`));
  return rows;
}

// Production's own token cap, plus a generous client timeout so a slow verdict is measured, not aborted — the grader applies the real deadline.
export function liveTransport(candidate) {
  return ({ system: sys, user }) =>
    runCall(candidate, { system: sys, user, maxTokens: PRODUCTION_TRIAGE_MAX_TOKENS, timeoutMs: 30000 });
}

// Prints a run: every row, then placement/deadline split by the case-set axes, then failure reasons.
// Exported, taking rows as an argument, so it can be tested against stored data rather than only live output.
export function printTriageReport(rows, { arm, candidate, tally }) {
  for (const r of rows) {
    const verdict = r.error ? 'ERROR' : r.fails.length === 0 ? 'PASS' : 'FAIL';
    console.log(`\n### ${r.case} rep${r.rep} [${verdict}] — ${r.what ?? r.error}`);
    if (r.error) continue;
    console.log(`  expected ${r.expect}, said ${r.where ?? '(unreadable)'}${r.preamble ? ` — preamble: ${JSON.stringify(r.preamble)}` : ''}`);
    console.log(`  ${Math.round(r.elapsedMs ?? 0)}ms complete, ttft ${Math.round(r.ttft ?? 0)}ms, ${r.inputTokens ?? '?'} input tokens`);
    for (const f of r.fails) console.log('  FAIL: ' + f);
  }

  const scored = rows.filter((r) => !r.error);
  const rate = (subset, predicate) =>
    subset.length === 0 ? '  -  ' : `${subset.filter(predicate).length}/${subset.length}`;
  const placed = (r) => r.where === r.expect;
  const inTime = (r) => r.elapsedMs !== null && r.elapsedMs <= PRODUCTION_TRIAGE_DEADLINE_MS;

  console.log(`\n===== ${arm} / ${candidate} =====`);
  const pad = (s, n) => String(s).padEnd(n);
  // 31 — the longest id here is 29 characters.
  console.log(pad('case', 31) + pad('expected', 10) + pad('said', 12) + 'ms');
  for (const r of rows) {
    console.log(pad(r.case, 31) + pad(r.expect, 10) + pad(r.error ? 'ERROR' : (r.where ?? 'unreadable'), 12) + Math.round(r.elapsedMs ?? 0));
  }

  console.log('\n--- placement (the answer was put where it actually is) ---');
  for (const [label, subset] of [
    ['overall', scored],
    ['long', scored.filter((r) => r.length === 'long')],
    ['short', scored.filter((r) => r.length === 'short')],
    ['long, expected room', scored.filter((r) => r.length === 'long' && r.expect === 'room')],
    ['short, expected room', scored.filter((r) => r.length === 'short' && r.expect === 'room')],
    ['long, expected outside', scored.filter((r) => r.length === 'long' && r.expect === 'outside')],
    ['short, expected outside', scored.filter((r) => r.length === 'short' && r.expect === 'outside')],
    ['russian room', scored.filter((r) => r.ru)],
    ['english room', scored.filter((r) => !r.ru)],
    ['long + russian', scored.filter((r) => r.ru && r.length === 'long')],
  ]) {
    console.log(`  ${pad(label, 26)} ${rate(subset, placed)}`);
  }

  // Rows that actually said `outside`, not rows that should have — a preamble only exists on that verdict, so grading the intended set would score a correct absence as a miss.
  const spoke = scored.filter((r) => r.where === 'outside');
  const noFail = (prefix) => (r) => !(r.fails ?? []).some((f) => f.startsWith(prefix));
  console.log('\n--- the preamble (spoken to the room with nothing reading what it says) ---');
  for (const [label, predicate] of [
    ['there at all', noFail('PREAMBLE')],
    ['language addressed in', noFail('LANGUAGE')],
    ['named nothing internal', noFail('MACHINERY')],
    ['held the floor, no answer', noFail('ANSWERED')],
  ]) {
    console.log(`  ${pad(label, 26)} ${rate(spoke, predicate)}`);
  }

  console.log(`\n--- production's ${PRODUCTION_TRIAGE_DEADLINE_MS}ms deadline (a slower verdict is no verdict) ---`);
  for (const [label, subset] of [
    ['long', scored.filter((r) => r.length === 'long')],
    ['short', scored.filter((r) => r.length === 'short')],
  ]) {
    const ms = subset.map((r) => r.elapsedMs ?? 0).sort((a, b) => a - b);
    const median = ms.length === 0 ? 0 : ms[Math.floor(ms.length / 2)];
    console.log(`  ${pad(label, 26)} ${rate(subset, inTime)} inside it, median ${Math.round(median)}ms, worst ${Math.round(ms[ms.length - 1] ?? 0)}ms`);
  }

  console.log('\n--- failure reasons ---');
  const counted = new Map();
  for (const r of rows) for (const f of r.fails ?? []) {
    const key = `${r.case} :: ${f.split('—')[0].trim()}`;
    counted.set(key, (counted.get(key) ?? 0) + 1);
  }
  [...counted.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  x${v} ${k}`));

  // Rates above are all over `scored` (rows with a reply); this reports how many had none, so `3/3` can't hide five unanswered attempts.
  printSampleReport(`${arm}/${candidate}`, accountRows(rows), { tally });
}

// Guarded like defect.mjs/turns.mjs — importing gradeTriage/readVerdict must never bill. pathToFileURL, not a file:// template, since a percent-encoded path breaks the template match.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const OUT = new URL('./results/', import.meta.url).pathname;
  fs.mkdirSync(OUT, { recursive: true });

  const candidate = process.argv[2] ?? 'haiku-4.5';
  const reps = Number(process.argv[3] ?? 1);
  const arm = process.env.ARM ?? 'now';
  // Resolved before the first call: an unrecognised value, or the one arm this driver refuses, must throw before anything is billed.
  const ctxArm = resolveTriageContextArm(process.env[CONTEXT_ARM_ENV]);
  const sys = triageSystem();
  const only = process.env.CASE_FILTER;
  const cases = TRIAGE_CASES.filter((c) => !only || c.id.includes(only));

  console.log(`triage prompt: ${triagePromptPath()} (${sys.length} chars)`);
  console.log(`arm=${arm} candidate=${candidate} reps=${reps} cases=${cases.length}`);
  // Printed before anything is billed: guards against a run that looks like one arm and is another. Expectations are shown too, since they vary by arm for the capability pair.
  const ctxChars = triageUserMsg('', undefined, armContext(ctxArm)).length - triageUserMsg('').length;
  const expectTally = {};
  for (const c of cases) {
    const e = expectedFor(c, ctxArm);
    expectTally[e] = (expectTally[e] ?? 0) + 1;
  }
  console.log(`context=${ctxArm} (+${ctxChars} chars of standing blocks per case) expects=${JSON.stringify(expectTally)}`);
  // A floor, not a total — retries add to it. The wire tally the accounting block prints at the end is what was actually sent.
  console.log(`billed model calls this invocation: at least ${cases.length * reps} (cases x reps; retries add to it)`);
  const pool = poolSize(4);
  console.log(`pool=${pool} min-gap=${minGapMs()}ms (429s retried: ${RETRY.MAX_ATTEMPTS} attempts, ${RETRY.MAX_TOTAL_WAIT_MS / 1000}s of backoff at most)\n`);

  const rows = await runTriage(cases, { call: liveTransport(candidate), sys, reps, pool, contextArm: ctxArm });
  // The context arm goes in the filename, so a full-context run can't silently join a bare-arm corpus it invalidates under a name that doesn't say so.
  const outFile = `${OUT}triage-${arm}${armFileTag(ctxArm)}-${candidate}.json`;
  fs.writeFileSync(outFile, JSON.stringify(rows, null, 2));
  console.log(`wrote ${outFile}`);
  printTriageReport(rows, { arm: `${arm}${armFileTag(ctxArm)}`, candidate, tally: transportTally() });
}
