# Memory Layer — Delta: memory-v2-pull-and-eval

## ADDED Requirements

### Requirement: Agent-callable memory read tools

The system SHALL expose a read-only memory tool surface to every agent track (PM, repo, plugin) via an in-process MCP server, gated by a dedicated environment variable `ARCHIE_MEMORY_TOOLS`. Tools SHALL be registered only when memory is enabled (`ARCHIE_MEMORY` ≠ `false`) AND `ARCHIE_MEMORY_TOOLS` is exactly `true`; the default (unset, or any other value) SHALL be **disabled** — no tools registered, no store reads, agent tool lists byte-identical to today. The tool flag SHALL be independent of `ARCHIE_MEMORY_INJECT`: pull SHALL work with push injection on or off.

The tool surface SHALL be exactly:

- `search_memory(query)` — lexical search over active entity pages (name, aliases, L0 summary, facts), user preference files, task summaries, and the recent-activity index, using the same tokenization as entity selection; returns a ranked, size-bounded list of hits (entity slug or file identifier, kind, L0/one-line summary or matching snippet). An empty result SHALL be a normal response, not an error.
- `read_entity(slug)` — the full rendered entity page for one slug, with `touched_by` relations truncated to `ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX` exactly as injection rendering does. Archived entities SHALL be readable and marked as archived.
- `read_task_summary(taskId)` — the contents of `memory/tasks/<taskId>/summary.md`.
- `grep_task_log(taskId, pattern)` — matching lines (with line numbers, count-bounded) from the task's `knowledge.log`.

All identifier arguments SHALL pass the existing path guards (`isValidEntitySlug`, task-ID validation, `getUserPath` rules) before any filesystem access; a failing guard SHALL return a tool error without touching the filesystem. The tool surface SHALL contain no operation that creates, mutates, or deletes memory content — writes remain funneled through the extraction side-agent. Tool implementation errors SHALL surface as tool-result errors to the calling agent, never as process faults.

**Rationale:** Push selection is bounded and can only miss silently; the always-injected `<entity_index>` tells agents what exists but not what it says. A pull path lets the agent that knows what it needs fetch it — and (via the pull sensor) turns every fetch into ground truth about what push should have injected.

#### Scenario: Tools are registered only when the flag is on

- **WHEN** `ARCHIE_MEMORY_TOOLS=true` and memory is enabled
- **AND** an agent spawns on any track
- **THEN** the agent's tool list contains `search_memory`, `read_entity`, `read_task_summary`, and `grep_task_log`
- **AND** no memory write/modify/delete tool is present

#### Scenario: Disabled flag leaves the system untouched

- **WHEN** `ARCHIE_MEMORY_TOOLS` is unset or not `true`
- **AND** an agent spawns
- **THEN** no memory tools are registered
- **AND** no store reads are performed on behalf of the tool layer

#### Scenario: Search returns ranked bounded hits

- **WHEN** an agent calls `search_memory("stripe webhooks")` against a store containing a matching entity
- **THEN** the result lists at most the configured maximum hits, ranked, each with identifier, kind, and a one-line summary or snippet
- **AND** the full page content is not returned by search (the agent follows up with `read_entity`)

#### Scenario: Zero-result search is a normal response

- **WHEN** an agent calls `search_memory` with a query matching nothing
- **THEN** the tool returns an empty result set without error

#### Scenario: Malformed identifiers are rejected before filesystem access

- **WHEN** an agent calls `read_entity("../../etc/passwd")` or `read_task_summary` with a malformed task ID
- **THEN** the tool returns an error
- **AND** no file outside the memory store is read

#### Scenario: Pull works with injection off

- **WHEN** `ARCHIE_MEMORY_TOOLS=true` and `ARCHIE_MEMORY_INJECT` is unset
- **AND** an agent calls `read_entity` with a valid slug
- **THEN** the full entity page is returned even though nothing was push-injected

### Requirement: Pull-call telemetry

