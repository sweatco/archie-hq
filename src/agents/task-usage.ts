/**
 * Task usage aggregation (pure, unit-testable).
 *
 * Answers "how much has this task used/cost so far?" from two independent data
 * sources, joined at report time:
 *
 *   TOKENS (source of truth, always available) — recursively read every SDK
 *   transcript under `sessions/<taskId>/claude/<agentKey>/session/projects/`.
 *   Crash-safe: the SDK writes transcripts continuously regardless of whether a
 *   turn produced a result event.
 *
 *   COST (SDK-reported, when available) — aggregated exclusively from the
 *   append-only `sessions/<taskId>/shared/usage.jsonl`, written on each SDK
 *   `result` event. No price table, no estimation — cost is the SDK's own
 *   `total_cost_usd`, shown as `unavailable` when no record exists.
 *
 * This module imports only `SESSIONS_DIR` from the workdir bootstrap so the
 * test module graph stays a single mock; all paths are built locally.
 */

import { createReadStream, existsSync } from 'fs';
import { readdir } from 'fs/promises';
import { createInterface } from 'readline';
import { join, relative, resolve, isAbsolute, sep } from 'path';
import type { Dirent } from 'fs';
import { SESSIONS_DIR } from '../system/workdir.js';

/** The SDK marks internal, non-billed assistant turns with this model. */
const SYNTHETIC_MODEL = '<synthetic>';

/**
 * taskId is untrusted — it can arrive from the HTTP API (`/api/tasks/:id/...`)
 * and both data paths build a filesystem path from it, so an unchecked `../`
 * id could escape `sessions/`. Every sink-building function below therefore
 * carries TWO barriers written INLINE (deliberately not extracted to a helper —
 * CodeQL's path-injection analysis does not recognise a regexp test hidden
 * behind a boolean-returning helper as a sanitizer, so the literal guard must
 * appear in the function that reaches the sink):
 *
 *   (a) an anchored allowlist matching the canonical `generateTaskId` shape
 *       (`task-YYYYMMDD-HHMM-<base36 suffix>`, exactly one segment, no `/`, no
 *       `..`) at entry — CodeQL's RegExpSanitizer barrier; and
 *   (b) a resolve()+relative() containment check immediately before the sink —
 *       the canonical CodeQL js/path-injection path-containment sanitizer —
 *       after which the RESOLVED absolute path is what is handed to the sink.
 */

/** Token totals, keyed by the same field names the SDK reports. */
export interface TokenTotals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** Per-agent usage: tokens roll up subagents into the parent agentKey. */
export interface AgentUsage {
  agentKey: string;
  tokens: TokenTotals;
  /** Distinct main `<sessionId>.jsonl` transcripts under this agent. */
  sessionCount: number;
  /** SDK-reported cost; `undefined` when usage.jsonl is absent. */
  cost?: number;
}

export interface TaskUsageReport {
  taskId: string;
  grand: TokenTotals;
  /** Distinct main-agent `end_turn` turns (drives the cost gap disclosure). */
  transcriptTurns: number;
  agents: AgentUsage[];
  /** SDK-reported cost, present only when usage.jsonl exists. */
  cost?: {
    grand: number;
    /** Total usage.jsonl record count. */
    costRecordedTurns: number;
  };
}

/** Minimal shape of the fields we read from a usage.jsonl record. */
interface UsageRecordLite {
  query_nonce?: string;
  agentKey?: string;
  total_cost_usd?: number;
}

/** Reduces all usage records sharing one query_nonce to a single cost. */
export type NonceReducer = (records: UsageRecordLite[]) => number;

/**
 * Reduce records that share one `query_nonce` to that query() call's cost.
 *
 * DEFAULT: `Math.max` of `total_cost_usd`. Per the SDK cost-tracking docs,
 * `total_cost_usd` is CUMULATIVE across the steps of a single query() call, so
 * the final (== maximum, under the cumulative model) value is that call's cost.
 * `max` is used over "last line" because it is robust to line ordering and
 * monotonic under the cumulative model.
 *
 * FALLBACK (one-line change, gated on the T6 live boot): if a live boot shows
 * successive result events within one query() call are per-turn DELTAS — which
 * would surface as a NON-monotonic within-nonce sequence — flip `max` to a sum.
 * The two hypotheses are self-distinguishing: cumulative implies monotonic
 * non-decreasing within a nonce; any decrease proves deltas.
 */
