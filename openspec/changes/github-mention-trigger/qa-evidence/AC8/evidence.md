# AC8 — VERIFIED

**Method**: unit · **Run**: 2026-07-11 (cycle 2 addendum), branch `forge/github-mention-trigger` @ `05fcf1a`, vitest v4.1.10 · **QA**: black-box

**Test file**: `src/connectors/github/__tests__/mention-routing.test.ts` — run fresh, 21/21 passed. Raw output: `../raw/mention-routing.txt`; full-suite run: `../test-run.txt` (904/904).

## Named scenarios → cases found (exact names from vitest verbose output)

| Plan scenario | Case in output | Result |
|---|---|---|
| "own bot comment is discarded before detection" — author `{slug}[bot]`, ack-shaped body naming a task id AND body containing the mention string; `discard: 'Own bot event'`, no `new_task` | `routeGitHubEvent — loop safety (AC8) > discards our own bot comment (ack-shaped, mention included) as Own bot event` | ✓ pass |
| Companion: other `[bot]`-suffixed authors produce no new-task route | `routeGitHubEvent — loop safety (AC8) > skips mentions from other [bot] authors` | ✓ pass |

Related loop-safety case also present and passing: `is inert with GITHUB_APP_SLUG unset: no detection, and the self-filter is off` (claimed by AC1's "slug unset" scenario).

## Vitest output excerpt (from `../raw/mention-routing.txt`, run at 04:08:27)

```
 ✓ src/connectors/github/__tests__/mention-routing.test.ts > routeGitHubEvent — loop safety (AC8) > discards our own bot comment (ack-shaped, mention included) as Own bot event 0ms
 ✓ src/connectors/github/__tests__/mention-routing.test.ts > routeGitHubEvent — loop safety (AC8) > skips mentions from other [bot] authors 0ms

 Test Files  1 passed (1)
      Tests  21 passed (21)
```

## Cycle history

- Cycle 1 (@ `d2976f9`): VERIFIED, same cases in the then-20-case file.
- Cycle 2 addendum (@ `05fcf1a`): stamps/counts/excerpt refreshed (file now 21 cases after the AC11 push pin); AC8 cases unchanged and still passing.
