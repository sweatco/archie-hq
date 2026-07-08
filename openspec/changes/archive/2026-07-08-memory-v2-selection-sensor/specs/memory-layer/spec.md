# memory-layer — delta for `memory-v2-selection-sensor`

## ADDED Requirements

### Requirement: Selection observability at agent spawn

When memory is enabled, injection is enabled (`ARCHIE_MEMORY_INJECT=true`), and an agent's system prompt is enriched for a known task, the system SHALL append exactly one JSON line to `workdir/memory/tasks/<taskId>/telemetry.jsonl` recording the selection decision, creating the task directory when absent. The line SHALL contain: a schema version, an ISO timestamp, the task ID, the spawning agent, the selection context snapshot (repo, plugin, task title, participating user IDs), the selected entity pages each with slug, score, and scope, the dropped-over-budget slugs, the count of zero-signal pages excluded from candidacy, the candidate count, the injection budgets in effect, and an estimate of the rendered memory-context tokens.

The record SHALL be written append-only, one line per enriched spawn, serialized in a single write. Sensor failures SHALL NOT affect the spawn: on any write or assembly error the system SHALL log a warning and return the enriched prompt exactly as if the sensor did not exist. When injection is disabled the system SHALL NOT write any telemetry — the zero-cost disabled path is preserved. When no task ID is available in the spawn selectors, the system SHALL skip the record silently while still enriching the prompt.

#### Scenario: Enriched spawn leaves a selection record

- **WHEN** `ARCHIE_MEMORY_INJECT=true` and an agent spawns for a task with at least one selectable entity
- **THEN** `workdir/memory/tasks/<taskId>/telemetry.jsonl` gains exactly one new line
- **AND** the line parses as JSON containing the schema version, timestamp, task ID, agent, context snapshot, selected pages with slug/score/scope, dropped slugs, zero-signal excluded count, candidate count, budgets, and rendered-token estimate

#### Scenario: Sensor failure never affects the spawn

- **WHEN** appending the selection record fails (e.g. the telemetry path is unwritable)
- **AND** an agent spawns with injection enabled
- **THEN** the agent's system prompt is enriched exactly as it would be without the sensor
- **AND** a warning is logged
- **AND** no error propagates to the spawn

#### Scenario: Disabled injection writes nothing

- **WHEN** `ARCHIE_MEMORY_INJECT` is unset or not `true`
- **AND** an agent spawns
- **THEN** no telemetry record is written
- **AND** no store reads or selection occur (the prompt is returned unchanged)

#### Scenario: Spawn without a task ID skips the record

- **WHEN** injection is enabled and the spawn selectors carry no task ID
- **THEN** the prompt is still enriched with memory context
- **AND** no selection record is written

## MODIFIED Requirements

### Requirement: Per-task summary written to session shared dir

The system SHALL write a per-task summary file to `workdir/memory/tasks/<taskId>/summary.md` for every task that produces a non-null extraction result. The previous locations — `workdir/sessions/<taskId>/shared/summary.md` and the flat `workdir/memory/summaries/<taskId>.md` — SHALL NOT be written; legacy files under `workdir/memory/summaries/` SHALL be relocated to `workdir/memory/tasks/<taskId>/summary.md` once at startup, idempotently, skipping filenames that do not form a valid task ID.

The summary file SHALL contain:

1. **YAML frontmatter** with `task_id`, `status`, `created_at`, `updated_at`, `domain`, `extraction_at` (when extraction ran), and a `links` section enumerating originating channel references (Slack thread URLs by `channel_id` + `thread_id`, GitHub PR URLs when present, CLI session IDs).
2. **`# Summary`** — the prose summary returned by the extractor.
3. **`## Memory Updates`** — a structured breakdown of every update applied, grouped by target file (including entity files). For each update: action (`added` or `updated`), target section, the new bullet, and for `updated` both the previous and the new content as a textual before/after. When zero updates were applied, the explicit literal `_no durable learnings_`.
4. **`## Related Tasks`** — up to 5 links to other task summaries. The system SHALL select related tasks by **shared entities first** (other tasks linked via `touched_by` to the entities this task touched), and SHALL fall back to domain + lexical similarity to the current `activity_summary` only when no entity overlap exists. When no candidates clear the threshold, the explicit literal `_no related tasks found_`.

The per-task directory `workdir/memory/tasks/<taskId>/` SHALL hold the task's memory artifacts (`summary.md`, `telemetry.jsonl`). Ejectability is preserved: the entire `workdir/memory/` tree (including `tasks/` and `entities/`) is removable as a unit.

**Rationale:** Co-locating each task's artifacts in one directory under memory keeps the store self-contained (single-step ejection, memory-only pulls carry everything) and separates the episodic (per-task) from the semantic (`entities/`, `users/`) side of the store. Selecting related tasks by shared entities replaces the weak lexical-overlap signal with one grounded in shared subject matter.

#### Scenario: Summary file lives under the task's memory directory

- **WHEN** a task completes and extraction succeeds
- **THEN** `workdir/memory/tasks/<taskId>/summary.md` exists
- **AND** neither `workdir/sessions/<taskId>/shared/summary.md` nor `workdir/memory/summaries/<taskId>.md` is written

#### Scenario: Legacy flat summaries are relocated at startup

- **WHEN** the memory layer initializes and `workdir/memory/summaries/<taskId>.md` files exist from a previous version
- **THEN** each file with a valid task-ID name is moved to `workdir/memory/tasks/<taskId>/summary.md`
- **AND** the legacy directory is removed once emptied

#### Scenario: Related tasks selected by shared entity

- **WHEN** task A and task B both have `touched_by` links to entity `payment-service`
- **AND** task B's summary is generated after task A
- **THEN** task B's `## Related Tasks` links to task A
