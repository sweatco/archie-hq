# AC6 — VERIFIED

**Method**: integration · **Run**: 2026-07-11 (cycle 2 addendum), branch `forge/github-mention-trigger` @ `05fcf1a`, vitest v4.1.10 · **QA**: black-box

**Test file**: `src/tasks/__tests__/github-channel.test.ts` — run fresh via `npx vitest run src/tasks/__tests__/github-channel.test.ts --reporter=verbose`. File result: 12/12 passed. Raw output: `../raw/github-channel.txt`; full-suite run: `../test-run.txt` (904/904).

## Named scenarios → cases found (exact names from vitest verbose output)

| Plan scenario | Case in output | Result |
|---|---|---|
| "PM message lands on the originating thread" — `addPRComment` with message + footer, `github:{repo}#{n}` destination logged, "message dropped" warn never fires | `postToUser — github channel > posts to the originating thread via the default github channel, never the dropped path (AC6)` | ✓ pass |
| explicit `target.channel` github delivery | `postToUser — github channel > delivers to an explicitly targeted github channel` | ✓ pass |
| `addPRComment` throws (locked issue / rate limit) → warn logged, no exception escapes `postToUser` (D7) | `postToUser — github channel > warns and continues when addPRComment throws` | ✓ pass |
| unconfigured client → warn, not silent null | `postToUser — github channel > warns (not silent null) when the GitHub client is unconfigured` | ✓ pass |

GitHub API mocked per the brief's QA note — real-thread behavior is only proven by AC12/AC13 (AC12 remains BLOCKED; see `../AC12/evidence.md`). Bonus case beyond the plan: `postFilesToUser warns that files are dropped on a github channel` — ✓ pass.

## Vitest output excerpt (from `../raw/github-channel.txt`, run at 04:08:38)

```
 ✓ src/tasks/__tests__/github-channel.test.ts > postToUser — github channel > posts to the originating thread via the default github channel, never the dropped path (AC6) 2ms
 ✓ src/tasks/__tests__/github-channel.test.ts > postToUser — github channel > delivers to an explicitly targeted github channel 1ms
 ✓ src/tasks/__tests__/github-channel.test.ts > postToUser — github channel > warns and continues when addPRComment throws 1ms
 ✓ src/tasks/__tests__/github-channel.test.ts > postToUser — github channel > warns (not silent null) when the GitHub client is unconfigured 1ms

 Test Files  1 passed (1)
      Tests  12 passed (12)
```

## Cycle history

- Cycle 1 (@ `d2976f9`): VERIFIED, 12/12.
- Cycle 2 addendum (@ `05fcf1a`): fresh re-run at the current commit; identical case set, 12/12, excerpt refreshed to the current raw log.
