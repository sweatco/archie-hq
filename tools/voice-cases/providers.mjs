// Raw fetch on purpose: production calls each provider with bare fetch + manual SSE, so this harness measures that exact path, not an SDK's.
// Wire shapes: Cerebras copies comprehension.ts's request; Anthropic keeps the Messages API differences: system as a field vs. a message, max_tokens vs. max_completion_tokens, clean close vs. explicit [DONE].
// Adds rate-limit survival production lacks: runCall retries a 429 with Retry-After honoured and bounded backoff (pacing.mjs) — a live meeting can't wait 40s, so production's own retry story differs.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SentenceEmitter, parseReply } from './emitter.mjs';
import {
  isRateLimited,
  noteExhausted,
  notePaced,
  noteRateLimited,
  noteRequest,
  noteRetry,
  paceDispatch,
  retryAfterMs,
  retryPlan,
  sleep,
} from './pacing.mjs';

const MAIN_ENV_FILE = '/Users/khmelev/Projects/swc/archie-hq/.env';
// This harness's own checkout/worktree: doesn't generally carry shared repo secrets, but a worktree-local addition like CEREBRAS_API_KEY may live only here.
const WORKTREE_ENV_FILE = fileURLToPath(new URL('../../.env', import.meta.url));

function readEnvKey(file, name) {
  if (!fs.existsSync(file)) return undefined;
  const line = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${name}=`));
  if (!line) return undefined;
  const value = line
    .slice(name.length + 1)
    .trim()
    .replace(/^["']|["']$/g, '');
  return value.length > 0 ? value : undefined;
}

// .env beats the ambient environment, so a stale exported value can't redirect a live key. process.env is the last resort — lets tests or a sandbox run this path without secrets.
function keyFromFilesOrEnv(name, files) {
  for (const f of files) {
    const v = readEnvKey(f, name);
    if (v) return v;
  }
  const ambient = process.env[name];
  return ambient && ambient.length > 0 ? ambient : undefined;
}

export function anthropicKey() {
  const key = keyFromFilesOrEnv('ANTHROPIC_API_KEY', [MAIN_ENV_FILE]);
  if (!key) throw new Error('ANTHROPIC_API_KEY not in ' + MAIN_ENV_FILE + ' or the environment');
  return key;
}

// Mirrors anthropicKey's resolution, plus the worktree's own .env as a fallback for a worktree-local key the main checkout never carries.
export function cerebrasKey() {
  const key = keyFromFilesOrEnv('CEREBRAS_API_KEY', [MAIN_ENV_FILE, WORKTREE_ENV_FILE]);
  if (!key) {
    throw new Error(`CEREBRAS_API_KEY not in ${MAIN_ENV_FILE}, ${WORKTREE_ENV_FILE} or the environment`);
  }
  return key;
}

// ---- <think> stripping, for the one arm that still needs it ----
//
// Production stripped `<think>...</think>` out of the content channel until 8c2d2621 and does not any more: reasoning arrives on its own channel, so a tag on the content channel is text
// a room would hear. That is why nothing downstream of here strips anything. But a prompt that *asks* for those tags is still a measurable arm — it is what production sent one commit ago —
// and grading its reasoning as speech would score every row of that arm on text no room was ever going to hear. So the strip lives here, on the wire, behind an explicit switch, and reaches
// exactly the arm whose prompt asks for the tags.
//
// Reimplemented from the function comprehension.ts used to export, semantics included, because production no longer has one to import. `final` flips two verdicts: mid-stream a trailing
// partial opening tag (`<thi`, one delta short of a real one) and a block opened but not yet closed are held back; at the end a partial tag was never completing and is kept as speech, while
// an unclosed block is discarded along with everything after it. Blocks do not nest — the first `</think>` closes the opening tag.
const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/** Length of a trailing run of `text` that is a genuine prefix of `<think>`, zero if not. Longest match wins; a complete tag is found by indexOf first. */
function partialOpenTagAtEnd(text) {
  for (let len = Math.min(text.length, THINK_OPEN.length - 1); len > 0; len--) {
    if (text.endsWith(THINK_OPEN.slice(0, len))) return len;
  }
  return 0;
}

export function stripThinkBlocks(text, final) {
  let visible = '';
  const thoughts = [];
  let cursor = 0;
  for (;;) {
    const openAt = text.indexOf(THINK_OPEN, cursor);
    if (openAt === -1) {
      const rest = text.slice(cursor);
      const risky = final ? 0 : partialOpenTagAtEnd(rest);
      visible += risky > 0 ? rest.slice(0, rest.length - risky) : rest;
      break;
    }
    visible += text.slice(cursor, openAt);
    const closeAt = text.indexOf(THINK_CLOSE, openAt + THINK_OPEN.length);
    if (closeAt === -1) break;
    thoughts.push(text.slice(openAt + THINK_OPEN.length, closeAt));
    cursor = closeAt + THINK_CLOSE.length;
  }
  return { visible, thought: thoughts.join('\n\n') };
}

export const STRIP_THINK_ENV = 'STRIP_THINK';

/** Whether this run's prompt asks for `<think>` tags. Unset is off, since the live prompt does not; an unrecognised value throws before anything is billed, for resolveContextArm's reason. */
export function stripThinkEnabled() {
  const raw = (process.env[STRIP_THINK_ENV] ?? '').trim().toLowerCase();
  if (raw === '' || raw === '0' || raw === 'false') {
    return false;
  } else if (raw === '1' || raw === 'true') {
    return true;
  } else {
    throw new Error(
      `${STRIP_THINK_ENV}="${process.env[STRIP_THINK_ENV]}" is not a switch. Use 1/true or 0/false, or leave it unset. ` +
      `Reading it as off would grade a prompted-<think> arm's reasoning as speech and fail every row of it; ` +
      `reading it as on would strip a tag the live prompt never asks for, hiding a real leak.`,
    );
  }
}

