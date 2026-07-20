/**
 * memory:eval — golden-set selection regression (mechanical tier).
 *
 * A golden case pins a recorded selection context + the selection it produced.
 * Replay runs the context through the PRODUCTION `selectEntities` (same code
 * path, never a reimplementation) against the snapshot's records and diffs.
 * Baseline semantics: goldens harvested from the same code+store must diff
 * zero, so a selector change shows only intentional diffs.
 *
 * Goldens are harvested from live selection telemetry (post-enablement) and
 * are prod-derived: they embed task titles and Slack IDs, so they live outside
 * the repo (default ~/archie-snapshots/golden/).
 */

import { selectEntities, type SelectionContext } from '../../src/memory/entity-index.js';
import type { EntityRecord, GoldenCase, GoldenDiff, SelectionRecord } from './types.js';

/**
 * Convert selection records into golden cases. Records without a `ctx` (legacy
 * or malformed telemetry lines) are skipped — a golden that can't reproduce
 * its context can only produce noise. Records without recorded `budgets` are
 * skipped for the same reason: replay against eval-env defaults would diff on
 * every budget-bound case without any selector change.
 */
export function harvestGoldens(records: SelectionRecord[], snapshotDate: string, now?: string): GoldenCase[] {
  const harvestedAt = now ?? new Date().toISOString();
  return records
    .filter((r) => r.ctx && r.budgets && typeof r.budgets.org === 'number' && typeof r.budgets.nonOrg === 'number')
    .map((r) => ({
      v: 1 as const,
      harvested_at: harvestedAt,
      snapshot_date: snapshotDate,
      ctx: {
        repo: r.ctx.repo ?? undefined,
        plugin: r.ctx.plugin ?? undefined,
        taskTitle: r.ctx.taskTitle ?? undefined,
        // Prefer the recorded display names (they feed token overlap); fall back
        // to ids for records predating the `ctx.users` field — the fallback can
        // drift from the original spawn's scores, which is why fresh harvests
        // beat old ones.
        users: (r.ctx.users ?? r.ctx.userIds?.map((id) => ({ id, name: id })) ?? []).map((u) => ({
          userId: u.id,
          displayName: u.name,
        })),
      },
      budgets: { org: r.budgets.org, nonOrg: r.budgets.nonOrg },
      expected: {
        selected: (r.selected ?? []).map((s) => s.slug),
        dropped: r.dropped ?? [],
      },
    }));
}

function setDiff(expected: string[], actual: string[]): { missing: string[]; unexpected: string[] } {
  const e = new Set(expected);
  const a = new Set(actual);
  return {
    missing: expected.filter((s) => !a.has(s)),
    unexpected: actual.filter((s) => !e.has(s)),
  };
}

export interface RegressionResult {
  cases: number;
  cleanCases: number;
  diffs: GoldenDiff[];
}

/** Replay every golden through the production selector; report per-case diffs. */
export function runRegression(goldens: GoldenCase[], records: EntityRecord[]): RegressionResult {
  const diffs: GoldenDiff[] = [];
  goldens.forEach((g, index) => {
    const ctx: SelectionContext = {
      repo: g.ctx.repo,
      plugin: g.ctx.plugin,
      taskTitle: g.ctx.taskTitle,
      users: g.ctx.users,
    };
    // Replay with the RECORDED budgets — the env-derived defaults belong to
    // the eval shell, not the spawn the golden captured. Legacy goldens
    // without budgets fall back to the current env (their diffs are then
    // env-sensitive; harvest fresh sets to retire them).
    const result = g.budgets
      ? selectEntities(records, ctx, g.budgets.nonOrg, g.budgets.org)
      : selectEntities(records, ctx);
    const sel = setDiff(g.expected.selected, result.selected.map((r) => r.entity));
    const drop = setDiff(g.expected.dropped, result.dropped);
    if (sel.missing.length || sel.unexpected.length || drop.missing.length || drop.unexpected.length) {
      diffs.push({
        index,
        missingFromSelected: sel.missing,
        unexpectedlySelected: sel.unexpected,
        droppedDelta: { missing: drop.missing, unexpected: drop.unexpected },
      });
    }
  });
  return { cases: goldens.length, cleanCases: goldens.length - diffs.length, diffs };
}
