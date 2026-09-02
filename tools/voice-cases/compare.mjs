// Offline re-grade of stored defect rows against the current rubric — every detector is a pure function of reply text, so nothing needs re-calling.
// IDS unions every variant's identifiers, not per-arm, so before/after prompts can't leak each other's examples. COMPARE_PROMPTS=path1,path2 reads saved files — save yours first; nothing is auto-snapshotted.
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gradeDefect, exampleIdentifiers } from './defect.mjs';
import { DCASES } from './dcases.mjs';
import { TCASES, findTurn, pseudoCasesForTurn, turnId } from './tcases.mjs';
import { gradeTurn } from './turns.mjs';
import { parseReply, SentenceEmitter, stripThinkBlocks } from './emitter.mjs';
import { accountRows, dropReason, printSampleReport } from './sampling.mjs';

function rehydrate(row) {
  const sentences = [];
  const em = new SentenceEmitter((s) => sentences.push({ text: s }));
  em.push(row.raw ?? '');
  em.finish();
  // Same fix as providers.mjs's runCall: the tag name was wrong (`thinking` vs. the real `think`), checked on raw text where a well-formed block is now expected, not a leak.
  const { visible: afterThink } = stripThinkBlocks(row.raw ?? '', true);
  return {
    text: row.raw ?? '',
    parsed: parseReply(row.raw ?? ''),
    sentences,
    thinkingLeak: /<\/?think>/i.test(afterThink),
    regionShrank: em.regionShrank,
  };
}

/**
 * Re-grades stored rows and accounts for the ones that cannot be graded.
 *
 * Exported, taking rows not filenames, so the two-arm report's arithmetic is
 * testable against canned rows before a campaign — as turns.mjs/triage.mjs do.
 *
 * Two drop kinds, both previously silent:
 *   - a row carrying `error`: no reply text to re-grade; grading it as a
 *     failure would invent a defect out of an HTTP 429.
 *   - a row whose case id is in neither `DCASES` nor `TCASES` (a fixture
 *     renamed/deleted since collection): the report just prints a smaller
 *     denominator.
 *
 * Reasons come back as `drops` so the caller can say what it lost.
 */
export function regradeRows(rows, ids) {
  const graded = [];
  const drops = [];
  for (const row of rows) {
    if (row.error) {
      drops.push({ case: row.case, reason: dropReason(row.error), error: row.error });
      continue;
    }
    // A turns.mjs row is one chain turn, filed `<case>#T<n>`. Pseudo-cases are a pure function of the fixture, so it re-grades like a single-turn row — same detectors, unioned over the turn's declared kinds.
    const turn = findTurn(row.case);
    if (turn !== undefined) {
      const g = gradeTurn(pseudoCasesForTurn(turn.chain, turn.index), rehydrate(row), ids);
      graded.push({ case: row.case, kind: 'D9', rep: row.rep, fails: g.fails, info: g.info, silent: g.silent, speech: g.speech, chat: g.chat, raw: row.raw, firstSentenceChars: row.firstSentenceChars, context: row.context });
      continue;
    }
    const c = DCASES.find((x) => x.id === row.case);
    if (c === undefined) {
      drops.push({ case: row.case, reason: 'unknown-case' });
      continue;
    }
    const g = gradeDefect(c, rehydrate(row), ids);
    graded.push({ case: row.case, kind: c.kind, rep: row.rep, fails: g.fails, info: g.info, silent: g.silent, speech: g.speech, chat: g.chat, raw: row.raw, firstSentenceChars: row.firstSentenceChars, context: row.context });
  }
  return { graded, drops };
}

