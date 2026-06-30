# Memory Layer

The memory layer gives Archie persistent cross-task knowledge — user preferences, a rolling activity index, per-task summaries, and a graph of **entity pages** (the durable subjects the work keeps touching: services, systems, integrations, concepts, repos). Organization-wide facts are themselves entity pages, scoped `org`. It is a self-contained subsystem under `src/memory/`, gated by the `ARCHIE_MEMORY` feature flag, and designed to be removable as a single unit.

This document describes the implementation as-built. The capability spec lives at `openspec/specs/memory-layer/spec.md` and is fully reflected in the code (the `harden-memory-layer` change is now archived).

## Goals

- Eliminate "new hire every task" behavior — agents should arrive informed.
- Stay simple and ejectable — Markdown files, no database, one feature flag.
- Keep a one-way dependency: `src/memory/` imports from core; core never imports from `src/memory/`.

## Two-Path Architecture

```
                ┌──────────────── READ PATH (push) ────────────────┐
                │                                                  │
  spawnAgent ──▶│  extractTaskUsernames(taskId)                    │
  (PM / repo /  │      └─ scans knowledge.log for Slack mentions   │
   plugin track)│                                                  │
                │  enrichPromptWithMemory(prompt, users, selectors)│
                │      ├─ readUser(u)    ─▶ <user_preferences …>   │
                │      ├─ readActivity() ─▶ <recent_activity>      │
                │      ├─ index.md       ─▶ <entity_index> (always)│
                │      └─ selectEntities(repo/users/title, +1 hop) │
                │                        ─▶ <entity …> pages       │
                │                                                  │
                │  appended under "## Organizational Memory"       │
                │  header in the agent's system prompt             │
                └──────────────────────────────────────────────────┘
                                       │
                                       ▼
                ┌────────── workdir/memory/ (Markdown store) ──────┐
                │   users/<U…>.md           ── frontmatter + bullets│
                │   recent-activity.md      ── markdown table (≤50)│
                │   summaries/<taskId>.md   ── per-task audit log  │
                │   entities/<slug>.md      ── frontmatter + facts │
                │   entities/index.md       ── derived thin index  │
                │   pending-extractions.md  ── durable queue       │
                └──────────────────────────────────────────────────┘
                                       ▲
                                       │
                ┌─────────────── WRITE PATH (extraction) ──────────┐
                │                                                  │
  task:completed│  initMemory() subscribes:                        │
  event ──────▶ │      onEvent('task:completed') →                 │
                │      handleTaskCompleted(taskId)                 │
                │                                                  │
                │  Sequential queue (durable via pending-          │
                │  extractions.md; resumes on restart)             │
                │      ↓                                           │
                │  processExtraction(taskId):                      │
                │   1. loadMetadata, readKnowledgeLog              │
                │   2. extract Slack mentions → UserRef[]          │
                │   3. read ALL involved users' memory + index     │
                │   4. runExtraction(input, allowedUserIds)        │
                │       Sonnet side-agent, maxTurns: 1, no tools   │
                │       prompts/memory-extractor.md                │
                │       sanitizer drops malformed/hostile updates  │
                │   5. applyUserUpdatesWithIdentity per user       │
                │       (writes touched: annotations)              │
                │   6. applyEntityUpdate per entity (resolve-or-   │
                │       create, auto touched_by) → rebuildIndex    │
                │   7. write workdir/memory/summaries/<taskId>.md  │
                │       (memory-diff + entity-based related-tasks) │
                │   8. appendActivity + trimActivity(50)           │
                │   9. if soft cap exceeded → runHousekeeping()    │
                └──────────────────────────────────────────────────┘
```

## Components

