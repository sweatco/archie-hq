# AC1 — VERIFIED

**Method**: unit · **Run**: 2026-07-11 (cycle 2 addendum), branch `forge/github-mention-trigger` @ `05fcf1a`, vitest v4.1.10 · **QA**: black-box (test names/output only, no source read)

**Test file**: `src/connectors/github/__tests__/mention-routing.test.ts` — run fresh via `npx vitest run src/connectors/github/__tests__/mention-routing.test.ts --reporter=verbose`. File result: 21/21 passed. Full raw output: `../raw/mention-routing.txt`; full-suite run: `../test-run.txt` (904/904).

## Named scenarios → cases found (exact names from vitest verbose output)

| Plan scenario | Case in output | Result |
|---|---|---|
| "mention in issue_comment.created with no resolving task → new_task with repo/number/commentId/author" | `routeGitHubEvent — mention detection (AC1) > routes a mentioning issue_comment.created with no resolving task to new_task` | ✓ pass |
| "no mention → discarded exactly as today" (byte-identical discard reason) | `routeGitHubEvent — mention detection (AC1) > discards a comment without a mention exactly as today` | ✓ pass |
| word boundary: `@slug-other` no match | `routeGitHubEvent — mention detection (AC1) > does not route @slug-other (word boundary) to new_task` | ✓ pass |
| word boundary: `@slug!` / case-insensitive match | `matchesMention — word boundaries > accepts trailing punctuation and end-of-line, case-insensitively` (plus `rejects prefix collisions and embedded slugs`) | ✓ pass |
| mention inside fenced code block → detected (accepted parity) | `routeGitHubEvent — mention detection (AC1) > detects a mention inside a fenced code block (markdown-unaware, accepted parity)` | ✓ pass |
| mention only in issue title → not detected | `routeGitHubEvent — mention detection (AC1) > does not trigger on a mention appearing only in the issue title` | ✓ pass |
| `issue_comment.edited` with edited-in mention → not routed | `routeGitHubEvent — mention detection (AC1) > never triggers on issue_comment.edited, even with a newly edited-in mention` | ✓ pass |
| "slug unset → no mention detected" | `routeGitHubEvent — loop safety (AC8) > is inert with GITHUB_APP_SLUG unset: no detection, and the self-filter is off` | ✓ pass |

Note: the plan's quoted labels are scenario descriptions; the vitest case names above are close, unambiguous matches (no exact-string test names were promised by the plan format).

## Vitest output excerpt (from `../raw/mention-routing.txt`, run at 04:08:27)

```
 ✓ src/connectors/github/__tests__/mention-routing.test.ts > matchesMention — word boundaries > rejects prefix collisions and embedded slugs 1ms
 ✓ src/connectors/github/__tests__/mention-routing.test.ts > matchesMention — word boundaries > accepts trailing punctuation and end-of-line, case-insensitively 0ms
 ✓ src/connectors/github/__tests__/mention-routing.test.ts > routeGitHubEvent — mention detection (AC1) > routes a mentioning issue_comment.created with no resolving task to new_task 1ms
 ✓ src/connectors/github/__tests__/mention-routing.test.ts > routeGitHubEvent — mention detection (AC1) > discards a comment without a mention exactly as today 0ms
 ✓ src/connectors/github/__tests__/mention-routing.test.ts > routeGitHubEvent — mention detection (AC1) > does not route @slug-other (word boundary) to new_task 0ms
 ✓ src/connectors/github/__tests__/mention-routing.test.ts > routeGitHubEvent — mention detection (AC1) > detects a mention inside a fenced code block (markdown-unaware, accepted parity) 0ms
 ✓ src/connectors/github/__tests__/mention-routing.test.ts > routeGitHubEvent — mention detection (AC1) > does not trigger on a mention appearing only in the issue title 0ms
 ✓ src/connectors/github/__tests__/mention-routing.test.ts > routeGitHubEvent — mention detection (AC1) > never triggers on issue_comment.edited, even with a newly edited-in mention 0ms
 ✓ src/connectors/github/__tests__/mention-routing.test.ts > routeGitHubEvent — loop safety (AC8) > is inert with GITHUB_APP_SLUG unset: no detection, and the self-filter is off 0ms

 Test Files  1 passed (1)
      Tests  21 passed (21)
```

## Cycle history

- Cycle 1 (@ `d2976f9`): VERIFIED, 20/20 in the file.
- Cycle 2 addendum (@ `05fcf1a`): stamps/counts/excerpt refreshed after the file gained the AC11 push pin (now 21/21); AC1 cases unchanged and still passing.
