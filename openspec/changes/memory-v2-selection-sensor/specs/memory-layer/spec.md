# memory-layer — delta for `memory-v2-selection-sensor`

## ADDED Requirements

### Requirement: Selection observability at agent spawn

When memory is enabled, injection is enabled (`ARCHIE_MEMORY_INJECT=true`), and an agent's system prompt is enriched for a known task, the system SHALL append exactly one JSON line to `sessions/<taskId>/shared/memory-injection.jsonl` recording the selection decision. The line SHALL contain: a schema version, an ISO timestamp, the task ID, the spawning agent, the selection context snapshot (repo, plugin, task title, participating user IDs), the selected entity pages each with slug, score, and scope, the dropped-over-budget slugs, the count of zero-signal pages excluded from candidacy, the candidate count, the injection budgets in effect, and an estimate of the rendered memory-context tokens.

The record SHALL be written append-only, one line per enriched spawn, serialized in a single write. Sensor failures SHALL NOT affect the spawn: on any write or assembly error the system SHALL log a warning and return the enriched prompt exactly as if the sensor did not exist. When injection is disabled the system SHALL NOT write any record and SHALL NOT touch the session directory — the zero-cost disabled path is preserved. When no task ID is available in the spawn selectors, the system SHALL skip the record silently while still enriching the prompt.

#### Scenario: Enriched spawn leaves a selection record

- **WHEN** `ARCHIE_MEMORY_INJECT=true` and an agent spawns for a task with at least one selectable entity
- **THEN** `sessions/<taskId>/shared/memory-injection.jsonl` gains exactly one new line
- **AND** the line parses as JSON containing the schema version, timestamp, task ID, agent, context snapshot, selected pages with slug/score/scope, dropped slugs, zero-signal excluded count, candidate count, budgets, and rendered-token estimate

#### Scenario: Sensor failure never affects the spawn

- **WHEN** appending the selection record fails (e.g. the session directory is missing or unwritable)
- **AND** an agent spawns with injection enabled
- **THEN** the agent's system prompt is enriched exactly as it would be without the sensor
- **AND** a warning is logged
- **AND** no error propagates to the spawn

#### Scenario: Disabled injection writes nothing

- **WHEN** `ARCHIE_MEMORY_INJECT` is unset or not `true`
- **AND** an agent spawns
- **THEN** no `memory-injection.jsonl` record is written
- **AND** no store reads or selection occur (the prompt is returned unchanged)

#### Scenario: Spawn without a task ID skips the record

- **WHEN** injection is enabled and the spawn selectors carry no task ID
- **THEN** the prompt is still enriched with memory context
- **AND** no selection record is written
