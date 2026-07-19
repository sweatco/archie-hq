/**
 * memory:eval — report rendering (Markdown + JSON sidecar).
 *
 * Pure given computed section inputs. The JSON sidecar carries the numbers a
 * later run's `--prev` consumes for deltas; the Markdown is the human report.
 * The header stamps everything that shaped the numbers: snapshot, budgets (as
 * read through the production flag accessors), metric versions, reader/judge
 * models and the judge's validation — an unvalidated or same-family judge is
 * marked NON-GATING inline.
 */

import type { WorstCaseBound } from './bound.js';
import type { ReadingList } from './reading-list.js';
import type { StoreHealth, StoreHealthDelta, Distribution } from './store-health.js';
import type { ExtractionSkipAggregate, PrefsOnlyAggregate, PullAggregate, SelectionAggregate, UserUpdateDropAggregate } from './telemetry-agg.js';
import type { RegressionResult } from './golden.js';
import type { FunctionalRunResult, JudgeStamp } from './types.js';

export interface ReportInputs {
  generatedAt: string;
  snapshotPath: string;
  storeHealth: StoreHealth & { slugs: string[] };
  delta?: StoreHealthDelta | null;
  selection: SelectionAggregate | null;
  pull: PullAggregate | null;
  extractionSkips?: ExtractionSkipAggregate | null;
  extractionPrefsOnly?: PrefsOnlyAggregate | null;
  userUpdateDrops?: UserUpdateDropAggregate | null;
  telemetrySkipped: number;
  regression?: RegressionResult | null;
  bound: WorstCaseBound;
  readingList?: ReadingList | null;
  functional?: FunctionalRunResult | null;
  judge?: JudgeStamp | null;
  notes: string[];
}

const fmtDist = (d: Distribution) => `min ${d.min} · p50 ${d.p50} · p90 ${d.p90} · max ${d.max} · mean ${d.mean}`;

