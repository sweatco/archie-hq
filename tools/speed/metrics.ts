/**
 * metrics.ts — the pure core of the speed suite.
 *
 * One question: where did the wall-clock go between a person asking Archie
 * something and Archie answering? Everything here is a pure function over
 * records already written to disk during a normal run, so a measurement can be
 * taken from a live campaign, from a session captured weeks ago, or from a
 * fixture — with no live instance and no re-run.
 *
 * Three sources, three tiers of detail. Each degrades on its own: a caller with
 * only `events` still gets the numbers a user feels, and the richer fields come
 * back `null` rather than fabricated.
 *
 *   events      shared/events.jsonl                      always present
 *               → time-to-first-word, time-to-completion, delegation hops
 *   transcripts claude/<agent>/session/projects/**.jsonl  local runs
 *               → round-trip count and cost, tool mix, pre-speech round trips
 *   usage       shared/usage.jsonl                        always present
 *               → tokens, cache behaviour, model, and the SERVING TIER
 *
 * The serving tier is in the third tier for a reason: a latency comparison that
 * does not control for it is measuring the tier, not the change under test.
 */

// ---- Source records -------------------------------------------------------
//
// Deliberately re-declared rather than imported from src/. This harness must
// parse records emitted by a *different build* of Archie than the one it is
// running from — an arm collected before a change, compared against an arm
// collected after it — so coupling it to the current in-tree types would make
// old evidence unreadable the moment a type changed. Unknown fields are
// ignored, absent fields are tolerated.

/** A row of `shared/events.jsonl`. Mirrors `SystemEvent` structurally. */
export interface SpeedEvent {
  type: string;
  taskId: string;
  timestamp: string;
  agentName?: string;
  data?: Record<string, unknown>;
}

/** One agent's Claude session transcript, already parsed and tagged. */
export interface AgentTranscript {
  /** Archie's agent id, e.g. `pm` — the directory name under `claude/`. */
  agentKey: string;
  entries: TranscriptEntry[];
}

/** A row of a session `.jsonl`. Rows without a `message` are structural. */
export interface TranscriptEntry {
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    usage?: Record<string, unknown>;
  };
}

