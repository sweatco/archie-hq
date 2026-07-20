# Memory Layer

The memory layer gives Archie persistent cross-task knowledge: user preferences, recent activity, task summaries, and entity pages for durable subjects such as services, systems, integrations, concepts, and repositories. Memory reaches agents through prompt injection and three read-only tools. The subsystem lives under `src/memory/`, uses Markdown files only, and is gated by `ARCHIE_MEMORY`.

This document describes the implementation as built. Historical decisions live in [`docs/plans/20260719-memory-v2.md`](../plans/20260719-memory-v2.md); future work lives in [`docs/proposals/memory-v2-roadmap.md`](../proposals/memory-v2-roadmap.md).

## Confidentiality Model

Authorization is a property of the task, not of individual memory artifacts.

Every task has one immutable `visibility` value:

- `public`: public Slack channels, including Slack Connect channels; CLI tasks; scheduled and message-triggered tasks.
- `private`: Slack DMs and private Slack conversations. A Slack channel-info lookup failure also creates a private task.
- Legacy task metadata without `visibility` fails closed to `private`; `Task.get()` persists that migration.

The task keeps the visibility assigned at creation. A follow-up in the same Slack thread continues the same task. A task cannot attach a second Slack thread, so it cannot bridge a public thread and a DM or private conversation.

Only public tasks write memory. `processExtraction()` checks `metadata.visibility === 'public'` before it reads `knowledge.log` or invokes the extractor. Private tasks write no user preferences, entities, summaries, or activity rows. Private tasks can still consume organizational memory through the normal injection and read-tool paths.

The store is therefore public by construction. Summaries and activity rows carry no access stamps, reads need no per-artifact authorization checks, and raw task logs are not part of the cross-task memory corpus. `grep_task_log` does not exist.

Slack Connect public channels use the same public-memory behavior as ordinary public channels. External and guest messages are filtered at Slack ingress, but internal users' questions and Archie's responses are visible to every channel member. Interactive authorization actions are separately restricted to internal Slack actors and fail closed when actor classification fails.

### One-time deployment cleanup

This model removes provenance stamps from stored artifacts, so an existing store created under the former channel-level policy must not be reused as-is. Before deploying this change, snapshot the existing `workdir/memory/` directory, clear it, and let Archie recreate an empty store. This removes private/DM-derived user preferences and entities whose provenance cannot be reconstructed reliably. Rollback restores the snapshot together with the previous binary.

## Architecture

```text
task spawn
  ├─ extract author users from knowledge.log
  ├─ inject their user preferences
  ├─ inject recent public activity and the entity index
  └─ select and inject relevant entity pages

agent pull tools
  ├─ search_memory
  ├─ read_entity
  └─ read_task_summary

task completion
  ├─ load metadata
  ├─ private or legacy-unknown visibility ──▶ stop
  └─ public
       ├─ read transcript and current memory
       ├─ run one-turn extraction side-agent
       ├─ validate author evidence and sanitize output
       ├─ update user and entity files
       ├─ write task summary and recent activity
       └─ enqueue housekeeping when soft caps are exceeded
```

Core imports the subsystem in exactly two seam files: `src/index.ts` initializes it, and `src/agents/spawn.ts` registers the read paths. The memory subsystem may import core persistence and task types internally.

## Components

```text
src/memory/
├── index.ts          bootstrap, directory creation, queue recovery, event subscription
├── paths.ts          paths, identifier guards, and feature-flag accessors
├── types.ts          memory, activity, user, and entity types
├── lifecycle.ts      public-task gate and serialized extraction pipeline
├── extractor.ts      one-turn extraction side-agent and response parser
├── sanitize.ts       untrusted-model-output validation
├── store.ts          user-memory reads and serialized update semantics
├── activity.ts       five-column recent-activity table
├── entities.ts       entity parsing, resolution, and persistence
├── entity-index.ts   derived index and push selection
├── context.ts        prompt-injection assembly
├── tools.ts          three read-only pull tools
├── telemetry.ts      selection, pull, and evidence-drop telemetry
├── pending-queue.ts  durable extraction queue
├── housekeeping.ts   user consolidation and entity merge/archive
└── annotations.ts    touched-date parsing and rendering
```

