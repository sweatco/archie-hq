/**
 * Sample accounting: rows graded, dropped, why, plus a banner for a materially incomplete arm. Skipping an errored row is correct (ungradeable) — doing so invisibly was the defect this fixes.
 * Two claims: state graded/dropped/reason in one line always, even at zero drops (silence reads as "nothing checked"); past a threshold, add a banner (INCOMPLETE_FRACTION).
 * Pure: no model calls or file reads, rows in, numbers/strings out — compare.mjs, defect.mjs, quality.mjs, turns.mjs and triage.mjs report the same shape from it.
 */

/**
 * Fraction of an arm's rows allowed missing before its rates go unreadable. 5%.
 * Drops are close to missing-at-random: a TPM 429 depends on tokens in flight, not reply content, so a dropped row mostly costs precision, not correctness — the harm is a rate claiming a denominator it doesn't have. At 3 reps/case, 5% loss leaves ~1 case in 7 scored out of 2 reps instead of 3: moves a family rate by a point, but stated counts let a reader discount it. Past 5%, the shortfall becomes the headline, not a caveat.
 * A second, fraction-independent trigger: any case with zero graded rows prints as ` - ` — "nothing to see" rather than "silently lost."
 */
export const INCOMPLETE_FRACTION = 0.05;

/** The reason classes, in the order they are reported. */
export const DROP_REASONS = Object.freeze([
  'rate-limit',
  'timeout',
  'http-4xx',
  'http-5xx',
  'stream-error',
  'unknown-case',
  'other',
]);

// Error strings come from runCall: `HTTP <status>: <body>`, `stream error: ...`, or the exception's message — classed "retry later" vs "request is broken"; only the former warrants gentler pacing.
export function dropReason(error) {
  if (error === undefined || error === null) return 'other';
  const s = String(error);
  // Status is only the leading token: matching "429" elsewhere could misclassify an HTTP 400 quoting digits as a rate limit.
  const http = /^HTTP (\d{3})\b/.exec(s);
  if (http !== null) {
    const status = Number(http[1]);
    if (status === 429) return 'rate-limit';
    if (status >= 500) return 'http-5xx';
    if (status >= 400) return 'http-4xx';
    return 'other';
  }
  if (/^stream error/i.test(s)) return 'stream-error';
  if (/timeout|timed out|aborted/i.test(s)) return 'timeout';
  // No status code: still classified as rate-limit if the message says so in words.
  if (/rate.?limit|tokens per minute/i.test(s)) return 'rate-limit';
  return 'other';
}

// `rows`: truthy `error` = drop, else graded. `extraDrops` covers losses that never became rows — e.g. compare.mjs's unknown-case-id row, declared `{ case, reason: 'unknown-case' }`, not left silent.
export function accountRows(rows, extraDrops = []) {
  const byReason = {};
  const perCase = new Map();
  const bump = (id, key) => {
    if (id === undefined) return;
    const e = perCase.get(id) ?? { graded: 0, dropped: 0 };
    e[key]++;
    perCase.set(id, e);
  };

  let graded = 0;
  let dropped = 0;
  for (const r of rows) {
    if (r.error) {
      dropped++;
      const reason = dropReason(r.error);
      byReason[reason] = (byReason[reason] ?? 0) + 1;
      bump(r.case, 'dropped');
    } else {
      graded++;
      bump(r.case, 'graded');
    }
  }
  for (const d of extraDrops) {
    dropped++;
    const reason = d.reason ?? 'other';
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    bump(d.case, 'dropped');
  }

  const total = graded + dropped;
  const fraction = total === 0 ? 0 : dropped / total;

  // Attempted but nothing graded: absent from the comparison, though ` - ` doesn't say so.
  const blanked = [...perCase.entries()]
    .filter(([, v]) => v.graded === 0 && v.dropped > 0)
    .map(([id]) => id)
    .sort();

  // "Short": fewer graded rows than this arm's deepest case — legitimate (e.g. a CASE_FILTERed file merged with a full one), not a fault.
  const depth = Math.max(0, ...[...perCase.values()].map((v) => v.graded));
  const short = [...perCase.entries()]
    .filter(([, v]) => v.graded > 0 && v.graded < depth)
    .map(([id, v]) => ({ case: id, graded: v.graded, of: depth }))
    .sort((a, b) => a.graded - b.graded || a.case.localeCompare(b.case));

  return {
    total,
    graded,
    dropped,
    fraction,
    byReason,
    blanked,
    short,
    depth,
    incomplete: fraction > INCOMPLETE_FRACTION || blanked.length > 0,
  };
}