// `price` is USD per 1M tokens, omitted rather than guessed where no confirmed rate card exists — costUsd() throws instead of reporting a made-up or zero cost.
export const CANDIDATES = {
  'haiku-4.5': {
    provider: 'anthropic', model: 'claude-haiku-4-5-20251001',
    temperature: 0, price: { in: 1, out: 5 }, note: 'production baseline',
  },
  'sonnet-4.5': {
    provider: 'anthropic', model: 'claude-sonnet-4-5-20250929',
    temperature: 0, price: { in: 3, out: 15 }, note: 'price not in current table; $3/$15 assumed',
  },
  'sonnet-4.6': {
    provider: 'anthropic', model: 'claude-sonnet-4-6',
    temperature: 0, price: { in: 3, out: 15 }, note: 'thinking omitted => off',
  },
  'sonnet-5': {
    provider: 'anthropic', model: 'claude-sonnet-5',
    thinking: 'disabled', price: { in: 2, out: 10 }, note: 'temperature rejected on this model',
  },
  'opus-5': {
    provider: 'anthropic', model: 'claude-opus-5',
    thinking: 'disabled', effort: 'low', price: { in: 5, out: 25 },
  },
  'opus-5-fast': {
    provider: 'anthropic', model: 'claude-opus-5', beta: 'fast-mode-2026-02-01',
    speed: 'fast', thinking: 'disabled', effort: 'low', price: { in: 10, out: 50 },
    note: 'research-preview fast mode, premium pricing',
  },
  // The model production runs. No price entry — Cerebras's per-token rate isn't confirmed against a published card.
  // The pre-thinking request shape, which is what production sent up to and including 68a16c6e: no `reasoning_effort` key at all, and the 600-token cap that was SPEAKING_MAX_TOKENS then.
  // Kept exactly as it was rather than moved forward with production: it is the baseline arm, and every stored row in results/ was collected under these bytes.
  'cerebras-gemma-4-31b': {
    provider: 'cerebras', model: 'gemma-4-31b',
    temperature: 0, maxTokens: 600, note: 'baseline — production up to 68a16c6e, prompted <think>',
  },
  // Production at HEAD: the same model asking for its own reasoning channel and sending no token cap — reasoning is billed as completion tokens, a cap it could reach would truncate the answer, and the request timeout is the bound.
  // `reasoning_effort: 'medium'`, no `max_completion_tokens`, no `reasoning_format` — the body is the shape requestBody() builds with `reasoning: true`, field for field.
  'cerebras-gemma-4-31b-thinking': {
    provider: 'cerebras', model: 'gemma-4-31b',
    temperature: 0, reasoningEffort: 'medium',
    note: 'production candidate — mirrors comprehension.ts requestBody with reasoning: true',
  },
};

