/**
 * Multi-turn driver, one chain per tcases.mjs case → results/turns-<arm>-<candidate>.json in defect.mjs's row shape, for compare.mjs's offline re-grade.
 * Turn N's request = transcript after its room lines + replies 1..N-1 + current <consults> (detail: tcases.mjs).
 * `runChain`'s model call is injectable: a stub returning `{ text }` grades identically to live (grading only reads `m.text`, via replyFromRaw) — turn-chain.test.ts gets real machinery free.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runCall } from './providers.mjs';
import { gradeDefect, exampleIdentifiers } from './defect.mjs';
import { TCASES, pseudoCasesForTurn, consultsAt, turnId } from './tcases.mjs';
import { system, userMsg, promptPath } from './promptio.mjs';
import { parseReply } from './emitter.mjs';
import { RETRY, minGapMs, poolSize, transportTally } from './pacing.mjs';
import { accountRows, printSampleReport } from './sampling.mjs';

/** Substituted for {{BOT_NAME}} by promptio.mjs; prefixes our own lines in the transcript. */
export const BOT_NAME = 'Archie';

// The `m` shape gradeDefect consumes: raw text only, same as compare.mjs's rehydrate.
// `regionShrank` false here for the same reason emitter.mjs hardcodes it.
export function replyFromRaw(raw, extra = {}) {
  const text = raw ?? '';
  const parsed = parseReply(text);
  return {
    text,
    parsed,
    // A literal tag in what the room hears: nothing strips one any more, so it is spoken. Stored rows collected under the strip arm arrive here already stripped.
    thinkingLeak: /<\/?think>/i.test(parsed.silent === true ? text : parsed.speech),
    regionShrank: false,
    ...extra,
  };
}

// Graded like a single-turn case (gradeDefect). Always-on checks (silence/markdown/contamination/language) dedupe. `info` merges safely: kind keys disjoint (nag=D6, asserted=D7, provenanceClaim=D8); overlaps compute identically.
export function gradeTurn(pseudoCases, m, ids) {
  if (pseudoCases.length === 0) {
    throw new Error('a turn must declare at least one kind in `as`');
  }
  const fails = [];
  const info = {};
  let graded = null;
  for (const pc of pseudoCases) {
    const g = gradeDefect(pc, m, ids);
    for (const f of g.fails) {
      if (!fails.includes(f)) fails.push(f);
    }
    Object.assign(info, g.info);
    graded = g;
  }
  // silent/speech/chat/raw depend only on the reply, same across kinds.
  return { fails, info, silent: graded.silent, speech: graded.speech, chat: graded.chat, raw: graded.raw };
}

// `call({ system, user, chain, turn })` returns `{ text }` or `{ error }`; an error ends the chain — later turns would build on a reply that never happened.
// A silent reply appends nothing to the transcript (production: noteOwnAnswer needs speech) — gradeDefect already fails silent turns.
export async function runChain(c, { call, sys, ids = [], botName = BOT_NAME, rep = 0 }) {
  /** Every line the model has seen, in speaking order. */
  const spoken = [];
  const rows = [];

  for (let i = 0; i < c.turns.length; i++) {
    for (const line of c.turns[i].room) {
      spoken.push(line);
    }
    const consults = consultsAt(c, i);
    const user = userMsg(spoken.join('\n'), consults);
    const res = (await call({ system: sys, user, chain: c, turn: i })) ?? {};

    if (res.error) {
      rows.push({ case: turnId(c, i), kind: 'D9', turn: i + 1, rep, error: res.error });
      break;
    }

    const m = replyFromRaw(res.text, {
      // Present for a live transport, null for a stub.
      ttft: res.ttft ?? null,
      complete: res.complete ?? null,
      inputTokens: res.inputTokens ?? null,
      outputTokens: res.outputTokens ?? null,
      sentenceTexts: (res.sentences ?? []).map((s) => s.text),
      // Renamed from runCall's `firstSentence`/`sentences` to defect.mjs's row field names.
      firstSentenceAt: res.firstSentence ?? null,
      sentenceCount: (res.sentences ?? []).length,
    });
    const pcs = pseudoCasesForTurn(c, i);
    const g = gradeTurn(pcs, m, ids);
    const turn = c.turns[i];

    rows.push({
      case: turnId(c, i),
      kind: 'D9',
      as: Array.isArray(turn.as) ? [...turn.as] : [turn.as],
      turn: i + 1,
      rep,
      what: turn.what,
      fails: g.fails,
      info: g.info,
      silent: g.silent,
      speech: g.speech,
      chat: g.chat,
      raw: g.raw,
      // Never spoken or graded; stored so a run shows whether turn 1 raised the consult the chain assumes.
      pm: m.parsed.pm ?? '',
      consults: consults ?? [],
      firstSentence: m.sentenceTexts[0] ?? '',
      firstSentenceChars: (m.sentenceTexts[0] ?? '').length,
      ttft: m.ttft,
      firstSentenceAt: m.firstSentenceAt,
      complete: m.complete,
      sentences: m.sentenceCount,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
    });

    // Only the spoken half is filed (mirrors noteOwnAnswer(answer.speech); CHAT:/PM:/<think> excluded), or the agent would believe it said what it only wrote.
    if (!g.silent && g.speech.length > 0) {
      spoken.push(`${botName}: ${g.speech}`);
    }
  }

  return rows;
}

/** Real-campaign transport: one streamed call per turn. */
export function liveTransport(candidate) {
  return ({ system: sys, user }) => runCall(candidate, { system: sys, user });
}

