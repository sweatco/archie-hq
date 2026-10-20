## Why

The memory layer couples two paths under one master flag (`ARCHIE_MEMORY`): **extraction** (learning facts from completed tasks and writing them to the store) and **injection** (reading those facts back and enriching every agent's prompt). Today you cannot run one without the other. To trust memory in production we first need to accumulate facts and judge their quality *before* they start steering Archie's behavior. A single flag that turns off injection — while extraction keeps populating the store — lets us collect and evaluate the stored facts with zero behavioral risk to day-to-day usage, and gives us a fast kill-switch if a stored fact ever turns out to be wrong or poisoned.

## What Changes

- Add a new environment flag `ARCHIE_MEMORY_INJECT` that gates **only** the injection (read) path. The extraction (write) path is untouched and keeps populating the store.
- **BREAKING (behavioral)**: when the master flag is enabled, injection now **defaults OFF**. Memory is no longer added to agent prompts unless `ARCHIE_MEMORY_INJECT=true` is set explicitly. This deliberately inverts the existing default-enabled flag convention so the safe posture (collect-only) is the default during rollout. To restore the previous always-inject behavior, set `ARCHIE_MEMORY_INJECT=true`.
- When injection is disabled, `enrichPromptWithMemory()` returns the prompt byte-for-byte and **skips all selection/read work** (no user-file reads, no entity-index read, no entity scoring/graph expansion). It emits a single debug log line per spawn noting injection is disabled. The spawn-time username scan is short-circuited for the same reason.
- Master-flag precedence is preserved: `ARCHIE_MEMORY=false` still disables everything (init, extraction, injection) regardless of `ARCHIE_MEMORY_INJECT`.
- Update `.env.example` and `docs/architecture/memory.md` to document the new flag, its inverted default, and the master/sub-flag interaction.

## Capabilities

### New Capabilities

<!-- None — this modifies behavior of the existing memory-layer capability. -->

### Modified Capabilities

- `memory-layer`: the **Memory injection at agent spawn** requirement gains an independent injection gate that defaults off and skips selection work when disabled; a new requirement documents the `ARCHIE_MEMORY_INJECT` toggle, its inverted default, and its precedence under the master `ARCHIE_MEMORY` flag.

## Impact

- **Code**: `src/memory/paths.ts` (new `isInjectionEnabled()` accessor), `src/memory/context.ts` (injection gate + debug log in `enrichPromptWithMemory`), `src/agents/spawn.ts` (short-circuit `extractTaskUsernames` when injection disabled, at all three spawn tracks).
- **Config/docs**: `.env.example`, `docs/architecture/memory.md`, and the canonical spec `openspec/specs/memory-layer/spec.md` (updated by archiving this change).
- **Tests**: `src/memory/__tests__/context.test.ts` (injection-disabled passthrough + no-read assertions); spawn-path coverage for the short-circuit.
- **Behavioral**: any current `feature/memory-layer` deployment that relies on injection must now add `ARCHIE_MEMORY_INJECT=true`. Extraction, storage, housekeeping, and the master kill-switch are unaffected.
