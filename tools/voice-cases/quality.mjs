// Quality driver + deterministic grader. Writes results/quality[-<context arm>]-<candidate>.json and prints every reply for manual read.
// CONTEXT_ARM works as in defect.mjs: `bare` (default) or `full`.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runCall } from './providers.mjs';
import { CASES, LEAK_PATTERNS } from './cases.mjs';
import { system, userMsg } from './promptio.mjs';
import { CONTEXT_ARM_ENV, armContext, armFileTag, resolveContextArm } from './context-arm.mjs';
import { TAIL_MARKERS } from './emitter.mjs';
import { minGapMs, transportTally } from './pacing.mjs';
import { accountRows, printSampleReport } from './sampling.mjs';

/** Markdown the speech sanitiser must strip. Speech region only — the CHAT line legitimately carries underscores, slashes and backticks. */
const MD = [
  { name: 'bold/italic-star', re: /\*/ },
  { name: 'underscore-emph', re: /(^|\s)_[^_]+_(\s|$)/ },
  { name: 'backtick', re: /`/ },
  { name: 'heading', re: /^\s*#{1,6}\s/m },
  { name: 'bullet', re: /^\s*[-+•]\s+/m },
  { name: 'numbered-list', re: /^\s*\d+[.)]\s+/m },
  { name: 'table-pipe', re: /\|/ },
];

function cyrillicShare(s) {
  const letters = s.match(/[\p{L}]/gu) ?? [];
  if (letters.length === 0) return 0;
  const cyr = s.match(/[Ѐ-ӿ]/g) ?? [];
  return cyr.length / letters.length;
}

// spokenRaw bounds the spoken region as parseReply does: cut at the first tail marker (PM: or CHAT:), so a PM-only reply's PM: line isn't scanned as spoken.
// No think-stripping: reasoning arrives on its own channel now, and the arm whose prompt asks for tags has had them removed on the wire (providers.mjs).
// chatRaw stays keyed on CHAT: — unused beyond this destructure, kept correct for later readers.
function splitRaw(raw) {
  const lines = raw.split(/\r?\n/);
  const tailStart = lines.findIndex((l) => TAIL_MARKERS.some((mk) => l.trimStart().startsWith(mk)));
  const spokenRaw = tailStart === -1 ? raw : lines.slice(0, tailStart).join('\n');
  const chatLine = lines.findIndex((l) => l.trimStart().startsWith('CHAT:'));
  const chatRaw = chatLine === -1 ? '' : [lines[chatLine].trimStart().slice(5), ...lines.slice(chatLine + 1)].join('\n');
  return { spokenRaw, chatRaw };
}

export function grade(c, m) {
  const e = c.expect;
  const raw = m.text;
  const { spokenRaw, chatRaw } = splitRaw(raw);
  // The whole reply, for checks that scan more than the spoken half. Identical to `raw` — kept as its own name because the two were once different strings and the checks below say which they mean.
  const rawVisible = raw;
  const parsed = m.parsed;
  const silent = parsed.silent === true;
  const speech = silent ? '' : parsed.speech;
  const chat = silent ? '' : (parsed.chat ?? '');
  const first = m.sentences[0]?.text ?? '';
  const fails = [];
  const warns = [];

  // ---- protocol ----
  if (e.silence === true && !silent) fails.push('PROTOCOL: spoke when it should have been SILENCE');
  if (e.silence === false && silent) fails.push('PROTOCOL: went SILENT when someone was waiting');
  if (!silent) {
    for (const md of MD) {
      if (md.re.test(spokenRaw)) fails.push(`PROTOCOL: markdown in speech (${md.name})`);
    }
  }
  if (parsed.chatOnly) fails.push('PROTOCOL: CHAT: line with nothing spoken (whole turn discarded)');
  if (e.chat === 'required' && !silent && chat.length === 0) fails.push('PROTOCOL: no CHAT: line where detail demanded one');
  if (e.chat === 'forbidden' && chat.length > 0) fails.push('PROTOCOL: unnecessary CHAT: line');
  // Native reasoning does not remove the tag, so a literal one on the content channel is read out to the room.
  if (m.thinkingLeak) fails.push('PROTOCOL: <think> tags leaked into the spoken text');
  if (m.regionShrank) fails.push('PROTOCOL: speech region shrank (emitter gating tripped)');
  // Checked against rawVisible, not raw — a silence decision's reasoning legitimately contains the word "silence" in text the room never hears, which raw would flag every time.
  if (e.silence === true && silent && /silence/i.test(rawVisible) && !/^\W*silence\W*$/i.test(rawVisible.trim())) {
    warns.push('narrated the silence decision instead of emitting the bare token');
  }
  if (!silent && m.emitted === 0) fails.push('PROTOCOL: reply parsed as speech but no sentence was ever emitted');

  // ---- injection ----
  if (e.noLeak) {
    for (const p of LEAK_PATTERNS) {
      if (p.test(raw)) fails.push(`INJECTION: leaked prompt prose matching ${p}`);
    }
  }

  // ---- judgement ----
  if (!silent) {
    for (const group of e.mustContainAll ?? []) {
      if (!group.some((re) => re.test(speech) || re.test(chat))) {
        fails.push(`JUDGEMENT: missing required content ${group.map(String).join('|')}`);
      }
    }
    for (const re of e.shouldNotContain ?? []) {
      if (re.test(rawVisible)) fails.push(`JUDGEMENT: contains what it should not ${re}`);
    }
    for (const re of e.speechShouldNotContain ?? []) {
      if (re.test(speech)) fails.push(`PROTOCOL: spoke detail that belonged in chat ${re}`);
    }
    if (e.chatMustContainAny && chat.length > 0 && !e.chatMustContainAny.some((re) => re.test(chat))) {
      fails.push('JUDGEMENT: CHAT line missing the detail it exists to carry');
    }
    if (e.leadWith && !e.leadWith.some((re) => re.test(first))) {
      fails.push(`JUDGEMENT: first sentence does not lead with the answer: ${JSON.stringify(first.slice(0, 110))}`);
    }
    if (e.lang === 'ru') {
      const share = cyrillicShare(speech);
      if (share < 0.5) fails.push(`RUSSIAN: replied in the wrong language (cyrillic share ${share.toFixed(2)})`);
      else if (share < 0.7) warns.push(`heavily anglicised Russian (cyrillic share ${share.toFixed(2)})`);
    }
  }
  return { fails, warns, silent, speech, chat, first, raw };
}

// Guarded so `import { grade } from './quality.mjs'` never fires a billed campaign — only running this file directly does.
// pathToFileURL, not a file://${argv[1]} template, stays exact under percent-encoding; `process.argv[1] !== undefined` covers evaluation with no backing script (e.g. node --eval).
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const OUT = new URL('./results/', import.meta.url).pathname;
  fs.mkdirSync(OUT, { recursive: true });

  const candidate = process.argv[2] ?? 'haiku-4.5';
  const reps = Number(process.argv[3] ?? 1);
  const sys = system();
  const out = [];

  // Both arms are available here now. `full` used to be refused because it sent a per-case triage verdict cases.mjs declares nothing to derive — production sends no such block any more,
  // so `full` is the standing blocks and nothing else, which these fixtures can be sent as readily as dcases.mjs's.
  // userMsg's 2nd arg is hardcoded undefined on both arms (no C case has consults) — fixing only one arm would add a second difference between them.
  const ctxArm = resolveContextArm(process.env[CONTEXT_ARM_ENV]);
  // Serial by construction, so there's no pool to size — MIN_GAP_MS is the only pacing knob that applies.
  console.log(`candidate=${candidate} reps=${reps} context=${ctxArm} min-gap=${minGapMs()}ms`);

  const only = process.env.CASE_FILTER;
  for (const c of CASES.filter((x) => !only || x.id.includes(only))) {
    for (let r = 0; r < reps; r++) {
      const m = await runCall(candidate, {
        system: sys,
        user: userMsg(c.transcript, undefined, armContext(ctxArm)),
      });
      if (m.error) {
        console.log(`\n### ${c.id} rep${r} :: ERROR ${m.error}`);
        out.push({ case: c.id, rep: r, context: ctxArm, error: m.error });
        continue;
      }
      const g = grade(c, m);
      out.push({
        case: c.id, rep: r, what: c.what, fails: g.fails, warns: g.warns,
        silent: g.silent, speech: g.speech, chat: g.chat, first: g.first, raw: g.raw,
        ttft: m.ttft, firstSentence: m.firstSentence, complete: m.complete,
        inputTokens: m.inputTokens, outputTokens: m.outputTokens, sentences: m.sentences.length,
        // Which arm this row was sent under — see defect.mjs for why a row says so.
        context: ctxArm,
      });
      const verdict = g.fails.length === 0 ? (g.warns.length ? 'PASS(warn)' : 'PASS') : 'FAIL';
      console.log(`\n### ${c.id} rep${r} [${verdict}] — ${c.what}`);
      if (g.silent) console.log('  -> SILENCE');
      else {
        console.log('  SPEECH: ' + JSON.stringify(g.speech));
        if (g.chat) console.log('  CHAT:   ' + JSON.stringify(g.chat));
      }
      for (const f of g.fails) console.log('  FAIL: ' + f);
      for (const w of g.warns) console.log('  warn: ' + w);
    }
  }

  // The context arm goes in the filename, as in defect.mjs: a full-context file must never be readable as a bare one.
  const outFile = `${OUT}quality${armFileTag(ctxArm)}-${candidate}${only ? '-' + only : ''}.json`;
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  // Over graded rows only — an errored row (an HTTP 429, above all) is a missing sample, not a failing reply; the accounting block below says so out loud.
  const graded = out.filter((o) => !o.error);
  const failed = graded.filter((o) => o.fails.length > 0).length;
  console.log(`\nwrote ${outFile}`);
  console.log(`\n===== ${candidate} / context=${ctxArm}: ${graded.length - failed}/${graded.length} clean passes, ${failed} with failures =====`);
  printSampleReport(`quality${armFileTag(ctxArm)}/${candidate}`, accountRows(out), { tally: transportTally() });
}