```
src/memory/
├── index.ts          — initMemory(): bootstrap, dir creation, queue drain, event subscription
├── types.ts          — MemoryUpdate, ExtractionResult, ActivityEntry, UserRef, Entity* types
├── paths.ts          — all path resolution + identifier/slug guards + env-flag accessors
├── store.ts          — readUser, writeUser, applyUserUpdatesWithIdentity, applyUserUpdates, softCapExceeded
├── sanitize.ts       — sanitizeUpdate/Activity + entity slug/observation/relation guards, injection/secret heuristics
├── annotations.ts    — parseLastTouched, stripLastTouched, appendLastTouched (touched: bullets)
├── pending-queue.ts  — durable extraction queue (enqueue/dequeue/read)
├── housekeeping.ts   — runHousekeeping (org/user side-agent + entity merge/archive), trace-back validator
├── entities.ts       — parse/serialize/read/write entity pages, resolveEntity, applyEntityUpdate
├── entity-index.ts   — rebuildIndex (derived), selectEntities (push selection + 1-hop expansion)
├── context.ts        — buildMemoryContext, enrichPromptWithMemory (read path; entity injection)
├── activity.ts       — readActivity, appendActivity, trimActivity
├── extractor.ts      — buildExtractionPrompt, parseExtractionResponse, runExtraction (Sonnet)
├── lifecycle.ts      — handleTaskCompleted, processExtraction, buildSummaryMarkdown, related-by-entity
└── __tests__/        — sanitize, paths, store, context, extractor, activity, pending-queue,
                        housekeeping, entities, entity-index, lifecycle (integration)

prompts/
├── memory-extractor.md   — extraction prompt template (Sonnet side-agent)
└── memory-housekeeper.md — consolidation prompt template (Sonnet side-agent)

scripts/
└── memory-housekeeping.ts — manual `npm run memory:housekeeping -- --target <org|all|U…>`

workdir/memory/                                  (runtime, gitignored)
├── users/<id>.md
├── recent-activity.md
├── summaries/<taskId>.md
├── entities/<slug>.md
├── entities/index.md
└── pending-extractions.md
```

## Read Path — Memory Injection at Spawn

`src/agents/spawn.ts` calls `enrichPromptWithMemory()` after assembling the track-specific system prompt for every agent it spawns. Three call sites, one per track:

| Track | Location | Trigger |
|-------|----------|---------|
| PM | `spawn.ts:252-253` | Every PM agent spawn |
| Repo | `spawn.ts:381-382` | Every repo agent spawn |
| Plugin | `spawn.ts:479-480` | Every plugin agent spawn |

The helper `extractTaskUsernames(taskId)` (`spawn.ts:132`) parses the task's `knowledge.log` for Slack mention markers `@<UID:Display Name>` and returns one `UserRef` (raw Slack ID + display name) per unique mentioned user. The Slack ID is the user-memory filename, so the read and write paths key identically. Those users are the only ones for whom `<user_preferences>` blocks are injected.

`buildMemoryContext(usernames)` (`src/memory/context.ts`) assembles up to three XML-tagged blocks:

```
<user_preferences user_id="U07ABC123" display_name="Dana">
{contents of users/U07ABC123.md}
</user_preferences>

<recent_activity>
{contents of recent-activity.md}
</recent_activity>

<entity_index>
{contents of entities/index.md — always injected when any entity exists}
</entity_index>

<entity slug="payment-service" type="service" scope="repo">
{full contents of entities/payment-service.md}
</entity>
```

**Entity selection is push, not pull** — the system decides which entity pages to inject; there is no agent-callable query tool. `enrichPromptWithMemory(prompt, users, selectors)` receives spawn-context selectors (`{ repo?, plugin?, taskTitle? }`): PM passes `taskTitle`, repo agents pass `repo: def.repo.repoKey`, plugin agents pass `plugin: def.pluginName`. `selectEntities()` (`entity-index.ts`) then:

1. Scores every active entity against the spawn context: `scope: org` entities get a base bonus, repo matches and entities `owned_by` a participating user are boosted, and the rest score by token overlap of the task title / users against each entity's name, aliases, and summary.
2. **Expands one hop** along `[[wikilink]]` relations from the selected set (so selecting `payment-service` pulls `postgres-prod` even if it wasn't directly matched).
3. Applies **two independent budgets** to the score-ranked list (last-touched recency breaks ties): `scope: org` pages are bounded by `ARCHIE_MEMORY_ORG_INJECT_MAX`, all other pages by `ARCHIE_MEMORY_ENTITY_INJECT_MAX`. Pages over either budget are dropped and their slugs logged. `scope: org` entities are **not** exempt — bounding them is what keeps the system prompt from scaling with the org's entity count.

The thin `<entity_index>` is never subject to a page bound — the agent always sees the full catalogue of what exists, so an `org` page dropped from full injection stays discoverable via its `L0` summary (the recall path until pull/embeddings land in a later phase).

`enrichPromptWithMemory()` appends the block to the prompt under a fixed `## Organizational Memory` header with a short instruction line. It returns the prompt unchanged — and performs no store reads — if the layer is disabled (`ARCHIE_MEMORY=false`), if **injection is disabled** (`ARCHIE_MEMORY_INJECT` ≠ `true`, the default — see [Feature Flags](#feature-flags)), or if no memory exists.

## Write Path — Extraction on Task Completion

### Trigger

`initMemory()` (`src/memory/index.ts`) runs once at startup, after `initEventPersistence()` in `src/index.ts:98`. It:

1. Returns immediately if `ARCHIE_MEMORY=false`.
2. Creates `workdir/memory/` and `workdir/memory/users/`.
3. Subscribes a listener via `onEvent()` to the `task:completed` event emitted by `Task.complete()` (`src/tasks/task.ts:546`).

When the event fires, `handleTaskCompleted(taskId)` is invoked. It is fire-and-forget — no caller awaits the result.

### Sequential Queue

`lifecycle.ts` maintains a module-level `extractionQueue: Promise<void>` that chains every new extraction onto the previous one. This serializes writes to `users/*.md`, `recent-activity.md`, and entity files across concurrent task completions.

**Durable across restarts.** `handleTaskCompleted` writes the task ID to `pending-extractions.md` via `enqueuePending()` *before* extraction and removes it with `dequeuePending()` only after success. If the process exits mid-extraction, `initMemory()` reads the leftover IDs on the next startup and replays each through `rescheduleTaskCompleted()`. Queue-file writes are atomic (tmp-file + `rename`).

### Extraction Pipeline (`processExtraction`)

```
1. loadMetadata(taskId)                  ──▶ task metadata (participants, channels, status)
2. readKnowledgeLog(taskId)              ──▶ transcript
3. extractUsernames(transcript)          ──▶ UserRef[] (Slack IDs + names); cli:<taskId> fallback when none
4. readUser() for ALL involved users + readIndexMarkdown ──▶ existing user memory + entity index
5. runExtraction({...}, allowedUserIds)                  ──▶ Sonnet side-agent (maxTurns: 1, no tools)
6. applyUserUpdatesWithIdentity(userId, name, updates) per user
7. applyEntityUpdate(update, taskId) per entity (resolve-or-create, auto touched_by) → rebuildIndex()
8. writeSummary() ──▶ workdir/memory/summaries/<taskId>.md (frontmatter + Memory Updates + Related Tasks)
9. appendActivity({...}) + trimActivity(50)

(If a user file or the entity count overflows its soft cap in steps 6–7, runHousekeeping(target) — including target 'entities' — is enqueued on the same queue. See "Housekeeping".)
```

### The Extraction Side-Agent

`runExtraction()` (`extractor.ts:187`) invokes the Claude Agent SDK's `query()` with:

- `model: 'sonnet'`
- `maxTurns: 1` — no multi-turn behavior; one prompt, one response.
- `allowedTools: []` — no tool calls.
- `executable: 'node'`, `pathToClaudeCodeExecutable: process.env.CLAUDE_PATH || 'claude'`.
- A fresh subprocess env limited to `NODE_ENV`, `ANTHROPIC_API_KEY`, `PATH`.

The agent's prompt comes from `prompts/memory-extractor.md` (substituted via `loadPrompt()`). The expected response is a JSON object matching `ExtractionResult`:

```ts
interface ExtractionResult {
  user_updates: Record<string, MemoryUpdate[]>;
  entity_updates: EntityUpdate[];
  task_summary: string;
  activity_summary: string;
  domain: string;
}

interface MemoryUpdate {
  action: 'add' | 'update';
  section?: string;
  content: string;
  old?: string;   // 'update' only
}

interface EntityUpdate {
  slug: string;                 // resolved against the entity index (by slug or alias)
  type?: string;                // service|system|integration|concept|repo (required on create)
  scope?: string;               // org|domain|repo
  repos?: string[];
  summary?: string;             // L0 one-liner
  observations?: { category: string; text: string }[];   // category ∈ fact|config|decision|caveat
  relations?: { type: string; target: string }[];        // type ∈ depends_on|integrates|owned_by|part_of|related_to
}
```

`parseExtractionResponse()` strips Markdown code fences, parses JSON, validates the top-level shape and every `MemoryUpdate`, and returns `null` on any failure. `entity_updates` is parsed **leniently** — entity writes are additive and fully sanitized downstream (`entities.ts` + `sanitize.ts`), so a malformed individual entity item is dropped with a warning rather than failing the whole extraction. Failure of the core result is logged and skipped — extraction is best-effort.

The transcript is truncated to 100,000 characters before being substituted; longer transcripts get a `[truncated]` sentinel.

## Storage Formats

### `users/<id>.md`

```markdown
---
slack_user_id: U07ABC123
display_name: "Dana"
aliases: []
---
## Communication
- Prefers concise Slack updates  <!-- touched: 2026-05-14 -->
```

`## Section` / `- bullet` structure, preceded by YAML frontmatter (`slack_user_id`, `display_name`, `aliases`) written on first touch by `applyUserUpdatesWithIdentity`. The filename is the raw Slack ID (`U…`/`W…`/`B…`/`T…`) or a `cli:`/`local:` fallback — never a display name. `getUserPath()` in `paths.ts` enforces this and normalises the `:` in fallback IDs to `__` for case-insensitive filesystems.

`applyUpdate()` (`store.ts`) handles two actions:

- **`add`** — Find `## {section}` header. If found, append `- {content}` at the section's last non-empty line. If missing, append a new `## {section}` block at file end. If no section is given, append at file end.
- **`update`** — Find the first line containing `old`. If found, replace it with `- {content}`. If not found, the update is skipped with a warning — no silent append (see the "Unmatched update actions SHALL NOT silently append" requirement).

### `recent-activity.md`

```markdown
# Recent Activity

| Date | Task ID | Summary | Domain | User |
|------|---------|---------|--------|------|
| 2026-04-10 | task-20260410-1000-abc | Fixed login validation bug | engineering | U07ABC123 |
| 2026-04-09 | task-20260409-1530-def | Updated blog copy | marketing | U05DEF456 |
```

`appendActivity()` inserts new rows immediately after the separator (newest first). `trimActivity(50)` rewrites the file with only the most recent 50 rows when the cap is exceeded.

### `summaries/<taskId>.md`

Written by `writeSummary()` under `workdir/memory/`. (The old `sessions/<taskId>/shared/summary.md` location is deprecated — see `getTaskSummaryPath`, retained only to clean up legacy files.)

```markdown
---
task_id: task-20260410-1000-abc123
status: completed
created_at: 2026-04-10T10:00:00Z
updated_at: 2026-04-10T10:30:00Z
domain: engineering
extraction_at: 2026-04-10T10:31:00Z
links:
  slack:
    - channel_id: C0123
      thread_id: "1700000000.000100"
  github:
    - url: https://github.com/acme/api/pull/42
  cli:
users:
  - id: U07ABC123
    display_name: "Dana"
---

# Summary

Investigated and fixed the login bug. Root cause was missing input validation in the auth handler. Backend agent added the validation, opened PR, and merged after review.

## Memory Updates

### entities/auth-service.md
- **[decision]** validate input length before hashing

### users/U07ABC123.md
- **added** `## Communication` › Prefers concise Slack updates

## Related Tasks

- [task-20260409-1530-def](./task-20260409-1530-def.md) — Hardened session token rotation (engineering)
```

Related tasks are selected **by shared entity first**: `selectRelatedTasksByEntity()` reads the entities this task touched and links other tasks that the same entities are `touched_by`. When there is no entity overlap it falls back to the lexical token-overlap over the activity index.

### `entities/<slug>.md`

One file per durable subject, written by `applyEntityUpdate()` (`entities.ts`). The slug is validated as a filename by `isValidEntitySlug()` / `sanitizeEntitySlug()` — lowercase-kebab only, no separators, no `..`, `index` reserved. People are **not** entities; they stay in `users/<id>.md` and are referenced by `[[<slackId>]]`.

```markdown
---
entity: payment-service
type: service                 # service | system | integration | concept | repo
display_name: "Payment Service"
aliases: [payments-api]
scope: repo                   # org | domain | repo  (org pages are relevance-selected up to ARCHIE_MEMORY_ORG_INJECT_MAX, not always injected; the index always lists them)
repos: [backend]
domain: engineering
status: active                # active | archived
---
<!-- L0: NestJS payments API, Stripe + postgres-prod -->

## Facts
- [decision] chose idempotency keys over a dedup table  <!-- touched: 2026-06-01 -->

## Relations
- depends_on [[postgres-prod]]
- owned_by [[U07ABC123]]
- touched_by [[task-20260601-1000-abc]]
```

Observations carry a **closed** category (`fact | config | decision | caveat`); relations a **closed** type (`depends_on | integrates | owned_by | part_of | touched_by | related_to`). Unknown categories/types are dropped by `sanitize.ts`. Every applied update auto-adds a `touched_by [[taskId]]` edge — this is what powers entity-based related-task selection.

### `entities/index.md`

A **derived** thin table — one row per entity (`[[slug]]`, type, scope, L0 summary, last-touched). Regenerated from the entity files by `rebuildIndex()` after every extraction and during entity housekeeping; **never authoritative** (the files win on conflict). It is always injected at spawn so agents know the full catalogue.

```markdown
# Entity Index
<!-- generated by housekeeping; derived from the entity files — do not edit -->

| Entity | Type | Scope | Summary | Last |
|--------|------|-------|---------|------|
| [[payment-service]] | service | repo:backend | NestJS payments API | 2026-06-01 |
```

## Housekeeping

`users/*.md` files are bounded by two coupled mechanisms (organizational knowledge lives in entities, which have their own housekeeping below):

**Per-bullet last-touched annotation.** Every bullet carries an inline HTML comment with the date it was added or last refreshed:

```
- Backend uses NestJS with PostgreSQL  <!-- touched: 2026-05-14 -->
```

Hidden in rendered Markdown, parsable via `parseLastTouched()` from `annotations.ts`. Refresh happens automatically when a matching `update` action runs.

**Soft caps with auto-trigger.** When a write exceeds `ARCHIE_MEMORY_USER_CAP` (default 100 total bullets) or `ARCHIE_MEMORY_SECTION_CAP` (default 30 per section), `runHousekeeping(target)` is enqueued on the same sequential queue used for extraction. The consolidation Sonnet side-agent (`prompts/memory-housekeeper.md`):

- **MERGE** semantically-duplicate bullets, keeping the most recent touched date.
- **DROP** bullets older than `ARCHIE_MEMORY_STALENESS_DAYS` (default 180) that are redundant with newer entries.
- **REORDER** within each section so newest-touched comes first.

A **trace-back validator** drops any output bullet whose normalised edit distance to every input bullet exceeds 40% — preventing the side-agent from smuggling in new facts under the cover of consolidation.

Consequences of a consolidation pass are queued and emitted in the next completed task's summary under `## Memory Updates › ### Housekeeping`, e.g. `**housekeeping** users/U07ABC123.md: dropped 3 entries, merged 2 duplicate(s)`.

**Entity consolidation** (`runHousekeeping('entities')`, triggered when entity count exceeds `ARCHIE_MEMORY_ENTITY_CAP`, default 300) is done **in code**, not by the side-agent — merging structured pages and repointing graph edges is deterministic and trivially satisfies the no-new-facts guarantee (only existing observations/relations are moved). It: merges entities that another entity lists as an alias (folding observations/relations/aliases into the canonical slug, deleting the duplicate, repointing inbound edges), archives entities whose observations are all stale beyond the window (`status: archived` — never deleted), and rebuilds `entities/index.md`.

Manual trigger: `npm run memory:housekeeping -- --target <all|entities|U07ABC123>` (entry point at `scripts/memory-housekeeping.ts`).

Disabled by `ARCHIE_MEMORY_HOUSEKEEPING=false` — overflow is still logged but no pass runs.

## Feature Flags

| Flag | Default | Purpose |
|------|---------|---------|
| `ARCHIE_MEMORY` | `true` | Master switch. `false` → `initMemory`/`enrichPromptWithMemory`/`handleTaskCompleted` all no-op. Enabling the layer does **not** by itself enable injection — see `ARCHIE_MEMORY_INJECT`. |
| `ARCHIE_MEMORY_INJECT` | `false` | **Read-path gate, default OFF (inverts the convention).** `true` → stored memory is injected into agent prompts. Unset / anything else → injection off and `enrichPromptWithMemory` does no store reads; extraction still stores facts. `ARCHIE_MEMORY=false` overrides. |
| `ARCHIE_MEMORY_HOUSEKEEPING` | `true` | Auto + manual housekeeping. `false` → no consolidation runs. |
| `ARCHIE_MEMORY_USER_CAP` | `100` | Soft cap on total bullets in each user file. |
| `ARCHIE_MEMORY_SECTION_CAP` | `30` | Soft cap on bullets per `## Section` (org or user). |
| `ARCHIE_MEMORY_STALENESS_DAYS` | `180` | Days after which an unrefreshed bullet / entity observation is eligible for drop. |
| `ARCHIE_MEMORY_ENTITY_CAP` | `300` | Soft cap on total entity pages; entity housekeeping (merge/archive) auto-triggers when exceeded. |
| `ARCHIE_MEMORY_ENTITY_INJECT_MAX` | `8` | Max full **non-`org`** entity pages pushed into a single agent prompt (the index is always injected in full). |
| `ARCHIE_MEMORY_ORG_INJECT_MAX` | `8` | Max full `scope: org` entity pages injected into a single prompt. Org is no longer exempt; pages over the budget stay listed in the always-injected index. |
| `ARCHIE_MEMORY_ENTITY_OBS_CAP` | `30` | Soft cap on observations kept per entity page; on write the newest-touched are retained and the oldest surplus dropped. |

All variables are documented in `.env.example`.

### Injection vs extraction

`ARCHIE_MEMORY_INJECT` gates only the **read** path (memory → prompt); extraction, storage, and housekeeping are unaffected. This lets the layer run in **collect-only** mode: facts accumulate and can be evaluated (read the files under `workdir/memory/`, or via the `archie-debug` MCP) before they ever steer an agent.

| `ARCHIE_MEMORY` | `ARCHIE_MEMORY_INJECT` | Extraction (write) | Injection (read) |
|---|---|---|---|
| `false` | (ignored) | off | off |
| `true` (default) | unset / not `true` | **on** | **off** (default) |
| `true` | `true` | on | on |

**Rollout:** deploy with injection unset (collect-only), evaluate the stored facts, then set `ARCHIE_MEMORY_INJECT=true` to enable injection. Rollback is unsetting the flag — the store is untouched.

The "Learned from this task" Slack post does **not** exist — visibility into what was learned comes from structured logs (`logger.system('[memory] Extraction complete for ...')`) and the per-task summary file in `workdir/memory/summaries/`.

## Ejection

The plan was built to support clean removal in five steps:

1. `rm -rf src/memory/`
2. `rm prompts/memory-extractor.md`
3. Remove `import { initMemory } from './memory/index.js'` and the `await initMemory();` call from `src/index.ts`.
4. Remove `import { enrichPromptWithMemory, isMemoryEnabled }`, the `extractTaskUsernames()` helper, and the three memory-injection call sites from `src/agents/spawn.ts`.
5. `rm -rf workdir/memory/`

No type changes propagate to other modules, no database migrations, no external service cleanup. Core never imports from `src/memory/`.

## Testing

| File | Surface tested |
|------|----------------|
| `sanitize.test.ts` | Every validator rule + injection / secret heuristics, positive + negative cases |
| `paths.test.ts` | Slack-ID acceptance, fallback-ID acceptance, malformed-ID rejection, filename construction |
| `store.test.ts` | `readUser`/`writeUser`, `applyUpdate` (add / update / skip-unmatched on user files), `applyUserUpdates*`, `softCapExceeded` |
| `context.test.ts` | `buildMemoryContext` user-tag attributes, `enrichPromptWithMemory` disabled-flag passthrough |
| `extractor.test.ts` | `buildExtractionPrompt` substitution, `parseExtractionResponse` happy/sad/fenced cases |
| `activity.test.ts` | `readActivity`, `appendActivity`, `trimActivity` (newest-first, cap behaviour) |
| `pending-queue.test.ts` | Round-trip enqueue/dequeue/read, idempotent enqueue, malformed-file resilience |
| `housekeeping.test.ts` | Annotation parsing, `extractBullets`, trace-back validator, soft-cap thresholds, entity merge-plan / staleness / merge+archive integration |
| `entities.test.ts` | parse/serialize round-trip, alias resolution, `applyEntityUpdate` (resolve-or-create, auto touched_by, closed-vocab drops, traversal-slug rejection, cap) |
| `entity-index.test.ts` | `rebuildIndex` derive/drop, `selectEntities` (org-always, repo match, 1-hop expansion, bound + dropped, archived excluded, title scoring) |
| `lifecycle.test.ts` | End-to-end: org / user / entity / summary / activity writes; entity-based related tasks; restart-resilience; multi-user allowed set; no Slack post |

Run with `npx vitest run src/memory/__tests__/` or `npm test`.

## Hardening & Guarantees

The layer's safety guards close seven gaps found in review; each is enforced in code today (the "Housekeeping" section above is the largest addition):

| Concern | Resolution |
|---------|------------|
| Identity collisions on shared first names | User-memory filename is the raw Slack ID (`U…`/`W…`/`B…`/`T…`) or a `cli:` / `local:` fallback. Display name lives in YAML frontmatter inside the file. |
| Model output corrupting Markdown | `src/memory/sanitize.ts` validates every update before write — section regex, domain enum, single-line bullets, table-cell escaping. |
| Unmatched `update` actions becoming orphan bullets | `applyUpdate` now skips + warns when `old` is not found. No silent fallback. |
| Lost extraction on crash | `pending-extractions.md` persists in-flight task IDs; `initMemory()` drains on startup. |
| Prompt injection via transcripts | Extractor prompt marks transcript as untrusted data; sanitizer rejects instruction-shaped lines, role-play directives, and secret-shaped tokens. |
| "Learned from this task" Slack noise | Slack post removed entirely; the audit trail lives in `summaries/<taskId>.md`. |
| Only first user's memory loaded | All involved users' memory loaded in parallel; `parseExtractionResponse` drops updates for users outside the allowed set. |

## Future Enhancements (Not in scope)

The entity/domain layer (this change) deliberately stays **push-only** and **keyword-scored**. The natural next experiments — to try and measure, not assumed:

- **Hybrid pull (`read_memory` tool/MCP)** — add an agent-callable tool to fetch an entity page by slug mid-task, on top of the pushed index. The open question is whether pull recovers the entities that push's bounded selection drops, at an acceptable latency/turn cost. A/B it against selective-push on selection precision/recall, prompt tokens, and task outcome quality.
- **Embedding / semantic selection** — replace token-overlap scoring of the index with embeddings once the measured miss-rate of the deterministic scorer justifies it.
- **Domain-directory splitting** — promote `domain` from a frontmatter dimension to an `entities/<domain>/` split once entity volume makes a flat directory unwieldy.
- **Channel visibility / access control** — public-vs-private filtering at retrieval time. Deferred until a concrete leak surface is identified.
- **Slack reaction → revert** — let users react ❌ to remove just-applied entries.

## Related Documentation

- [Spec](../../openspec/specs/memory-layer/spec.md) — target capability spec with numbered requirements
- [Hardening change (archived)](../../openspec/changes/archive/2026-05-29-harden-memory-layer/proposal.md) — the bundled improvements that closed the gaps above
- [Agents](agents.md) — agent prompt composition (memory is appended last)
- [Orchestration](orchestration.md) — task lifecycle and event emission
- [Persistence](persistence.md) — `knowledge.log` and metadata storage that extraction reads from