/** A row of `shared/usage.jsonl`. */
export interface UsageRecord {
  ts?: string;
  agentId?: string;
  query_nonce?: string;
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    contextWindow?: number;
    costUSD?: number;
  }>;
  usage?: {
    speed?: string;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface TaskSources {
  taskId: string;
  events: SpeedEvent[];
  transcripts?: AgentTranscript[];
  usage?: UsageRecord[];
}

// ---- Output ---------------------------------------------------------------

/**
 * One prompt-and-answer cycle: a message addressed to the PM, and the first
 * thing the user heard back. A task usually holds several.
 */
export interface Exchange {
  index: number;
  /** Who sent the prompt, verbatim from the event. */
  from: string;
  /** First 120 chars of the prompt, for reading a report without the raw log. */
  promptPreview: string;
  promptAt: string;
  /** First `message` from the PM to the user after the prompt. */
  firstWordAt: string | null;
  /** The number a person actually experiences. `null` if Archie never replied. */
  timeToFirstWordMs: number | null;
  /** Prompt → `task:completed`. `null` while the task is still open. */
  timeToCompletionMs: number | null;
}

/**
 * A hand-off to another agent, split into the two costs that have different
 * causes: getting the agent running, and the agent's own first turn.
 */
export interface Delegation {
  agent: string;
  dispatchedAt: string;
  /** Dispatch → `agent:active`. Engine-side; historically ~0. */
  dispatchToActiveMs: number | null;
  /**
   * `agent:active` → the agent's first `agent:log` or outbound `message`.
   * This is the real price of a hop: a fresh CLI subprocess, its own MCP
   * servers, and a cold system-prompt cache write.
   */
  activeToFirstOutputMs: number | null;
}

/**
 * One model round trip: a tool result went in, the next tool call came out.
 * Covers thinking, output generation, network, and local dispatch overhead —
 * it is a wall-clock span between two transcript rows, not a server-side timer,
 * and is reported as such rather than attributed to any one of those.
 *
 * Parallel tool calls in a single assistant message count as ONE round trip
 * (they are one inference), while every tool name in it lands in the tool mix.
 */
export interface RoundTrip {
  agentKey: string;
  tools: string[];
  roundTripMs: number;
  /** 0-based position among that agent's round trips. */
  ordinal: number;
  /** Epoch ms of the assistant row that closed this round trip, so a report can bucket trips by exchange. */
  atMs: number;
  /**
   * True when this round trip produced nothing the user could see AND the user
   * had not yet heard anything — pure setup, spent while someone waits in
   * silence. The round trip that *does* speak is false: it is the one doing the
   * work the wait was for. Counting it as setup would make an unavoidable trip
   * look like waste and hide real movement in the number.
   */
  silentSetup: boolean;
}

/**
 * Per-arm mechanism counters — the check that separates "this tweak did
 * nothing" from "this tweak never had a target".
 *
 * Each tweak claims to remove a specific behaviour. If the behaviour is absent
 * from the baseline too, the arm measured nothing and reporting it as a
 * negative would retire the idea for the wrong reason. These are counted from
 * the transcript rather than inferred from latency.
 */
export interface Mechanisms {
  /**
   * Turns spent fetching knowledge.log — by ANY route. Counted across `Read`
   * and `Bash`, because the PM on the current build reaches for `cat` rather
   * than `Read`, and a counter that only knew about `Read` would report the
   * behaviour as absent while it happens on every single turn.
   */
  knowledgeLogFetches: number;
  /** `Read` calls carrying a `pages` argument — the T1 target. */
  readWithPages: number;
  /** `ToolSearch` calls — the T2 target. */
  toolSearches: number;
  /** `Skill` loads. */
  skillLoads: number;
}

export interface UsageSummary {
  /** Distinct model ids that served this task. */
  models: string[];
  /**
   * Serving tiers seen, e.g. `['standard']`. An arm whose tiers differ from
   * the arm it is compared against is not a valid comparison.
   */
  speedTiers: string[];
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /**
   * Only counted for models the SDK priced natively. Gateway-routed models are
   * priced at Opus rates regardless of what actually served them, so their cost
   * is confidently wrong rather than merely absent — excluded, and counted in
   * `costUnpricedRecords` so a report can say so instead of implying $0.
   */
  costUSD: number;
  costUnpricedRecords: number;
}

/**
 * Where the wall-clock actually goes, in phases that have different fixes.
 *
 * The transcript writes ONE ROW PER CONTENT BLOCK, all rows of a single
 * response sharing that response's `usage` object. So a reply that thinks, then
 * writes text, then emits a tool call is three rows with three timestamps and
 * one usage — which is what makes this decomposition possible at all: the usage
 * object is the inference's identity, and the gaps between its rows are
 * generation, not separate round trips.
 *
 * Phases, in the order a turn spends them:
 *   dispatch  the engine accepting the message and the agent reaching its first
 *             transcript row — queue, spawn, MCP connect
 *   ttft      user row -> the inference's FIRST block. Thinking lives here.
 *   generate  first block -> last block of the same inference. Streaming.
 *   tool      the tool_use row -> the tool_result row. Actual work done locally.
 *
 * All four sum to roughly time-to-first-word; whatever is left over is the gap
 * between the last tool call and the user-visible event, which is small and
 * folded into `unaccountedMs` rather than hidden.
 */
export interface Waterfall {
  dispatchMs: number;
  ttftMs: number;
  generateMs: number;
  toolMs: number;
  /** Time-to-first-word minus the four phases. Should be small; watch it. */
  unaccountedMs: number;
  /** Number of model responses before the first user-visible message. */
  inferences: number;
}

export interface SpeedSample {
  taskId: string;
  exchanges: Exchange[];
  delegations: Delegation[];
  roundTrips: RoundTrip[];
  /**
   * How many round trips the PM burned on setup before the one that finally
   * spoke. The leading indicator: time-to-first-word is roughly this times the
   * per-round-trip cost, so it moves before the felt latency does. `null`
   * without a PM transcript.
   */
  silentSetupRoundTrips: number | null;
  /** Tool name → call count, across every transcript supplied. */
  toolMix: Record<string, number>;
  mechanisms: Mechanisms;
  /** Phase breakdown of the FIRST exchange. `null` without a PM transcript. */
  waterfall: Waterfall | null;
  usage: UsageSummary | null;
  /**
   * Gaps rejected as not-a-round-trip, and why. Never silently dropped: a
   * suite that hides what it excluded reads as if it covered everything.
   */
  excluded: { overCap: number; capMs: number };
}

// ---- Extraction -----------------------------------------------------------

const ms = (a: string, b: string): number => Date.parse(b) - Date.parse(a);

/**
 * Upper bound on a gap that can plausibly be one model round trip. Above it the
 * agent was parked — waiting on a delegate, on a human approval, or on a
 * reminder — and counting that as thinking time would swamp every real number.
 * Exposed so a report can state the bound it measured under.
 */
export const ROUND_TRIP_CAP_MS = 300_000;

const isPmToUser = (e: SpeedEvent): boolean =>
  e.type === 'message' && e.data?.from === 'pm-agent' && e.data?.to === 'user';

const isPromptToPm = (e: SpeedEvent): boolean =>
  e.type === 'message' && e.data?.to === 'pm-agent';

/**
 * Split a task's event stream into prompt→answer cycles.
 *
 * A prompt is any message addressed to the PM — which is how a Slack message, a
 * CLI message and a GitHub webhook all arrive, so one definition covers every
 * entry point. A second prompt arriving before Archie has answered replaces the
 * pending one rather than opening a cycle of its own: the user asked twice and
 * felt one wait, and charging Archie for two would flatter the numbers.
 */
export function extractExchanges(events: SpeedEvent[]): Exchange[] {
  const out: Exchange[] = [];
  let pending: SpeedEvent | null = null;

  for (const e of events) {
    if (isPromptToPm(e)) {
      pending = e;
      continue;
    }
    // A task can complete and reopen several times. Each completion closes the
    // exchange it actually belongs to — the most recent one still open — rather
    // than the last exchange in the task, which for a reopened task sits in the
    // future and would produce a negative duration.
    if (e.type === 'task:completed') {
      const open = out[out.length - 1];
      if (open && open.timeToCompletionMs === null && Date.parse(open.promptAt) <= Date.parse(e.timestamp)) {
        open.timeToCompletionMs = ms(open.promptAt, e.timestamp);
      }
      continue;
    }
    if (pending && isPmToUser(e)) {
      out.push({
        index: out.length,
        from: String(pending.data?.from ?? 'unknown'),
        promptPreview: String(pending.data?.message ?? '').replace(/\s+/g, ' ').slice(0, 120),
        promptAt: pending.timestamp,
        firstWordAt: e.timestamp,
        timeToFirstWordMs: ms(pending.timestamp, e.timestamp),
        timeToCompletionMs: null,
      });
      pending = null;
    }
  }

  // A prompt Archie never answered is still a data point — the worst one.
  if (pending) {
    out.push({
      index: out.length,
      from: String(pending.data?.from ?? 'unknown'),
      promptPreview: String(pending.data?.message ?? '').replace(/\s+/g, ' ').slice(0, 120),
      promptAt: pending.timestamp,
      firstWordAt: null,
      timeToFirstWordMs: null,
      timeToCompletionMs: null,
    });
  }

  return out;
}

/**
 * Every hand-off from the PM to another agent, with the two halves of its cost.
 *
 * `agent:active` fires more than once per agent (each turn re-activates it), so
 * only the first activation after a dispatch is the spawn being measured.
 */
export function extractDelegations(events: SpeedEvent[]): Delegation[] {
  const out: Delegation[] = [];
  /** agent → the delegation still waiting for its first output. */
  const open = new Map<string, Delegation>();

  for (const e of events) {
    if (e.type === 'message' && e.data?.from === 'pm-agent') {
      const to = e.data?.to;
      if (typeof to === 'string' && to !== 'user' && !open.has(to)) {
        const d: Delegation = {
          agent: to,
          dispatchedAt: e.timestamp,
          dispatchToActiveMs: null,
          activeToFirstOutputMs: null,
        };
        open.set(to, d);
        out.push(d);
      }
      continue;
    }

    const actor = e.agentName ?? (typeof e.data?.from === 'string' ? e.data.from : undefined);
    if (!actor) continue;
    const d = open.get(actor);
    if (!d) continue;

    if (e.type === 'agent:active' && d.dispatchToActiveMs === null) {
      d.dispatchToActiveMs = ms(d.dispatchedAt, e.timestamp);
      continue;
    }
    // First thing the agent produced: a finding, or a message back.
    const produced = e.type === 'agent:log' || (e.type === 'message' && e.data?.from === actor);
    if (produced && d.dispatchToActiveMs !== null) {
      const activeAt = Date.parse(d.dispatchedAt) + d.dispatchToActiveMs;
      d.activeToFirstOutputMs = Date.parse(e.timestamp) - activeAt;
      open.delete(actor);
    }
  }
  return out;
}

const toolUses = (content: unknown): string[] => {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b): b is { type: string; name?: string } =>
      typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_use')
    .map((b) => b.name ?? 'unknown');
};

