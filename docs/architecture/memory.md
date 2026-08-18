# Memory Layer

The memory layer gives Archie persistent cross-task knowledge: user collaboration profiles, recent activity, task summaries, and entity pages for durable subjects such as services, systems, integrations, concepts, and repositories. Memory reaches agents through bounded prompt injection. The subsystem lives under `src/memory/`; memory artifacts use Markdown and operator telemetry uses JSONL. Its runtime lifecycle and injection path are gated by `ARCHIE_MEMORY`; manual housekeeping has its own flag.

This document is the as-built source of truth for the runtime layer.

## Confidentiality Model

Authorization is a property of the task, not of individual memory artifacts.

Every task has one immutable `visibility` value:

- `public`: public Slack channels, including Slack Connect channels; CLI tasks; triggers firing from public Slack channels.
- `private`: Slack DMs and private Slack conversations. A Slack channel-info lookup failure also creates a private task.
- Legacy task metadata without `visibility` fails closed to `private`; `Task.get()` persists that migration.

The task keeps the visibility assigned at creation. A follow-up in the same Slack thread continues the same task. A task cannot attach a second Slack thread, so it cannot bridge a public thread and a DM or private conversation.

Only public tasks write memory. `processExtraction()` checks `metadata.visibility === 'public'` before it reads `knowledge.log` or invokes the extractor. Private tasks write no collaboration profiles, entities, summaries, or activity rows. Private tasks can still consume organizational memory through bounded prompt injection.

The store is therefore public by construction. Summaries and activity rows carry no access stamps, reads need no per-artifact authorization checks, and raw task logs are not part of the cross-task memory corpus. `grep_task_log` does not exist.