Runtime data lives under `workdir/memory/`:

```text
users/<id>.md
recent-activity.md
tasks/<taskId>/summary.md
tasks/<taskId>/telemetry.jsonl
entities/<slug>.md
entities/index.md
pending-extractions.md
```

## Read Path

`src/agents/spawn.ts` extracts the current task's message authors from `knowledge.log`. Source-line authorship counts; a body mention does not. Redacted external authors are excluded. The resulting Slack IDs scope user memory for both injection and search.

When `ARCHIE_MEMORY_INJECT=true`, `enrichPromptWithMemory()` can append:

```xml
<user_preferences user_id="U07ABC123" display_name="Dana">…</user_preferences>
<recent_activity>…</recent_activity>
<entity_index>…</entity_index>
<entity slug="payment-service" type="service" scope="repo">…</entity>
```

Recent activity contains only public-task output, so every row is injected. The entity index is always included when entities exist. Full entity pages are selected by repo, author relations, and lexical overlap with the task title, then expanded one relation hop and bounded separately for `org` and non-`org` scopes. `touched_by` relations are truncated only while rendering; disk retains the full provenance list.

When `ARCHIE_MEMORY_TOOLS=true`, every agent receives three read-only tools:

| Tool | Reads | Bound |
|---|---|---|
| `search_memory(query[, max_results])` | active entities, current authors' user files, all task summaries, recent activity | 10 thin hits by default |
| `read_entity(slug)` | one entity page; aliases resolve and archived pages are marked | about 8K characters |
| `read_task_summary(taskId)` | one public task summary | about 8K characters |

Identifiers pass `paths.ts` guards before filesystem access. No tool mutates memory or opens a task's raw `knowledge.log`.

## Write Path

`initMemory()` subscribes to `task:completed`. `handleTaskCompleted()` first records the task ID in `pending-extractions.md`, then runs it through a process-wide sequential queue. Successful processing removes the pending entry; startup replays entries left by a crash.

The public-task pipeline is:

1. Load task metadata and stop immediately unless visibility is exactly `public`.
2. Read the transcript and identify message authors, falling back to `cli:<taskId>` when no Slack author exists.
3. Load every author's existing memory plus the entity index.
4. Run the Sonnet extraction side-agent with `maxTurns: 1`, no tools, and a minimal environment.
5. Sanitize every update. User updates are accepted only for author IDs and must cite `msg:<ts>` source lines authored by that same user.
6. Apply user updates and entity updates. Entity writes resolve aliases, enforce closed vocabularies, add `touched_by [[taskId]]`, and rebuild the index after changes.
7. Write `tasks/<taskId>/summary.md`, append a recent-activity row, trim activity to 50 rows, and schedule housekeeping for exceeded soft caps.

Model output and transcript content are untrusted. Instruction-shaped content, secret-like values, malformed Markdown fields, invalid IDs, and invalid entity fields are rejected before persistence.

## Storage Formats

### User memory

User files are keyed by raw Slack ID or a documented `cli:`/`local:` fallback. Display names are labels, never identifiers.

```markdown
---
slack_user_id: U07ABC123
display_name: "Dana Lee"
aliases: []
---

## Communication
- Prefers concise Slack updates  <!-- touched: 2026-05-14 -->
```

### Recent activity

```markdown
# Recent Activity

| Date | Task ID | Summary | Domain | User |
|------|---------|---------|--------|------|
| 2026-06-01 | task-20260601-1000-abc | Fixed webhook retries | engineering | U07ABC123 |
```

Rows are newest first, keyed by task ID, and capped at 50.

### Task summary