When memory tools are enabled and a read tool is invoked during a known task, the system SHALL append exactly one JSON line to `workdir/memory/tasks/<taskId>/telemetry.jsonl` per invocation, creating the task directory when absent. The line SHALL carry a schema version, a record-kind discriminator distinguishing pull records from selection records (existing selection lines without a kind field SHALL remain valid and be read as selection records), an ISO timestamp, the task ID, the calling agent, the tool name, the query or arguments, and a result summary (returned identifiers, result count, zero-result flag). Sensor failures SHALL NOT affect the tool result: on any telemetry write error the system SHALL log a warning and return the tool result exactly as if the sensor did not exist. When no task ID is available, the system SHALL skip the record silently while still serving the tool call.

**Rationale:** Pull calls are revealed ground truth — a pulled-but-never-injected page is a measured push-recall miss, and a zero-result search is a measured store gap. These records are the input that makes the later memory-value eval honest, and they cannot be backfilled.

#### Scenario: Pull call leaves a telemetry record

- **WHEN** an agent working task `task-X` calls `search_memory("payments")`
- **THEN** `memory/tasks/task-X/telemetry.jsonl` gains exactly one new line
- **AND** the line parses as JSON with the pull kind, tool name, query, returned identifiers, and result count

#### Scenario: Zero-result search is recorded as a store gap

- **WHEN** an agent's `search_memory` call returns no hits
- **THEN** the pull record carries a zero-result flag and the query text

#### Scenario: Sensor failure never affects the tool call

- **WHEN** the telemetry path is unwritable
- **AND** an agent calls a memory read tool
- **THEN** the tool returns its normal result
- **AND** a warning is logged

#### Scenario: Mixed record kinds coexist in one telemetry file

- **WHEN** a task has both an enriched spawn (selection record) and read-tool calls (pull records)
- **THEN** all records append to the same `telemetry.jsonl`
- **AND** a reader can partition them by the kind discriminator, treating kind-less lines as selection records

### Requirement: Memory health and functional eval over pulled data