Slack Connect public channels use the same public-memory behavior as ordinary public channels. Slack filters or redacts external authors before extraction, but a first shared-channel lookup failure can leave external history unredacted. Interactive authorization actions fail closed unless Slack verifies an internal actor. The cache behavior and residual risk are defined in [Slack Integration](slack-integration.md#acknowledgment-muting-and-shared-channel-awareness).

Trigger-created tasks follow the same public/private write boundary. Trigger creation, update, firing, and legacy-migration rules are defined in [Triggers](triggers.md#visibility--privacy).

### One-time deployment cleanup

An existing store created under the former channel-level policy must not be reused because its private-derived provenance cannot be reconstructed. Initialization refuses a non-empty store without `.public-store-v1`. Follow the [deployment reset procedure](../guides/deployment.md#memory-v2-store-reset) before upgrading.

## Architecture

```text
task spawn
  ├─ extract author users from knowledge.log
  ├─ inject their collaboration profiles
  ├─ inject recent public activity and the entity index
  └─ select and inject relevant entity pages

task completion
  ├─ load metadata
  ├─ private or legacy-unknown visibility ──▶ stop
  └─ public
       ├─ read transcript and current memory
       ├─ run one-turn extraction side-agent
       ├─ validate author evidence and sanitize output
       ├─ update user and entity files
       ├─ write task summary and recent activity
       └─ run deterministic housekeeping when soft caps are exceeded
```

Core imports the subsystem in exactly two seam files: `src/index.ts` initializes it, and `src/agents/spawn.ts` injects context. The memory subsystem may import core persistence and task types internally.

## Components

```text
src/memory/
├── index.ts          bootstrap, directory creation, queue recovery, event subscription
├── paths.ts          memory/telemetry paths, identifier guards, and feature-flag accessors
├── types.ts          memory, activity, user, and entity types
├── lifecycle.ts      public-task gate and serialized extraction pipeline
├── extractor.ts      one-turn extraction side-agent and response parser
├── sanitize.ts       untrusted-model-output validation
├── store.ts          collaboration-profile reads and serialized update semantics
├── activity.ts       five-column recent-activity table
├── entities.ts       entity parsing, resolution, and persistence
├── entity-index.ts   derived index and push selection
├── context.ts        prompt-injection assembly
├── telemetry.ts      selection and evidence-drop telemetry
├── pending-queue.ts  durable extraction queue
├── housekeeping.ts   deterministic validation, dedupe, staleness, and ordering
```

Agent-loadable runtime memory lives under `workdir/memory/`:

```text
.public-store-v1
users/<id>.md
recent-activity.md
tasks/<taskId>/summary.md
telemetry/tasks/<taskId>/telemetry.jsonl  # operator-only, never loaded into agents
entities/<slug>.md
entities/index.md
pending-extractions.md
```

The telemetry subtree is operator-only, so downloading or snapshotting `workdir/memory/` captures the public memory corpus and its full telemetry in one batch without adding telemetry to the agent read surface.

## Read Path

`src/agents/spawn.ts` extracts the current task's message authors from `knowledge.log`. Source-line authorship counts; a body mention does not. Redacted external authors are excluded. The resulting Slack IDs scope collaboration-profile injection.

When `ARCHIE_MEMORY_INJECT=true`, `enrichPromptWithMemory()` can append:

```xml
<collaboration_profile user_id="U07ABC123" display_name="Dana">…</collaboration_profile>
<recent_activity>…</recent_activity>
<entity_index>…</entity_index>
<entity slug="payment-service" type="service" scope="repo">…</entity>
```

Recent activity contains only public-task output, so every row is injected. The entity index is always included when entities exist. Full entity pages are selected by repo, author relations, and lexical overlap with the task title; while asynchronous title generation is still pending, selection falls back to the first non-redacted user message from `knowledge.log`. Selection then expands one relation hop and is bounded separately for `org` and non-`org` scopes. `touched_by` relations are truncated only while rendering; disk retains the full provenance list.

## Write Path

`initMemory()` subscribes to `task:completed`. `handleTaskCompleted()` first records a generation-keyed task intent in `pending-extractions.md`, then runs it through a process-wide sequential queue. Finalization marks the same generation committed in its journal, removes that pending intent, and only then deletes the journal. Startup can therefore clear a committed intent without rerunning extraction after a crash at that boundary.

The public-task pipeline is:

1. Under the task's ingestion lock, load visibility and take an immutable transcript snapshot; stop without reading the transcript unless visibility is exactly `public`. Release the lock before model work.
2. Identify actual Slack message authors from the snapshot. When none exist, use `cli:<taskId>` only to label the task summary and activity row; the writable profile set remains empty.
3. Load every writable Slack author's existing collaboration profile plus the entity index. Never load a `cli:`/`local:` fallback profile into the extractor.
4. Run the Sonnet extraction side-agent with `maxTurns: 1`, no tools, and a minimal environment.
5. Sanitize every update. Profile updates are accepted only for Slack author IDs, require one or more resolvable `msg:<ts>` source lines all authored by that same user, and must declare one of the five allowed profile sections.
6. Apply profile and entity updates. The profile store reports only sanitized candidates that actually changed the file; unmatched replacements are no-ops. Entity writes resolve aliases, enforce closed vocabularies, add `touched_by [[taskId]]`, and rebuild the index after changes.
7. Record each sanitized applied delta in `tasks/<taskId>/extraction-journal.json` immediately before its store write. A retry reapplies that small journal idempotently and uses it to rebuild the summary, so a crash after profile or entity writes cannot erase the audit of what changed. The journal is deleted after the summary, activity, and housekeeping complete.
8. Replace raw profile and entity candidates with the store-confirmed journaled set before writing `tasks/<taskId>/summary.md`. Task-summary prose receives the same instruction and secret checks as other artifacts; rejected prose becomes a fixed placeholder rather than falling back to raw extractor output. Then append a recent-activity row, trim activity to 50 rows, and run housekeeping for exceeded soft caps.

Model output and transcript content are untrusted. Instruction-shaped content, secret-like values, malformed Markdown fields, invalid IDs, and invalid entity fields are rejected before persistence.

## Storage Formats

### Collaboration profiles

Profile files remain at `users/<id>.md`; existing files are preserved. New profile writes are keyed only by raw Slack author ID. Existing `cli:`/`local:` fallback files remain valid legacy files for maintenance, but extraction neither loads nor updates them. Display names are labels, never identifiers.

```markdown
---
slack_user_id: U07ABC123
display_name: "Dana Lee"
aliases: []
---

## Communication
- Prefers concise Slack updates  <!-- touched: 2026-05-14 -->
```

New adds and updates are limited to `Communication`, `Deliverables`, `Workflow`, `Decision Making`, and `Constraints`. They capture only durable collaboration context explicitly stated by the target user in a first-person message; general facts, skills, personality judgments, inferred behavior, and task-specific requests are excluded. Every update declares its section, and replacements search only inside that section. Legacy sections remain readable and can still be consolidated by housekeeping.

### Recent activity

```markdown
# Recent Activity

| Date | Task ID | Summary | Domain | User |
|------|---------|---------|--------|------|
| 2026-06-01 | task-20260601-1000-abc | Fixed webhook retries | engineering | U07ABC123 |
```

Rows are newest first, keyed by task ID, and capped at 50.

### Task summary

Task summaries contain ordinary metadata, channel links, participating users, a sanitized summary, successfully applied memory updates, and related public tasks. Evidence failures, sanitizer rejections, and unmatched profile replacements never appear in `## Memory Updates`; when no profile or entity update was written, that section renders `_no durable learnings_`. There is no `access:` field and Slack links have no per-link visibility field.

### Entity pages

Entity frontmatter carries type, scope, repos, domain, status, aliases, and `last_touched`; the body carries an L0 summary. Every accepted update advances `last_touched`, including summary-only and relation-only changes. Legacy pages without it fall back to their newest observation date. Facts use the closed categories `fact | config | decision | caveat`; relations use `depends_on | integrates | owned_by | part_of | touched_by | related_to`. Unknown values are dropped. Housekeeping structurally merges alias-colliding pages into a deterministic canonical slug, repoints inbound relations, and then archives the least-recently-touched active overflow. Archived rows remain on disk but are excluded from the derived `entities/index.md` and prompt selection.

## Telemetry

`$ARCHIE_WORKDIR/memory/telemetry/tasks/<taskId>/telemetry.jsonl` contains two active record shapes:

- Selection records, one per enriched spawn, with selected and dropped entities plus token estimates.
- `user-update-dropped` records for evidence-validation failures.

Public and private tasks both persist telemetry from enabled memory paths. Records include visibility and may contain the generated task title or up to 500 characters of the first user message used as its fallback, participant identifiers, and verbatim search queries, so operators must treat the subtree as sensitive.

Telemetry is outside the agent-loadable corpus: the sandbox does not mount `workdir/memory/`, and prompt injection has no telemetry reader. The `.public-store-v1` marker certifies only the loadable corpus, not the telemetry subtree.

All telemetry appends are fail-safe and never alter agent results or extraction outcomes.

## Housekeeping

Soft caps run deterministic housekeeping on the serialized extraction queue: validation, deduplication, staleness pruning, stable ordering, active-entity cap archival, and entity-index rebuilds. Existing safe legacy profile headings are preserved, but their bullets still pass the current content, secret, staleness, and deduplication checks.

The manual entry point is `npm run memory:housekeeping -- --target <all|entities|U…>`. It runs in a separate process, does not share the server's in-memory queue, and must only run while the Archie service is stopped.

## Feature Flags

| Flag | Default | Purpose |
|---|---|---|
| `ARCHIE_MEMORY` | `true` | Master switch for initialization, extraction, and injection. |
| `ARCHIE_MEMORY_INJECT` | `false` | Enables prompt injection. Extraction remains active when off. |
| `ARCHIE_MEMORY_HOUSEKEEPING` | `true` | Enables automatic and manual housekeeping; the manual command does not consult `ARCHIE_MEMORY`. |
| `ARCHIE_MEMORY_USER_CAP` | `100` | Soft cap on bullets per collaboration-profile file. |
| `ARCHIE_MEMORY_SECTION_CAP` | `30` | Soft cap on bullets per section. |
| `ARCHIE_MEMORY_STALENESS_DAYS` | `180` | Age threshold for consolidation and entity archival. |
| `ARCHIE_MEMORY_ENTITY_CAP` | `300` | Soft cap on entity pages. |
| `ARCHIE_MEMORY_ENTITY_INJECT_MAX` | `8` | Full non-org entity pages per prompt. |
| `ARCHIE_MEMORY_ORG_INJECT_MAX` | `8` | Full org entity pages per prompt. |
| `ARCHIE_MEMORY_ENTITY_OBS_CAP` | `30` | Persisted observations per entity. |
| `ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX` | `10` | Rendered `touched_by` relations per entity block. |

## Evaluation

The evaluation harness is not part of this branch. It lives in the stacked [`feature/memory-v2-eval` change](https://github.com/sweatco/archie-hq/pull/228) and consumes snapshots of this store without modifying them.

## Ejection

1. Delete `src/memory/` and the two memory prompts.
2. Remove `initMemory()` from `src/index.ts`.
3. Remove memory imports, author extraction, and injection from `src/agents/spawn.ts`.
4. Delete `workdir/memory/`.
5. Delete `scripts/memory-housekeeping.ts` and remove the `memory:housekeeping` package script.

No database or external service cleanup is required.

## Testing

Tests under `src/memory/__tests__/` cover extraction, persistence, selection, telemetry, and crash recovery. Slack and task tests cover visibility assignment and authorization boundaries. Developer commands live in [`src/memory/CLAUDE.md`](../../src/memory/CLAUDE.md).
