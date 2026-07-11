# AC7 — VERIFIED

**Method**: integration · **Run**: 2026-07-11 (cycle 2 addendum), branch `forge/github-mention-trigger` @ `05fcf1a`, vitest v4.1.10 · **QA**: black-box

**Test files**: `src/connectors/github/__tests__/mention-handler.test.ts` (26/26 passed) and `src/connectors/github/__tests__/mention-routing.test.ts` (21/21 passed), each run fresh with `--reporter=verbose`. Raw output: `../raw/mention-handler.txt`, `../raw/mention-routing.txt`; full-suite run: `../test-run.txt` (904/904).

## Cycle history

- Cycle 1 (@ `d2976f9`): VERIFIED with an anomaly — a single dedup case name (`skips a redelivered comment id via the channel watermark`) was compatible with either of the plan's two dedup companions, so only one could be confirmed.
- Cycle 2 (@ `8f70930`): the dedup case was split into two distinctly named shapes; both exist and pass. Anomaly cleared.
- Cycle 2 addendum (@ `05fcf1a`): stamps/counts/excerpt refreshed (file now 26 cases after the AC2 monolith split); all AC7 cases unchanged and still passing.

## Named scenarios → cases found (exact names from vitest verbose output)

| Plan scenario | Case in output | Result |
|---|---|---|
| "authorized follow-up comment routes to the mapped task" — `existing_task` via `findTaskByIssueChannel` (router side) | `routeGitHubEvent — issue→task mapping > resolves a follow-up comment on a mapped issue to existing_task via the mapping` (mention-routing.test.ts) | ✓ pass |
| delivery run re-checks author, appends to `knowledge.log`, PM pinged with existing-task prompt | `handleExistingTaskDirect — GitHub-born follow-ups (AC7) and AC11 pins > routes an authorized mention-free follow-up: appends, advances the watermark, pings the PM (AC7)` | ✓ pass |
| author gate: `read`/`none` follow-up → silently dropped, no append, no PM wake, watermark NOT advanced, reason logged | `handleExistingTaskDirect — GitHub-born follow-ups (AC7) and AC11 pins > silently drops a read/none follow-up author: no append, no PM wake, watermark unchanged (AC7 gate)` | ✓ pass |
| permission lookup throws → dropped fail-closed, failure not cached (retry re-queries) | `handleExistingTaskDirect — GitHub-born follow-ups (AC7) and AC11 pins > fails closed on a thrown lookup and does not cache the failure — a retry re-queries` | ✓ pass |
| `[bot]`-suffixed follow-up author → dropped, `getCollaboratorPermission` never called (D10) | `handleExistingTaskDirect — GitHub-born follow-ups (AC7) and AC11 pins > drops [bot] follow-up authors before any permission lookup` | ✓ pass |
| two follow-ups same author within TTL → exactly one permission lookup (D10) | `handleExistingTaskDirect — GitHub-born follow-ups (AC7) and AC11 pins > performs exactly one permission lookup for two follow-ups by the same author within the TTL` | ✓ pass |
| dedup (a): same authorized comment id delivered twice → second skipped | `handleExistingTaskDirect — GitHub-born follow-ups (AC7) and AC11 pins > skips a redelivered follow-up comment id via the channel watermark (AC7 dedup)` | ✓ pass |
| dedup (b): the triggering comment's redelivery skipped via the creation-time watermark | `handleExistingTaskDirect — GitHub-born follow-ups (AC7) and AC11 pins > dedups a redelivered triggering comment via the creation-time watermark (AC7)` | ✓ pass |
| slug companion (router side): slug unset → mapping never consulted, follow-up does not route (D9) | `routeGitHubEvent — issue→task mapping > never consults the mapping when GITHUB_APP_SLUG is unset — github-born follow-ups stop routing` (mention-routing.test.ts) | ✓ pass |

All nine named scenarios are individually identifiable and passing — no open anomalies.

## Vitest output excerpt (from `../raw/mention-handler.txt` at 04:08:05 and `../raw/mention-routing.txt` at 04:08:27)

```
 ✓ src/connectors/github/__tests__/mention-handler.test.ts > handleExistingTaskDirect — GitHub-born follow-ups (AC7) and AC11 pins > routes an authorized mention-free follow-up: appends, advances the watermark, pings the PM (AC7) 1ms
 ✓ src/connectors/github/__tests__/mention-handler.test.ts > handleExistingTaskDirect — GitHub-born follow-ups (AC7) and AC11 pins > silently drops a read/none follow-up author: no append, no PM wake, watermark unchanged (AC7 gate) 2ms
 ✓ src/connectors/github/__tests__/mention-handler.test.ts > handleExistingTaskDirect — GitHub-born follow-ups (AC7) and AC11 pins > fails closed on a thrown lookup and does not cache the failure — a retry re-queries 2ms
 ✓ src/connectors/github/__tests__/mention-handler.test.ts > handleExistingTaskDirect — GitHub-born follow-ups (AC7) and AC11 pins > drops [bot] follow-up authors before any permission lookup 2ms
 ✓ src/connectors/github/__tests__/mention-handler.test.ts > handleExistingTaskDirect — GitHub-born follow-ups (AC7) and AC11 pins > performs exactly one permission lookup for two follow-ups by the same author within the TTL 2ms
 ✓ src/connectors/github/__tests__/mention-handler.test.ts > handleExistingTaskDirect — GitHub-born follow-ups (AC7) and AC11 pins > skips a redelivered follow-up comment id via the channel watermark (AC7 dedup) 2ms
 ✓ src/connectors/github/__tests__/mention-handler.test.ts > handleExistingTaskDirect — GitHub-born follow-ups (AC7) and AC11 pins > dedups a redelivered triggering comment via the creation-time watermark (AC7) 3ms
 ✓ src/connectors/github/__tests__/mention-routing.test.ts > routeGitHubEvent — issue→task mapping > resolves a follow-up comment on a mapped issue to existing_task via the mapping 1ms
 ✓ src/connectors/github/__tests__/mention-routing.test.ts > routeGitHubEvent — issue→task mapping > never consults the mapping when GITHUB_APP_SLUG is unset — github-born follow-ups stop routing 0ms
```
