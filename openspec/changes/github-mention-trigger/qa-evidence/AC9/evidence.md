# AC9 — VERIFIED

**Method**: unit · **Run**: 2026-07-11 (cycle 2 addendum), branch `forge/github-mention-trigger` @ `05fcf1a`, vitest v4.1.10 · **QA**: black-box

**Test file**: `src/connectors/github/__tests__/mention-handler.test.ts` — run fresh, 26/26 passed. Raw output: `../raw/mention-handler.txt`; full-suite run: `../test-run.txt` (904/904).

## Named scenarios → cases found (exact names from vitest verbose output)

| Plan scenario | Case in output | Result |
|---|---|---|
| "authorized mention in an undeclared repo declines politely" — exactly one `addPRComment` with mention-free decline text, no task dir; second authorized mention within the window posts no second decline | `handleGitHubMentionDirect — gates (AC3, AC9) > declines once for two authorized mentions on an uncovered repo within the window (AC9)` (single case covering both the polite decline and the in-window dedup) | ✓ pass |
| mention after the window elapses posts a fresh decline — expiry + lazy eviction (D5) | `handleGitHubMentionDirect — gates (AC3, AC9) > posts a fresh decline after the dedup window elapses (expiry + lazy eviction)` | ✓ pass |
| unauthorized author in an undeclared repo → nothing posted (authorization precedes coverage) | `handleGitHubMentionDirect — gates (AC3, AC9) > stays silent for an unauthorized mention in an uncovered repo (authorization first)` | ✓ pass |

Note: the plan's primary ("declines politely") and its first companion (in-window dedup) are folded into one case whose name asserts both — "declines once" entails the polite decline being posted.

## Vitest output excerpt (from `../raw/mention-handler.txt`, run at 04:08:05)

```
 ✓ src/connectors/github/__tests__/mention-handler.test.ts > handleGitHubMentionDirect — gates (AC3, AC9) > declines once for two authorized mentions on an uncovered repo within the window (AC9) 1ms
 ✓ src/connectors/github/__tests__/mention-handler.test.ts > handleGitHubMentionDirect — gates (AC3, AC9) > posts a fresh decline after the dedup window elapses (expiry + lazy eviction) 1ms
 ✓ src/connectors/github/__tests__/mention-handler.test.ts > handleGitHubMentionDirect — gates (AC3, AC9) > stays silent for an unauthorized mention in an uncovered repo (authorization first) 0ms

 Test Files  1 passed (1)
      Tests  26 passed (26)
```

## Cycle history

- Cycle 1 (@ `d2976f9`): VERIFIED, same three cases in the then-20-case file.
- Cycle 2 addendum (@ `05fcf1a`): stamps/counts/excerpt refreshed (file now 26 cases); AC9 cases unchanged and still passing.