Task summaries contain ordinary metadata, channel links, participating users, a sanitized summary, applied memory updates, and related public tasks. There is no `access:` field and Slack links have no per-link visibility field.

### Entity pages

Entity frontmatter carries type, scope, repos, domain, status, aliases, and an L0 summary. Facts use the closed categories `fact | config | decision | caveat`; relations use `depends_on | integrates | owned_by | part_of | touched_by | related_to`. Unknown values are dropped. `entities/index.md` is derived and never authoritative.

## Telemetry

`tasks/<taskId>/telemetry.jsonl` is not runtime memory. It contains three record shapes:

- Selection records, one per enriched spawn, with selected and dropped entities plus token estimates.
- Pull records, one per read-tool call, with arguments, returned identifiers, result count, and zero-result status.
- `user-update-dropped` records for evidence-validation failures.

All telemetry appends are fail-safe and never alter agent results or extraction outcomes.

## Housekeeping

User bullets carry touched dates. Soft caps enqueue a consolidation side-agent on the same sequential queue; a trace-back validator prevents it from inventing facts. Entity housekeeping is deterministic code: it merges alias-linked duplicates, archives stale entities, repoints relations, and rebuilds the index. Manual entry point: `npm run memory:housekeeping -- --target <all|entities|U…>`.

## Feature Flags

| Flag | Default | Purpose |
|---|---|---|
| `ARCHIE_MEMORY` | `true` | Master switch for initialization, extraction, injection, and tools. |
| `ARCHIE_MEMORY_INJECT` | `false` | Enables prompt injection. Extraction remains active when off. |
| `ARCHIE_MEMORY_TOOLS` | `false` | Enables the three read-only tools independently of injection. |
| `ARCHIE_MEMORY_HOUSEKEEPING` | `true` | Enables automatic and manual housekeeping. |
| `ARCHIE_MEMORY_USER_CAP` | `100` | Soft cap on bullets per user file. |
| `ARCHIE_MEMORY_SECTION_CAP` | `30` | Soft cap on bullets per section. |
| `ARCHIE_MEMORY_STALENESS_DAYS` | `180` | Age threshold for consolidation and entity archival. |
| `ARCHIE_MEMORY_ENTITY_CAP` | `300` | Soft cap on entity pages. |
| `ARCHIE_MEMORY_ENTITY_INJECT_MAX` | `8` | Full non-org entity pages per prompt. |
| `ARCHIE_MEMORY_ORG_INJECT_MAX` | `8` | Full org entity pages per prompt. |
| `ARCHIE_MEMORY_ENTITY_OBS_CAP` | `30` | Persisted observations per entity. |
| `ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX` | `10` | Rendered `touched_by` relations per entity block. |

## Eval Harness

`npm run memory:eval` reads a snapshot selected by `ARCHIE_WORKDIR`, refuses to use a path without a `memory/` subtree, and writes reports outside the snapshot. The mechanical tier measures store health, selection and pull telemetry, regression goldens, and prompt-size bounds. The functional tier exercises production selection/rendering with reader and judge controls. The harness is read-only over the snapshot.

## Ejection

1. Delete `src/memory/` and the two memory prompts.
2. Remove `initMemory()` from `src/index.ts`.
3. Remove memory imports, author extraction, injection, and tool registration from `src/agents/spawn.ts`.
4. Delete `workdir/memory/`.
5. Optionally delete `tools/memory-eval/`, the memory scripts, and their package scripts.

No database or external service cleanup is required.

## Testing

Run `npx vitest run src/memory/__tests__/` or the whole suite with `npm test`. The lifecycle integration tests cover the public/private task boundary, Slack Connect public behavior, author-only user updates, entity writes, summaries, activity, and crash recovery. Tool tests cover the three-tool surface, public-store reads, author-scoped user search, identifier guards, result bounds, and telemetry. Slack client and action tests cover task visibility assignment and internal-only interactive mutations.