/**
 * Names the agent uses to speak or to end its turn. A round trip landing on one
 * of these is where "before first word" stops.
 */
const SPEECH_TOOLS = /post_to_user|post_files_to_user|report_completion|request_edit_mode|request_max_mode/;

/**
 * Round trips for one agent's transcript.
 *
 * The span measured is `user row (carrying the tool result) → next assistant
 * row containing a tool call`. Rows without timestamps are skipped rather than
 * guessed at; a gap over {@link ROUND_TRIP_CAP_MS} is excluded and counted.
 */
export function extractRoundTrips(t: AgentTranscript): { trips: RoundTrip[]; overCap: number } {
  const trips: RoundTrip[] = [];
  let overCap = 0;
  let lastResultAt: number | null = null;
  let spoke = false;
  let ordinal = 0;

  for (const entry of t.entries) {
    const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    const role = entry.message?.role;
    if (!entry.message || Number.isNaN(at)) continue;

    if (role === 'user') {
      lastResultAt = at;
      continue;
    }
    if (role !== 'assistant') continue;

    const tools = toolUses(entry.message.content);
    if (tools.length === 0) continue;

    const speaks = tools.some((n) => SPEECH_TOOLS.test(n));
    if (lastResultAt !== null) {
      const gap = at - lastResultAt;
      if (gap >= 0 && gap <= ROUND_TRIP_CAP_MS) {
        trips.push({
          agentKey: t.agentKey,
          tools,
          roundTripMs: gap,
          ordinal: ordinal++,
          atMs: at,
          silentSetup: !spoke && !speaks,
        });
      } else {
        overCap++;
      }
    }
    if (speaks) spoke = true;
    // One inference produced this message; the next round trip starts from the
    // result that answers it, so drop the consumed anchor.
    lastResultAt = null;
  }
  return { trips, overCap };
}

