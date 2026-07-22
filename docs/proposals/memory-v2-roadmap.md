# Memory v2 — Roadmap

> **Status:** The runtime architecture is implemented in PR [#135](https://github.com/sweatco/archie-hq/pull/135). The evaluation harness is a separate stacked change, PR [#228](https://github.com/sweatco/archie-hq/pull/228), and is not part of the current branch. Injection and tools remain off by default.
> **As built:** [`docs/architecture/memory.md`](../architecture/memory.md) · **History:** [`docs/plans/20260719-memory-v2.md`](../plans/20260719-memory-v2.md)

## Current capability — PR #135

- Relevance-gated, separately capped org and non-org entity injection.
- Always-available thin entity index when injection is enabled.
- Three read-only pull tools: `search_memory`, `read_entity`, and `read_task_summary`.
- Selection, pull, and profile-evidence-drop telemetry under `memory/tasks/<taskId>/telemetry.jsonl`.
- Immutable public/private task visibility. Only public tasks contribute to the shared store.
- Author-scoped collaboration profiles with evidence-bound updates.
- Markdown-only storage and two core integration seams.

The runtime exposes no raw-task-log reader, per-artifact ACL, denial telemetry, private-task extraction mode, or bundled evaluation command.

## Measurement — stacked PR #228

The evaluation change consumes snapshots of the runtime store without modifying them. It owns the commands, snapshot tooling, regression sets, and reports needed to measure:

- worst-case rendered prompt size;
- entity selection precision and recall;
- pull-vs-push misses and zero-result searches;
- store health and near-duplicate trends;
- functional answer quality against fixed-reader and oracle arms.

Until that change lands, `npm run memory:eval` and `scripts/snapshot-memory.sh` are not available on the memory-v2 branch and must not appear in PR #135's operational instructions.

## Rollout gates

1. Merge the runtime architecture with `ARCHIE_MEMORY_INJECT=false` and `ARCHIE_MEMORY_TOOLS=false`.
2. Before deployment, snapshot and clear the existing `workdir/memory/` store. Its private-derived provenance cannot be reconstructed under the new public-store model.
3. Land or otherwise run the evaluation harness from PR #228 against a fresh store snapshot.
4. Review the worst-case token bound, store contents, and functional selection results.
5. Enable injection and tools independently in dedicated changes that carry the evidence. Either flag is the rollback switch for its read path.
6. After enough production telemetry accumulates, review selection drops, pulled-but-not-injected pages, zero-result searches, and `user-update-dropped` records before tuning budgets or retrieval.

Automatic housekeeping is serialized with runtime extraction. Manual housekeeping is a separate process; stop the Archie service before running `npm run memory:housekeeping`.

## Proposed later work

### Write-path revision

Consider a single classify-then-write funnel supporting `ADD`, `UPDATE`, `DELETE`, and `NOOP`. It should handle deduplication and contradiction-driven forgetting without adding a second unsanitized writer. Selective forgetting requires its own evaluated gate.

### Hybrid retrieval

Add embeddings only if telemetry shows lexical selection remains the bottleneck after pull tools are enabled. Keep lexical, repo, ownership, and graph signals; any embedding signal should enter a hybrid ranker and beat the regression set before rollout.

### Outcome evaluation

After enough live data accumulates, sample completed tasks to determine whether memory helped, misled, or went unused. This is distinct from question-set evaluation and should drive later decisions about index tiering, budgets, and retention.

## Open questions

- Should future agents propose writes through the existing extraction funnel, and which agent roles may do so?
- When does the always-injected entity index become the dominant prompt cost?
- What evidence threshold should enable contradiction-based deletion?
- How should production-derived evaluation artifacts be retained without exposing task titles or Slack identities?
