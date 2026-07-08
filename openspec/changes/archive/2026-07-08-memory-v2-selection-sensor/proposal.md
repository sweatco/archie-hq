# Proposal: memory-v2-selection-sensor

## Why

Roadmap Phase 1.5 enables `ARCHIE_MEMORY_INJECT=true` in prod with every tuning decision (budget defaults, zero-signal recency floor, org allowlist, ossification response) deliberately deferred to live data — but the read path emits no durable record of what was injected; the only trace is an ephemeral console line listing dropped slugs. Without a per-spawn record, those deferred decisions stay anecdotal, "what did memory tell this agent?" is unanswerable after the fact (the store moves on, spawn context isn't kept), and the Phase 5 value eval loses ground truth that cannot be backfilled.

## What Changes

- When injection is enabled and a spawn's prompt is enriched, append one JSON line to `memory/tasks/<taskId>/telemetry.jsonl`: timestamp, spawning agent, selected entity pages (slug, score, scope), dropped-over-budget slugs, count of zero-signal pages excluded from candidacy, rendered memory-block token estimate, and the budgets in effect (`ORG_INJECT_MAX`, `ENTITY_INJECT_MAX`).
- Reshape per-task memory artifacts into `memory/tasks/<taskId>/` (episodic side of the store): `summary.md` moves from `memory/summaries/<taskId>.md` (one-time startup migration), `telemetry.jsonl` is new. Ejection stays a single `rm -rf workdir/memory/`; `-m` memory-only pulls now carry telemetry.
- Extend `MemorySelectors` with optional `taskId` and `agent` so the memory layer can address the task's directory; `spawn.ts` passes both at the existing seam (no seam signature change).
- Telemetry is fail-safe: a write failure logs a warning and never affects the spawn or the enriched prompt.
- No new flags: records are written iff injection is enabled; with injection off the read path stays zero-cost, exactly as today.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `memory-layer`: new requirement — selection observability. Every injection-enabled spawn leaves a durable, machine-readable record of what was selected, what was dropped, and what it cost; record writes never impact spawns.

## Impact

- **Code:** `src/memory/context.ts` (assemble + write the record), `src/memory/paths.ts` (`tasks/<taskId>/` path helpers replace the flat summaries path), `src/memory/entity-index.ts` (selection result must expose scores and the zero-signal count, which are currently internal), `src/memory/lifecycle.ts` (summary path + one-time `migrateLegacySummaries`), `src/memory/index.ts` (init creates `tasks/`, runs the migration), `src/agents/spawn.ts` (pass `taskId`/`agent` in the selectors object).
- **Docs:** `docs/architecture/memory.md` read-path + Telemetry section + storage layout; spec delta for `memory-layer` (sensor requirement added, summary-path requirement modified).
- **Ops:** none — `scripts/pull-remote-data.sh` already tarballs `memory/`, so records are harvested by the existing pull (including `-m` memory-only) with zero new plumbing.
- **Sequencing:** lands before the Phase 1.5 enablement flip; the pre-flight checklist and later Phase 5 eval both consume these records.
