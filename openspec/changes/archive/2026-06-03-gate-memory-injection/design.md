## Context

The memory layer has two architecturally decoupled paths that share only the on-disk store:

- **Injection (read)** — `enrichPromptWithMemory()` in `src/memory/context.ts` appends a `## Organizational Memory` block to every spawned agent's system prompt. Called at three sites in `src/agents/spawn.ts` (PM, repo, plugin tracks), each preceded by `extractTaskUsernames()` which scans the task transcript for Slack mentions and reads the matching user files.
- **Extraction (write)** — `handleTaskCompleted()` → `processExtraction()` in `src/memory/lifecycle.ts` runs after `task:completed`, learns facts, and writes user/entity/summary/activity files.

Both are currently gated by a single accessor, `isMemoryEnabled()` (`src/memory/paths.ts`), driven by `ARCHIE_MEMORY`. There is no way to keep extraction running while suppressing injection. We want exactly that: accumulate and evaluate stored facts without letting them change Archie's behavior in day-to-day usage, and keep a fast kill-switch on the read path. The branch (`feature/memory-layer`) is not yet relied on in production, so changing the default posture is low-risk and the right moment.

## Goals / Non-Goals

**Goals:**
- A single env flag that suppresses only the injection path; extraction/storage continue unchanged.
- When injection is disabled, do **zero** selection/read work — no user-file reads, no entity-index read, no entity scoring or graph expansion — and return the prompt byte-for-byte.
- Make the safe (collect-only) posture the zero-config default on this branch.
- Preserve the master kill-switch and its precedence exactly.

**Non-Goals:**
- A symmetric extraction toggle (`ARCHIE_MEMORY_EXTRACT`). Out of scope; may follow later.
- "Shadow injection" (computing what *would* be injected and logging it). Explicitly rejected — selection work is skipped. Stored facts are evaluated directly via the files / `archie-debug` MCP.
- Any change to the extraction pipeline, storage layout, housekeeping, or entity selection logic.

## Decisions

### Decision 1: A dedicated boolean sub-flag, not an overloaded master value

Add `ARCHIE_MEMORY_INJECT` as a new env var with its own accessor `isInjectionEnabled()` in `src/memory/paths.ts`, mirroring the existing `isHousekeepingEnabled()` sub-flag.

- **Why**: orthogonal concern (read path) deserves its own switch; it composes cleanly with the master flag and is discoverable in `.env.example`.
- **Alternative — tri-state `ARCHIE_MEMORY` (`false` | `collect` | `true`)**: rejected. Overloads one boolean accessor that the whole layer reads, mixes two concerns into one var, and is harder to reason about than two independent switches.

### Decision 2: Default OFF (inverts the default-enabled convention)

`isInjectionEnabled()` returns `true` **only** when `process.env.ARCHIE_MEMORY_INJECT === 'true'`. Unset or any other value ⇒ injection off.

- **Why**: the requested rollout is collect-first. Making off the default means the safe posture needs no configuration, and turning memory loose on prompts is an explicit, auditable opt-in.
- **Trade-off**: this is the opposite of `ARCHIE_MEMORY` and `ARCHIE_MEMORY_HOUSEKEEPING`, which default enabled. The inconsistency is intentional and is called out as **BREAKING** in the proposal and documented in `.env.example` and `docs/architecture/memory.md`.
- **Alternative — default ON for convention consistency**: rejected; it defeats the purpose (memory would start steering behavior the moment the master flag is on).

### Decision 3: Two gates, centralized in the functions that own the read path

Injection is active iff `isMemoryEnabled() && isInjectionEnabled()`.

- **Primary gate — `enrichPromptWithMemory()` (`context.ts`)**: after the existing `isMemoryEnabled()` early-return, add a second early-return when `!isInjectionEnabled()` that returns the input prompt unchanged and emits one debug log line. This is the authoritative gate: it runs *before* `buildMemoryContext()`, so it skips the global reads (`recent-activity.md`, entity index, entity scoring, one-hop expansion) and the per-user reads alike.
- **Secondary gate — `extractTaskUsernames()` (`spawn.ts`)**: return `[]` early when `!isInjectionEnabled()` (it already returns `[]` when `!isMemoryEnabled()`). Its result feeds only the injection call, so short-circuiting skips the transcript username scan and per-user file lookups.

- **Why both**: gating spawn alone is insufficient — `buildMemoryContext()` still injects the global `<recent_activity>`, `<entity_index>`, and `scope: org` entities regardless of the user list. Gating `context.ts` alone is functionally correct but leaves the username scan running for nothing. Together they guarantee no read work.
- **Alternative — wrap each of the 3 spawn call sites in an `if`**: rejected; three duplicated guards drift over time. Centralizing in the two functions that already encapsulate the read path keeps one source of truth.

### Decision 4: `isInjectionEnabled()` is a pure sub-flag accessor

It checks only `ARCHIE_MEMORY_INJECT`; it does **not** internally call `isMemoryEnabled()`. Callers combine the two. This keeps the accessor single-responsibility (matching the other `paths.ts` accessors), makes precedence explicit at the call site (`isMemoryEnabled()` is always checked first), and means `ARCHIE_MEMORY=false` short-circuits before the inject flag is ever read.

### Decision 5: Lean observability — one debug line, no info-level noise

When `enrichPromptWithMemory()` short-circuits on inject-off, log a single debug line (via the unified logger) distinguishing it from the master-off path. No per-fact or selection logging.

## Risks / Trade-offs

- **Existing branch deployments silently lose injection** → Mitigated by the **BREAKING** callout in the proposal, the `.env.example` entry, the truth table in `docs/architecture/memory.md`, and the per-spawn debug line; the one-line fix is `ARCHIE_MEMORY_INJECT=true`.
- **Store accumulates facts that are never exercised by injection** → No new risk: extraction is already bounded by soft caps + housekeeping. Evaluate the store directly via files / `archie-debug` MCP.
- **Two flags with opposite defaults confuse operators** → Mitigated by a single documented truth table (`ARCHIE_MEMORY` × `ARCHIE_MEMORY_INJECT`) in `.env.example` and `memory.md`.
- **Gate drift between `context.ts` and `spawn.ts`** → Mitigated by tests asserting (a) prompt is returned byte-for-byte and (b) no store reads occur when injection is disabled.

## Migration Plan

1. Deploy with `ARCHIE_MEMORY` enabled and `ARCHIE_MEMORY_INJECT` unset → collect-only mode. Extraction populates the store; prompts are unchanged.
2. Evaluate stored facts (files / `archie-debug` MCP) until confident.
3. Set `ARCHIE_MEMORY_INJECT=true` to enable injection.

**Rollback**: unset `ARCHIE_MEMORY_INJECT` (or set ≠ `true`). No data migration — the store is untouched. Full kill remains `ARCHIE_MEMORY=false`.

## Open Questions

- A symmetric `ARCHIE_MEMORY_EXTRACT` toggle for completeness — deferred; revisit if a "inject-only, stop-learning" mode is ever needed.
- If the per-spawn debug line proves noisy in practice, downgrade to once-per-process. Defaulting to per-spawn at debug level for now.
