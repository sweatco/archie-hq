import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCall } from './providers.mjs';
import {
  MIN_GAP_ENV,
  POOL_ENV,
  RETRY,
  isRateLimited,
  minGapMs,
  poolSize,
  resetTransportState,
  retryAfterMs,
  retryPlan,
  transportTally,
} from './pacing.mjs';
import { accountRows } from './sampling.mjs';
import { gradeDefect, exampleIdentifiers } from './defect.mjs';
import { DCASES } from './dcases.mjs';
import { runTriage } from './triage.mjs';
import { TRIAGE_CASES } from './triage-cases.mjs';

const CANDIDATE = 'cerebras-gemma-4-31b';

type Attempt = { at: number };
const attempts: Attempt[] = [];

const enc = new TextEncoder();

function streamOf(chunks: string[]) {
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (i >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: enc.encode(chunks[i++]) };
        },
        async cancel() {},
      };
    },
  };
}

/** One Cerebras `chat.completion.chunk` frame, plus the documented sentinel. */
function cerebrasStream(text: string): string[] {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, index: 0 } ] })}\n\n`,
    'data: [DONE]\n\n',
  ];
}

function okResponse(text: string) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: streamOf(cerebrasStream(text)),
    async text() {
      return '';
    },
  };
}

function rateLimitedResponse(retryAfter?: string) {
  return {
    ok: false,
    status: 429,
    headers: new Headers(retryAfter === undefined ? {} : { 'retry-after': retryAfter }),
    async text() {
      return 'Tokens per minute limit exceeded - too many tokens processed.';
    },
  };
}

function badRequestResponse() {
  return {
    ok: false,
    status: 400,
    headers: new Headers(),
    async text() {
      return '{"error":{"type":"invalid_request_error","message":"context_length_exceeded"}}';
    },
  };
}

function stubResponses(queue: (() => unknown)[]) {
  let i = 0;
  vi.stubGlobal('fetch', async () => {
    attempts.push({ at: Date.now() });
    const make = queue[Math.min(i, queue.length - 1)];
    i++;
    return make();
  });
}

/** Starts the promise, then sweeps the clock past any policy backoff. */
async function onFakeClock<T>(fn: () => Promise<T>, sweepMs = 600_000): Promise<T> {
  vi.useFakeTimers();
  try {
    const p = fn();
    await vi.advanceTimersByTimeAsync(sweepMs);
    return await p;
  } finally {
    vi.useRealTimers();
  }
}

const AMBIENT_POOL = process.env[POOL_ENV];
const AMBIENT_GAP = process.env[MIN_GAP_ENV];

beforeEach(() => {
  attempts.length = 0;
  resetTransportState();
  delete process.env[POOL_ENV];
  delete process.env[MIN_GAP_ENV];
  // Transport needs a key for headers even with fetch stubbed and nothing sent.
  // ??= fills the gap only with no .env (CI, fresh clone); a real .env always wins.
  process.env.CEREBRAS_API_KEY ??= 'stub-key-never-sent';
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (AMBIENT_POOL === undefined) delete process.env[POOL_ENV];
  else process.env[POOL_ENV] = AMBIENT_POOL;
  if (AMBIENT_GAP === undefined) delete process.env[MIN_GAP_ENV];
  else process.env[MIN_GAP_ENV] = AMBIENT_GAP;
});

describe('a 429 costs a wait, not a row', () => {
  it('retries the rate-limited attempt and grades the reply that follows', async () => {
    stubResponses([() => rateLimitedResponse(), () => okResponse('The deploy finished just before noon.')]);

    const m = (await onFakeClock(() =>
      runCall(CANDIDATE, { system: 'sys', user: 'user' }),
    )) as Record<string, any>;

    expect(attempts).toHaveLength(2);
    expect(m.error).toBeNull();
    expect(m.text).toContain('deploy finished');
    expect(m.attempts).toBe(2);
    expect(m.rateLimitedAttempts).toBe(1);
    // Equal jitter on the first 5s step: half to full.
    expect(m.retryWaitMs).toBeGreaterThanOrEqual(RETRY.BASE_DELAY_MS / 2);
    expect(m.retryWaitMs).toBeLessThanOrEqual(RETRY.BASE_DELAY_MS);

    const c = DCASES[0] as { id: string; kind: string; transcript: string };
    const ids = exampleIdentifiers('') as string[];
    const g = gradeDefect(c, m, ids) as { fails: string[] };
    const row = { case: c.id, kind: c.kind, rep: 0, fails: g.fails };
    expect(Array.isArray(row.fails)).toBe(true);
    const acct = accountRows([row]);
    expect(acct.graded).toBe(1);
    expect(acct.dropped).toBe(0);
    expect(acct.incomplete).toBe(false);
  });

  it('measures the successful attempt, not the wait before it', async () => {
    stubResponses([() => rateLimitedResponse('20'), () => okResponse('Noon.')]);

    const m = (await onFakeClock(() =>
      runCall(CANDIDATE, { system: 'sys', user: 'user' }),
    )) as Record<string, any>;

    // t0 is taken per attempt, after the sleep — a shared t0 would leak >=20000 into headers_at/ttft below.
    expect(m.retryWaitMs).toBeGreaterThanOrEqual(20_000);
    expect(m.headers_at).toBeLessThan(m.retryWaitMs);
    expect(m.ttft).toBeLessThan(m.retryWaitMs);
  });

  it('counts requests separately from rows, so a retry is not a double-count', async () => {
    stubResponses([() => rateLimitedResponse('1'), () => okResponse('Noon.')]);

    const m = (await onFakeClock(() =>
      runCall(CANDIDATE, { system: 'sys', user: 'user' }),
    )) as Record<string, any>;

    const tally = transportTally();
    expect(tally.requests).toBe(2);
    expect(tally.rateLimited).toBe(1);
    expect(tally.retries).toBe(1);
    expect(tally.exhausted).toBe(0);
    // Row is the successful attempt's usage only, never a sum; the extra request is in the tally above.
    expect(m.attempts).toBe(2);
    expect(m.inputTokens).toBeNull();
    expect(m.outputTokens).toBeNull();
  });
});

describe('Retry-After', () => {
  it('is honoured as a floor, with a small spread on top so pooled workers do not collide', async () => {
    stubResponses([() => rateLimitedResponse('12'), () => okResponse('Noon.')]);

    const m = (await onFakeClock(() =>
      runCall(CANDIDATE, { system: 'sys', user: 'user' }),
    )) as Record<string, any>;

    expect(m.retryWaitMs).toBeGreaterThanOrEqual(12_000);
    expect(m.retryWaitMs).toBeLessThanOrEqual(12_000 + RETRY.RETRY_AFTER_SPREAD_MS);
    // Not the exponential schedule — the server's number won.
    expect(m.retryWaitMs).toBeGreaterThan(RETRY.BASE_DELAY_MS);
  });

  it('reads both RFC forms and refuses to invent one', () => {
    expect(retryAfterMs({ 'retry-after': '12' })).toBe(12_000);
    expect(retryAfterMs({ 'Retry-After': '0.5' })).toBe(500);
    expect(retryAfterMs(new Headers({ 'retry-after': '3' }))).toBe(3_000);
    const now = Date.parse('2026-09-01T12:00:00Z');
    expect(retryAfterMs({ 'retry-after': 'Tue, 01 Sep 2026 12:00:30 GMT' }, now)).toBe(30_000);
    // A date already past is 0, not a negative wait.
    expect(retryAfterMs({ 'retry-after': 'Tue, 01 Sep 2026 11:59:00 GMT' }, now)).toBe(0);
    // Absent or unparseable falls back to backoff, not a guess.
    expect(retryAfterMs({})).toBeNull();
    expect(retryAfterMs(new Headers())).toBeNull();
    expect(retryAfterMs({ 'retry-after': 'soon' })).toBeNull();
    expect(retryAfterMs(undefined)).toBeNull();
  });
});

describe('what is not a "later"', () => {
  it('fails a 400 on the first attempt', async () => {
    stubResponses([() => badRequestResponse()]);

    const m = (await onFakeClock(() =>
      runCall(CANDIDATE, { system: 'sys', user: 'user' }),
    )) as Record<string, any>;

    expect(attempts).toHaveLength(1);
    expect(m.attempts).toBe(1);
    expect(m.error).toMatch(/^HTTP 400:/);
    expect(m.error).toContain('context_length_exceeded');
    expect(m.error).not.toContain('gave up');
    expect(m.retryWaitMs).toBe(0);
    const tally = transportTally();
    expect(tally.requests).toBe(1);
    expect(tally.rateLimited).toBe(0);
    expect(tally.retries).toBe(0);
    // Classed as its own kind of loss, not rate limiting.
    expect(accountRows([{ case: 'x', error: m.error }]).byReason['http-4xx']).toBe(1);
  });

  it('treats 429 and nothing else as retryable', () => {
    expect(isRateLimited(429)).toBe(true);
    for (const status of [200, 400, 401, 404, 408, 500, 502, 503, 529]) {
      expect(isRateLimited(status)).toBe(false);
    }
  });
});

describe('the bounds', () => {
  it('stops at the attempt cap when every attempt is refused', async () => {
    // A cheap Retry-After keeps the wait cap out; only the attempt cap can fail this.
    stubResponses([() => rateLimitedResponse('1')]);

    const m = (await onFakeClock(() =>
      runCall(CANDIDATE, { system: 'sys', user: 'user' }),
    )) as Record<string, any>;

    expect(attempts).toHaveLength(RETRY.MAX_ATTEMPTS);
    expect(m.attempts).toBe(RETRY.MAX_ATTEMPTS);
    expect(m.error).toMatch(/^HTTP 429:/);
    expect(m.error).toContain('attempt-cap');
    expect(m.retryWaitMs).toBeLessThan(RETRY.MAX_TOTAL_WAIT_MS);
    expect(transportTally().exhausted).toBe(1);
    // The lost row states why, and classes as rate limiting.
    expect(accountRows([{ case: 'x', error: m.error }]).byReason['rate-limit']).toBe(1);
  });

  it('stops at the total-wait cap even with attempts to spare', async () => {
    // 40s a time exceeds the 75s total by attempt 2 of 5 — not explainable by the attempt cap.
    stubResponses([() => rateLimitedResponse('40')]);

    const m = (await onFakeClock(() =>
      runCall(CANDIDATE, { system: 'sys', user: 'user' }),
    )) as Record<string, any>;

    expect(attempts).toHaveLength(2);
    expect(attempts.length).toBeLessThan(RETRY.MAX_ATTEMPTS);
    expect(m.error).toContain('retry-after-over-budget');
    expect(m.error).toContain('server asked for');
    expect(m.retryWaitMs).toBeGreaterThanOrEqual(40_000);
    expect(m.retryWaitMs).toBeLessThanOrEqual(RETRY.MAX_TOTAL_WAIT_MS);
  });

  it('caps the backoff path by total wait too', () => {
    // No Retry-After; four sleeps spent already — the fifth would overrun.
    const plan = retryPlan({ attempt: 4, spentWaitMs: RETRY.MAX_TOTAL_WAIT_MS - 1_000 });
    expect(plan.retry).toBe(false);
    expect(plan.reason).toBe('wait-cap');
    // Two caps agree by construction (summed nominal delays equal the wait cap); otherwise one would be unreachable decoration.
    let spent = 0;
    for (let attempt = 1; attempt < RETRY.MAX_ATTEMPTS; attempt++) {
      const nominal = Math.min(RETRY.MAX_DELAY_MS, RETRY.BASE_DELAY_MS * 2 ** (attempt - 1));
      spent += nominal;
    }
    expect(spent).toBe(RETRY.MAX_TOTAL_WAIT_MS);
  });

  it('refuses to retry past the attempt cap', () => {
    const plan = retryPlan({ attempt: RETRY.MAX_ATTEMPTS, spentWaitMs: 0 });
    expect(plan.retry).toBe(false);
    expect(plan.reason).toBe('attempt-cap');
  });
});

describe('jitter', () => {
  it('spreads the backoff delay rather than handing every worker the same tick', () => {
    const draws = Array.from({ length: 200 }, () => retryPlan({ attempt: 1, spentWaitMs: 0 }).delayMs);
    // A spread, not a fixed value — pooled workers must not wake together.
    expect(new Set(draws).size).toBeGreaterThan(20);
    // Equal jitter: half the schedule plus a random half; the floor keeps a near-zero wait out of an empty bucket.
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(RETRY.BASE_DELAY_MS / 2);
    expect(Math.max(...draws)).toBeLessThanOrEqual(RETRY.BASE_DELAY_MS);
    expect(Math.max(...draws) - Math.min(...draws)).toBeGreaterThan(RETRY.BASE_DELAY_MS / 8);
  });

  it('spreads a Retry-After wait too, without ever shortening it', () => {
    const draws = Array.from(
      { length: 200 },
      () => retryPlan({ attempt: 1, retryAfterMs: 12_000, spentWaitMs: 0 }).delayMs,
    );
    expect(new Set(draws).size).toBeGreaterThan(20);
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(12_000);
    expect(Math.max(...draws)).toBeLessThanOrEqual(12_000 + RETRY.RETRY_AFTER_SPREAD_MS);
  });

  it('grows the delay with the attempt number', () => {
    const at = (attempt: number) =>
      Math.min(...Array.from({ length: 50 }, () => retryPlan({ attempt, spentWaitMs: 0 }).delayMs));
    expect(at(2)).toBeGreaterThan(at(1));
    expect(at(3)).toBeGreaterThan(at(2));
    // Bounded per sleep, so one attempt can't eat the whole budget.
    const fourth = Array.from({ length: 50 }, () => retryPlan({ attempt: 4, spentWaitMs: 0 }).delayMs);
    expect(Math.max(...fourth)).toBeLessThanOrEqual(RETRY.MAX_DELAY_MS);
  });
});

describe('concurrency is settable, and defaults to what the drivers always used', () => {
  it('reads POOL, defaults to the caller`s constant, and rejects nonsense', () => {
    expect(poolSize(5)).toBe(5);
    expect(poolSize(3)).toBe(3);
    process.env[POOL_ENV] = '2';
    expect(poolSize(5)).toBe(2);
    process.env[POOL_ENV] = '  ';
    expect(poolSize(5)).toBe(5);
    for (const bad of ['0', '-1', 'abc', '2.5', 'o']) {
      process.env[POOL_ENV] = bad;
      expect(() => poolSize(5)).toThrow(/POOL/);
    }
  });

  it('is respected by a driver: runTriage runs POOL calls at a time', async () => {
    const cases = (TRIAGE_CASES as { id: string }[]).slice(0, 6);
    const reply = JSON.stringify({ where: 'room' });

    const concurrencyOf = async (): Promise<number> => {
      let live = 0;
      let peak = 0;
      const rows = await runTriage(cases, {
        sys: 'sys',
        call: async () => {
          live++;
          peak = Math.max(peak, live);
          await Promise.resolve();
          live--;
          return { text: reply, complete: 100 };
        },
      });
      expect(rows).toHaveLength(cases.length);
      return peak;
    };

    // The historical default, unset.
    expect(await concurrencyOf()).toBe(4);
    process.env[POOL_ENV] = '2';
    expect(await concurrencyOf()).toBe(2);
    process.env[POOL_ENV] = '6';
    expect(await concurrencyOf()).toBe(6);
  });

  // defect.mjs/turns.mjs pools are read as source text (isMain import bills a campaign), per triage.test.ts.
  // What matters: the hardcoded constant is gone, and the fallback matches every stored run's value.
  it('leaves defect.mjs and turns.mjs defaulting to their own historical values', () => {
    const read = (f: string) => fs.readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
    const defect = read('./defect.mjs');
    expect(defect).toContain('poolSize(5)');
    expect(defect).not.toMatch(/const POOL = 5/);
    const turns = read('./turns.mjs');
    expect(turns).toContain('poolSize(3)');
    expect(turns).not.toMatch(/const POOL = 3/);
    expect(read('./triage.mjs')).toContain('poolSize(4)');
  });
});