export function renderReportMarkdown(r: ReportInputs): string {
  const L: string[] = [];
  L.push(`# Memory Eval Report — ${r.generatedAt.slice(0, 10)}`);
  L.push('');
  L.push(`- Snapshot: \`${r.snapshotPath}\``);
  L.push(`- Generated: ${r.generatedAt}`);
  L.push(`- Budgets (via production flag accessors): org ${r.bound.budgets.orgInjectMax} · non-org ${r.bound.budgets.entityInjectMax} · touched_by ${r.bound.budgets.touchedByInjectMax}`);
  L.push(`- Duplicate metric: ${r.storeHealth.dupMetricVersion}`);
  if (r.judge) {
    const v = r.judge.validation;
    L.push(`- Reader: \`${r.judge.readerModel}\` · Judge: \`${r.judge.judgeModel}\` (${r.judge.judgeFamily} family; extractor: ${r.judge.extractorFamily})`);
    L.push(`- Judge validation: ${v ? `κ=${v.kappa}, position bias=${v.positionBias}, n=${v.sampleSize}, at ${v.at}` : 'NONE'}`);
    L.push(r.judge.gating ? '- Judge status: **gating**' : `- Judge status: **NON-GATING** — ${r.judge.nonGatingReasons.join('; ')}`);
  }
  for (const n of r.notes) L.push(`- Note: ${n}`);
  L.push('');

  // ---- Store health ----
  L.push('## Store health (mechanical)');
  L.push('');
  L.push(`- Entities: ${r.storeHealth.entityCount} / cap ${r.storeHealth.entityCap} (${r.storeHealth.activeCount} active, ${r.storeHealth.archivedCount} archived)`);
  L.push(`- Observations/page: ${fmtDist(r.storeHealth.observationsPerPage)}`);
  L.push(`- Page bytes: ${fmtDist(r.storeHealth.pageBytes)}`);
  const s = r.storeHealth.staleness;
  L.push(`- Staleness (days since last touch): fresh(<30) ${s.fresh} · aging(30–90) ${s.aging} · stale(90–180) ${s.stale} · dead(>180/undated) ${s.dead}`);
  L.push(`- Near-duplicate rate: **${r.storeHealth.nearDuplicateRate}** (${r.storeHealth.nearDuplicatePairs.length} pair(s))`);
  for (const [a, b] of r.storeHealth.nearDuplicatePairs.slice(0, 20)) L.push(`  - ${a} ↔ ${b}`);
  if (r.delta) {
    L.push(`- Δ vs prev: entities ${sign(r.delta.entityCountDelta)} · archived ${sign(r.delta.archivedDelta)} · dup-rate ${sign(r.delta.nearDuplicateRateDelta)} · +${r.delta.added.length} new / -${r.delta.removed.length} gone`);
  }
  L.push('');

  // ---- Telemetry ----
  L.push('## Telemetry (mechanical)');
  L.push('');
  if (r.selection) {
    L.push(`- Selection records: ${r.selection.records} across ${r.selection.tasks} task(s); injecting spawns ${r.selection.injectingSpawns}, zero-injection ${r.selection.zeroInjectionSpawns}, with budget drops ${r.selection.spawnsWithBudgetDrops}`);
    L.push(`- Rendered tokens/spawn: ${fmtDist(r.selection.renderedTokens)}`);
    for (const d of r.selection.droppedSlugTop) L.push(`  - dropped over budget: ${d.slug} ×${d.count}`);
  } else {
    L.push('- Selection records: **absent** (injection has not run against this snapshot — not zero activity, no data)');
  }
  if (r.pull) {
    L.push(`- Pull records: ${r.pull.records} across ${r.pull.tasks} task(s); hit rate ${r.pull.hitRate}, zero-result ${r.pull.zeroResultRate}`);
    L.push(`- By tool: ${Object.entries(r.pull.byTool).map(([t, n]) => `${t} ×${n}`).join(' · ')}`);
    if (r.pull.denied > 0) {
      L.push(`- Authorization denials: ${r.pull.denied} (${r.pull.deniedRate} of pull calls) — ${Object.entries(r.pull.denyReasons).map(([reason, n]) => `${reason} ×${n}`).join(' · ')}`);
    }
    if (r.pull.storeGaps.length) {
      L.push('- Store gaps (zero-result searches):');
      for (const g of r.pull.storeGaps.slice(0, 20)) L.push(`  - ${JSON.stringify(g)}`);
    }
  } else {
    L.push('- Pull records: **absent** (read tools have not run against this snapshot)');
  }
  if (r.extractionSkips) {
    L.push(`- Extraction skips (confidentiality gate): ${r.extractionSkips.records} across ${r.extractionSkips.tasks} task(s) — ${Object.entries(r.extractionSkips.byReason).map(([reason, n]) => `${reason} ×${n}`).join(' · ')}`);
  }
  if (r.extractionPrefsOnly) {
    L.push(`- Prefs-only extractions (DM write lockdown): ${r.extractionPrefsOnly.records} across ${r.extractionPrefsOnly.tasks} task(s)${r.extractionPrefsOnly.retractions > 0 ? ` — ${r.extractionPrefsOnly.retractions} retracted stale artifacts` : ''}`);
  }
  if (r.userUpdateDrops) {
    L.push(`- User updates dropped (evidence validation): ${r.userUpdateDrops.records} across ${r.userUpdateDrops.tasks} task(s) — ${Object.entries(r.userUpdateDrops.byUser).map(([u, n]) => `${u} ×${n}`).join(' · ')}`);
  }
  if (r.telemetrySkipped > 0) L.push(`- Skipped ${r.telemetrySkipped} unparseable/unknown-kind telemetry line(s)`);
  L.push('');

  // ---- Regression ----
  if (r.regression) {
    L.push('## Selection regression (mechanical)');
    L.push('');
    L.push(`- ${r.regression.cleanCases}/${r.regression.cases} golden case(s) clean`);
    for (const d of r.regression.diffs.slice(0, 20)) {
      L.push(`  - case ${d.index}: missing [${d.missingFromSelected.join(', ')}], unexpected [${d.unexpectedlySelected.join(', ')}]`);
    }
    L.push('');
  }

  // ---- Enablement gate ----
  L.push('## Enablement gate — worst-case injected-token bound');
  L.push('');
  L.push('Every term rendered through the production render path (chars/4, the sensor\'s rule):');
  L.push('');
  L.push(`| Term | Tokens |`);
  L.push(`|---|---|`);
  L.push(`| Always-injected index | ${r.bound.indexTokens} |`);
  L.push(`| Largest org page (${r.bound.largestOrgPage?.slug ?? '—'}) × ${r.bound.budgets.orgInjectMax} | ${r.bound.orgTermTokens} |`);
  L.push(`| Largest non-org page (${r.bound.largestNonOrgPage?.slug ?? '—'}) × ${r.bound.budgets.entityInjectMax} | ${r.bound.nonOrgTermTokens} |`);
  L.push(`| All user files (${r.bound.userBlocks.length}) summed | ${r.bound.userTermTokens} |`);
  L.push(`| Recent activity | ${r.bound.recentActivityTokens} |`);
  L.push(`| **Worst case total** | **${r.bound.totalTokens}** |`);
  L.push('');

  // ---- Reading list ----
  if (r.readingList) {
    L.push('## Store-review reading list (human, ~1–2h)');
    L.push('');
    L.push(`Flagged items: **${r.readingList.flaggedCount}** — review these first.`);
    L.push('');
    L.push('| Entity | Scope | Rel | Obs | Bytes | Last | Flags |');
    L.push('|---|---|---|---|---|---|---|');
    for (const e of r.readingList.entities) {
      L.push(`| ${e.slug}${e.status === 'archived' ? ' (archived)' : ''} | ${e.scope} | ${e.relations} | ${e.observations} | ${e.bytes} | ${e.lastTouched} | ${e.flags.join(', ') || '—'} |`);
    }
    L.push('');
    L.push('Non-entity blocks the same flag injects:');
    L.push('');
    L.push('| File | Bytes | Flags |');
    L.push('|---|---|---|');
    for (const f of r.readingList.files) L.push(`| ${f.file} | ${f.bytes} | ${f.flags.join(', ') || '—'} |`);
    L.push('');
  }

  // ---- Functional ----
  if (r.functional) {
    const f = r.functional.summary;
    L.push('## Functional tier — real implementation under test');
    L.push('');
    L.push(`- Questions: ${f.questions}`);
    L.push(`- Surfaced-context recall (mean): **${f.meanContextRecall}** · precision (mean): ${f.meanContextPrecision}`);
    const arms = Object.entries(f.armCorrect);
    if (arms.length) {
      L.push(`- Answer correctness by arm: ${arms.map(([a, n]) => `${a} ${n}/${f.questions}`).join(' · ')}`);
      const oracle = f.armCorrect['oracle'] ?? 0;
      const memory = f.armCorrect['memory'] ?? 0;
      L.push(`- Oracle − memory gap: **${oracle - memory}** (retrieval loss; reader ceiling is the oracle arm)`);
      for (const b of f.budgetSweep) L.push(`- Over-injection sweep @${Math.round(b.fraction * 100)}% context: ${b.correct}/${f.questions} correct`);
    } else {
      L.push('- Arms not run (context-only mode — no reader/judge calls)');
    }
    L.push('');
    L.push('| Q | Recall | Precision | Ctx tokens | Arms |');
    L.push('|---|---|---|---|---|');
    for (const c of r.functional.cases) {
      const armStr = c.arms.map((a) => `${a.arm}:${a.correct === undefined ? '?' : a.correct ? '✓' : '✗'}`).join(' ');
      L.push(`| ${c.id} | ${c.contextRecall} | ${c.contextPrecision} | ${c.contextTokensEst} | ${armStr || '—'} |`);
    }
    L.push('');
    L.push('Functional numbers gate selection/injection/pull changes only — never answering-model comparisons (arm-relative, not absolute).');
    L.push('');
  }

  return L.join('\n');
}

function sign(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

/** JSON sidecar a later run's `--prev` consumes. */
export function reportSidecar(r: ReportInputs): Record<string, unknown> {
  return {
    v: 1,
    generatedAt: r.generatedAt,
    snapshotPath: r.snapshotPath,
    entityCount: r.storeHealth.entityCount,
    archivedCount: r.storeHealth.archivedCount,
    nearDuplicateRate: r.storeHealth.nearDuplicateRate,
    dupMetricVersion: r.storeHealth.dupMetricVersion,
    slugs: r.storeHealth.slugs,
    worstCaseTokens: r.bound.totalTokens,
    functional: r.functional
      ? {
          questions: r.functional.summary.questions,
          meanContextRecall: r.functional.summary.meanContextRecall,
          meanContextPrecision: r.functional.summary.meanContextPrecision,
          armCorrect: r.functional.summary.armCorrect,
        }
      : null,
  };
}
