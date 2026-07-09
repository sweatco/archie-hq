# Memory Layer — Delta: memory-v2-preflight

## ADDED Requirements

### Requirement: Offline selection replay against a pulled store

Before injection enablement, the repo SHALL provide a read-only replay tool (`scripts/memory-preflight.ts`) that, given an extracted snapshot produced by `pull-remote-data.sh`, reconstructs recent tasks' spawn selection contexts from session artifacts and reports what entity injection would have produced — using the same `selectEntities` code path and render logic as production, never a reimplementation. The tool MUST NOT modify the snapshot, the local store, or any prod system. This requirement is scoped to the pre-enablement phase: once live selection telemetry supersedes the replay after enablement, the tool MAY be deleted without violating this requirement.

#### Scenario: Replay reports would-be injection per spawn

- **WHEN** the tool runs with `ARCHIE_WORKDIR` pointing at an extracted snapshot containing `memory/` and `sessions/`
- **THEN** for each replayed spawn it prints the selected entity slugs with score and scope, dropped-over-budget slugs, zero-signal exclusion count, candidate count, and a rendered-token estimate computed with the sensor's `chars/4` rule over the full memory context the injection flag would enable — user-preferences and recent-activity blocks included, via the production context builder — not entity blocks alone

#### Scenario: Worst-case token arithmetic is computed from the store

- **WHEN** the tool completes a replay
- **THEN** it prints an enablement bound derived from the snapshot, covering every block the injection flag enables: rendered index tokens plus `ARCHIE_MEMORY_ORG_INJECT_MAX` times the largest org page plus `ARCHIE_MEMORY_ENTITY_INJECT_MAX` times the largest non-org page (after `touched_by` render truncation) plus the summed rendered `<user_preferences>` blocks over every user file in the snapshot (rendered with the production wrapper, not raw file bytes — a true bound, since runtime does not cap involved users and each user contributes at most one block) plus rendered recent-activity tokens, alongside the observed per-spawn maximum, every number tagged with the env values that shaped it (`ARCHIE_MEMORY_ORG_INJECT_MAX`, `ARCHIE_MEMORY_ENTITY_INJECT_MAX`, `ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX`) as read back through the production flag accessors, not raw environment strings

#### Scenario: Coverage is reported honestly

- **WHEN** some tasks in the snapshot cannot be reconstructed (missing or unparseable `metadata.json`, agent unresolvable from agent config and snapshot metadata, or a multi-repo agent whose primary is ambiguous without config)
- **THEN** the tool reports how many tasks were replayed out of how many were found, with per-skip reasons, instead of silently narrowing the sample

#### Scenario: Store-review reading list

- **WHEN** the tool runs with `--report`
- **THEN** it prints a reading list for the human store review covering every block the injection flag enables: entities ordered by relation count, observation count, and page size; a staleness distribution; every per-user preference file (`memory/users/*.md`), `recent-activity.md`, and the persisted entity index (`memory/entities/index.md`, injected verbatim as `<entity_index>`), each with its size; and flagged content matching suspicious patterns (URLs, imperative override phrasing, base64-like blobs) across entity pages, user files, recent-activity, and the rendered index alike

#### Scenario: Replay leaves the snapshot untouched

- **WHEN** a full replay including a `--report` run completes over an extracted snapshot
- **THEN** the snapshot tree is byte-identical to its pre-run state (verifiable by hashing the tree before and after), with no new files — no selection telemetry under `memory/tasks/`, no `plugins/` or `plugins-data/` directories
