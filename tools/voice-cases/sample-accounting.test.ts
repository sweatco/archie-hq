import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DROP_REASONS,
  INCOMPLETE_FRACTION,
  accountRows,
  dropReason,
  printSampleReport,
  reasonSummary,
  sampleReportLines,
} from './sampling.mjs';
import { regradeRows } from './compare.mjs';
import { printReport } from './turns.mjs';
import { printTriageReport } from './triage.mjs';
import { DCASES } from './dcases.mjs';
import { TCASES, turnId } from './tcases.mjs';

type Row = { case?: string; error?: string; fails?: string[] };

function captured(fn: () => void): string {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

function capturedStderr(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: unknown }).write = (s: string) => {
    chunks.push(String(s));
    return true;
  };
  try {
    fn();
  } finally {
    (process.stderr as unknown as { write: unknown }).write = original;
  }
  return chunks.join('');
}

function capturedBoth(fn: () => void): string {
  let out = '';
  const err = capturedStderr(() => {
    out = captured(fn);
  });
  return `${out}\n${err}`;
}

const RATE_LIMIT_ERROR =
  'HTTP 429: Tokens per minute limit exceeded - too many tokens processed. ' +
  '[gave up after 5 attempt(s) and 75.0s of backoff: attempt-cap]';

describe('classifying what was lost', () => {
  it('separates "come back later" from "this request is broken"', () => {
    expect(dropReason(RATE_LIMIT_ERROR)).toBe('rate-limit');
    expect(dropReason('HTTP 429: Rate limit reached')).toBe('rate-limit');
    expect(dropReason('HTTP 400: context_length_exceeded')).toBe('http-4xx');
    expect(dropReason('HTTP 401: invalid x-api-key')).toBe('http-4xx');
    expect(dropReason('HTTP 529: overloaded_error')).toBe('http-5xx');
    expect(dropReason('HTTP 500: internal')).toBe('http-5xx');
    expect(dropReason('The operation was aborted due to timeout')).toBe('timeout');
    expect(dropReason('stream error: 3001 something went wrong mid-stream')).toBe('stream-error');
    expect(dropReason('fetch failed')).toBe('other');
    expect(dropReason(undefined)).toBe('other');
    // Status code decides, not any "429" in the body.
    expect(dropReason('HTTP 400: request 429e1 exceeded 429000 prompt tokens')).toBe('http-4xx');
    expect(dropReason('cerebras rate limit reached, try later')).toBe('rate-limit');
  });

  it('reports every class it knows in a stable order', () => {
    expect(reasonSummary({})).toBe('none');
    expect(reasonSummary({ timeout: 1, 'rate-limit': 32 })).toBe('rate-limit 32, timeout 1');
    expect(reasonSummary({ 'rate-limit': 2, weird: 1 })).toBe('rate-limit 2, weird 1');
    expect(DROP_REASONS).toContain('unknown-case');
  });
});