The repo SHALL provide an eval entry point (`npm run memory:eval` → `scripts/memory-eval.ts`) that runs read-only over an extracted snapshot addressed by `ARCHIE_WORKDIR` (refusing to run unless the workdir contains `memory/`, so it can never silently read the developer's live store) and produces a dated report. The eval MUST NOT modify the snapshot or the local store. The report has two tiers.

**Mechanical tier** (no model calls) SHALL contain:

1. **Store health** — entity count against `ARCHIE_MEMORY_ENTITY_CAP`, observation-per-page and page-size distributions, staleness distribution over `touched:` annotations, archived-page count, and a near-duplicate rate (candidate pairs by normalized lexical similarity over entity names, aliases, and L0 summaries — the metric semantic dedupe is later judged by). When a previous snapshot or report is supplied, the report SHALL include deltas (growth, duplicate-rate trend, page turnover).
2. **Telemetry aggregation** — over all `memory/tasks/*/telemetry.jsonl` records in the snapshot: for selection records, spawn counts, injection and zero-injection rates, budget-drop frequency, and the rendered-token distribution; for pull records, calls per task, hit and zero-result rates, and the list of zero-result queries (the store-gap list). Absent record kinds SHALL be reported as absent, not as zero activity.
3. **Selection regression** — when a golden set is supplied: each golden case's recorded selection context replayed through the production `selectEntities` (same code path, never a reimplementation) against the snapshot, with per-case diffs (selected/dropped deltas) against the recorded expectation and a summary count. This is the benchmark any future selector change must beat before shipping.
4. **Enablement-gate outputs** — a worst-case injected-token bound computed from the snapshot through the production render path (rendered index + `ARCHIE_MEMORY_ORG_INJECT_MAX` × largest org page + `ARCHIE_MEMORY_ENTITY_INJECT_MAX` × largest non-org page, both after `touched_by` render truncation, + the summed rendered `<user_preferences>` blocks over every user file + rendered recent-activity), every term tagged with the budget env values as read through the production flag accessors; and a store-review reading list covering every block the injection flag enables — entities ordered by connectedness / observation count / page bytes with a staleness distribution, plus every `memory/users/*.md`, `recent-activity.md`, and `memory/entities/index.md`, each with size and flagged content matching suspicious patterns (URLs, imperative override phrasing, base64-like blobs).

A golden case SHALL be a versioned JSON record containing a selection context, the injection budgets the recorded spawn ran with (replay SHALL apply these, not the eval environment's), and the expected selection, harvested from live selection telemetry (recorded once injection is enabled; records lacking a context or budgets SHALL be skipped at harvest). Eval reports, golden sets, and question sets are tooling artifacts, not runtime memory: they SHALL live outside `workdir/memory/` and are exempt from the store's Markdown-only rule.

**Functional tier** SHALL, when a question set is supplied, exercise the real memory implementation as the system-under-test and score what it surfaces:

5. For each question the eval SHALL produce the **surfaced context** through the production code path — entity selection (`selectEntities`) plus injection render, and optionally the read tools — never a reimplementation of selection or ranking, and SHALL score two units: (a) **surfaced-context recall/precision** against the question's labeled evidence entities (computed without a model), and (b) **answer correctness**, where a **fixed reader model** answers from the question plus the surfaced context and a rubric judge scores against the gold answer. The reader, judge, and agent harness SHALL be held fixed across all arms. The eval SHALL run at least a *memory* arm (the surfaced context) and an *Oracle* arm (evidence-only context, the reader ceiling), reporting the Oracle-minus-memory gap so retrieval failure is distinguished from reader failure.

Any LLM judge SHALL be governed: it SHALL be validated against a human-labeled sample by chance-corrected agreement (Cohen's κ, not raw agreement) with measured position bias below 0.10, and SHALL be from a different model family than the extraction side-agent. The report header SHALL stamp the reader model, judge model, and the judge's last validation (κ and position bias); results from an unvalidated or unstamped judge SHALL be marked non-gating. Functional results SHALL be scoped to gating selection/injection/pull changes and SHALL NOT be presented as an answering-model comparison.

A question set SHALL be a versioned collection of `{question, gold answer, evidence-entity labels, source-transcript reference}` records, from either a portable public benchmark or a set synthesized from production task transcripts; the synthesized set's trust anchor SHALL be a human-validated label sample, not the generating model.

#### Scenario: Eval runs read-only over a snapshot

- **WHEN** `memory:eval` completes over an extracted snapshot, with report output directed outside the snapshot
- **THEN** the snapshot tree is byte-identical to its pre-run state

#### Scenario: Duplicate rate is comparable across snapshots

- **WHEN** the eval runs over two snapshots taken at different dates
- **THEN** each report states the near-duplicate rate under the same metric definition and metric version
- **AND** the two numbers are directly comparable as a trend

#### Scenario: Zero-result queries become the store-gap list

- **WHEN** the snapshot's telemetry contains pull records with zero-result searches
- **THEN** the report lists those query texts as store gaps

#### Scenario: Selector change is judged against the golden set

- **WHEN** the eval runs with a golden set against a code tree with a modified `selectEntities`
- **THEN** the report shows per-case selection diffs against the recorded expectations
- **AND** an unchanged selector reports zero diffs against a golden set harvested from the same code and store

#### Scenario: Wrong workdir is refused

- **WHEN** `memory:eval` runs with `ARCHIE_WORKDIR` pointing at a directory without a `memory/` subtree
- **THEN** the eval exits with an error before reading anything

#### Scenario: Worst-case token bound is computed from the store

- **WHEN** the eval runs over a snapshot
- **THEN** it reports a worst-case injected-token bound derived from the snapshot through the production render path, covering the index, the largest org and non-org pages at their budget multiples, the summed per-user preference blocks, and recent-activity
- **AND** each term is tagged with the budget env values as read through the production flag accessors

#### Scenario: Store-review reading list covers every injected block

- **WHEN** the eval runs with `--report`
- **THEN** the reading list orders entities by connectedness, observation count, and page size with a staleness distribution
- **AND** it also lists every `memory/users/*.md`, `recent-activity.md`, and `memory/entities/index.md` with size and suspicious-content flags, so the human review covers every block the injection flag would enable

#### Scenario: Functional tier scores the real implementation's surfaced context

- **WHEN** the eval runs with a question set
- **THEN** for each question the surfaced context is produced through the production `selectEntities` + injection render (never a reimplementation)
- **AND** the report states surfaced-context recall against the labeled evidence entities and answer correctness from a fixed reader over that context

#### Scenario: Oracle arm separates retrieval failure from reader failure

- **WHEN** the functional tier runs
- **THEN** it reports a memory arm (surfaced context) and an Oracle arm (evidence-only context) scored by the same fixed reader and judge
- **AND** the Oracle-minus-memory gap is reported so a low memory score caused by the reader is distinguished from one caused by selection

#### Scenario: Unvalidated or same-family judge is non-gating

- **WHEN** the functional tier runs with a judge that lacks a stamped κ/position-bias validation, or whose model family matches the extraction side-agent
- **THEN** its answer-correctness numbers are marked non-gating in the report
- **AND** the report header still records the judge model and the missing or failing validation

#### Scenario: Over-injection is measured functionally

- **WHEN** the functional tier re-scores answer correctness at a tighter injected-token budget
- **THEN** the report shows whether trimming the surfaced context changed answer correctness, identifying injected tokens that did not affect answers

## MODIFIED Requirements

### Requirement: Selection observability at agent spawn

When memory is enabled, injection is enabled (`ARCHIE_MEMORY_INJECT=true`), and an agent's system prompt is enriched for a known task, the system SHALL append exactly one JSON line to `workdir/memory/tasks/<taskId>/telemetry.jsonl` recording the selection decision, creating the task directory when absent. The line SHALL contain: a schema version, an ISO timestamp, the task ID, the spawning agent, the selection context snapshot (repo, plugin, task title, participating user IDs and display names — display names feed selection token overlap, so recording them lets a harvested golden replay the exact signal the spawn scored), the selected entity pages each with slug, score, and scope, the dropped-over-budget slugs, the count of zero-signal pages excluded from candidacy, the candidate count, the injection budgets in effect, and an estimate of the rendered memory-context tokens.

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

### Requirement: File-based Markdown storage

The system SHALL persist all memory artifacts as Markdown files inside `WORKDIR/memory/` — entity pages, user preferences, the activity index, and per-task artifacts (`tasks/<taskId>/summary.md`). (Per-task telemetry rides alongside as JSONL; telemetry and eval artifacts are instrumentation, not memory content, and are exempt from the Markdown rule.)

**Rationale:** Human-readable, diffable, requires no database, supports clean ejection.

#### Scenario: Memory files are markdown with sections and bullets

- **WHEN** the system writes user memory
- **THEN** the result is a Markdown file at `workdir/memory/users/<id>.md` with `## Section` headers and `- bullet` items

### Requirement: Organizational knowledge SHALL be stored as entities, not a flat file

The system SHALL represent organizational knowledge — cross-cutting facts about the company, its products, processes, and conventions — as entity pages. Cross-cutting facts SHALL be `scope: org` entities; facts specific to one or more repos SHALL be repo-scoped entities. The system SHALL NOT create or write `workdir/memory/org.md`, and the extraction side-agent SHALL NOT emit a separate `org_updates` channel — an organizational fact SHALL be recorded as a typed observation on the relevant entity (creating it when absent).

**Rationale:** Every org-level fact maps to a nameable subject, and `scope: org` entities are relevance-selected for injection and always discoverable through the injected `<entity_index>` — a flat file with a parallel update channel, soft cap, and consolidation path would be redundant and force an arbitrary per-fact channel choice.

#### Scenario: No org.md is written

- **WHEN** extraction runs for any completed task
- **THEN** no file `workdir/memory/org.md` is created or written
- **AND** the extraction result carries no `org_updates` channel

#### Scenario: An org-level fact becomes a scope:org entity observation

- **WHEN** a task durably establishes a cross-cutting fact such as "feature flags are managed via LaunchDarkly"
- **THEN** the fact is written as a typed observation on a `scope: org` entity (e.g. `launchdarkly`), created if absent
- **AND** that entity is listed in the always-injected `<entity_index>` and is eligible for full-page injection when relevant to the spawn context

## RENAMED Requirements

- FROM: `### Requirement: Per-task summary written to session shared dir`
- TO: `### Requirement: Per-task summary written to the task memory directory`