describe('inter-request pacing', () => {
  it('is off by default, so an unset MIN_GAP_MS dispatches exactly as before', async () => {
    expect(minGapMs()).toBe(0);
    stubResponses([() => okResponse('Noon.')]);

    await onFakeClock(async () => {
      await Promise.all([
        runCall(CANDIDATE, { system: 's', user: 'u' }),
        runCall(CANDIDATE, { system: 's', user: 'u' }),
        runCall(CANDIDATE, { system: 's', user: 'u' }),
      ]);
    });

    expect(attempts).toHaveLength(3);
    expect(attempts[2].at - attempts[0].at).toBe(0);
  });

  it('holds a floor between dispatches when MIN_GAP_MS asks for one', async () => {
    process.env[MIN_GAP_ENV] = '250';
    expect(minGapMs()).toBe(250);
    stubResponses([() => okResponse('Noon.')]);

    await onFakeClock(async () => {
      await Promise.all([
        runCall(CANDIDATE, { system: 's', user: 'u' }),
        runCall(CANDIDATE, { system: 's', user: 'u' }),
        runCall(CANDIDATE, { system: 's', user: 'u' }),
      ]);
    });

    expect(attempts).toHaveLength(3);
    // Queued behind each other, not firing together, unlike a per-worker sleep.
    expect(attempts[1].at - attempts[0].at).toBeGreaterThanOrEqual(250);
    expect(attempts[2].at - attempts[1].at).toBeGreaterThanOrEqual(250);
    expect(transportTally().pacedMs).toBeGreaterThanOrEqual(750);
  });

  it('rejects a nonsense gap rather than silently ignoring it', () => {
    for (const bad of ['abc', '-1']) {
      process.env[MIN_GAP_ENV] = bad;
      expect(() => minGapMs()).toThrow(/MIN_GAP_MS/);
    }
  });
});
