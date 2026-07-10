/**
 * memory:eval — telemetry aggregation (mechanical tier).
 *
 * Reads every memory/tasks/<taskId>/telemetry.jsonl under an explicit tasks
 * dir (the caller resolves it from the snapshot). Kind-less lines are
 * selection records; `kind: "pull"` lines are pull records; anything else
 * (unparseable, unknown kind) is counted and skipped. This reader is the
 * reference implementation for the mixed-kind file contract.
 */

import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { distribution, type Distribution } from './store-health.js';
import type { PullRecord, SelectionRecord, TelemetryReadResult } from './types.js';

export async function readAllTelemetry(tasksDir: string): Promise<TelemetryReadResult> {
  const result: TelemetryReadResult = { selection: [], pull: [], skipped: 0 };
  let taskDirs: string[];
  try {
    taskDirs = await readdir(tasksDir);
  } catch {
    return result;
  }
  for (const taskId of taskDirs) {
    let raw: string;
    try {
      raw = await readFile(join(tasksDir, taskId, 'telemetry.jsonl'), 'utf-8');
    } catch {
      continue; // no telemetry for this task
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        result.skipped++;
        continue;
      }
      if (rec.kind === undefined) result.selection.push(rec as SelectionRecord);
      else if (rec.kind === 'pull') result.pull.push(rec as PullRecord);
      else result.skipped++;
    }
  }
  return result;
}

export interface SelectionAggregate {
  records: number;
  tasks: number;
  /** Spawns that injected at least one full page. */
  injectingSpawns: number;
  zeroInjectionSpawns: number;
  spawnsWithBudgetDrops: number;
  droppedSlugTop: Array<{ slug: string; count: number }>;
  renderedTokens: Distribution;
}

export interface PullAggregate {
  records: number;
  tasks: number;
  byTool: Record<string, number>;
  hitRate: number;
  zeroResultRate: number;
  /** Zero-result search queries — the store-gap list. */
  storeGaps: string[];
}

export function aggregateSelection(records: SelectionRecord[]): SelectionAggregate | null {
  if (records.length === 0) return null;
  const droppedCounts = new Map<string, number>();
  let injecting = 0;
  let withDrops = 0;
  for (const r of records) {
    if ((r.selected ?? []).length > 0) injecting++;
    if ((r.dropped ?? []).length > 0) {
      withDrops++;
      for (const slug of r.dropped) droppedCounts.set(slug, (droppedCounts.get(slug) ?? 0) + 1);
    }
  }
  return {
    records: records.length,
    tasks: new Set(records.map((r) => r.taskId)).size,
    injectingSpawns: injecting,
    zeroInjectionSpawns: records.length - injecting,
    spawnsWithBudgetDrops: withDrops,
    droppedSlugTop: [...droppedCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([slug, count]) => ({ slug, count })),
    renderedTokens: distribution(records.map((r) => r.renderedTokensEst ?? 0)),
  };
}

export function aggregatePull(records: PullRecord[]): PullAggregate | null {
  if (records.length === 0) return null;
  const byTool: Record<string, number> = {};
  const gaps: string[] = [];
  let zero = 0;
  for (const r of records) {
    byTool[r.tool] = (byTool[r.tool] ?? 0) + 1;
    if (r.zeroResult) {
      zero++;
      if (r.tool === 'search_memory' && typeof r.args?.query === 'string') gaps.push(r.args.query);
    }
  }
  return {
    records: records.length,
    tasks: new Set(records.map((r) => r.taskId)).size,
    byTool,
    hitRate: Math.round(((records.length - zero) / records.length) * 1000) / 1000,
    zeroResultRate: Math.round((zero / records.length) * 1000) / 1000,
    storeGaps: [...new Set(gaps)],
  };
}