// Exported, not inlined: exercisable against canned rows without a campaign — same reason the transport is injectable.
export function printReport(out, { arm, candidate, reps, tally }) {
  for (const c of TCASES) {
    for (let r = 0; r < reps; r++) {
      const chain = out.filter((row) => row.case.startsWith(`${c.id}#T`) && row.rep === r).sort((a, b) => a.turn - b.turn);
      if (chain.length === 0) continue;
      console.log(`\n======== ${c.id} rep${r} — ${c.what}`);
      for (const row of chain) {
        const verdict = row.error ? 'ERROR' : row.fails.length === 0 ? 'PASS' : 'FAIL';
        console.log(`\n### T${row.turn} [${verdict}] as=${(row.as ?? []).join('+')} — ${row.what ?? row.error}`);
        if (row.error) continue;
        if (row.consults.length > 0) {
          console.log(`  consult: ${row.consults.map((q) => `${q.id} ${q.answer === undefined ? 'PENDING' : 'answered'}`).join(', ')}`);
        }
        if (row.silent) console.log('  -> SILENCE');
        else console.log('  SPEECH: ' + JSON.stringify(row.speech));
        if (row.chat) console.log('  CHAT:   ' + JSON.stringify(row.chat));
        if (row.pm) console.log('  PM:     ' + JSON.stringify(row.pm));
        for (const f of row.fails) console.log('  FAIL: ' + f);
        if (row.info?.fabricated?.length) console.log('  note: unsourced values ' + row.info.fabricated.join(', '));
        if (row.info?.promises?.length) {
          console.log(`  note: promised future work ${row.info.promiseBacked ? '(a consult is behind it)' : 'with nothing behind it'} — ${row.info.promises.join(', ')} (advisory)`);
        }
      }
    }
  }

  console.log(`\n===== ${arm} / ${candidate} =====`);
  // Errored turns excluded below: a missing sample, not a defect — the accounting block reports the losses.
  const graded = out.filter((row) => !row.error);
  const perTurn = {};
  for (const row of graded) {
    perTurn[row.case] ??= [0, 0];
    perTurn[row.case][1]++;
    if (row.fails.length === 0) perTurn[row.case][0]++;
  }
  for (const [k, v] of Object.entries(perTurn).sort()) console.log(`  ${k.padEnd(40)} ${v[0]}/${v[1]}`);
  // A chain counts clean only if every turn does: about a whole conversation going wrong, not one reply.
  for (const c of TCASES) {
    let clean = 0;
    let n = 0;
    let lost = 0;
    for (let r = 0; r < reps; r++) {
      const chain = out.filter((row) => row.case.startsWith(`${c.id}#T`) && row.rep === r);
      if (chain.length === 0) continue;
      // An errored turn ends the chain — later turns never happened: incomplete, not failed. Calling it failed would invent a defect out of a rate limit.
      if (chain.some((row) => row.error)) {
        lost++;
        continue;
      }
      n++;
      if (chain.every((row) => row.fails.length === 0)) clean++;
    }
    if (n > 0 || lost > 0) {
      console.log(`  ${c.id.padEnd(40)} ${clean}/${n} whole chains clean${lost > 0 ? `  <-- ${lost} chain(s) ended early on a transport error and are not counted` : ''}`);
    }
  }

  printSampleReport(`${arm}/${candidate}`, accountRows(out), { tally });
}

// Guarded like defect.mjs: turn-chain.test.ts and compare.mjs import runChain/gradeTurn without billing a campaign. pathToFileURL avoids a file://${argv[1]} template's percent-encoding mismatch.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const OUT = new URL('./results/', import.meta.url).pathname;
  fs.mkdirSync(OUT, { recursive: true });

  const candidate = process.argv[2] ?? 'haiku-4.5';
  const reps = Number(process.argv[3] ?? 1);
  const arm = process.env.ARM ?? 'now';
  const sys = system();
  const ids = exampleIdentifiers(sys);
  const only = process.env.CASE_FILTER;
  const cases = TCASES.filter((c) => !only || c.id.includes(only));

  const calls = cases.reduce((n, c) => n + c.turns.length, 0) * reps;
  console.log(`prompt: ${promptPath()} (${sys.length} chars)`);
  console.log(`example identifiers auto-extracted: ${JSON.stringify(ids)}`);
  console.log(`arm=${arm} candidate=${candidate} reps=${reps} chains=${cases.length}`);
  // A floor, not a total: retries add to it — the accounting block's wire tally is the actual count.
  console.log(`billed model calls this invocation: at least ${calls} (turns x cases x reps; retries add to it)`);

  // Turns are serial per chain; chains/reps aren't, so pooling bounds wall time — a convenience, not a substitute for cross-process sampling (README).
  const jobs = [];
  for (const c of cases) for (let r = 0; r < reps; r++) jobs.push({ c, r });
  const out = [];
  // Defaults (pool 3, 0ms gap) match every stored run; a chain's turns stay serial — this pool spans chains/reps.
  const POOL = poolSize(3);
  console.log(`pool=${POOL} min-gap=${minGapMs()}ms (429s retried: ${RETRY.MAX_ATTEMPTS} attempts, ${RETRY.MAX_TOTAL_WAIT_MS / 1000}s of backoff at most)\n`);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(POOL, jobs.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= jobs.length) return;
        const { c, r } = jobs[i];
        const rows = await runChain(c, { call: liveTransport(candidate), sys, ids, rep: r });
        out.push(...rows);
        process.stderr.write('.');
      }
    })
  );

  out.sort((a, b) => `${a.case}${a.rep}`.localeCompare(`${b.case}${b.rep}`));
  fs.writeFileSync(`${OUT}turns-${arm}-${candidate}.json`, JSON.stringify(out, null, 2));
  printReport(out, { arm, candidate, reps, tally: transportTally() });
}
