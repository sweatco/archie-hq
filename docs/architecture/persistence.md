# Task Persistence

How Archie stores task state on disk, syncs in-memory runtime to files, and recovers after restarts.

> Source of truth: the code in `src/tasks/persistence.ts`, `src/tasks/task.ts`,
> `src/tasks/recovery.ts`, and `src/types/task.ts`. This document describes only
> what is implemented.

---

## File-Based Persistence Architecture

Each task gets its own directory under `${ARCHIE_WORKDIR}/sessions/` (default `./workdir/sessions/`, exported as `SESSIONS_DIR` from `src/system/workdir.ts`). While a task is active the in-memory `Task.metadata` is the source of truth; disk is a **crash-recovery checkpoint**, written through a debounce so rapid state changes coalesce into one I/O operation.

There is no database. All lookups (by thread, by branch, by PR number, by status) scan the filesystem, using `grep` where possible.

---

## Directory Structure

```
${ARCHIE_WORKDIR}/sessions/
  task-{YYYYMMDD}-{HHMM}-{random}/       # e.g. task-20251223-1712-a3f9k2
    shared/                                # shared task state, mounted read-only
      metadata.json                        # task metadata (canonical state)
      knowledge.log                        # append-only record (see below)
      events.jsonl                         # append-only system events, one JSON per line
      usage.jsonl                          # append-only SDK usage/cost records
      memory/                              # per-task memory staging
      attachments/                         # downloaded Slack files, {file_id}-{filename}
      artifacts/                           # content-hash-deduped file snapshots
    agents/
      pm/                                  # the PM's workspace (cwd, read-write)
        .claude/settings.json              # commit attribution only
    claude/
      pm/
        session/                           # SDK config dir
        tmp/                               # SDK tool-results scratch dir
    researches/                            # web_research outputs
    repos/
      {owner}/{repo}/                      # one shared clone per repo, created by mount_repo
```

`agents/` and `claude/` hold exactly one entry, `pm`, because a task runs one agent. That key is deliberately unchanged from before the flattening, so `claude/{key}/` and the usage records keep their shape and historical cost reports stay readable.

### Path helpers (`src/tasks/persistence.ts`)

| Function | Returns |
|---|---|
| `getTaskPath(taskId)` | `{SESSIONS_DIR}/{taskId}` |
| `getSharedPath(taskId)` | `…/{taskId}/shared` |
| `getAgentsPath(taskId)` | `…/{taskId}/agents` |
| `getReposPath(taskId)` | `…/{taskId}/repos` |
| `getTaskClonePath(taskId, github)` | `…/{taskId}/repos/{owner}/{repo}` |
| `getMetadataPath(taskId)` | `…/{taskId}/shared/metadata.json` |
| `getKnowledgeLogPath(taskId)` | `…/{taskId}/shared/knowledge.log` |
| `getMemoryPath(taskId)` | `…/{taskId}/shared/memory` |
| `getAttachmentsPath(taskId)` | `…/{taskId}/shared/attachments` |
| `getArtifactsPath(taskId)` | `…/{taskId}/shared/artifacts` |
| `getEventsLogPath(taskId)` | `…/{taskId}/shared/events.jsonl` |
| `getUsageLogPath(taskId)` | `…/{taskId}/shared/usage.jsonl` |

The workspace and SDK runtime dirs are created in `src/agents/spawn.ts`, not here.

### Task ID format

`generateTaskId()` produces `task-{YYYYMMDD}-{HHMM}-{random6}`, e.g. `task-20251223-1712-a3f9k2`. The date prefix gives natural filesystem sorting; the base-36 suffix gives uniqueness. `isSafeTaskId()` matches exactly that shape — a single path segment with no `..` — and every function that builds a path from an API-supplied id checks it.

---

## Metadata Schema

**Source**: `src/types/task.ts`

```typescript
interface TaskMetadata {
  task_id: string;
  channels: Record<string, Channel>;   // active delivery targets, keyed by channel id
  default_channel: string | null;      // originating channel (null for CLI-originated tasks)
  home_channel?: { channel_id, channel_name };  // trigger-fired tasks: where to open the thread
  title?: string;                      // Haiku-authored one-liner; absent on pre-feature tasks
  agent_sessions: Record<string, AgentSessionState | string>;  // one entry: 'pm-agent'
  repositories: AttachedRepo[];        // flat — one entry per mounted repo
  status: TaskStatus;                  // 'in_progress' | 'stopped' | 'completed'
  edit_allowed?: boolean;
  max_mode?: boolean;
  edit_approved_by?: { id, name, email? };
  pending_merge_approval?: { github, pr_number, requested_by, requested_at };
  pending_tool_approval?: { digest, server, tool, summary, heading, requested_by, requested_at };
  approved_tool_calls?: ApprovedToolCall[];
  research_budget_extra?: number;
  research_request_count?: number;
  reminder?: { trigger_at, reason };
  triggered_by?: string;
  pending_trigger_id?: string;
  briefed_channels?: string[];
  slack_threads?: SlackThreadRef[];    // legacy — migrated to `channels` on first load
  created_at: string;
  updated_at: string;
}
```