/** `rate-limit 32, timeout 1` — reason classes in DROP_REASONS order, then any stragglers. */
export function reasonSummary(byReason) {
  const known = DROP_REASONS.filter((r) => byReason[r] > 0).map((r) => `${r} ${byReason[r]}`);
  const rest = Object.keys(byReason)
    .filter((r) => !DROP_REASONS.includes(r) && byReason[r] > 0)
    .sort()
    .map((r) => `${r} ${byReason[r]}`);
  const all = [...known, ...rest];
  return all.length === 0 ? 'none' : all.join(', ');
}

const BANNER_WIDTH = 78;

// Hashes and full-width rules, not an indented note, so skimming can't miss it and quote the rate anyway.
function bannerLines(label, acct) {
  const pct = (acct.fraction * 100).toFixed(1);
  const body = [
    'INCOMPLETE SAMPLE — DO NOT READ RATES OFF THIS ARM',
    `arm ${label}: ${acct.graded}/${acct.total} rows graded, ${acct.dropped} dropped (${pct}%)`,
    `dropped: ${reasonSummary(acct.byReason)}`,
  ];
  if (acct.blanked.length > 0) {
    body.push(`${acct.blanked.length} case(s) produced NO graded row: ${acct.blanked.slice(0, 6).join(', ')}${acct.blanked.length > 6 ? ', ...' : ''}`);
  }
  if (acct.short.length > 0) {
    body.push(`${acct.short.length} case(s) scored out of fewer reps than this arm's deepest (${acct.depth})`);
  }
  body.push('re-run the missing rows before quoting anything from this table');
  const rule = '#'.repeat(BANNER_WIDTH);
  const inner = BANNER_WIDTH - 6;
  return [
    '',
    rule,
    ...body.map((l) => `## ${l.slice(0, inner).padEnd(inner)} ##`),
    rule,
    '',
  ];
}

// Returned, not printed, so a test can read these lines without capturing a stream — same reason turns.mjs/triage.mjs return rows instead of running live.
// `tally`: pacing.mjs's transportTally() for a driver that just called; absent offline (e.g. compare.mjs), untouched by the wire.
export function sampleReportLines(label, acct, { tally } = {}) {
  const lines = [];
  const pct = (acct.fraction * 100).toFixed(1);
  lines.push(
    `sample ${label}: ${acct.graded}/${acct.total} rows graded, ` +
    `${acct.dropped} dropped (${pct}%) — ${reasonSummary(acct.byReason)}`,
  );
  if (acct.short.length > 0) {
    const shown = acct.short.slice(0, 8).map((s) => `${s.case} ${s.graded}/${s.of}`).join(', ');
    lines.push(`  short denominators (this arm's deepest case has ${acct.depth}): ${shown}${acct.short.length > 8 ? `, +${acct.short.length - 8} more` : ''}`);
  }
  if (acct.blanked.length > 0) {
    lines.push(`  no graded row at all: ${acct.blanked.join(', ')}`);
  }
  if (tally !== undefined) {
    // Requests, not cost: a retry is one row but several requests — `requests` > graded means retries, not double-counting.
    lines.push(
      `  wire: ${tally.requests} requests for ${acct.total} rows ` +
      `(${tally.retries} retries after ${tally.rateLimited} rate-limited responses, ` +
      `${(tally.waitedMs / 1000).toFixed(1)}s slept on backoff, ` +
      `${(tally.pacedMs / 1000).toFixed(1)}s on pacing, ` +
      `${tally.exhausted} row(s) given up on)`,
    );
  }
  if (acct.incomplete) lines.push(...bannerLines(label, acct));
  return lines;
}

// Also written to stderr: a campaign redirects stdout to a log file, and this must be visible while running.
export function printSampleReport(label, acct, opts = {}) {
  for (const l of sampleReportLines(label, acct, opts)) console.log(l);
  if (acct.incomplete) process.stderr.write(bannerLines(label, acct).join('\n') + '\n');
}
