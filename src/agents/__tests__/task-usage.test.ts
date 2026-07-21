/**
 * Unit tests for the task-usage aggregator + formatter.
 *
 * The module imports only SESSIONS_DIR from ../../system/workdir.js, so a single
 * mock (a mkdtempSync temp dir) isolates it. Fixtures are written to disk and the
 * aggregator fns are imported directly.
 *
 * Transcript layout mirrors the SDK: sessions/<taskId>/claude/<agentKey>/session/
 * projects/<encoded-cwd>/<sessionId>.jsonl, with subagent transcripts nested under
 * <sessionId>/subagents/**\/agent-*.jsonl. Cost lives in shared/usage.jsonl.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const SESSIONS_ROOT = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  return mkdtempSync(join(tmpdir(), 'archie-task-usage-test-'));
});

vi.mock('../../system/workdir.js', () => ({
  SESSIONS_DIR: SESSIONS_ROOT,
  WORKDIR: SESSIONS_ROOT,
}));

import {
  aggregateTaskUsage,
  formatTaskUsageReport,
  type NonceReducer,
} from '../task-usage.js';

afterAll(async () => {
  await rm(SESSIONS_ROOT, { recursive: true, force: true });
});

// ---- fixture helpers ----

function projectsDir(taskId: string, agentKey: string): string {
  return join(SESSIONS_ROOT, taskId, 'claude', agentKey, 'session', 'projects', 'encoded-cwd');
}

function sharedDir(taskId: string): string {
  return join(SESSIONS_ROOT, taskId, 'shared');
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** One assistant transcript line. */
function assistantLine(opts: {
  id: string;
  usage: Usage;
  model?: string;
  stop_reason?: string;
  isSidechain?: boolean;
}): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: opts.isSidechain ?? false,
    message: {
      id: opts.id,
      model: opts.model ?? 'claude-sonnet-4-5',
      stop_reason: opts.stop_reason ?? 'end_turn',
      usage: opts.usage,
    },
  });
}

async function writeTranscript(dir: string, name: string, lines: string[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), lines.join('\n') + '\n');
}