function anthropicBody(c, { system, user, maxTokens, stream }) {
  const body = {
    model: c.model,
    max_tokens: maxTokens,
    stream,
    system,
    messages: [{ role: 'user', content: user }],
  };
  if (c.temperature !== undefined) body.temperature = c.temperature;
  if (c.thinking === 'disabled') body.thinking = { type: 'disabled' };
  if (c.effort) body.output_config = { effort: c.effort };
  if (c.speed) body.speed = c.speed;
  return body;
}

// Matches comprehension.ts's requestBody: `system` is a message with the system role, not a top-level field; a candidate with a cap sends it as `max_completion_tokens` (`max_tokens` is the deprecated alias); one without sends no cap at all.
// `reasoning_effort` is appended last and only for a candidate that asks for it, exactly as production appends it only for a call with `reasoning: true` — and no `reasoning_format` key on either arm, because production sends none.
function cerebrasBody(c, { system, user, maxTokens, stream }) {
  const body = {
    model: c.model,
    ...(maxTokens === undefined ? {} : { max_completion_tokens: maxTokens }),
    temperature: c.temperature ?? 0,
    stream,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  if (c.reasoningEffort !== undefined) {
    body.reasoning_effort = c.reasoningEffort;
  }
  return body;
}

const WIRE = {
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    headers: (c) => {
      const h = {
        'content-type': 'application/json',
        'x-api-key': anthropicKey(),
        'anthropic-version': '2023-06-01',
      };
      if (c.beta) h['anthropic-beta'] = c.beta;
      return h;
    },
    body: anthropicBody,
  },
  cerebras: {
    url: 'https://api.cerebras.ai/v1/chat/completions',
    headers: () => ({
      'content-type': 'application/json',
      authorization: `Bearer ${cerebrasKey()}`,
    }),
    body: cerebrasBody,
  },
};

// Returns null for a frame carrying no *content* (keep-alives, role/usage-only frames, a reasoning-only frame, [DONE]) — callers treat that as "nothing yet", not a failure. Mirrors comprehension.ts's deltaFrom.
// Reasoning is accumulated onto `m` here and never returned, which is what keeps it out of the reply text and out of the emitter: only a returned string reaches either.
function frameFrom(providerName, payload, m) {
  if (providerName === 'cerebras' && payload === '[DONE]') {
    return null; // The documented end-of-stream sentinel, and not JSON.
  }
  let ev;
  try {
    ev = JSON.parse(payload);
  } catch {
    return null;
  }

  if (providerName === 'anthropic') {
    if (ev.type === 'message_start') {
      const u = ev.message?.usage ?? {};
      m.inputTokens = u.input_tokens ?? null;
      m.cacheRead = u.cache_read_input_tokens ?? null;
      m.cacheWrite = u.cache_creation_input_tokens ?? null;
    } else if (ev.type === 'message_delta') {
      m.outputTokens = ev.usage?.output_tokens ?? m.outputTokens;
    } else if (ev.type === 'error') {
      m.error = `stream error: ${ev.error?.type} ${ev.error?.message}`;
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      return ev.delta.text ?? null;
    }
    return null;
  } else {
    // An in-band error is permitted here, though every failure so far has come back as an HTTP status instead. A usage-only frame carries `usage`, no `choices[0].delta.content`; both fall through to null.
    if (ev.choices === undefined && typeof ev.message === 'string') {
      m.error = `stream error: ${ev.code ?? 'unknown'} ${ev.message}`;
      return null;
    }
    if (ev.usage) {
      m.inputTokens = ev.usage.prompt_tokens ?? m.inputTokens;
      m.outputTokens = ev.usage.completion_tokens ?? m.outputTokens;
      // Only present once the request asked for reasoning; left at whatever it already was otherwise, so "the field never arrived" stays distinguishable from "no reasoning".
      const reasoned = ev.usage.completion_tokens_details?.reasoning_tokens;
      if (typeof reasoned === 'number') m.reasoningTokens = reasoned;
    }
    const delta = ev.choices?.[0]?.delta;
    if (typeof delta?.reasoning === 'string') {
      m.reasoning += delta.reasoning;
      if (m.reasoningAt === null) m.reasoningAt = m.now();
    }
    const finish = ev.choices?.[0]?.finish_reason;
    if (typeof finish === 'string') m.finishReason = finish;
    return typeof delta?.content === 'string' ? delta.content : null;
  }
}

