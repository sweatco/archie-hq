# Red team — round 2 (verifying the B1 fix)

Verdict: **PASS — B1 closed. No blocking objections. 5 non-blocking** (folded into the plan in the final round-3 revision, except the two doc-only notes which the revision records in design.md).

## B1 closure verified via two independent legs

- Leg 1 (primary): the follow-up gate keys on "the resolved task has a matching github channel" — a task property, independent of resolution path — so it fires regardless of which resolution step produced the taskId.
- Leg 2 (defense-in-depth): no resolution path other than `findTaskByIssueChannel` can reach a github-born task in v1. Traced: `findTaskByPRNumber` requires `branch_state.pr_number`, whose sole writer is `assignPrNumber` (`branch-state.ts:25-30`) called only from the `create_pull_request` tool (`tools.ts:1140`) — RO-disallowed (`spawn.ts:499`); branch-pattern resolution requires `push_branch` (RO-disallowed, `spawn.ts:498`); PR-review events aren't wired to the issue mapping and hit the no-taskId discard.
- "PR the PM later opens" probe: unreachable in v1 (readonly blocks PR creation; edit mode unreachable). Latent for v2 — recorded as a doc note.
- Watermark-not-advanced-on-drop confirmed correct (idempotent drops, no out-of-order loss). TOCTOU direction fail-safe (checked at processing time).
- Revision side-checks: slug-gated mapping (safe inert posture; slug-unset window loses follow-ups — operator misconfiguration, acceptable); sync `save(true)` ordering safe (`task.ts:1062-1066`); `isGitHubBorn()` exact in v1 (only github-channel writer is the mention handler); `handleEditModeApproval` return-widening safe (both callers ignore return); no over-correction; no dangling `github_origin` references; AC7 consistent across all six documents.

## Non-blocking objections

1. Uncached permission GET per follow-up = shared-installation primary-rate DoS from low-privilege actors (5,000/h budget shared with all Archie GitHub ops). Fix: v1 short-TTL per-(repo,user) cache + `[bot]` short-circuit before the GET + trade-off note. → folded into plan (round 3).
2. Follow-up gate safety is load-bearing on readonly-v1 + exact repo#number match; relaxing readonly in v2 would let Archie-opened PR threads bypass the gate. → doc note in design.md (round 3).
3. Spec wording used resolution-path phrasing; design/tasks use the (safer) task-property phrasing. → spec reworded (round 3).
4. `findTaskByIssueChannel` adds a metadata scan to every non-resolving issue_comment (previously scan-free for plain issues). Low severity; gated by in-memory activeTasks check. → doc note (round 3).
5. Decline-dedup Map unbounded in principle. → lazy eviction specified (round 3).
