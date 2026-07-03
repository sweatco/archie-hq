# Tasks: memory-v2-selection-sensor

## 1. Selection telemetry surface

- [x] 1.1 Extend `SelectionResult` in `src/memory/entity-index.ts` with additive fields — per-selected `{slug, score, scope}`, `zeroSignalExcluded`, `candidates` — populated inside `selectEntities`; `selected`/`dropped` keep their existing shapes.
- [x] 1.2 Unit tests for the new fields: scores match the ranking order, `zeroSignalExcluded` = active pages minus candidates, counts stay correct under budget pressure and with zero candidates.

## 2. Sensor write path

- [x] 2.1 Add `getTasksDir()` / `getTaskDir(taskId)` / `getTaskTelemetryPath(taskId)` to `src/memory/paths.ts` (`memory/tasks/<taskId>/telemetry.jsonl`; `getTaskDir` rejects pure-dot taskIds since the ID is a directory segment).
- [x] 2.2 Extend `MemorySelectors` in `src/memory/context.ts` with optional `taskId` and `agent`.
- [x] 2.3 In `buildMemoryContext`, assemble the v1 record (schema version, timestamp, taskId, agent, context snapshot with repo/plugin/taskTitle/userIds, selected pages, dropped, zeroSignalExcluded, candidates, budgets in effect, `renderedTokensEst` = chars/4 of the full memory context) and append it as one JSONL line in a single write, creating the task dir on first write; wrap assemble+write in try/catch that logs a `logger.warn('memory', …)` and never throws; skip silently when `taskId` is absent.
- [x] 2.4 Tests: enriched spawn appends exactly one parseable line with all fields; unwritable telemetry path → prompt identical to sensor-less enrichment + warning logged; injection disabled → no write and no store reads; missing taskId → prompt enriched, no write.

## 3. Spawn seam

- [x] 3.1 Pass `taskId` and `agent: def.id` in `memorySelectors` for all three track branches in `src/agents/spawn.ts` (~L517).

## 4. Docs sync (same change, per src/memory/CLAUDE.md)

- [x] 4.1 Update `docs/architecture/memory.md`: read-path flow gains the sensor step, a dedicated Telemetry section documents the v1 record, storage layout documents `memory/tasks/<taskId>/{summary.md,telemetry.jsonl}`, ejection section confirms everything the layer writes is removed with `memory/`.

## 5. Verify

- [x] 5.1 `npm run typecheck` and `npx vitest run src/memory/__tests__/` pass.
- [x] 5.2 Manual: run a local task with `ARCHIE_MEMORY_INJECT=true` (via `npm run docker:dev`), then inspect the task's telemetry record — one record per spawned agent, fields populated, token estimate plausible. (Done 2026-07-02 in the worktree, pre-relayout at the then-current session-dir path: dockerized instance on port 3458 with injection on and the 139-entity prod-shaped store seeded; task `task-20260702-1908-jgjfb6` created and observed via the `archie-debug` MCP server; PM spawn wrote one v1 record — CLI spawn has no title/users → `candidates: 0`, `zeroSignalExcluded: 138`, `selected: []`, `renderedTokensEst: 8207` (the always-injected index), and the PM still answered the Adjust/antifraud question correctly from index `L0` summaries. Signal-bearing selection verified separately by the unit suite and a real-module harness — score 510 = repo 500 + 1 title token. The record content and fire conditions are unchanged by the relayout; the destination path is covered by unit tests and the 6.x harness rerun.)

## 6. Per-task layout under memory/ (follow-up decision, same change)

- [x] 6.1 Move the sensor destination to `memory/tasks/<taskId>/telemetry.jsonl` and relocate summaries to `memory/tasks/<taskId>/summary.md` (`getSummaryPath` now routes through `getTaskDir`); delete the dead legacy session-summary helper.
- [x] 6.2 One-time idempotent `migrateLegacySummaries()` in `src/memory/lifecycle.ts`, called from `initMemory` — moves `memory/summaries/*.md` into per-task dirs, skips invalid filenames, removes the legacy dir once emptied; tests for move/no-op/skip.
- [x] 6.3 Update tests (context/lifecycle/paths mocks + assertions), the spec delta (sensor path + MODIFIED summary requirement with migration scenario), `docs/architecture/memory.md`, the roadmap sensor bullets, and this change's proposal/design.
- [x] 6.4 Re-verify: typecheck + full memory suite green; real-module harness run against the new layout (record lands in `memory/tasks/<taskId>/telemetry.jsonl`, task dir auto-created).