export const reduceNonceCost: NonceReducer = (records) =>
  records.reduce((max, r) => Math.max(max, r.total_cost_usd ?? 0), 0);

function zeroTokens(): TokenTotals {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

function addTokens(target: TokenTotals, usage: Record<string, unknown> | undefined): void {
  if (!usage) return;
  target.input_tokens += Number(usage.input_tokens) || 0;
  target.output_tokens += Number(usage.output_tokens) || 0;
  target.cache_creation_input_tokens += Number(usage.cache_creation_input_tokens) || 0;
  target.cache_read_input_tokens += Number(usage.cache_read_input_tokens) || 0;
}

interface AgentTokens {
  tokens: TokenTotals;
  sessionCount: number;
}

interface ScanContext {
  agentTokens: TokenTotals;
  grand: TokenTotals;
  /** Global dedup for token sums — assistant `message.id`, keep first. */
  seenIds: Set<string>;
  /** Distinct-id, non-sidechain, non-synthetic `end_turn` assistant ids. */
  turnIds: Set<string>;
}

/**
 * Stream one transcript file line-by-line (skips blank/malformed lines, like
 * `readEvents`), folding assistant token usage and turn ids into the context.
 */
async function scanTranscript(filePath: string, ctx: ScanContext): Promise<void> {
  try {
    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // skip malformed
      }
      if (entry?.type !== 'assistant') continue;
      const message = entry.message as Record<string, unknown> | undefined;
      if (!message) continue;
      if (message.model === SYNTHETIC_MODEL) continue;
      const id = message.id;
      if (typeof id !== 'string') continue;

      // Turn count: distinct-id, non-sidechain, end_turn (main-agent turns).
      if (entry.isSidechain !== true && message.stop_reason === 'end_turn') {
        ctx.turnIds.add(id);
      }

      // Token sums: dedup by id (parallel-tool partials repeat identical usage).
      if (ctx.seenIds.has(id)) continue;
      ctx.seenIds.add(id);
      addTokens(ctx.agentTokens, message.usage as Record<string, unknown> | undefined);
      addTokens(ctx.grand, message.usage as Record<string, unknown> | undefined);
    }
  } catch {
    // Unreadable / vanished file — skip it, tokens are best-effort.
  }
}

/** Resolve a recursive-readdir Dirent to its containing directory. */
function direntDir(entry: Dirent, fallback: string): string {
  const e = entry as Dirent & { parentPath?: string; path?: string };
  return e.parentPath ?? e.path ?? fallback;
}

