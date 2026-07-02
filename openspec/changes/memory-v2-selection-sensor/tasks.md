# Tasks: memory-v2-selection-sensor

## 1. Selection telemetry surface

- [x] 1.1 Extend `SelectionResult` in `src/memory/entity-index.ts` with additive fields — per-selected `{slug, score, scope}`, `zeroSignalExcluded`, `candidates` — populated inside `selectEntities`; `selected`/`dropped` keep their existing shapes.
- [x] 1.2 Unit tests for the new fields: scores match the ranking order, `zeroSignalExcluded` = active pages minus candidates, counts stay correct under budget pressure and with zero candidates.

## 2. Sensor write path

- [x] 2.1 Add `getSessionInjectionLogPath(taskId)` to `src/memory/paths.ts` (joins `WORKDIR`, `sessions`, taskId, `shared/memory-injection.jsonl`).
- [x] 2.2 Extend `MemorySelectors` in `src/memory/context.ts` with optional `taskId` and `agent`.
- [x] 2.3 In `buildMemoryContext`, assemble the v1 record (schema version, timestamp, taskId, agent, context snapshot with repo/plugin/taskTitle/userIds, selected pages, dropped, zeroSignalExcluded, candidates, budgets in effect, `renderedTokensEst` = chars/4 of the full memory context) and append it as one JSONL line in a single write; wrap assemble+write in try/catch that logs a `logger.warn('memory', …)` and never throws; skip silently when `taskId` is absent.
- [x] 2.4 Tests: enriched spawn appends exactly one parseable line with all fields; unwritable session dir → prompt identical to sensor-less enrichment + warning logged; injection disabled → no write and no store reads; missing taskId → prompt enriched, no write.

## 3. Spawn seam

- [x] 3.1 Pass `taskId` and `agent: def.id` in `memorySelectors` for all three track branches in `src/agents/spawn.ts` (~L517).

## 4. Docs sync (same change, per src/memory/CLAUDE.md)

- [x] 4.1 Update `docs/architecture/memory.md`: read-path flow gains the sensor step, storage layout documents `sessions/<taskId>/shared/memory-injection.jsonl` with the v1 record fields, ejection section notes telemetry lives under `sessions/` and is removed with sessions, not with `memory/`.

## 5. Verify

- [x] 5.1 `npm run typecheck` and `npx vitest run src/memory/__tests__/` pass.
- [x] 5.2 Manual: run a local task with `ARCHIE_MEMORY_INJECT=true` (via `npm run docker:dev`), then inspect `workdir/sessions/<taskId>/shared/memory-injection.jsonl` — one record per spawned agent, fields populated, token estimate plausible. (Done 2026-07-02 in the worktree: dockerized instance on port 3458 with injection on and the 139-entity prod-shaped store seeded; task `task-20260702-1908-jgjfb6` created and observed via the `archie-debug` MCP server; PM spawn wrote one v1 record — CLI spawn has no title/users → `candidates: 0`, `zeroSignalExcluded: 138`, `selected: []`, `renderedTokensEst: 8207` (the always-injected index), and the PM still answered the Adjust/antifraud question correctly from index `L0` summaries. Signal-bearing selection verified separately by the unit suite and a real-module harness — score 510 = repo 500 + 1 title token. Also verified earlier: fail-safe warn path, disabled-injection no-write, missing-taskId skip.)