// One streaming attempt, instrumented; timings in ms from just before fetch().
// Each attempt gets its own metrics object and t0, so TTFT excludes sleep time — why the retry loop wraps this function in runCall, not inside it.
// `ttft` is time to first *content* token on every arm, which is the comparable quantity: a prompted-<think> arm spends its reasoning on the content channel and a native-reasoning one does not,
// and that difference is the measurement, not something to normalise away. `reasoningAt` is the first reasoning token, recorded separately and never confused with it.
async function attemptCall(candidateId, c, wire, url, headers, { system, user, maxTokens, timeoutMs }) {
  notePaced(await paceDispatch());
  noteRequest();

  const strip = stripThinkEnabled();
  const m = {
    candidate: candidateId, ttft: null, firstSentence: null, complete: null,
    headers_at: null, text: '', raw: '', inputTokens: null, outputTokens: null,
    cacheRead: null, cacheWrite: null, sentences: [], error: null,
    thinkingLeak: false, status: null, rateLimited: false, retryAfterMs: null,
    // Reasoning off the model's own channel: the text, when it started arriving, how many tokens the provider billed for it, and why generation stopped.
    // `reasoningTokens` starts at 0 for a candidate that asks for no reasoning and null for one that does, so a missing `completion_tokens_details` reads as "never reported", not as "none".
    reasoning: '', reasoningAt: null, finishReason: null,
    reasoningTokens: c.reasoningEffort === undefined ? 0 : null,
    strippedThink: strip, thought: '',
  };

  const t0 = performance.now();
  const now = () => performance.now() - t0;
  // frameFrom timestamps the first reasoning delta; it holds no clock of its own.
  m.now = now;

  const emitter = new SentenceEmitter((s) => {
    m.sentences.push({ at: now(), text: s });
  });

  // Hands the emitter and `m.text` only what is settled speech. Without the strip arm that is every content delta; with it, whatever the strip has resolved so far.
  const handOver = (chunk) => {
    if (chunk.length === 0) return;
    m.text += chunk;
    const before = emitter.emitted;
    emitter.push(chunk);
    if (m.firstSentence === null && emitter.emitted > before) {
      m.firstSentence = m.sentences[0].at;
    }
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(wire.body(c, { system, user, maxTokens, stream: true })),
      signal: AbortSignal.timeout(timeoutMs),
    });
    m.headers_at = now();
    m.status = res.status;
    if (!res.ok) {
      m.error = `HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`;
      if (isRateLimited(res.status)) {
        m.rateLimited = true;
        m.retryAfterMs = retryAfterMs(res.headers);
      }
      return m;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let cut = buf.indexOf('\n');
      while (cut !== -1) {
        const line = buf.slice(0, cut);
        buf = buf.slice(cut + 1);
        const t = line.trimEnd();
        if (t.startsWith('data:')) {
          const payload = t.slice(5).trim();
          if (payload) {
            const d = frameFrom(c.provider, payload, m);
            if (d) {
              if (m.ttft === null) m.ttft = now();
              m.raw += d;
              // Mid-stream (`final` false): a trailing partial `<thi` and an unclosed block are withheld, so neither reaches the room as speech. `visible` only ever grows as a prefix, so the slice is the new part.
              handOver(strip ? stripThinkBlocks(m.raw, false).visible.slice(m.text.length) : d);
            }
          }
        }
        cut = buf.indexOf('\n');
      }
    }
    await reader.cancel().catch(() => {});
    m.complete = now();
    if (strip) {
      // Final pass: a partial opening tag was never going to complete and is speech after all, and an unclosed block takes everything after it with it. Both can only add to `visible`, never take back what was handed over.
      const done = stripThinkBlocks(m.raw, true);
      m.thought = done.thought;
      handOver(done.visible.slice(m.text.length));
    }
    const before = emitter.emitted;
    emitter.finish();
    if (m.firstSentence === null && emitter.emitted > before) {
      m.firstSentence = m.sentences[0].at;
    }
    m.parsed = parseReply(m.text);
    m.emitted = emitter.emitted;
    m.regionShrank = emitter.regionShrank;
    m.reasoningChars = m.reasoning.length;
    // A literal `<think>` surviving into the spoken half is a defect in either arm, and a different one in each: with native reasoning nothing removes it, so the room hears the tag read out;
    // under the strip arm a well-formed block is gone, so what is left is a malformed tag the strip could not pair. Checked on `<think>`, never `<thinking>` — the wrong tag name graded everything clean once already.
    const spokenHalf = m.parsed.silent === true ? m.text : m.parsed.speech;
    if (/<\/?think>/i.test(spokenHalf)) m.thinkingLeak = true;
  } catch (e) {
    m.error = String(e?.message ?? e);
  }
  return m;
}

