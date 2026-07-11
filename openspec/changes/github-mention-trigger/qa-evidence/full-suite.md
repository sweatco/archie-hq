# Full-suite run — github-mention-trigger QA

**Run**: 2026-07-11, QA cycle 2 addendum, branch `forge/github-mention-trigger` @ `05fcf1a`, vitest v4.1.10 · Command: `npm test` · Full output captured to `test-run.txt` (this directory, per the verification plan's evidence location).

## Totals (cycle 2 addendum, current)

```
 Test Files  67 passed (67)
      Tests  904 passed (904)
   Start at  04:09:05
   Duration  3.26s (transform 2.66s, setup 0ms, import 10.86s, tests 4.45s, environment 4ms)
```

No failures, no skips reported in the summary. Zero flaky reruns across all cycles — every run passed on the first attempt.

## Cycle history

- Cycle 1 (@ `d2976f9`): 67 files / 897 tests, all passing, but two plan-named cases were missing (AC5 ack-failure companion; AC11 push→merge_check pin) and one AC7 dedup case name was ambiguous.
- Cycle 2 (@ `8f70930`): the three cases were added/split (897 → 900); AC5/AC7/AC11 re-verified.
- Cycle 2 addendum (@ `05fcf1a`): the AC2 monolith was split into 5 per-claim named cases (900 → 904); AC2 re-verified against the split, and ALL evidence files' stamps/counts/excerpts were refreshed to this commit so every quoted line reproduces from `raw/` or `test-run.txt`. Key case lines in `test-run.txt`: AC2 split cases at 241-245, AC5 ack-failure companion at 248, AC7 dedup pair at 305-306, AC11 push pin at 489.

## Per-named-file fresh runs (all `--reporter=verbose` at `05fcf1a`, raw output under `raw/`)

| File | Result |
|---|---|
| `src/connectors/github/__tests__/mention-handler.test.ts` | 26/26 passed (`raw/mention-handler.txt`, run at 04:08:05) |
| `src/connectors/github/__tests__/mention-routing.test.ts` | 21/21 passed (`raw/mention-routing.txt`, run at 04:08:27) |
| `src/tasks/__tests__/github-channel.test.ts` | 12/12 passed (`raw/github-channel.txt`, run at 04:08:38) |
| `src/agents/__tests__/readonly-github.test.ts` | 11/11 passed (`raw/readonly-github.txt`, run at 04:08:52) |

## Cross-cutting gates (verification plan, last paragraph)

- `npm test` green — ✓ (904/904 above).
- `npm run typecheck` green — ✓ (`tsc --noEmit`, exit 0, re-run at `05fcf1a`).
- `npm run build` — not run by QA: it writes `dist/`, and this QA session is confined to writing under `qa-evidence/` only. Left to the implementer/CI.
- Boot warning for set `GITHUB_WEBHOOK_SECRET` with unset `GITHUB_APP_SLUG` — not observed: the AC12 boot did not happen (BLOCKED), and no targeted unit assertion for this warning is identifiable by name in the suite output. Outstanding alongside AC12.
- `lifecycle.test.ts` summary-links gate — ✓ present and passing in the full run (`test-run.txt` line 924): `src/memory/__tests__/lifecycle.test.ts > buildSummaryMarkdown — github links > renders /pull/ and /issues/ URLs from is_pr on github channels`.
- Docs tasks (9.1-9.2) present in the diff — not checked: black-box QA does not read the diff.
