## ADDED Requirements

### Requirement: Memory injection MUST be independently gated and default off

Injection (the read path) SHALL be gated by a dedicated environment variable `ARCHIE_MEMORY_INJECT`, independent of extraction. Injection SHALL occur only when memory is enabled (`ARCHIE_MEMORY` ≠ `false`) AND `ARCHIE_MEMORY_INJECT` is exactly `true`. The default (unset, or any value other than `true`) SHALL be **disabled**, so an enabled memory layer collects and stores facts without injecting them into prompts until injection is explicitly opted in. The master flag SHALL take precedence: when `ARCHIE_MEMORY=false`, injection SHALL be off regardless of `ARCHIE_MEMORY_INJECT`. Extraction, storage, and housekeeping SHALL NOT be affected by `ARCHIE_MEMORY_INJECT`.

#### Scenario: Injection is off by default

- **WHEN** `ARCHIE_MEMORY` is enabled and `ARCHIE_MEMORY_INJECT` is unset
- **AND** an agent spawns
- **THEN** no memory block is appended to its system prompt
- **AND** extraction still runs on task completion, writing to the store

#### Scenario: Injection is opt-in

- **WHEN** `ARCHIE_MEMORY_INJECT=true` and memory is enabled
- **AND** an agent spawns for a task with available memory
- **THEN** the `## Organizational Memory` block is appended to its system prompt

#### Scenario: Master flag takes precedence over the injection flag

- **WHEN** `ARCHIE_MEMORY=false` and `ARCHIE_MEMORY_INJECT=true`
- **AND** an agent spawns
- **THEN** no memory block is appended
- **AND** no store reads occur

#### Scenario: Disabling injection does not disable extraction

- **WHEN** `ARCHIE_MEMORY` is enabled and injection is disabled
- **AND** a task completes
- **THEN** facts are extracted and written to the store as usual

## MODIFIED Requirements

### Requirement: Memory injection at agent spawn

The system SHALL append a memory context block to the system prompt of every spawned agent (PM track, repo track, plugin track) **when memory is enabled AND injection is enabled** (`ARCHIE_MEMORY_INJECT=true`; see "Memory injection MUST be independently gated and default off"). The block SHALL contain `<user_preferences user="...">` per Slack user mentioned in the task who has a memory file, `<recent_activity>` (when recent-activity.md is non-empty), `<entity_index>` (when at least one entity exists), and `<entity slug="..." ...>` blocks for the entities selected for this task. Organizational knowledge is carried by the injected `scope: org` entity pages, not a separate `<organizational_knowledge>` block. The block SHALL be appended after the agent's track-specific context and any plugin overlays, under a header `## Organizational Memory`. If no memory exists, the prompt SHALL be returned unchanged. When injection is disabled, the system SHALL return the prompt unchanged and SHALL NOT perform any store reads or entity selection.

Entity-page selection SHALL be **push** (decided by the system at spawn, with no agent-callable query tool). The system SHALL select full entity pages by scoring the entity index against the spawn context — the agent's repo or plugin, the participating users, and the task title — SHALL always include entities whose `scope` is `org`, and SHALL expand one hop along `[[wikilink]]` relations from the selected set. Entities whose `scope` is `org` SHALL always be injected in full and SHALL NOT be subject to the page bound — they hold the organizational knowledge that previously lived in `org.md` and must remain always-on. The bound (`ARCHIE_MEMORY_ENTITY_INJECT_MAX`) SHALL apply only to the remaining repo/domain/title-scored and graph-expanded pages; when more of those qualify than the bound allows, the system SHALL inject the highest-scoring ones and SHALL log which entities were dropped. The thin `<entity_index>` is likewise not subject to the page bound.

#### Scenario: Spawned agent receives memory context

- **WHEN** a `scope: org` entity exists and a user with memory is mentioned in the task
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **AND** an agent spawns for that task
- **THEN** its system prompt contains both the `scope: org` `<entity ...>` block and a `<user_preferences user="...">` block
- **AND** no `<organizational_knowledge>` block is present

#### Scenario: Org-scoped entities are exempt from the injection bound

- **WHEN** more `scope: org` entities exist than `ARCHIE_MEMORY_ENTITY_INJECT_MAX`
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **AND** an agent spawns
- **THEN** every `scope: org` entity page is injected in full
- **AND** the bound applies only to the repo/domain/title-selected and graph-expanded pages

#### Scenario: Entity index is always injected when entities exist

- **WHEN** at least one entity file exists
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **AND** an agent spawns
- **THEN** its system prompt contains an `<entity_index>` block listing the entities

#### Scenario: Repo-scoped and org-scoped entities are selected

- **WHEN** a repo agent spawns for repo `backend`
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **AND** an entity `payment-service` has `repos: [backend]` and an entity `stripe` has `scope: org`
- **THEN** both `payment-service` and `stripe` full pages are injected

#### Scenario: One-hop graph expansion pulls a linked entity

- **WHEN** `payment-service` is selected and contains `depends_on [[postgres-prod]]`
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **AND** `postgres-prod` is not directly matched by the spawn context
- **THEN** `postgres-prod` is also injected

#### Scenario: Injection bound drops are logged

- **WHEN** more entities qualify for injection than `ARCHIE_MEMORY_ENTITY_INJECT_MAX`
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

### Requirement: Feature flag controls all read+write paths

The system SHALL provide a master kill-switch via the environment variable `ARCHIE_MEMORY`. When `ARCHIE_MEMORY=false` the initialization function SHALL be a no-op, the enrichment function SHALL return its input unchanged, and the task-completed handler SHALL return immediately — disabling initialization, extraction, and injection together. Default for the master flag SHALL be enabled: `ARCHIE_MEMORY` unset or any value other than `false` enables the layer (initialization and extraction). Enabling the layer SHALL NOT by itself enable injection — the read path is independently gated by `ARCHIE_MEMORY_INJECT`, which defaults off (see "Memory injection MUST be independently gated and default off"). `ARCHIE_MEMORY=false` SHALL take precedence over `ARCHIE_MEMORY_INJECT`.

#### Scenario: Disabled flag produces no side effects

- **WHEN** `ARCHIE_MEMORY=false` is set
- **AND** the process starts and tasks complete
- **THEN** `workdir/memory/` is not created
- **AND** no Slack "Learned from this task" messages are posted