// Only 429 retries; everything else returns on the first attempt, so a broken request fails fast instead of costing five waits for the same answer. isRateLimited/RETRY: pacing.mjs.
// Returns the last attempt's metrics plus attempts/rateLimitedAttempts/retryWaitMs, never summed — a rate-limited attempt has no tokens, and a graded row must read as one request's usage, not several.
export async function runCall(candidateId, { system, user, maxTokens = 600, timeoutMs = 30000 }) {
  const c = CANDIDATES[candidateId];
  if (!c) throw new Error('unknown candidate ' + candidateId);
  const wire = WIRE[c.provider];
  if (!wire) throw new Error('provider not wired: ' + c.provider);

  const url = wire.url;
  // Resolved once, not per attempt: repeated reads tell us nothing, and a mid-call key rotation isn't a case here.
  const headers = wire.headers(c);
  // A candidate's own cap wins over the caller's: the two Cerebras arms differ by it (600 before native thinking, 2000 after), and that difference is production's, not a knob for a driver to set.
  const opts = { system, user, maxTokens: c.maxTokens ?? maxTokens, timeoutMs };

  let attempts = 0;
  let rateLimitedAttempts = 0;
  let spentWaitMs = 0;
  for (;;) {
    const m = await attemptCall(candidateId, c, wire, url, headers, opts);
    attempts++;
    if (!m.rateLimited) {
      return { ...m, attempts, rateLimitedAttempts, retryWaitMs: spentWaitMs };
    }
    rateLimitedAttempts++;
    noteRateLimited();
    const plan = retryPlan({ attempt: attempts, retryAfterMs: m.retryAfterMs, spentWaitMs });
    if (!plan.retry) {
      noteExhausted();
      // The row is lost either way, but sampling.mjs classes this text as `rate-limit`, not unexplained — "pace slower next time" vs. "something is broken".
      m.error +=
        ` [gave up after ${attempts} attempt(s) and ${(spentWaitMs / 1000).toFixed(1)}s of backoff: ${plan.reason}` +
        (plan.reason === 'retry-after-over-budget' ? `, server asked for ${plan.delayMs}ms` : '') + ']';
      return { ...m, attempts, rateLimitedAttempts, retryWaitMs: spentWaitMs };
    }
    await sleep(plan.delayMs);
    spentWaitMs += plan.delayMs;
    noteRetry(plan.delayMs);
  }
}

// Takes token counts explicitly — one attempt's own counters, never summed across retries: dcases.mjs's/long-transcripts.mjs's CHARS_PER_TOKEN fits read these fields and would skew on a summed value.
export function costUsd(candidateId, inputTokens, outputTokens) {
  const p = CANDIDATES[candidateId].price;
  if (!p) throw new Error(`no confirmed per-token price for ${candidateId} — do not estimate one`);
  return (inputTokens / 1e6) * p.in + (outputTokens / 1e6) * p.out;
}

export function stats(xs) {
  const a = xs.filter((x) => typeof x === 'number' && !Number.isNaN(x)).sort((x, y) => x - y);
  if (a.length === 0) return null;
  const q = (p) => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1) + 0.5))];
  return {
    n: a.length, min: a[0], p50: q(0.5), p90: q(0.9), max: a[a.length - 1],
    mean: a.reduce((s, x) => s + x, 0) / a.length,
    iqr: q(0.75) - q(0.25),
  };
}