`src/types/task.ts` is the source of truth; a couple of minor fields are omitted above. Nothing validates or filters metadata on the way to disk — `save()` stringifies the whole object and `loadMetadata` is a bare `JSON.parse` — so an older build never drops a field a newer one wrote.

**Fields the flat model removed:** `task_owner`, `participants`, `dynamic_agents`, and the `AgentName` / `CoreAgentName` / `TriageResult` / `DynamicAgentSpec` types behind them. There is one agent, so ownership and participation carry no information. `requested_by` survives on the two pending-approval slots, where it is always `pm-agent`, because the invariant it guards (a deferred stop must have someone to cancel it) is cheaper to keep than to re-derive.

### `repositories`: flat, one entry per repo

```typescript
interface AttachedRepo {
  github: string;                                // 'acme/backend' — also the key
  clone_path?: string;                           // sessions/<id>/repos/acme/backend
  base_path?: string;                            // base cache the clone borrows objects from
  current_branch?: string;                       // key into branch_states
  branch_states?: Record<string, BranchState>;
}
```

The task owns the clone, not an agent, so there is no agent segment in the path and no agent key in the record. Two legacy on-disk shapes migrate lazily in `Task.get()` via `migrateRepositoriesShape()`:

- `Record<agentId, AttachedRepo[]>` — the per-agent shape that preceded this one. Flattened by union on `github`: two agents that both mounted a repo produce one entry, the first seen. Arbitrary but stable — their branch state is the same PR history, and only one clone survives per task now.
- Pre-v30 `Record<repoKey, RepositoryInfo>` — keyed by a short repo name whose `github` identifier only the (now removed) agent registry could resolve. Those entries are **dropped with a warning**; such tasks predate the per-agent shape by many months and are terminal.

The migration is in-memory on every load, and `Task.get()` persists the upgrade once so a read-only load (webhook resolution, comment dedup) does not re-migrate forever. The webhook lookups `findTaskByPRNumber` and `findTaskByBranch` run the same migration on their loaded copy before walking, so an in-flight PR on a task that has not been re-saved since deploy still routes.

### `BranchState`

```typescript
interface BranchState {
  base_branch?: string;                // PR target branch
  pr_number?: number;
  last_processed_comment_id?: number;  // GitHub comment dedup for this branch's PR
  stash_name?: string;                 // set if dirty work was auto-stashed when leaving
  pr_card?: PrCardState;               // posted-card ref + change-detection fingerprint
  merge_ready_notified?: boolean;
  merge_armed?: boolean;
}
```

### `AgentSessionState`

```typescript
interface AgentSessionState {
  session_id?: string;     // SDK session id (undefined = fresh start)
  active: boolean;         // true = processing, false = finished/crashed
  last_activity?: string;
}
```

`agent_sessions` holds one entry, keyed `pm-agent`. It is the only on-disk record of which session to resume at startup, and the entry max-mode clears when the approved upgrade changes the resolved model. The `AgentSessionState | string` union handles legacy files where the value was a bare session id.

---

## The knowledge log

**Source**: `src/tasks/persistence.ts`

`shared/knowledge.log` is an append-only text record of the task: inbound Slack messages and edits, GitHub events, CLI messages, outgoing user-facing messages, and system findings.

