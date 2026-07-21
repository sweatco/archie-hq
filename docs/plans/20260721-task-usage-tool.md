# Per-task usage & cost accounting (`get_task_usage`)

**Status:** Implemented

## Context

There was no way to ask "how much has this task used or cost so far?". Token consumption and SDK-reported cost were emitted transiently in the agent event loop and then discarded, so neither the PM nor an operator could see a running total for a task. This plan adds a PM-only, zero-argument MCP tool `get_task_usage` that reports the current task's token usage (always) and SDK-reported cost (when available), with a per-agent breakdown, backed by a new append-only `shared/usage.jsonl`.

## Approach

The design keeps two independent data sources and joins them only at report time, because they have different availability and trust properties.

Tokens are the source of truth and are always available. The aggregator recursively reads every SDK transcript under `sessions/<taskId>/claude/<agentKey>/session/projects/` — including nested subagent transcripts and excluding `journal.jsonl` — dedups assistant lines by `message.id` (parallel-tool partials repeat identical usage), skips `<synthetic>` turns, and sums the four token buckets. Tokens bucket per top-level `agentKey`, so subagent tokens roll up into the parent agent. This is crash-safe: the SDK writes transcripts continuously regardless of whether a turn produced a result event, so tokens are recoverable even for turns that never reported cost.

Cost is SDK-reported and only present when the SDK emitted a `result` event. It is aggregated exclusively from a new append-only `sessions/<taskId>/shared/usage.jsonl`, populated by a fire-and-forget hook on the SDK `result` event in `spawn.ts`. There is deliberately no price table and no estimation — cost is the SDK's own `total_cost_usd` reported verbatim, shown as `unavailable` when no record exists.

## Files / subsystems

`src/tasks/persistence.ts` gains `getUsageLogPath(taskId)`, the `TaskUsageRecord` type, and `appendUsageRecord()`, all cloned from the `events.jsonl` pattern (`getEventsLogPath`/`appendEvent`). A dedicated module-level `usageWriteQueues` map serializes writes per task (kept separate from the events queue so the two never contend), an `existsSync` guard on `shared/` no-ops when the directory is missing, and the whole body is wrapped in try/catch so the fire-and-forget writer never throws.

`src/agents/task-usage.ts` is a new pure, unit-testable module holding the aggregation and formatting logic (`aggregateTaskUsage`, `formatTaskUsageReport`, and the injectable `reduceNonceCost`). It imports only `SESSIONS_DIR` from the workdir bootstrap so its test module graph stays a single mock, and builds all paths locally.

`src/agents/tools.ts` gains `createGetTaskUsageTool(agent, task)`, a `tool('get_task_usage', …, {}, handler)` that mirrors `createGetAgentsStatusTool`. It is registered in `createOrchestrationMcpServer`, which is wired only in the PM branch of `spawn.ts`, so the tool never reaches repo or plugin agents.

`src/agents/spawn.ts` generates one `randomUUID()` nonce per `query()` call inside the retry loop, in scope for that call's entire event loop, and appends a usage record (fire-and-forget, never awaited) on each `result` event.

## Cost aggregation semantics — why the nonce replaced the rejected `session_id` heuristic

The rejected design tried to reconstruct query()-call boundaries at READ time by grouping `usage.jsonl` records on `session_id` and segmenting each session's records into runs on a `total_cost_usd` drop (a `decumulateCost` step). Verified against the real code, that approach is both over-engineered and silently wrong. Archie makes exactly one `query()` call per spawn inside a `while (true)` retry loop, and an agent RESUMES the same `session_id` across many spawns (`existingSessionId = agent.session.session_id`, `resume: sessionId` in `buildQueryOptions`). So one `session_id` accumulates many independent query()-call cost windows.

The drop-heuristic OMITS cost whenever a cheap query() call precedes a more expensive one under a shared `session_id`. Concretely: spawn #1 is a $0.02 acknowledgement (query call A), the agent parks, spawn #2 resumes and its first turn costs $0.60 (query call B). The records `[0.02, 0.60]` show no drop, so A is absorbed into B's run and the $0.02 is lost — an omission the design must not have. Worse, the heuristic's correctness depended on an unconfirmed assumption (that `session_id` is stable across resume) that was never established.

The fix adopts a write-time nonce and deletes drop detection entirely. Each usage record is stamped with `query_nonce = randomUUID()`, generated once per `query()` call. A nonce cleanly delimits exactly one query() call's cost window and belongs to exactly one agent (each spawn is per-agent). Read-time cost becomes a two-level reduce with no ordering, no drop detection, and no dependency on `session_id` semantics: reduce within a nonce, then sum across nonces. Grand cost is the sum over nonces of `reduceNonceCost(nonce)`; per-agent cost is the same sum bucketed by the nonce's `agentKey`, and since every record in a nonce shares one `agentKey`, per-agent costs sum to the grand total by construction. The concrete undercount above is now impossible and is directly unit-tested: nonce A max $0.02 + nonce B max $0.60 = $0.62, no omission. `session_id` is kept on the record for traceability and debugging only, never for cost math.

## The empirical within-nonce reducer decision

Within a nonce, the records sharing one `query_nonce` must reduce to that query() call's single cost. Per the SDK cost-tracking docs, `total_cost_usd` is CUMULATIVE across the steps of a single query() call, so the default reducer takes the maximum — equivalently the final cumulative value, with `max` chosen because it is robust to line ordering and monotonic under the cumulative model. This is the one empirical fork in the design, and it is self-distinguishing: the cumulative hypothesis implies a monotonic non-decreasing sequence within a nonce, so any decrease within a nonce would prove the SDK is instead emitting per-turn deltas.

The fork was resolved on the live boot: successive result events within one query() call were observed to be cumulative (monotonic non-decreasing), so `max` is correct. The reducer is injectable (`NonceReducer`), so the delta fallback — flip `max` to `sum` — is a one-line change confined to `reduceNonceCost` and is unit-tested independently. The choice only ever matters for a nonce with multiple result events; for a single-result-event nonce `max == sum`, so it cannot produce a wrong number.

Across nonces the reduction is always SUM, which is documented rather than empirical: each query() call reports only its own cost, so there is nothing to deduplicate between nonces.

## Output shape

The report shows a grand total (input / output / cache-read / cache-write token buckets, plus `Cost (SDK-reported): $X.XX` or `Cost: unavailable`) followed by a per-agent breakdown with the same token buckets, a session count, and SDK-reported cost. Every cost figure is explicitly labelled as an SDK-reported estimate from the SDK's bundled price table — not actual Anthropic billing, and divergent under subscription auth where spend is flat. When the count of cost-recorded turns (usage.jsonl records) is below the transcript turn count (main-agent `end_turn` count), a disclosed gap line is appended noting how many turns the cost covers and that the rest predate cost logging or ended without a result event.

## Caveats (documented, not corrected)

SDK cost is a client-side estimate and diverges from real billing under subscription/flat auth — disclosed in output rather than corrected, per the non-goal.

Cache-write tokens are reported as a single bucket; the 1h-vs-5m ephemeral split (`ephemeral_1h/5m_input_tokens`) and `inference_geo` multipliers are NOT modeled, because Archie sets neither `ENABLE_PROMPT_CACHING_1H` nor `inference_geo` (confirmed: no such settings in `src/`; observed records carry `inference_geo:"global"` and `ephemeral_1h:0`).

The scope is the current task only. PR #162's temporary per-turn logging line is untouched, and `CHANGELOG.md` is left to its automation.
