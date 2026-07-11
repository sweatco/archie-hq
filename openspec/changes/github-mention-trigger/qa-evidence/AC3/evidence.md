# AC3 — VERIFIED

**Method**: unit · **Run**: 2026-07-11 (cycle 2 addendum), branch `forge/github-mention-trigger` @ `05fcf1a`, vitest v4.1.10 · **QA**: black-box

**Test file**: `src/connectors/github/__tests__/mention-handler.test.ts` — run fresh, 26/26 passed. Raw output: `../raw/mention-handler.txt`; full-suite run: `../test-run.txt` (904/904).

## Named scenarios → cases found (exact names from vitest verbose output)

| Plan scenario | Case in output | Result |
|---|---|---|
| "read/none author → discarded silently" — permission `read` | `handleGitHubMentionDirect — gates (AC3, AC9) > discards a read-permission author: no task, no reply, no reaction, reason logged (AC3)` | ✓ pass |
| "read/none author → discarded silently" — permission `none` | `handleGitHubMentionDirect — gates (AC3, AC9) > discards a none-permission author: no task, no reply, no reaction, reason logged (AC3)` | ✓ pass |
| "permission lookup throws → fail-closed discard, nothing posted" | `handleGitHubMentionDirect — gates (AC3, AC9) > fails closed when the permission lookup throws` | ✓ pass |
| "creation throws after the permission gate → error logged, no ack comment posted" | `handleGitHubMentionDirect — gates (AC3, AC9) > logs and posts no ack when creation throws after the permission gate` | ✓ pass |

Bonus case present beyond the plan: `fails closed when the GitHub client is unconfigured` — ✓ pass.

## Vitest output excerpt (from `../raw/mention-handler.txt`, run at 04:08:05)

```
 ✓ src/connectors/github/__tests__/mention-handler.test.ts > handleGitHubMentionDirect — gates (AC3, AC9) > discards a read-permission author: no task, no reply, no reaction, reason logged (AC3) 1ms
 ✓ src/connectors/github/__tests__/mention-handler.test.ts > handleGitHubMentionDirect — gates (AC3, AC9) > discards a none-permission author: no task, no reply, no reaction, reason logged (AC3) 1ms
 ✓ src/connectors/github/__tests__/mention-handler.test.ts > handleGitHubMentionDirect — gates (AC3, AC9) > fails closed when the permission lookup throws 0ms
 ✓ src/connectors/github/__tests__/mention-handler.test.ts > handleGitHubMentionDirect — gates (AC3, AC9) > logs and posts no ack when creation throws after the permission gate 1ms

 Test Files  1 passed (1)
      Tests  26 passed (26)
```

## Cycle history

- Cycle 1 (@ `d2976f9`): VERIFIED, same four cases in the then-20-case file.
- Cycle 2 addendum (@ `05fcf1a`): stamps/counts/excerpt refreshed (file now 26 cases after the AC5/AC7/AC2 additions and split); AC3 cases unchanged and still passing.
