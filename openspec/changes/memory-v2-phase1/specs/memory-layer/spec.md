## MODIFIED Requirements

### Requirement: Memory injection at agent spawn

The system SHALL append a memory context block to the system prompt of every spawned agent (PM track, repo track, plugin track) **when memory is enabled AND injection is enabled** (`ARCHIE_MEMORY_INJECT=true`; see "Memory injection MUST be independently gated and default off"). The block SHALL contain `<user_preferences user="...">` per Slack user mentioned in the task who has a memory file, `<recent_activity>` (when recent-activity.md is non-empty), `<entity_index>` (when at least one entity exists), and `<entity slug="..." ...>` blocks for the entities selected for this task. Organizational knowledge is carried by the injected `scope: org` entity pages **and the always-injected `<entity_index>`**, not a separate `<organizational_knowledge>` block. The block SHALL be appended after the agent's track-specific context and any plugin overlays, under a header `## Organizational Memory`. If no memory exists, the prompt SHALL be returned unchanged. When injection is disabled, the system SHALL return the prompt unchanged and SHALL NOT perform any store reads or entity selection.

Entity-page selection SHALL be **push** (decided by the system at spawn, with no agent-callable query tool). The system SHALL select full entity pages by scoring the entity index against the spawn context — the agent's repo or plugin, the participating users, and the task title — and SHALL expand one hop along `[[wikilink]]` relations from the selected set. `scope: org` entity pages SHALL be bounded by `ARCHIE_MEMORY_ORG_INJECT_MAX` and SHALL be selected by relevance score with last-touched recency as the tiebreak; they SHALL NOT be injected unconditionally and SHALL NOT be exempt from a bound. The bound `ARCHIE_MEMORY_ENTITY_INJECT_MAX` SHALL apply to the remaining repo/domain/title-scored and graph-expanded (non-`org`) pages. When more pages of either class qualify than its bound allows, the system SHALL inject the highest-scoring ones and SHALL log which entities were dropped. The thin `<entity_index>` SHALL always be injected in full and SHALL NOT be subject to any page bound — it is the catalogue through which org knowledge dropped from full injection remains discoverable via its `L0` summary.

#### Scenario: Spawned agent receives memory context

- **WHEN** a `scope: org` entity exists and a user with memory is mentioned in the task
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **AND** an agent spawns for that task
- **THEN** its system prompt contains both the `scope: org` `<entity ...>` block and a `<user_preferences user="...">` block
- **AND** no `<organizational_knowledge>` block is present

#### Scenario: Org-scoped entities are bounded by the org injection budget

- **WHEN** more `scope: org` entities exist than `ARCHIE_MEMORY_ORG_INJECT_MAX`
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **AND** an agent spawns
- **THEN** at most `ARCHIE_MEMORY_ORG_INJECT_MAX` `scope: org` entity pages are injected in full
- **AND** the injected pages are the highest-scoring org pages by relevance, with last-touched date breaking ties
- **AND** the dropped org entity slugs are logged

#### Scenario: Dropped org page remains discoverable via the index

- **WHEN** a `scope: org` entity is not selected for full injection
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **AND** an agent spawns
- **THEN** the `<entity_index>` still contains that entity's row including its `L0` summary

#### Scenario: Entity index is always injected when entities exist

- **WHEN** at least one entity file exists
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **AND** an agent spawns
- **THEN** its system prompt contains an `<entity_index>` block listing the entities

#### Scenario: Repo-scoped and org-scoped entities are selected

- **WHEN** a repo agent spawns for repo `backend`
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **AND** an entity `payment-service` has `repos: [backend]` and an entity `stripe` has `scope: org`
- **AND** the number of `scope: org` entities is within `ARCHIE_MEMORY_ORG_INJECT_MAX`
- **THEN** both `payment-service` and `stripe` full pages are injected

#### Scenario: One-hop graph expansion pulls a linked entity

- **WHEN** `payment-service` is selected and contains `depends_on [[postgres-prod]]`
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **AND** `postgres-prod` is not directly matched by the spawn context
- **THEN** `postgres-prod` is also injected

#### Scenario: Injection bound drops are logged

- **WHEN** more non-`org` entities qualify for injection than `ARCHIE_MEMORY_ENTITY_INJECT_MAX`
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **THEN** only the bound's worth of highest-scoring pages are injected
- **AND** the dropped entity slugs are logged

#### Scenario: Feature-disabled passthrough

- **WHEN** memory is disabled (`ARCHIE_MEMORY=false`)
- **AND** any agent spawns
- **THEN** `enrichPromptWithMemory()` returns the input prompt byte-for-byte

#### Scenario: Injection-disabled passthrough

- **WHEN** memory is enabled but `ARCHIE_MEMORY_INJECT` is unset or not `true`
- **AND** any agent spawns
- **THEN** `enrichPromptWithMemory()` returns the input prompt byte-for-byte
- **AND** no store reads or entity selection are performed
- **AND** a single debug log line records that injection is disabled

## ADDED Requirements

### Requirement: Entity pages SHALL be bounded by a per-page observation cap

The system SHALL bound the number of observations stored on any single entity page by a configurable soft cap (`ARCHIE_MEMORY_ENTITY_OBS_CAP`, default 30). When applying an entity update would push a page's observation count above the cap, the system SHALL retain the newest-touched observations up to the cap and SHALL drop the oldest-touched surplus, logging the number dropped. Dropping SHALL be deterministic (ordered by the `touched:` annotation, newest retained) and SHALL NOT invoke a side-agent. Relations SHALL NOT be subject to this cap.

**Rationale:** Entity observations are append-only and only deduplicated, never bounded per page. Without a per-page cap a single page grows without limit and re-inflates the injected system prompt even when the *number* of injected pages is bounded. The cap mirrors the per-section bullet cap already enforced on user memory files.

#### Scenario: Over-cap page keeps the newest observations

- **WHEN** an entity page already holds `ARCHIE_MEMORY_ENTITY_OBS_CAP` observations
- **AND** an applied update adds a further distinct observation
- **THEN** the page retains exactly `ARCHIE_MEMORY_ENTITY_OBS_CAP` observations
- **AND** the retained observations are the newest by `touched:` date
- **AND** the number of dropped observations is logged

#### Scenario: Relations are not affected by the observation cap

- **WHEN** an entity page has more relations than `ARCHIE_MEMORY_ENTITY_OBS_CAP`
- **AND** an entity update is applied to it
- **THEN** no relations are dropped by the observation cap
