# AC11 — VERIFIED

**Method**: unit · **Run**: 2026-07-11 (cycle 2 addendum), branch `forge/github-mention-trigger` @ `05fcf1a`, vitest v4.1.10 · **QA**: black-box

**Test files**: `src/connectors/github/__tests__/mention-routing.test.ts` (21/21 passed) and `src/connectors/github/__tests__/mention-handler.test.ts` (26/26 passed), each run fresh with `--reporter=verbose`. Raw output: `../raw/mention-routing.txt`, `../raw/mention-handler.txt`; full-suite run: `../test-run.txt` (904/904).

## Cycle history

- Cycle 1 (@ `d2976f9`): FAILED — the plan-named pin "`push` → `merge_check`" had no corresponding case in either named file or the entire 897-test suite.
- Cycle 2 (@ `8f70930`): the pin was added to `mention-routing.test.ts`; verdict upgraded to VERIFIED.
- Cycle 2 addendum (@ `05fcf1a`): stamps/counts/excerpt refreshed; all AC11 cases unchanged and still passing.

## Named scenarios → cases found (exact names from vitest verbose output)

| Plan scenario | Case in output | Result |
|---|---|---|
| comments on `archie/task-{id}` branches still route `existing_task` with the same taskId | `routeGitHubEvent — existing routing unchanged (AC11) > routes a mentioning comment on an Archie-managed PR to existing_task, not new_task` | ✓ pass |
| `pull_request_review` approved → `merge_check` byte-identical | `routeGitHubEvent — existing routing unchanged (AC11) > routes pull_request_review approvals to merge_check byte-identically` | ✓ pass |
| `push` → `merge_check` byte-identical | `routeGitHubEvent — existing routing unchanged (AC11) > routes push events to merge_check byte-identically` | ✓ pass |
| failing `check_suite.completed` → `checks_ready` byte-identical | `routeGitHubEvent — existing routing unchanged (AC11) > routes failed check_suite completions to checks_ready byte-identically` | ✓ pass |
| `formatGitHubEvent` output for an Archie PR comment byte-identical | `routeGitHubEvent — existing routing unchanged (AC11) > formats an Archie PR comment byte-identically` (plus bonus `formats a plain-issue comment with the issue #N destination`) | ✓ pass |
| handler: Archie-managed PR task without a github channel → no permission lookup, exact advance dedup | `handleExistingTaskDirect — GitHub-born follow-ups (AC7) and AC11 pins > keeps the Archie-managed PR path ungated with byte-identical advance dedup (AC11)` | ✓ pass |
| handler: skip when `commentId <= last_processed_comment_id`, still no permission lookup | `handleExistingTaskDirect — GitHub-born follow-ups (AC7) and AC11 pins > keeps the Archie-managed PR skip path byte-identical, still with no permission lookup (AC11)` | ✓ pass |

All plan-named regression pins are present and passing.

## Vitest output excerpt (from `../raw/mention-routing.txt` at 04:08:27 and `../raw/mention-handler.txt` at 04:08:05)

```
 ✓ src/connectors/github/__tests__/mention-routing.test.ts > routeGitHubEvent — existing routing unchanged (AC11) > routes a mentioning comment on an Archie-managed PR to existing_task, not new_task 0ms
 ✓ src/connectors/github/__tests__/mention-routing.test.ts > routeGitHubEvent — existing routing unchanged (AC11) > routes pull_request_review approvals to merge_check byte-identically 0ms
 ✓ src/connectors/github/__tests__/mention-routing.test.ts > routeGitHubEvent — existing routing unchanged (AC11) > routes push events to merge_check byte-identically 0ms
 ✓ src/connectors/github/__tests__/mention-routing.test.ts > routeGitHubEvent — existing routing unchanged (AC11) > routes failed check_suite completions to checks_ready byte-identically 0ms
 ✓ src/connectors/github/__tests__/mention-routing.test.ts > routeGitHubEvent — existing routing unchanged (AC11) > formats an Archie PR comment byte-identically 0ms
 ✓ src/connectors/github/__tests__/mention-routing.test.ts > routeGitHubEvent — existing routing unchanged (AC11) > formats a plain-issue comment with the issue #N destination 0ms
 ✓ src/connectors/github/__tests__/mention-handler.test.ts > handleExistingTaskDirect — GitHub-born follow-ups (AC7) and AC11 pins > keeps the Archie-managed PR path ungated with byte-identical advance dedup (AC11) 2ms
 ✓ src/connectors/github/__tests__/mention-handler.test.ts > handleExistingTaskDirect — GitHub-born follow-ups (AC7) and AC11 pins > keeps the Archie-managed PR skip path byte-identical, still with no permission lookup (AC11) 2ms
```
