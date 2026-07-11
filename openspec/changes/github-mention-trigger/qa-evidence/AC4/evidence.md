# AC4 — VERIFIED

**Method**: integration · **Run**: 2026-07-11 (cycle 2 addendum), branch `forge/github-mention-trigger` @ `05fcf1a`, vitest v4.1.10 · **QA**: black-box

**Test files**: `src/connectors/github/__tests__/mention-handler.test.ts` (26/26 passed) and `src/connectors/github/__tests__/mention-routing.test.ts` (21/21 passed), each run fresh with `--reporter=verbose`. Raw output: `../raw/mention-handler.txt`, `../raw/mention-routing.txt`; full-suite run: `../test-run.txt` (904/904).

## Named scenarios → cases found (exact names from vitest verbose output)

| Plan scenario | Case in output | Result |
|---|---|---|
| `issues.opened` mention routed via `routeGitHubEvent` → `new_task` (newly routed `issues` event) | `routeGitHubEvent — mention detection (AC1) > routes a newly opened issue with a body mention to new_task (AC4)` (mention-routing.test.ts) | ✓ pass |
| "issues.opened mention behaves like AC2" (same task/seed/channel-origin/prompt outcomes, issue body as mentioning text) | `handleGitHubMentionDirect — creation path (AC2, AC4, AC5) > creates and acks from an issues.opened mention, with the reaction on the issue (AC4)` (mention-handler.test.ts) | ✓ pass |
| Redelivery companion: redelivered `issues.opened` for a mapped issue → noop, no second task, no second ack (D1/D8) | `routeGitHubEvent — issue→task mapping > discards a redelivered issues.opened for a mapped issue via noop — no new_task, no duplicate` (mention-routing.test.ts) | ✓ pass |

Since the cycle 2 addendum, the "behaves like AC2" comparison baseline is pinned claim-by-claim by the five AC2-named cases (see `../AC2/evidence.md`).

## Vitest output excerpt (from `../raw/mention-routing.txt` at 04:08:27 and `../raw/mention-handler.txt` at 04:08:05)

```
 ✓ src/connectors/github/__tests__/mention-routing.test.ts > routeGitHubEvent — mention detection (AC1) > routes a newly opened issue with a body mention to new_task (AC4) 0ms
 ✓ src/connectors/github/__tests__/mention-routing.test.ts > routeGitHubEvent — issue→task mapping > discards a redelivered issues.opened for a mapped issue via noop — no new_task, no duplicate 0ms
 ✓ src/connectors/github/__tests__/mention-handler.test.ts > handleGitHubMentionDirect — creation path (AC2, AC4, AC5) > creates and acks from an issues.opened mention, with the reaction on the issue (AC4) 4ms
```

## Cycle history

- Cycle 1 (@ `d2976f9`): VERIFIED, same three cases.
- Cycle 2 addendum (@ `05fcf1a`): stamps/counts/excerpt refreshed; AC4 cases unchanged and still passing.
