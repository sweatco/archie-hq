## MODIFIED Requirements

### Requirement: Memory injection at agent spawn

The system SHALL append a memory context block to the system prompt of every spawned agent (PM track, repo track, plugin track) **when memory is enabled AND injection is enabled** (`ARCHIE_MEMORY_INJECT=true`; see "Memory injection MUST be independently gated and default off"). The block SHALL contain `<user_preferences user="...">` per Slack user mentioned in the task who has a memory file, `<recent_activity>` (when recent-activity.md is non-empty), `<entity_index>` (when at least one entity exists), and `<entity slug="..." ...>` blocks for the entities selected for this task. Organizational knowledge is carried by the injected `scope: org` entity pages **and the always-injected `<entity_index>`**, not a separate `<organizational_knowledge>` block. The block SHALL be appended after the agent's track-specific context and any plugin overlays, under a header `## Organizational Memory`. If no memory exists, the prompt SHALL be returned unchanged. When injection is disabled, the system SHALL return the prompt unchanged and SHALL NOT perform any store reads or entity selection.

Entity-page selection SHALL be **push** (decided by the system at spawn, with no agent-callable query tool). The system SHALL select full entity pages by scoring the entity index against the spawn context — the agent's repo or plugin, the participating users, and the task title — and SHALL expand one hop along `[[wikilink]]` relations from the selected set. A page of any scope SHALL become an injection candidate only when it carries at least one relevance signal from the spawn context: a repo match, an `owned_by` relation to a participating user, token overlap with the context, or one-hop graph expansion from a signal-bearing page. `scope: org` entity pages SHALL be bounded by `ARCHIE_MEMORY_ORG_INJECT_MAX` as a **ceiling, not a target**: the highest-scoring signal-bearing org pages are injected up to the bound, with last-touched recency as the tiebreak, and an org page with no relevance signal SHALL NOT be injected even when the org budget has spare capacity. The bound `ARCHIE_MEMORY_ENTITY_INJECT_MAX` SHALL apply to the remaining repo/domain/title-scored and graph-expanded (non-`org`) pages. When more signal-bearing pages of either class qualify than its bound allows, the system SHALL inject the highest-scoring ones and SHALL log which entities were dropped; pages with no signal are not candidates and SHALL NOT be logged as drops. The thin `<entity_index>` SHALL always be injected in full and SHALL NOT be subject to any page bound — it is the catalogue through which org knowledge not selected for full injection remains discoverable via its `L0` summary.

When rendering a selected entity page into its `<entity>` block, the system SHALL bound the number of `touched_by` relations rendered to `ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX` (default 10), retaining the newest (most recently appended) edges; `0` SHALL be honored as "render no `touched_by` edges". Rendering SHALL NOT modify the stored entity page — the full `touched_by` history SHALL remain on disk for provenance and related-task selection. Relation types other than `touched_by` SHALL NOT be subject to this bound.

#### Scenario: Spawned agent receives memory context

- **WHEN** a `scope: org` entity relevant to the task (e.g. its name appears in the task title) exists and a user with memory is mentioned in the task
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **AND** an agent spawns for that task
- **THEN** its system prompt contains both the `scope: org` `<entity ...>` block and a `<user_preferences user="...">` block
- **AND** no `<organizational_knowledge>` block is present

#### Scenario: Org-scoped entities are bounded by the org injection budget

- **WHEN** more signal-bearing `scope: org` entities qualify than `ARCHIE_MEMORY_ORG_INJECT_MAX`
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **AND** an agent spawns
- **THEN** at most `ARCHIE_MEMORY_ORG_INJECT_MAX` `scope: org` entity pages are injected in full
- **AND** the injected pages are the highest-scoring org pages by relevance, with last-touched date breaking ties
- **AND** the dropped org entity slugs are logged

#### Scenario: Zero-signal org page is not injected and not logged as a drop