/**
 * A stable identity for the inference a row belongs to.
 *
 * Built from the usage counters, which the SDK stamps identically on every row
 * of one response and which differ between responses (output tokens always
 * advance). Rows with no usage — structural entries — return null and are
 * skipped rather than merged into whichever inference happens to be open.
 */
function inferenceKey(usage: Record<string, unknown> | undefined): string | null {
  if (!usage) return null;
  return [usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens].join('|');
}

/**
 * Decompose the run-up to the first user-visible message.
 *
 * Stops at the first speech tool, because everything after it is time the user
 * is no longer waiting through. `promptAt`/`firstWordAt` come from the event
 * log, so dispatch and the residual are measured against the same clock a
 * person experiences rather than against the transcript's own start.
 */
export function extractWaterfall(
  t: AgentTranscript,
  promptAt: string,
  firstWordAt: string,
): Waterfall | null {
  const promptMs = Date.parse(promptAt);
  const firstWordMs = Date.parse(firstWordAt);
  if (Number.isNaN(promptMs) || Number.isNaN(firstWordMs)) return null;

  // Rows inside the window, in order, that carry a timestamp and a message.
  const rows = t.entries
    .filter((e) => e.message && e.timestamp)
    .map((e) => ({ at: Date.parse(e.timestamp!), m: e.message! }))
    .filter((r) => !Number.isNaN(r.at) && r.at >= promptMs && r.at <= firstWordMs)
    .sort((a, b) => a.at - b.at);
  if (rows.length === 0) return null;

  const w: Waterfall = { dispatchMs: 0, ttftMs: 0, generateMs: 0, toolMs: 0, unaccountedMs: 0, inferences: 0 };

  const firstUser = rows.find((r) => r.m.role === 'user');
  w.dispatchMs = firstUser ? firstUser.at - promptMs : 0;

  let lastUserAt: number | null = firstUser ? firstUser.at : null;
  let openKey: string | null = null;
  let openFirstAt = 0;
  let openLastAt = 0;

  const closeInference = (): void => {
    if (openKey === null) return;
    w.generateMs += openLastAt - openFirstAt;
    w.inferences++;
    openKey = null;
  };

  for (const r of rows) {
    if (r.m.role === 'user') {
      // A tool result closes the inference that asked for it; the gap from the
      // tool call to here is the tool actually running.
      if (openKey !== null) w.toolMs += r.at - openLastAt;
      closeInference();
      lastUserAt = r.at;
      continue;
    }
    if (r.m.role !== 'assistant') continue;

    const key = inferenceKey(r.m.usage as Record<string, unknown> | undefined);
    if (key === null) continue;

    if (key !== openKey) {
      closeInference();
      openKey = key;
      openFirstAt = r.at;
      // First block of a new response: everything since the last input is the
      // model deciding what to say, thinking included.
      if (lastUserAt !== null) w.ttftMs += r.at - lastUserAt;
    }
    openLastAt = r.at;
  }
  closeInference();

  const total = firstWordMs - promptMs;
  w.unaccountedMs = total - (w.dispatchMs + w.ttftMs + w.generateMs + w.toolMs);
  return w;
}

