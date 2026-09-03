/**
 * Campaign throttling: how hard to push the API, and what to do when it pushes back.
 * Three parts: pace (paceDispatch — dispatch gap floor), retry (retryPlan — 429 handling), accounting (transportTally — requests vs. rows).
 * providers.mjs calls all three; drivers call poolSize() and read the tally. No model calls here. Inert unless an env var is set: POOL defaults to each driver's constant, MIN_GAP_MS to 0.
 */

// Exported so tests and the README reference the same names.
export const POOL_ENV = 'POOL';
export const MIN_GAP_ENV = 'MIN_GAP_MS';

// fallback = each driver's historical constant (5 defect.mjs, 3 turns.mjs): unset POOL matches prior runs. Malformed input throws, not defaults — POOL=o (letter o) would silently bill wrong concurrency, unlabeled.
export function poolSize(fallback) {
  const raw = process.env[POOL_ENV];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${POOL_ENV} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

// Minimum gap between dispatches, ms; 0 (default) is no pacing.
// A gap, not a smaller pool: the cap is tokens/minute; pool size only bounds rate for equal-cost requests, which these aren't (~10k tokens long-transcript, ~3k others). Gap bounds requests/minute directly (60000/gap).
export function minGapMs() {
  const raw = process.env[MIN_GAP_ENV];
  if (raw === undefined || raw.trim() === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${MIN_GAP_ENV} must be a non-negative number of milliseconds, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * Retry policy, as constants so the reasoning sits by the number.
 * MAX_ATTEMPTS = 5 (1 initial + 4 retries): unbounded retry would hang a foreground campaign. 5 is where caps meet — the schedule reaches MAX_TOTAL_WAIT_MS on the fourth sleep.
 * MAX_TOTAL_WAIT_MS = 75_000 (sleep time only): a TPM bucket is a 60s window, so 75s is one window plus slack; past it, re-run smaller instead of waiting.
 * BASE_DELAY_MS = 5_000 doubling, MAX_DELAY_MS = 40_000: schedule is 5s/10s/20s/40s = 75s, matching the wait cap — a successful request gets a full minute of bucket refill by its fourth sleep.
 * RETRY_AFTER_SPREAD_MS = 1_000: `Retry-After` is honoured as a floor, never shortened; the spread stops pooled workers waking on the same tick and colliding again.
 */
export const RETRY = Object.freeze({
  MAX_ATTEMPTS: 5,
  MAX_TOTAL_WAIT_MS: 75_000,
  BASE_DELAY_MS: 5_000,
  MAX_DELAY_MS: 40_000,
  RETRY_AFTER_SPREAD_MS: 1_000,
});

// 429 only: a 400 fails the same way every time, wasting 5x the wait. 5xx/529 aren't retried either — only the TPM 429 is measured here; broadening on speculation turns real breakage into slow breakage.
export function isRateLimited(status) {
  return status === 429;
}

/** Read one header from a `Headers` instance or from a plain object (stubs use both). */
function headerValue(headers, name) {
  if (headers === undefined || headers === null) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return v;
  }
  return null;
}

// Reads both RFC forms: delta-seconds (Anthropic/Cerebras) and HTTP-date. A past date yields 0. `nowMs` is injectable so tests avoid the wall clock.
export function retryAfterMs(headers, nowMs = Date.now()) {
  const raw = headerValue(headers, 'retry-after');
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const text = String(raw).trim();
  const seconds = Number(text);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

// Pure — testable without a clock or network. `attempt` = completed attempts; `spentWaitMs` accumulates only chosen delays, not a clock read, so the cap holds regardless of scheduling.
// Fallback delay is equal jitter (half nominal + random half), not full jitter (uniform over the whole delay): a near-zero full-jitter draw would hit the empty bucket and 429 again. Equal jitter de-correlates the five workers without waiting under half the schedule.
export function retryPlan({ attempt, retryAfterMs: afterMs = null, spentWaitMs = 0, random = Math.random }) {
  if (attempt >= RETRY.MAX_ATTEMPTS) {
    return { retry: false, reason: 'attempt-cap', delayMs: 0 };
  }
  let delayMs;
  let source;
  if (afterMs !== null && afterMs !== undefined) {
    delayMs = Math.round(afterMs + random() * RETRY.RETRY_AFTER_SPREAD_MS);
    source = 'retry-after';
  } else {
    const nominal = Math.min(RETRY.MAX_DELAY_MS, RETRY.BASE_DELAY_MS * 2 ** (attempt - 1));
    delayMs = Math.round(nominal / 2 + random() * (nominal / 2));
    source = 'backoff';
  }
  if (spentWaitMs + delayMs > RETRY.MAX_TOTAL_WAIT_MS) {
    return { retry: false, reason: source === 'retry-after' ? 'retry-after-over-budget' : 'wait-cap', delayMs };
  }
  return { retry: true, reason: source, delayMs };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One slot per call, so N workers queue instead of firing together: reading and rewriting `nextDispatchAt` with no `await` between is all the mutual exclusion a single-threaded runtime needs.
// minGapMs() is read per dispatch, not captured once, so it's live for a test that sets it and a driver reading it after argv parsing.
let nextDispatchAt = 0;

export async function paceDispatch() {
  const gap = minGapMs();
  if (gap <= 0) return 0;
  const now = Date.now();
  const at = Math.max(now, nextDispatchAt);
  nextDispatchAt = at + gap;
  const wait = at - now;
  if (wait > 0) await sleep(wait);
  return wait;
}

// A row carries only its attempt's tokens; this tally separately counts requests sent. `requests` > graded rows means retries, not double-counting — a rejected 429 bills no tokens.
const tally = {
  requests: 0,
  rateLimited: 0,
  retries: 0,
  waitedMs: 0,
  pacedMs: 0,
  exhausted: 0,
};

export function noteRequest() {
  tally.requests++;
}

export function noteRateLimited() {
  tally.rateLimited++;
}

export function noteRetry(waitedMs) {
  tally.retries++;
  tally.waitedMs += waitedMs;
}

export function notePaced(ms) {
  tally.pacedMs += ms;
}

/** A row abandoned after the caps were reached; the sample it cost is real. */
export function noteExhausted() {
  tally.exhausted++;
}

export function transportTally() {
  return { ...tally };
}

// Tests only — a campaign is one process; a test file runs many scenarios per process and would leak tally/dispatch state between them.
export function resetTransportState() {
  nextDispatchAt = 0;
  for (const k of Object.keys(tally)) tally[k] = 0;
}