/** ---------------- driver ----------------
 * Guarded like quality.mjs/defect.mjs: never calls a paid model API, only
 * re-grades disk JSON — but exports `regradeRows`, so the "imported for a pure
 * function" case this guard protects is real, not just consistent.
 * Below the guard: reads COMPARE_PROMPTS/live-prompt identifiers, then result
 * files off disk, and prints report tables.
 */
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const LIVE_PROMPT = fileURLToPath(new URL('../../prompts/voice-speaking.md', import.meta.url));
  const PROMPT_FILES = (process.env.COMPARE_PROMPTS ?? LIVE_PROMPT)
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const IDS = PROMPT_FILES.flatMap((p) => exampleIdentifiers(fs.readFileSync(p, 'utf8')));

  const arms = {};
  const drops = {};
  for (const arg of process.argv.slice(2)) {
    const [name, files] = arg.split('=');
    const stored = [];
    for (const f of files.split(',')) {
      stored.push(...JSON.parse(fs.readFileSync(`results/${f}`, 'utf8')));
    }
    const regraded = regradeRows(stored, IDS);
    arms[name] = regraded.graded;
    drops[name] = regraded.drops;
  }

  const names = Object.keys(arms);

  /**
   * Which context arm each named arm's rows were collected under.
   * Re-grading is arm-agnostic (every detector is a pure function of reply
   * text; the pinned context carries nothing a detector reads as a source, per
   * context-arm.test.ts), so bare/full compare fairly — except a named arm
   * mixing both, whose rate silently averages two different requests. Rows
   * predating this field print `unrecorded`, meaning bare here.
   */
  for (const n of names) {
    const seen = [...new Set(arms[n].map((r) => r.context ?? 'unrecorded'))].sort();
    const warn = seen.length > 1 ? '  <-- MIXED ARMS: this rate averages two different requests' : '';
    console.log(`arm ${n}: ${arms[n].length} rows, context=${seen.join('+')}${warn}`);
    // What the arm did NOT grade, stated before any rate — every table below is over graded rows; losing a third of the sample to rate limiting used to score per-case out of 1-3 reps and read complete.
    printSampleReport(n, accountRows(arms[n], drops[n]));
  }
  console.log('');
  const pad = (s, n) => String(s).padEnd(n);
  const rate = (rows) => {
    const ok = rows.filter((r) => r.fails.length === 0).length;
    return rows.length === 0 ? '  -  ' : `${ok}/${rows.length}`;
  };

  // Single-turn cases first, then every chain turn under its own `#T` id — one row per turn, since a chain fails at a turn, not as a lump.
  const CASE_ROWS = [
    ...DCASES.map((c) => c.id),
    ...TCASES.flatMap((c) => c.turns.map((_, i) => turnId(c, i))),
  ];
  console.log(pad('case', 40) + names.map((n) => pad(n, 12)).join(''));
  for (const id of CASE_ROWS) {
    console.log(pad(id, 40) + names.map((n) => pad(rate(arms[n].filter((r) => r.case === id)), 12)).join(''));
  }
  console.log('');
  // Every family, not a subset: D5-D8 used to be missing, leaving the pending-consult incident's four families with per-case rows but no family line, though the README promised one.
  for (const k of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10']) {
    console.log(pad(k + ' overall', 40) + names.map((n) => pad(rate(arms[n].filter((r) => r.kind === k)), 12)).join(''));
  }
  console.log(pad('SILENT (should be 0)', 40) + names.map((n) => pad(`${arms[n].filter((r) => r.silent).length}/${arms[n].length}`, 12)).join(''));

  // D3 has a debatable edge: a short ticket id or bare filename is arguably speakable, a commit hash or full path isn't. Reported separately.
  const CORE = /hash:|path:|url:/;
  for (const n of names) {
    const d3 = arms[n].filter((r) => r.kind === 'D3');
    const core = d3.filter((r) => !r.fails.some((f) => f.startsWith('SPOKEN-DETAIL: identifiers read aloud') && CORE.test(f)));
    console.log(`  ${pad(n, 10)} D3 with no hash/path/URL spoken: ${core.length}/${d3.length}`);
  }

  console.log('\n--- failure reasons ---');
  for (const n of names) {
    console.log(`\n## ${n}`);
    const m = new Map();
    for (const r of arms[n]) for (const f of r.fails) {
      const key = `${r.case} :: ${f.split('—')[0].trim()}`;
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    [...m.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  x${v} ${k}`));
  }

  // Promising to find something out is a hard failure on D2 only, information elsewhere (gradeDefect's promiseBacked block). Reported here since unused information is useless; unbacked promises print verbatim, since this detector needs reading, not counting.
  console.log('\n--- promises of future work (hard failure on D2 only, advisory elsewhere) ---');
  for (const n of names) {
    const promised = arms[n].filter((r) => (r.info?.promises ?? []).length > 0);
    const unbacked = promised.filter((r) => r.info.promiseBacked !== true);
    console.log(`\n## ${n}: ${promised.length}/${arms[n].length} replies promised future work, ${unbacked.length} of them with nothing behind it`);
    const m = new Map();
    for (const r of promised) {
      const key = `${r.case} :: ${r.info.promiseBacked ? 'backed' : 'NOTHING BEHIND IT'} :: ${r.info.promises.join(' | ')}`;
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    [...m.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  x${v} ${k}`));
    for (const r of unbacked) console.log(`  UNBACKED ${r.case} rep${r.rep}: ${JSON.stringify(r.speech)}`);
  }

  console.log('\n--- first-sentence length (chars; a longer one risks an extra transport flush) ---');
  for (const n of names) {
    const xs = arms[n].map((r) => r.firstSentenceChars).filter((x) => typeof x === 'number' && x > 0).sort((a, b) => a - b);
    const sp = arms[n].filter((r) => r.speech).map((r) => r.speech.length).sort((a, b) => a - b);
    console.log(`  ${pad(n, 10)} first-sentence median ${xs[Math.floor(xs.length / 2)]} mean ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)} | whole-reply spoken median ${sp[Math.floor(sp.length / 2)]}`);
  }
}
