# Design: memory-v2-selection-sensor

## Context

The read path (`spawn.ts:523` → `enrichPromptWithMemory` → `buildMemoryContext` → `selectEntities` + render) is fully assembled and gated by the default-off `ARCHIE_MEMORY_INJECT`. Phase 1 made selection bounded and relevance-gated; the roadmap's Phase 1.5 flips the flag in prod and tunes budgets from live data. Today the only trace of a selection decision is a console line listing dropped slugs (`context.ts:81`) — ephemeral, incomplete (no scores, no tokens, no selected set), and not joinable to the task afterwards. Constraints from `src/memory/CLAUDE.md`: memory stays ejectable (no DB), core↔memory coupling stays at the two existing seams, no memory types leak into core, model output is untrusted, and behavior changes ship with doc/spec/test updates in the same change.

## Goals / Non-Goals

**Goals:**
- Every injection-enabled spawn leaves one durable, self-contained JSON record of the selection decision: inputs (context), outputs (selected/dropped with scores), and cost (token estimate).
- Records land where the existing ops tooling already harvests them (`sessions/<taskId>/shared/`), joinable against `knowledge.log` for the Phase 5 eval.
- Telemetry can never break a spawn.

**Non-Goals:**
- Pull-tool telemetry (Phase 2), store snapshots and pull cadence (ops, no code), the disposable pre-flight replay script, and any analysis/reporting on the records (Phase 5).
- New env flags or config surface.
- Changing selection behavior — this change observes, it does not alter ranking, budgets, or rendering.

## Decisions

### 1. The record is assembled and written inside `buildMemoryContext`, not returned to core

`buildMemoryContext` is the only place where the selection result, the rendered blocks, and the inputs coexist. Writing there keeps `enrichPromptWithMemory`'s signature (`Promise<string>`) and the two-seam invariant intact.
- **Alternative — return a record object to `spawn.ts` and write from core:** rejected; it leaks memory types into core and widens the seam, the exact coupling `src/memory/CLAUDE.md` forbids.

### 2. Destination: `<WORKDIR>/sessions/<taskId>/shared/memory-injection.jsonl`, one line per enriched spawn

A `getSessionInjectionLogPath(taskId)` helper goes in `paths.ts` (which already imports `WORKDIR`). JSONL because a task sees multiple spawns (PM, then specialists) and append-only lines need no read-modify-write.
- **Why the session dir and not `memory/`:** colocation with `knowledge.log` is what makes Phase 5 joins trivial; `scripts/pull-remote-data.sh` already tarballs `sessions/`, so harvesting needs zero new plumbing; per-task sharding avoids a global file with cross-task write contention.
- **Trade-off accepted:** the memory module learns one session-layout path. It is contained in a single `paths.ts` helper; the inverse (core writes memory's record) leaks types the other way and was rejected in Decision 1. The ejection recipe in `memory.md` gains one line: telemetry files live under `sessions/` and disappear with sessions, not with `memory/`.
- **Concurrency:** each record is serialized to a single small `appendFile` call (O_APPEND); concurrent spawns are rare and temporally spread, and a worst-case interleave corrupts one telemetry line, never app state. Phase 5 readers must skip unparseable lines.

### 3. Each line is a self-contained replay case: inputs + outputs + cost, versioned

```json
{"v":1,"ts":"2026-07-02T14:03:11.412Z","taskId":"task-…","agent":"backend",
 "ctx":{"repo":"sweatco/api","plugin":null,"taskTitle":"…","userIds":["U…"]},
 "selected":[{"slug":"payment-service","score":510,"scope":"org"}],
 "dropped":["adjust"],"zeroSignalExcluded":141,"candidates":17,
 "budgets":{"org":8,"nonOrg":8},"renderedTokensEst":3120}
```
- Recording the `SelectionContext` snapshot alongside the outcome makes every line a labeled selection case — the raw material for the Phase 5 golden/regression set — and makes lines survive aggregation across files (hence `taskId` in the line despite being derivable from the path).
- `v:1` is cheap insurance for Phase 5 parsers against schema evolution.
- `renderedTokensEst` is `chars/4` over the full appended memory context (user prefs + activity + index + entity blocks), labeled an estimate; budget tuning needs relative comparisons, not tokenizer-exact counts.

### 4. `SelectionResult` gains additive telemetry fields; existing consumers untouched

`selectEntities` currently returns `{selected: EntityRecord[], dropped: string[]}` and keeps scores and the zero-signal count internal. It gains additive fields — per-selected `{slug, score, scope}`, `zeroSignalExcluded`, `candidates` — while `selected`/`dropped` keep their shapes so renderers and existing tests are unaffected.
- **Alternative — recompute scores outside:** rejected; duplicates the scoring pass and drifts the moment scoring changes.

### 5. `MemorySelectors` gains optional `taskId` and `agent`; spawn passes both

Both are in scope at the call site (`taskId`, `def.id`). Optional fields keep every other caller (tests, future CLI paths) valid; when `taskId` is absent, the sensor is skipped silently — there is no session dir to write into.

### 6. Fail-safe by construction; no new flag

The entire assemble-and-append path is wrapped in try/catch; failure logs one `logger.system` warning and the enriched prompt is returned exactly as if the sensor didn't exist. The write is awaited (a fire-and-forget promise loses errors and can be dropped on process exit; one small append adds negligible latency to a spawn that already does file and network I/O). Records are written iff injection is enabled — with injection off, `enrichPromptWithMemory` bails before any store read, preserving today's zero-cost path. A dedicated telemetry flag adds config surface with no current use case; if "inject without recording" is ever wanted, add it then.

## Risks / Trade-offs

- **[Schema drifts before Phase 5 consumes it]** → `v` field per line; readers skip lines with unknown versions or parse failures.
- **[Token estimate inaccuracy]** → labeled `Est`; tuning decisions compare configurations relative to each other, where a constant-factor error cancels.
- **[User IDs and task titles duplicated into another session file]** → same trust/PII class as `metadata.json` and `knowledge.log` already in the same directory; no new exposure surface.
- **[Sensor writes on every spawn forever]** → bounded: a few KB per task, sharded per session dir, cleaned up with sessions; no compaction needed.

## Migration Plan

Purely additive; dark until `ARCHIE_MEMORY_INJECT=true`. No data migration, no flag changes. Rollback: revert the commit, or disable injection (which also stops the sensor). Verify: `npm run typecheck`; `npx vitest run src/memory/__tests__/`; manual: enable injection locally, run a task, inspect `sessions/<taskId>/shared/memory-injection.jsonl`.

## Open Questions

- Should the record itemize per-block token estimates (user prefs vs activity vs index vs entities) instead of one total? Decide during implementation — additive either way; start with the total plus an `entities` sub-count if it falls out naturally.