const KNOWLEDGE_LOG = /knowledge\.log/;

/**
 * Count the behaviours the arms target.
 *
 * A knowledge-log fetch is any `Read` whose path names the log, or any `Bash`
 * whose command mentions it — `cat`, `head`, `tail`, a redirect, anything. The
 * loose match is deliberate: the question is "did this turn spend a round trip
 * getting the log", and every shape of that answer counts.
 */
export function extractMechanisms(transcripts: AgentTranscript[]): Mechanisms {
  const m: Mechanisms = { knowledgeLogFetches: 0, readWithPages: 0, toolSearches: 0, skillLoads: 0 };
  for (const t of transcripts) {
    for (const entry of t.entries) {
      if (entry.message?.role !== 'assistant') continue;
      const content = entry.message.content;
      if (!Array.isArray(content)) continue;
      for (const raw of content) {
        const b = raw as { type?: string; name?: string; input?: Record<string, unknown> };
        if (b.type !== 'tool_use') continue;
        const input = b.input ?? {};
        if (b.name === 'ToolSearch') m.toolSearches++;
        else if (b.name === 'Skill') m.skillLoads++;
        else if (b.name === 'Read') {
          if ('pages' in input) m.readWithPages++;
          if (KNOWLEDGE_LOG.test(String(input.file_path ?? ''))) m.knowledgeLogFetches++;
        } else if (b.name === 'Bash') {
          if (KNOWLEDGE_LOG.test(String(input.command ?? ''))) m.knowledgeLogFetches++;
        }
      }
    }
  }
  return m;
}