- **WHEN** a `scope: org` entity carries no relevance signal for the spawn context (no repo match, no `owned_by` participant, no token overlap, not reachable by one-hop expansion)
- **AND** fewer signal-bearing org pages qualify than `ARCHIE_MEMORY_ORG_INJECT_MAX`
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **AND** an agent spawns
- **THEN** that entity's full page is not injected despite spare org budget
- **AND** its slug is not logged as an over-cap drop
- **AND** the `<entity_index>` still contains its row including its `L0` summary

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

- **WHEN** a repo agent spawns for repo `backend` on a task titled "Stripe webhooks failing"
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **AND** an entity `payment-service` has `repos: [backend]` and an entity `stripe` has `scope: org`
- **AND** the number of signal-bearing `scope: org` entities is within `ARCHIE_MEMORY_ORG_INJECT_MAX`
- **THEN** both `payment-service` (repo match) and `stripe` (token overlap with the task title) full pages are injected

#### Scenario: One-hop graph expansion pulls a linked entity

- **WHEN** `payment-service` is selected and contains `depends_on [[postgres-prod]]`
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **AND** `postgres-prod` is not directly matched by the spawn context
- **THEN** `postgres-prod` is also injected

#### Scenario: Injection bound drops are logged

- **WHEN** more signal-bearing non-`org` entities qualify for injection than `ARCHIE_MEMORY_ENTITY_INJECT_MAX`
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **THEN** only the bound's worth of highest-scoring pages are injected
- **AND** the dropped entity slugs are logged

#### Scenario: touched_by relations are truncated at render time only

- **WHEN** a selected entity page holds more `touched_by` relations than `ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX`
- **AND** `ARCHIE_MEMORY_INJECT=true`
- **AND** an agent spawns
- **THEN** the injected `<entity>` block contains only the newest `ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX` `touched_by` relations
- **AND** relations of other types are rendered in full
- **AND** the entity file on disk retains every `touched_by` relation

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

### Requirement: Organizational knowledge SHALL be stored as entities, not a flat file

The system SHALL represent organizational knowledge — cross-cutting facts about the company, its products, processes, and conventions — as entity pages, not as a flat `org.md` file. Cross-cutting facts SHALL be `scope: org` entities; facts specific to one or more repos SHALL be repo-scoped entities. The system SHALL NOT create or write `workdir/memory/org.md`, and the extraction side-agent SHALL NOT emit a separate `org_updates` channel — an organizational fact SHALL be recorded as a typed observation on the relevant entity (creating it when absent). Organizational knowledge that predates this change SHALL be backfilled into entities.

**Rationale:** Once entities are first-class, every org-level fact already maps to a nameable subject, and `scope: org` entities are relevance-selected for injection and always discoverable through the injected `<entity_index>` — so a separate flat file with its parallel `org_updates` channel, soft cap, and consolidation side-agent is redundant. The extractor prompt aimed `org_updates` and `scope: org` entities at an identical bar ("applies across the organization, durable, reusable"), forcing an arbitrary per-fact channel choice. Collapsing to one model removes that ambiguity and an entire housekeeping path.

#### Scenario: No org.md is written

- **WHEN** extraction runs for any completed task
- **THEN** no file `workdir/memory/org.md` is created or written
- **AND** the extraction result carries no `org_updates` channel

#### Scenario: An org-level fact becomes a scope:org entity observation

- **WHEN** a task durably establishes a cross-cutting fact such as "feature flags are managed via LaunchDarkly"
- **THEN** the fact is written as a typed observation on a `scope: org` entity (e.g. `launchdarkly`), created if absent
- **AND** that entity is listed in the always-injected `<entity_index>` and is eligible for full-page injection when relevant to the spawn context

#### Scenario: Pre-existing org knowledge is backfilled

- **WHEN** an `org.md` bullet exists from before this change (e.g. "Backend uses Ruby 3.4.9")
- **THEN** the fact is migrated to an entity observation at the appropriate scope (here, a repo-scoped `backend` entity)
- **AND** `workdir/memory/org.md` is removed
