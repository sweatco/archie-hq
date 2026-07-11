# AC5 — VERIFIED

**Method**: integration · **Run**: 2026-07-11 (cycle 2 addendum), branch `forge/github-mention-trigger` @ `05fcf1a`, vitest v4.1.10 · **QA**: black-box

**Test file**: `src/connectors/github/__tests__/mention-handler.test.ts` — run fresh via `npx vitest run src/connectors/github/__tests__/mention-handler.test.ts --reporter=verbose`. File result: 26/26 passed. Raw output: `../raw/mention-handler.txt`; full-suite run: `../test-run.txt` (904/904).

## Cycle history

- Cycle 1 (@ `d2976f9`): FAILED — the plan-named companion "ack failure does not abort creation" was absent from the file and the entire 897-test suite.
- Cycle 2 (@ `8f70930`): the missing companion was added; verdict upgraded to VERIFIED (22/22 file total).
- Cycle 2 addendum (@ `05fcf1a`): stamps/counts/excerpt refreshed (file now 26 cases after the AC2 monolith split); all AC5 cases unchanged and still passing.

## Named scenarios → cases found (exact names from vitest verbose output)

| Plan scenario | Case in output | Result |
|---|---|---|
| "acknowledges in-thread" — comment-born: `addCommentReaction(repo, commentId, 'eyes')` + `addPRComment` naming the task, no mention string | `handleGitHubMentionDirect — creation path (AC2, AC4, AC5) > acknowledges a comment mention with a comment reaction plus a task-naming comment (AC5)` | ✓ pass |
| issue-born: `addIssueReaction(repo, issueNumber, 'eyes')` instead | `handleGitHubMentionDirect — creation path (AC2, AC4, AC5) > creates and acks from an issues.opened mention, with the reaction on the issue (AC4)` | ✓ pass |
| Companion: "ack failure does not abort creation" (reaction mock throws → task still created, warn logged) | `handleGitHubMentionDirect — creation path (AC2, AC4, AC5) > does not abort creation when the ack calls throw — task, seed, and PM ping still land (AC5)` | ✓ pass |

GitHub API mocked per the brief's QA note — real-thread behavior is only proven by AC12/AC13 (AC12 remains BLOCKED; see `../AC12/evidence.md`).

## Vitest output excerpt (from `../raw/mention-handler.txt`, run at 04:08:05)

```
 ✓ src/connectors/github/__tests__/mention-handler.test.ts > handleGitHubMentionDirect — creation path (AC2, AC4, AC5) > acknowledges a comment mention with a comment reaction plus a task-naming comment (AC5) 3ms
 ✓ src/connectors/github/__tests__/mention-handler.test.ts > handleGitHubMentionDirect — creation path (AC2, AC4, AC5) > creates and acks from an issues.opened mention, with the reaction on the issue (AC4) 4ms
 ✓ src/connectors/github/__tests__/mention-handler.test.ts > handleGitHubMentionDirect — creation path (AC2, AC4, AC5) > does not abort creation when the ack calls throw — task, seed, and PM ping still land (AC5) 3ms

 Test Files  1 passed (1)
      Tests  26 passed (26)
```