describe('accounting', () => {
  it('states graded and dropped counts even when nothing was dropped', () => {
    const rows: Row[] = Array.from({ length: 6 }, (_, i) => ({ case: `D1a`, rep: i, fails: [] }));
    const acct = accountRows(rows);
    expect(acct.total).toBe(6);
    expect(acct.graded).toBe(6);
    expect(acct.dropped).toBe(0);
    expect(acct.incomplete).toBe(false);
    const out = sampleReportLines('after', acct).join('\n');
    expect(out).toContain('6/6 rows graded, 0 dropped (0.0%)');
    expect(out).toContain('none');
    expect(out).not.toContain('INCOMPLETE SAMPLE');
  });

  it('reconstructs the campaign that prompted all of this, and refuses to be read', () => {
    // Drops front-load: some cases lose every rep.
    const rows: Row[] = [];
    const cases = Array.from({ length: 37 }, (_, i) => `D${i}-case`);
    let dropsLeft = 32;
    for (const id of cases) {
      for (let rep = 0; rep < 3; rep++) {
        const drop = dropsLeft > 0 && (rep === 0 || dropsLeft > 20);
        if (drop) {
          dropsLeft--;
          rows.push({ case: id, error: RATE_LIMIT_ERROR });
        } else {
          rows.push({ case: id, fails: [] });
        }
      }
    }
    const acct = accountRows(rows);
    expect(acct.total).toBe(111);
    expect(acct.dropped).toBe(32);
    expect(acct.graded).toBe(79);
    expect(acct.byReason['rate-limit']).toBe(32);
    expect(acct.fraction).toBeCloseTo(32 / 111, 5);
    expect(acct.incomplete).toBe(true);

    const out = sampleReportLines('bare', acct).join('\n');
    expect(out).toContain('79/111 rows graded, 32 dropped (28.8%) — rate-limit 32');
    expect(out).toContain('INCOMPLETE SAMPLE — DO NOT READ RATES OFF THIS ARM');
    expect(out).toContain('re-run the missing rows before quoting anything from this table');
    // Rule is full-width: 40+ # chars.
    expect(out).toMatch(/#{40,}/);
    expect(out).toContain('short denominators');
  });

  it('puts the threshold at 5% of rows and treats the boundary as complete', () => {
    expect(INCOMPLETE_FRACTION).toBe(0.05);
    const build = (drops: number) => {
      const rows: Row[] = [];
      for (let c = 0; c < 10; c++) {
        for (let rep = 0; rep < 10; rep++) {
          // One drop per case isolates the fraction trigger from blanked-case.
          const drop = rep === 0 && c < drops;
          rows.push(drop ? { case: `c${c}`, error: RATE_LIMIT_ERROR } : { case: `c${c}`, fails: [] });
        }
      }
      return accountRows(rows);
    };
    expect(build(5).fraction).toBe(0.05);
    expect(build(5).incomplete).toBe(false);
    expect(build(6).incomplete).toBe(true);
  });

  it('flags a case that produced no graded row at all, whatever the fraction', () => {
    const rows: Row[] = [{ case: 'D9-lonely', error: RATE_LIMIT_ERROR }];
    for (let i = 0; i < 99; i++) rows.push({ case: 'D1-busy', fails: [] });
    const acct = accountRows(rows);
    expect(acct.fraction).toBeLessThan(INCOMPLETE_FRACTION);
    expect(acct.blanked).toEqual(['D9-lonely']);
    expect(acct.incomplete).toBe(true);
    const out = sampleReportLines('after', acct).join('\n');
    expect(out).toContain('no graded row at all: D9-lonely');
    expect(out).toContain('case(s) produced NO graded row');
  });

  it('names cases scored out of fewer reps than the arm managed elsewhere', () => {
    const rows: Row[] = [];
    for (let rep = 0; rep < 6; rep++) rows.push({ case: 'deep', fails: [] });
    for (let rep = 0; rep < 2; rep++) rows.push({ case: 'shallow', fails: [] });
    rows.push({ case: 'shallow', error: RATE_LIMIT_ERROR });
    const acct = accountRows(rows);
    expect(acct.depth).toBe(6);
    expect(acct.short).toEqual([{ case: 'shallow', graded: 2, of: 6 }]);
    expect(sampleReportLines('x', acct).join('\n')).toContain('shallow 2/6');
  });

  it('reports the wire separately from the rows, so a retry is not a double-count', () => {
    const rows: Row[] = [{ case: 'a', fails: [] }, { case: 'b', fails: [] }];
    const out = sampleReportLines('after', accountRows(rows), {
      tally: { requests: 5, rateLimited: 3, retries: 3, waitedMs: 21_000, pacedMs: 1_500, exhausted: 0 },
    }).join('\n');
    expect(out).toContain('wire: 5 requests for 2 rows');
    expect(out).toContain('3 retries after 3 rate-limited responses');
    expect(out).toContain('21.0s slept on backoff');
    expect(out).toContain('0 row(s) given up on');
  });

  it('writes the banner to stderr as well, so a redirected run still shows it', () => {
    const incomplete = accountRows([{ case: 'a', error: RATE_LIMIT_ERROR }, { case: 'b', fails: [] }]);
    let stdout = '';
    const stderr = capturedStderr(() => {
      stdout = captured(() => printSampleReport('bare', incomplete));
    });
    expect(stdout).toContain('INCOMPLETE SAMPLE');
    expect(stderr).toContain('INCOMPLETE SAMPLE — DO NOT READ RATES OFF THIS ARM');

    const complete = accountRows([{ case: 'a', fails: [] }]);
    let cleanStdout = '';
    const cleanStderr = capturedStderr(() => {
      cleanStdout = captured(() => printSampleReport('bare', complete));
    });
    expect(cleanStdout).toContain('1/1 rows graded');
    expect(cleanStderr).toBe('');
  });
});

describe('compare.mjs re-grades what it can and accounts for what it cannot', () => {
  const goodDefectRow = {
    case: (DCASES as { id: string }[])[0].id,
    rep: 0,
    raw: 'The deploy finished just before noon.',
    firstSentenceChars: 36,
    context: 'bare',
  };
  const goodTurnRow = {
    case: turnId((TCASES as { id: string }[])[0], 0),
    rep: 0,
    raw: 'Not yet, nothing has come back.',
    firstSentenceChars: 31,
    context: 'bare',
  };

  it('grades a single-turn row and a chain-turn row from the fixture alone', () => {
    const { graded, drops } = regradeRows([goodDefectRow, goodTurnRow], []);
    expect(drops).toHaveLength(0);
    expect(graded).toHaveLength(2);
    expect(graded[0].case).toBe(goodDefectRow.case);
    expect(Array.isArray(graded[0].fails)).toBe(true);
    expect(graded[1].kind).toBe('D9');
  });

  it('drops an errored row with its reason instead of in silence', () => {
    const { graded, drops } = regradeRows(
      [goodDefectRow, { case: goodDefectRow.case, rep: 1, error: RATE_LIMIT_ERROR }],
      [],
    );
    expect(graded).toHaveLength(1);
    expect(drops).toEqual([
      { case: goodDefectRow.case, reason: 'rate-limit', error: RATE_LIMIT_ERROR },
    ]);
    const acct = accountRows(graded, drops);
    expect(acct.total).toBe(2);
    expect(acct.graded).toBe(1);
    expect(acct.byReason['rate-limit']).toBe(1);
  });

  it('accounts for a row whose case no longer exists, which was the other silent drop', () => {
    const { graded, drops } = regradeRows(
      [goodDefectRow, { case: 'D4z-renamed-away', rep: 0, raw: 'anything' }],
      [],
    );
    expect(graded).toHaveLength(1);
    expect(drops).toEqual([{ case: 'D4z-renamed-away', reason: 'unknown-case' }]);
    const acct = accountRows(graded, drops);
    expect(acct.dropped).toBe(1);
    expect(acct.byReason['unknown-case']).toBe(1);
    expect(acct.incomplete).toBe(true);
  });
});

describe('the drivers say the same thing at the end of a run', () => {
  it('turns.mjs does not count a chain that ended on a transport error as a failure', () => {
    const chain = (TCASES as { id: string }[])[0];
    const rows = [
      {
        case: turnId(chain, 0), kind: 'D9', turn: 1, rep: 0, as: ['D5'], what: 'first turn',
        fails: [], info: {}, silent: false, speech: 'Not yet.', chat: '', pm: '', consults: [],
      },
      { case: turnId(chain, 1), kind: 'D9', turn: 2, rep: 0, error: RATE_LIMIT_ERROR },
    ];
    const out = capturedBoth(() => printReport(rows, { arm: 'test', candidate: 'stub', reps: 1 }));
    // 0/0, not 0/1: unfinished chain isn't a failure.
    expect(out).toContain('0/0 whole chains clean');
    expect(out).toContain('1 chain(s) ended early on a transport error and are not counted');
    expect(out).toContain('1 dropped (50.0%) — rate-limit 1');
    expect(out).toContain('INCOMPLETE SAMPLE');
    // Completed turn reports its own 1/1 denominator.
    expect(out).toMatch(new RegExp(`${turnId(chain, 0)}\\s+1/1`));
  });

  it('triage.mjs states how many rows it dropped under its placement table', () => {
    const rows = [
      { case: 'TGa', expect: 'room', length: 'long', ru: false, rep: 0, what: 'x', fails: [], where: 'room', preamble: '', raw: '{}', ttft: 100, elapsedMs: 300, inputTokens: 9000, outputTokens: 12 },
      { case: 'TGb', expect: 'room', length: 'short', ru: false, rep: 0, what: 'y', fails: [], where: 'room', preamble: '', raw: '{}', ttft: 100, elapsedMs: 300, inputTokens: 900, outputTokens: 12 },
      { case: 'TGc', expect: 'outside', length: 'short', ru: true, rep: 0, error: RATE_LIMIT_ERROR },
    ];
    const out = capturedBoth(() => printTriageReport(rows, { arm: 'test', candidate: 'stub' }));
    expect(out).toContain('2/3 rows graded, 1 dropped (33.3%) — rate-limit 1');
    expect(out).toContain('INCOMPLETE SAMPLE');
    expect(out).toContain('overall');
  });

  // defect.mjs/quality.mjs fire a billed campaign if imported (isMain); reads source text instead, like triage.test.ts for constants.
  it('every report site is wired to the same accounting', () => {
    const read = (f: string) => fs.readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
    for (const f of ['./defect.mjs', './quality.mjs', './turns.mjs', './triage.mjs', './compare.mjs']) {
      expect(read(f)).toContain('printSampleReport(');
    }
    // Checks the new expression is present, not that the old one is absent.
    // Old text can remain in an explanatory comment; absence alone is unreliable.
    expect(read('./quality.mjs')).toContain('const failed = graded.filter((o) => o.fails.length > 0).length');
    expect(read('./defect.mjs')).toContain('const graded = out.filter((r) => !r.error)');
  });
});