**It is write-only as far as the running agent is concerned.** Everything the PM needs is delivered **inline** into its stream (see [orchestration.md](orchestration.md#wakes-carry-their-content)), so nothing on the live path reads the file back, and the PM's prompt does not mention it. The append functions that feed the PM therefore **return the line they wrote**, and the caller hands that exact string to the PM — so the inline copy and the logged copy are identical by construction rather than by two renderers agreeing.

Two offline consumers read it after the fact, and they are the reason it is still written:

- **Memory extraction** (`src/memory/lifecycle.ts`) — the post-task pass that distils organizational facts and user preferences ([memory.md](memory.md)).
- **The people section** built at spawn (`extractTaskUsernames` / `buildTaskPeopleSection` in `src/agents/spawn.ts`) — it scans the log for `<@UID:Name>` markers to build the `<people_in_task>` block.

It is also the per-task audit trail: every approval, denial, budget change, gated tool call requested and gated tool call actually spent leaves a finding here.

### Log format

```
[{ISO timestamp}] [{source}] {message}
[{ISO timestamp}] [{source}] [{type}] {message}
```

The `type` field (`discovery`, `decision`, `completion`, `blocker`, `artifact`) is present on findings and omitted on messages.

| Source pattern | Written by |
|---|---|
| `<@{userId}:{name}> in slack:#<{channelId}:{channelName}>:{threadId} \| msg:{ts}` | `appendSlackMessage()` / `appendSlackEdit()` |
| `@<{author}> in github:{owner}/{repo}/{destination}` | `appendGitHubEvent()` |
| `cli` | `appendCliMessage()` |
| `{agentName} in {destination}` | `appendMessageToUser()` (outgoing) |
| `system` | `appendAgentFinding()` (approvals, budgets, mode changes) |

The `msg:{ts}` id stamped on each Slack line is what the PM passes to the reaction tools as `message_id`, which is why it has to survive into the inline copy verbatim.

Message bodies arrive already rendered — rendering is owned by `renderMessageBody` in `src/connectors/slack/message-body.ts` — so no second renderer grows in the persistence layer. Attached files are downloaded to `attachments/` as `{fileId}-{originalName}` before rendering, so the `[Attachments: …]` suffix carries usable local paths.

---

## Usage & cost accounting

**Source**: `src/tasks/persistence.ts` (writer), `src/agents/spawn.ts` (hook), `src/agents/task-usage.ts` (aggregator), `src/agents/tools.ts` (`get_task_usage`).

Archie tracks consumption from two independent sources, joined only at report time. Tokens are the source of truth and are always available; cost is SDK-reported and present only when the SDK emitted a result event.

### The `shared/usage.jsonl` writer

`spawn.ts` installs a fire-and-forget hook in the event loop: on every SDK `result` event it calls `appendUsageRecord()` (never awaited, so it can never block or break the loop). Each record is a `TaskUsageRecord` — `{ ts, taskId, agentId, agentKey, query_nonce, session_id?, subtype, num_turns, total_cost_usd, modelUsage, usage }` — serialized one per line. Writes are serialized per task via a dedicated `usageWriteQueues` map (kept separate from the `events.jsonl` queue), guarded by an `existsSync` check on `shared/`, and wrapped in try/catch so the writer never throws. If a turn crashes before its result event nothing is appended — the desired "cost unavailable for that turn" behavior, disclosed later as a transcript-vs-cost gap rather than papered over.

Because a taskId can arrive untrusted from the HTTP API, both the writer (`appendUsageRecord`) and the reader (`aggregateTaskUsage`) reject anything but the canonical shape before any path is built from it; an unsafe id is a silent no-op on write and an empty report on read. The guard is written twice, inline in each sink-reaching function — an anchored allowlist regexp at entry plus a `resolve()`+`relative()` containment check immediately before the sink — because CodeQL's `js/path-injection` analysis only recognises a sanitizer when the literal test sits in the function that reaches the sink, not when it is wrapped in a shared boolean helper (`isSafeTaskId` is retained for readability but is not the barrier CodeQL sees).

### The `query_nonce` cost model

Cost is aggregated by `query_nonce`, not by `session_id`. Archie makes exactly one `query()` call per spawn inside a retry loop, and the agent RESUMES the same `session_id` across many spawns — so one `session_id` accumulates many independent cost windows. Any read-time attempt to reconstruct call boundaries by grouping on `session_id` (e.g. segmenting on a `total_cost_usd` drop) is both over-engineered and silently wrong: a cheap call preceding an expensive one under a shared session shows no drop and is absorbed into the later run.

The nonce sidesteps this at write time. `spawn.ts` generates one `randomUUID()` per `query()` call, in scope for that call's entire event loop, so every result event it emits carries the same nonce. Read-time cost is then a two-level reduce with no ordering assumptions:

- **Within a nonce**: `reduceNonceCost` takes the maximum, since `total_cost_usd` is cumulative across the steps of one call (`max` is robust to line ordering and monotonic under the cumulative model).
- **Across nonces**: always sum — each call reports only its own cost.

`session_id` is retained per record for traceability only; it is never used in the cost math.

### The `get_task_usage` tool

A zero-argument tool on the orchestration MCP server answering "how much has this task used and cost so far?". `aggregateTaskUsage` computes tokens the source-of-truth way: it recursively reads every SDK transcript under `claude/pm/session/projects/` — **including the nested subagent transcripts**, so a worker's tokens roll up into the PM's line — dedups assistant lines by `message.id`, skips `<synthetic>` turns, and sums the token buckets. Cost is read exclusively from `usage.jsonl` via the nonce model. There is no price table and no estimation. Cost is never 0-filled: it renders `unavailable` when no record exists, because a missing record means unmeasured (the turn predates the hook, or crashed before its result event), not free. Figures print at four decimals, and a nonzero cost below that floor prints as `<$0.0001`. When fewer turns carry cost than the transcript recorded, the report appends a disclosed gap line.

### Caveats (documented, not corrected)

- SDK cost is a client-side estimate from the SDK's bundled price table, not actual Anthropic billing — under subscription auth, where spend is flat, it diverges. This is disclosed in the tool's output rather than corrected.
- Cache-write tokens are reported as a single bucket. The 1h-vs-5m ephemeral split and `inference_geo` multipliers are not modeled because Archie sets neither.
- Every `query_nonce` carries exactly one result-event record in practice, confirmed on a live boot under both sequential turns and messages queued mid-turn. Because a nonce reduces over a singleton, `max == sum` unconditionally. The reducer stays injectable purely as defensive headroom: if a future SDK emitted multiple result events within one `query()` call, flipping `max` to `sum` is a one-line change in `reduceNonceCost`.

---

## Debounced Writes

**Source**: `src/tasks/task.ts` — `Task.save()` / `Task.debouncedSave()`.

| Mode | Behavior |
|---|---|
| `debouncedSave()` | If a timer is already armed, return. Otherwise arm a 500 ms timer that syncs the agent session and writes `metadata.json` once. |
| `save(true)` | Sync and write `metadata.json` immediately. Does not cancel a pending debounced timer — the next fire just rewrites the same JSON. |

Flush mode is used wherever losing the write would change behaviour rather than merely cost an I/O: `stop()` / `complete()`, edit-mode approval (the spawn reads `edit_allowed` from disk), `mount_repo` (a clone exists on disk and needs a record pointing at it), arming a merge, and every tool-approval slot and grant transition.

Before every write the save path copies the live agent's session into metadata:

```typescript
if (this.agent) {
  this.metadata.agent_sessions[this.agent.def.id] = { ...this.agent.session };
}
this.metadata.updated_at = new Date().toISOString();
await writeFile(getMetadataPath(this.taskId), JSON.stringify(this.metadata, null, 2));
```

`save()` only re-syncs a *live* agent, which is what makes max mode's session clear stick: `request_max_mode` evicts the task, so the instance handling the approval has no live agent and the cleared `agent_sessions` entry survives to disk.

A second per-task write queue (`writeQueues` in `persistence.ts`) serialises appends to `events.jsonl` so event ordering is preserved.

---

## Deduplication

**Slack.** Each `SlackChannel` carries `last_processed_ts`. On a new thread, `Task.append()` writes the whole history and links the channel; on an existing one it writes only messages with `ts > last_processed_ts`, then advances the watermark. A message *edit* deliberately does not advance it — an edit reuses the original `ts`, so touching the watermark would skip genuinely new replies. Bot-message and external-user filtering happens upstream in `src/connectors/slack/events.ts`.

**GitHub.** `BranchState.last_processed_comment_id` tracks the most recent processed PR comment per branch. `handleExistingTaskDirect()` appends only comments with a higher id before waking the PM.

---

## State Recovery on Restart

**Source**: `src/tasks/recovery.ts`

1. `findTasksByStatus('in_progress')` greps every `metadata.json` for the status.
2. For each hit, `Task.get(taskId)` rebuilds the in-memory `Task` from disk (running the repositories migration and re-scanning the PM definition).
3. `task.sendMessage(AGENT_PROMPTS.recovery)` activates the task, which lazily creates and spawns the PM; its spawn rehydrates `session_id` from `agent_sessions` and resumes.

During graceful shutdown `isShuttingDown` is flipped, and `Task.updateAgentState()` **skips** deactivation writes so `active: true` survives in metadata and recovery knows to re-engage.

`Task.get()` is idempotent at the active-tasks-map level: an in-flight task is returned as-is and never disturbed; otherwise metadata is read from disk into a new, inert `Task`. The on-disk status is preserved by the constructor; the flip back to `in_progress` happens in `activate()`, lazily on the first `sendMessage()`. That is how a parked task reopens after an edit-mode, merge or tool-call approval.

---

## Cleanup Policy

There is no automated cleanup or garbage collection of task directories. Completed and stopped task directories remain on disk indefinitely; the `sessions/` directory grows over time. Read-only clones are removed on stop/complete (edit-mode clones are kept — they hold commits and PR state), and the shared package-manager caches live outside `sessions/` in `$ARCHIE_WORKDIR/caches/` precisely so they are not duplicated per task.

---

## Related Documents

- [System Orchestration](./orchestration.md) — runtime state, message routing, recovery
- [Edit Mode](./edit-mode.md) — `mount_repo`, clone lifecycle, branch state
- [Memory Layer](./memory.md) — the offline consumer of `knowledge.log`