export function extractToolMix(transcripts: AgentTranscript[]): Record<string, number> {
  const mix: Record<string, number> = {};
  for (const t of transcripts) {
    for (const entry of t.entries) {
      if (entry.message?.role !== 'assistant') continue;
      for (const name of toolUses(entry.message.content)) {
        mix[name] = (mix[name] ?? 0) + 1;
      }
    }
  }
  return mix;
}

/**
 * Roll up `usage.jsonl`.
 *
 * Rows are cumulative per `query_nonce` — a later row for the same nonce
 * restates the running total, it does not add to it — so each nonce is reduced
 * with `max` per field. Summing them instead inflates the totals (measured at
 * ~162% of the real figure), which would make a token-reduction change look
 * like it did more than it did.
 */
export function summarizeUsage(records: UsageRecord[]): UsageSummary | null {
  if (records.length === 0) return null;

  const models = new Set<string>();
  const speedTiers = new Set<string>();
  /** nonce+model → the largest totals seen for it. */
  const peak = new Map<string, { out: number; cw: number; cr: number; cost: number; priced: boolean }>();
  let unpriced = 0;

  for (const r of records) {
    if (r.usage?.speed) speedTiers.add(r.usage.speed);
    const nonce = r.query_nonce ?? `${r.agentId ?? '?'}:${r.ts ?? '?'}`;
    for (const [model, u] of Object.entries(r.modelUsage ?? {})) {
      models.add(model);
      // A gateway-routed model (`vendor/model`) is priced by the SDK at Opus
      // rates whatever actually served it. Count the record, drop the number.
      const priced = !/^[a-z0-9-]+\//i.test(model) || model.toLowerCase().startsWith('anthropic/');
      const key = `${nonce}|${model}`;
      const prev = peak.get(key);
      const next = {
        out: Math.max(prev?.out ?? 0, u.outputTokens ?? 0),
        cw: Math.max(prev?.cw ?? 0, u.cacheCreationInputTokens ?? 0),
        cr: Math.max(prev?.cr ?? 0, u.cacheReadInputTokens ?? 0),
        cost: Math.max(prev?.cost ?? 0, u.costUSD ?? 0),
        priced,
      };
      peak.set(key, next);
    }
  }

  let outputTokens = 0, cacheCreationTokens = 0, cacheReadTokens = 0, costUSD = 0;
  for (const v of peak.values()) {
    outputTokens += v.out;
    cacheCreationTokens += v.cw;
    cacheReadTokens += v.cr;
    if (v.priced) costUSD += v.cost;
    else unpriced++;
  }

  return {
    models: [...models].sort(),
    speedTiers: [...speedTiers].sort(),
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    costUSD: Math.round(costUSD * 1e6) / 1e6,
    costUnpricedRecords: unpriced,
  };
}

/** Everything above, for one task. */
export function extractSample(sources: TaskSources): SpeedSample {
  const events = [...sources.events].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const transcripts = sources.transcripts ?? [];

  const roundTrips: RoundTrip[] = [];
  let overCap = 0;
  for (const t of transcripts) {
    const r = extractRoundTrips(t);
    roundTrips.push(...r.trips);
    overCap += r.overCap;
  }

  const pm = transcripts.find((t) => t.agentKey === 'pm');
  const silentSetupRoundTrips = pm
    ? extractRoundTrips(pm).trips.filter((r) => r.silentSetup).length
    : null;

  const exchanges = extractExchanges(events);

  return {
    taskId: sources.taskId,
    exchanges,
    delegations: extractDelegations(events),
    roundTrips,
    silentSetupRoundTrips,
    toolMix: extractToolMix(transcripts),
    mechanisms: extractMechanisms(transcripts),
    waterfall: (() => {
      const first = exchanges[0];
      if (!pm || !first?.firstWordAt) return null;
      return extractWaterfall(pm, first.promptAt, first.firstWordAt);
    })(),
    usage: sources.usage ? summarizeUsage(sources.usage) : null,
    excluded: { overCap, capMs: ROUND_TRIP_CAP_MS },
  };
}