async function writeUsage(
  taskId: string,
  records: Array<Record<string, unknown>>,
): Promise<void> {
  await mkdir(sharedDir(taskId), { recursive: true });
  await writeFile(
    join(sharedDir(taskId), 'usage.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
}

// =============================================================================
// AC2 — token sums: dedup by message.id, exclude <synthetic>, across 2 files.
// =============================================================================

describe('AC2: token dedup + synthetic exclusion across two session files', () => {
  it('sums usage after keep-first dedup and dropping the synthetic line', async () => {
    const taskId = 'task-ac2';
    const dir = projectsDir(taskId, 'pm');

    // Session 1: msg-a, a DUPLICATE of msg-a (must be ignored), and a synthetic
    // line (must be excluded entirely).
    await writeTranscript(dir, 'sess-1.jsonl', [
      assistantLine({ id: 'msg-a', usage: { input_tokens: 100, output_tokens: 40, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 } }),
      assistantLine({ id: 'msg-a', usage: { input_tokens: 100, output_tokens: 40, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 } }),
      assistantLine({ id: 'msg-synthetic', model: '<synthetic>', usage: { input_tokens: 999, output_tokens: 999, cache_creation_input_tokens: 999, cache_read_input_tokens: 999 } }),
    ]);

    // Session 2: msg-b.
    await writeTranscript(dir, 'sess-2.jsonl', [
      assistantLine({ id: 'msg-b', usage: { input_tokens: 200, output_tokens: 60, cache_creation_input_tokens: 20, cache_read_input_tokens: 7 } }),
    ]);

    const report = await aggregateTaskUsage(taskId);

    // Hand-computed: msg-a (once) + msg-b; synthetic and the dup excluded.
    expect(report.grand).toEqual({
      input_tokens: 300,
      output_tokens: 100,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 12,
    });
    const pm = report.agents.find((a) => a.agentKey === 'pm');
    expect(pm?.tokens).toEqual(report.grand);
  });
});

// =============================================================================
// AC3 — subagent tokens included; sibling journal.jsonl excluded.
// =============================================================================

describe('AC3: nested subagent transcript included, journal.jsonl excluded', () => {
  it('rolls subagent tokens into the parent agent and skips journal.jsonl', async () => {
    const taskId = 'task-ac3';
    const dir = projectsDir(taskId, 'backend');

    // Main session file.
    await writeTranscript(dir, 'sess-1.jsonl', [
      assistantLine({ id: 'main-1', usage: { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }),
    ]);

    // journal.jsonl sibling — must be EXCLUDED even though it parses.
    await writeTranscript(dir, 'journal.jsonl', [
      assistantLine({ id: 'journal-1', usage: { input_tokens: 777, output_tokens: 777, cache_creation_input_tokens: 777, cache_read_input_tokens: 777 } }),
    ]);

    // Nested subagent transcript — must be INCLUDED and rolled into backend.
    await writeTranscript(join(dir, 'sess-1', 'subagents', 'child'), 'agent-1.jsonl', [
      assistantLine({ id: 'sub-1', isSidechain: true, usage: { input_tokens: 30, output_tokens: 10, cache_creation_input_tokens: 3, cache_read_input_tokens: 1 } }),
    ]);

    const report = await aggregateTaskUsage(taskId);

    // main-1 + sub-1; journal-1 excluded.
    expect(report.grand).toEqual({
      input_tokens: 80,
      output_tokens: 30,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 1,
    });
    const backend = report.agents.find((a) => a.agentKey === 'backend');
    expect(backend?.tokens).toEqual(report.grand);
    // Only the main file counts as a session; the subagent file does not.
    expect(backend?.sessionCount).toBe(1);
  });
});

// =============================================================================
// AC4 — grand total + per-agent breakdown present; two-session agent = sessions:2.
// =============================================================================

describe('AC4: report structure and session counting', () => {
  it('reports grand + per-agent breakdown, two-session agent as sessions: 2', async () => {
    const taskId = 'task-ac4';
    const pmDir = projectsDir(taskId, 'pm');
    await writeTranscript(pmDir, 'sess-a.jsonl', [
      assistantLine({ id: 'a', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }),
    ]);
    await writeTranscript(pmDir, 'sess-b.jsonl', [
      assistantLine({ id: 'b', usage: { input_tokens: 20, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }),
    ]);

    const report = await aggregateTaskUsage(taskId);
    const pm = report.agents.find((a) => a.agentKey === 'pm');
    expect(pm?.sessionCount).toBe(2);

    const text = formatTaskUsageReport(report);
    expect(text).toContain('Grand total:');
    expect(text).toContain('Per-agent:');
    expect(text).toContain('sessions: 2');
    expect(text).toContain('pm —');
  });
});

// =============================================================================
// AC6-unit — nonce-based cost aggregation.
// =============================================================================

describe('AC6-unit: nonce-based cost', () => {
  it('(i) single nonce, monotonically increasing records → cost = max/final (cumulative)', async () => {
    const taskId = 'task-ac6-i';
    // A transcript so the report is otherwise well-formed.
    await writeTranscript(projectsDir(taskId, 'pm'), 'sess-1.jsonl', [
      assistantLine({ id: 'x', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }),
    ]);
    await writeUsage(taskId, [
      { query_nonce: 'N1', agentKey: 'pm', total_cost_usd: 0.10 },
      { query_nonce: 'N1', agentKey: 'pm', total_cost_usd: 0.25 },
      { query_nonce: 'N1', agentKey: 'pm', total_cost_usd: 0.40 },
    ]);

    const report = await aggregateTaskUsage(taskId);
    expect(report.cost?.grand).toBeCloseTo(0.40, 10);
    expect(report.cost?.costRecordedTurns).toBe(3);
  });

  it('(ii) NO-OMISSION: two cheap+expensive nonces sharing a session_id → grand = $0.62', async () => {
    const taskId = 'task-ac6-ii';
    await writeTranscript(projectsDir(taskId, 'pm'), 'sess-1.jsonl', [
      assistantLine({ id: 'x', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }),
    ]);
    // The exact scenario the deleted drop-heuristic omitted: nonce A ($0.02) then
    // nonce B ($0.60), BOTH with the same session_id. Must sum to $0.62.
    await writeUsage(taskId, [
      { query_nonce: 'A', agentKey: 'pm', session_id: 'shared-sess', total_cost_usd: 0.02 },
      { query_nonce: 'B', agentKey: 'pm', session_id: 'shared-sess', total_cost_usd: 0.60 },
    ]);

    const report = await aggregateTaskUsage(taskId);
    expect(report.cost?.grand).toBeCloseTo(0.62, 10);
  });

  it('(iii) two agents each with their own nonce(s) → per-agent costs sum to grand', async () => {
    const taskId = 'task-ac6-iii';
    await writeTranscript(projectsDir(taskId, 'pm'), 'sess-1.jsonl', [
      assistantLine({ id: 'p', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }),
    ]);
    await writeTranscript(projectsDir(taskId, 'backend'), 'sess-1.jsonl', [
      assistantLine({ id: 'q', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }),
    ]);
    await writeUsage(taskId, [
      { query_nonce: 'P1', agentKey: 'pm', total_cost_usd: 0.10 },
      { query_nonce: 'P2', agentKey: 'pm', total_cost_usd: 0.15 },
      { query_nonce: 'B1', agentKey: 'backend', total_cost_usd: 0.30 },
    ]);

    const report = await aggregateTaskUsage(taskId);
    const pm = report.agents.find((a) => a.agentKey === 'pm');
    const backend = report.agents.find((a) => a.agentKey === 'backend');
    expect(pm?.cost).toBeCloseTo(0.25, 10);
    expect(backend?.cost).toBeCloseTo(0.30, 10);
    expect((pm!.cost! + backend!.cost!)).toBeCloseTo(report.cost!.grand, 10);
    expect(report.cost?.grand).toBeCloseTo(0.55, 10);
  });

  it('(iv) delta-fork guard: with reduceNonceCost set to sum, a multi-record nonce sums', async () => {
    const taskId = 'task-ac6-iv';
    await writeTranscript(projectsDir(taskId, 'pm'), 'sess-1.jsonl', [
      assistantLine({ id: 'x', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }),
    ]);
    await writeUsage(taskId, [
      { query_nonce: 'N1', agentKey: 'pm', total_cost_usd: 0.10 },
      { query_nonce: 'N1', agentKey: 'pm', total_cost_usd: 0.25 },
      { query_nonce: 'N1', agentKey: 'pm', total_cost_usd: 0.40 },
    ]);

    // Documents the one-line fallback: the SUM reducer sums within the nonce.
    const sumReducer: NonceReducer = (records) =>
      records.reduce((s, r) => s + (r.total_cost_usd ?? 0), 0);

    const report = await aggregateTaskUsage(taskId, sumReducer);
    expect(report.cost?.grand).toBeCloseTo(0.75, 10);
  });
});

// =============================================================================
// AC7 — missing usage.jsonl → tokens + cost unavailable + gap; fewer records → gap.
// =============================================================================

describe('AC7: cost unavailable / gap disclosure', () => {
  it('no usage.jsonl → tokens report, cost undefined, gap disclosed, no throw', async () => {
    const taskId = 'task-ac7-nocost';
    await writeTranscript(projectsDir(taskId, 'pm'), 'sess-1.jsonl', [
      assistantLine({ id: 'm1', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, stop_reason: 'end_turn' }),
      assistantLine({ id: 'm2', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, stop_reason: 'end_turn' }),
    ]);

    const report = await aggregateTaskUsage(taskId);
    expect(report.cost).toBeUndefined();
    expect(report.grand.input_tokens).toBe(20);
    expect(report.transcriptTurns).toBe(2);

    const text = formatTaskUsageReport(report);
    expect(text).toContain('Cost: unavailable');
    expect(text).toContain('Cost covers 0 of 2 turns');
  });

  it('costRecordedTurns < end_turn count → gap line', async () => {
    const taskId = 'task-ac7-gap';
    await writeTranscript(projectsDir(taskId, 'pm'), 'sess-1.jsonl', [
      assistantLine({ id: 'm1', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, stop_reason: 'end_turn' }),
      assistantLine({ id: 'm2', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, stop_reason: 'end_turn' }),
      assistantLine({ id: 'm3', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, stop_reason: 'end_turn' }),
    ]);
    // Only one cost record for three transcript turns.
    await writeUsage(taskId, [{ query_nonce: 'N1', agentKey: 'pm', total_cost_usd: 0.10 }]);

    const report = await aggregateTaskUsage(taskId);
    expect(report.transcriptTurns).toBe(3);
    expect(report.cost?.costRecordedTurns).toBe(1);

    const text = formatTaskUsageReport(report);
    expect(text).toContain('Cost covers 1 of 3 turns');
  });
});

// =============================================================================
// AC8 — output contains the SDK-reported label + subscription-auth divergence.
// =============================================================================

describe('AC8: SDK-reported / subscription-auth divergence disclosure', () => {
  it('labels cost SDK-reported and discloses subscription-auth divergence', async () => {
    const taskId = 'task-ac8';
    await writeTranscript(projectsDir(taskId, 'pm'), 'sess-1.jsonl', [
      assistantLine({ id: 'x', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }),
    ]);
    await writeUsage(taskId, [{ query_nonce: 'N1', agentKey: 'pm', total_cost_usd: 0.42 }]);

    const text = formatTaskUsageReport(await aggregateTaskUsage(taskId));
    expect(text).toContain('Cost (SDK-reported): $0.42');
    expect(text).toContain('SDK-reported');
    expect(text).toContain('not actual Anthropic billing');
    expect(text).toContain('subscription auth');
  });
});