async function collectTokens(taskId: string): Promise<{
  grand: TokenTotals;
  agents: Map<string, AgentTokens>;
  transcriptTurns: number;
}> {
  const grand = zeroTokens();
  const agents = new Map<string, AgentTokens>();

  // (a) INLINE allowlist barrier: reject anything but the canonical single-
  // segment id before a path is built — an unsafe id yields empty totals and
  // performs no join / existsSync / readdir / createReadStream below.
  if (!/^task-\d{8}-\d{4}-[a-z0-9]+$/.test(taskId)) {
    return { grand, agents, transcriptTurns: 0 };
  }

  // (b) INLINE containment barrier: resolve the taskId-derived path and confirm
  // it stays under SESSIONS_DIR before the readdir sink; hand the sink the
  // resolved absolute path (`claudeDir`).
  const root = resolve(SESSIONS_DIR);
  const claudeDir = resolve(join(SESSIONS_DIR, taskId, 'claude'));
  const claudeRel = relative(root, claudeDir);
  if (claudeRel === '..' || claudeRel.startsWith('..' + sep) || isAbsolute(claudeRel)) {
    return { grand, agents, transcriptTurns: 0 };
  }

  const seenIds = new Set<string>();
  const turnIds = new Set<string>();

  if (!existsSync(claudeDir)) return { grand, agents, transcriptTurns: 0 };

  let agentEntries: Dirent[];
  try {
    agentEntries = await readdir(claudeDir, { withFileTypes: true });
  } catch {
    return { grand, agents, transcriptTurns: 0 };
  }

  for (const agentEntry of agentEntries) {
    if (!agentEntry.isDirectory()) continue;
    const agentKey = agentEntry.name;
    const projectsDir = join(claudeDir, agentKey, 'session', 'projects');
    if (!existsSync(projectsDir)) continue;

    const bucket: AgentTokens = { tokens: zeroTokens(), sessionCount: 0 };
    agents.set(agentKey, bucket);

    let entries: Dirent[];
    try {
      entries = await readdir(projectsDir, { recursive: true, withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.jsonl')) continue;
      if (entry.name === 'journal.jsonl') continue;

      const fullPath = join(direntDir(entry, projectsDir), entry.name);
      const isSubagent = relative(projectsDir, fullPath).split(sep).includes('subagents');

      // Session count: distinct main `<sessionId>.jsonl` files (a filesystem
      // count) — the ones NOT nested under a `subagents/` subtree.
      if (!isSubagent) bucket.sessionCount += 1;

      await scanTranscript(fullPath, { agentTokens: bucket.tokens, grand, seenIds, turnIds });
    }
  }

  return { grand, agents, transcriptTurns: turnIds.size };
}

async function collectCost(
  taskId: string,
  reduce: NonceReducer,
): Promise<{ grand: number; perAgent: Map<string, number>; costRecordedTurns: number } | undefined> {
  // (a) INLINE allowlist barrier: reject an unsafe taskId before a path is
  // built — an unsafe id reports no cost (undefined), like a missing file.
  if (!/^task-\d{8}-\d{4}-[a-z0-9]+$/.test(taskId)) return undefined;

  // (b) INLINE containment barrier: resolve the taskId-derived path and confirm
  // it stays under SESSIONS_DIR before the createReadStream sink; the resolved
  // absolute path (`usagePath`) is what is streamed below.
  const root = resolve(SESSIONS_DIR);
  const usagePath = resolve(join(SESSIONS_DIR, taskId, 'shared', 'usage.jsonl'));
  const usageRel = relative(root, usagePath);
  if (usageRel === '..' || usageRel.startsWith('..' + sep) || isAbsolute(usageRel)) {
    return undefined;
  }
  if (!existsSync(usagePath)) return undefined;

  const records: UsageRecordLite[] = [];
  try {
    const rl = createInterface({ input: createReadStream(usagePath), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        continue; // skip malformed
      }
    }
  } catch {
    // File vanished/unreadable after the existsSync check — treat as empty.
  }

  // Group by query_nonce; a record missing one is its own singleton group
  // (defensive only — this greenfield file always carries a nonce).
  const groups = new Map<string, UsageRecordLite[]>();
  let singleton = 0;
  for (const r of records) {
    const nonce = typeof r.query_nonce === 'string' && r.query_nonce
      ? r.query_nonce
      : `__no-nonce-${singleton++}`;
    const list = groups.get(nonce);
    if (list) list.push(r);
    else groups.set(nonce, [r]);
  }

  let grand = 0;
  const perAgent = new Map<string, number>();
  for (const list of groups.values()) {
    const cost = reduce(list);
    grand += cost;
    // Every record in a nonce shares one agentKey (each spawn is per-agent), so
    // per-agent sums to grand by construction.
    const agentKey = list.find((r) => typeof r.agentKey === 'string')?.agentKey ?? 'unknown';
    perAgent.set(agentKey, (perAgent.get(agentKey) ?? 0) + cost);
  }

  return { grand, perAgent, costRecordedTurns: records.length };
}

/**
 * Aggregate token usage (always) and SDK-reported cost (when usage.jsonl
 * exists) for one task. Pure over the filesystem; never throws for missing
 * dirs/files (they yield an empty / cost-less report). An unsafe taskId (not
 * the canonical `generateTaskId` shape) is rejected before any filesystem
 * access and yields the same empty report — no path is ever built from it.
 *
 * @param reduce - per-nonce cost reducer; the default is documented-cumulative
 *   (`reduceNonceCost`). Injectable so the delta-fork fallback is unit-testable.
 */
export async function aggregateTaskUsage(
  taskId: string,
  reduce: NonceReducer = reduceNonceCost,
): Promise<TaskUsageReport> {
  const { grand, agents: tokenAgents, transcriptTurns } = await collectTokens(taskId);
  const cost = await collectCost(taskId, reduce);

  const agentKeys = new Set<string>(tokenAgents.keys());
  if (cost) for (const k of cost.perAgent.keys()) agentKeys.add(k);

  const agents: AgentUsage[] = [...agentKeys].sort().map((agentKey) => {
    const bucket = tokenAgents.get(agentKey);
    return {
      agentKey,
      tokens: bucket?.tokens ?? zeroTokens(),
      sessionCount: bucket?.sessionCount ?? 0,
      cost: cost ? (cost.perAgent.get(agentKey) ?? 0) : undefined,
    };
  });

  return {
    taskId,
    grand,
    transcriptTurns,
    agents,
    cost: cost ? { grand: cost.grand, costRecordedTurns: cost.costRecordedTurns } : undefined,
  };
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Disclosure attached to every SDK-reported cost figure. */
const COST_DISCLOSURE =
  "SDK-reported estimate from the SDK's bundled price table — not actual Anthropic " +
  'billing; diverges under subscription auth where spend is flat.';

/**
 * Render a report as human-readable text for the PM `get_task_usage` tool.
 * Cost is explicitly labelled SDK-reported / not billing / diverges under
 * subscription auth, shown `unavailable` when absent, and a gap line is
 * appended when fewer turns carry cost than the transcript recorded.
 */
export function formatTaskUsageReport(report: TaskUsageReport): string {
  const lines: string[] = [];
  lines.push(`Task ${report.taskId} usage`);
  lines.push('');
  lines.push('Grand total:');
  lines.push(`  Input:       ${fmtNum(report.grand.input_tokens)} tokens`);
  lines.push(`  Output:      ${fmtNum(report.grand.output_tokens)} tokens`);
  lines.push(`  Cache read:  ${fmtNum(report.grand.cache_read_input_tokens)} tokens`);
  lines.push(`  Cache write: ${fmtNum(report.grand.cache_creation_input_tokens)} tokens`);
  if (report.cost) {
    lines.push(`  Cost (SDK-reported): ${fmtCost(report.cost.grand)}`);
    lines.push(`    (${COST_DISCLOSURE})`);
  } else {
    lines.push('  Cost: unavailable');
  }

  lines.push('');
  lines.push('Per-agent:');
  for (const a of report.agents) {
    const costPart =
      a.cost !== undefined ? ` · cost (SDK-reported): ${fmtCost(a.cost)}` : ' · cost: unavailable';
    lines.push(
      `  ${a.agentKey} — input ${fmtNum(a.tokens.input_tokens)}, ` +
        `output ${fmtNum(a.tokens.output_tokens)}, ` +
        `cache-read ${fmtNum(a.tokens.cache_read_input_tokens)}, ` +
        `cache-write ${fmtNum(a.tokens.cache_creation_input_tokens)}` +
        ` · sessions: ${a.sessionCount}${costPart}`,
    );
  }

  const recordedTurns = report.cost?.costRecordedTurns ?? 0;
  if (recordedTurns < report.transcriptTurns) {
    lines.push('');
    lines.push(
      `Cost covers ${recordedTurns} of ${report.transcriptTurns} turns; ` +
        'the rest predate cost logging or ended without a result event — excluded.',
    );
  }

  return lines.join('\n');
}
