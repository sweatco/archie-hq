# QA verdict reviewer — final ruling (round 1 + AC2 re-rule)

Blind audit of `qa-evidence/` against brief ACs + verification plan. Four test files re-run and matched byte-for-byte against recorded raw logs; all 58 quoted excerpt lines reproduce from `raw/` or `test-run.txt` at `05fcf1a` (suite 904/904).

## Final per-AC rulings

| AC | Ruling | Basis |
|----|--------|-------|
| AC1 | VERIFIED | 8 named routing cases (mention→new_task, discard, word-boundary, fenced-code, title-only, edited, slug-unset). Minor caveat: carried payload fields named collectively, not individually. |
| AC2 | VERIFIED (after re-rule) | Initially UNCONVINCING (7-field seed contract hidden in one generic case). Fixed at `05fcf1a`: 5 per-claim named cases map clause-for-clause; the split also surfaced and fixed a vacuous thread-link assertion (substring-shadowed by the comment permalink). |
| AC3 | VERIFIED | read/none discards, fail-closed lookup, creation-throw→no-ack — each named. |
| AC4 | VERIFIED | issues.opened→new_task, issue-reaction ack, redelivery-noop named; seed parity now backed by the named AC2 cases (round-1 caveat cleared). |
| AC5 | VERIFIED | Reaction + naming comment (comment-born and issue-born) + ack-failure-doesn't-abort companion (added after cycle-1 FAIL — missing case). Real-thread ack mock-proven only; AC12/AC13 own the live proof. |
| AC6 | VERIFIED | All four postToUser github scenarios named (no-drop, explicit target, throw→warn-no-escape, null-client warn). API mocked. |
| AC7 | VERIFIED | All 9 scenarios incl. the amended author gate (silent drop, watermark unchanged), [bot] pre-GET short-circuit, TTL cache, fail-closed-uncached, both dedup shapes (split after cycle-1 ambiguity). Strongest set. |
| AC8 | VERIFIED | Own-bot ack-shaped discard + other-[bot] skip. |
| AC9 | VERIFIED | Decline-once, window-expiry/eviction, authorization-before-coverage. |
| AC10 | VERIFIED | Both request tools decline fast; approval rejected; route 403 without approval:resolved; 4 Slack-born controls. |
| AC11 | VERIFIED | All pins incl. push→merge_check (added after cycle-1 FAIL — missing case), review→merge_check, failing check_suite→checks_ready, byte-identical formatGitHubEvent, no-permission-lookup + exact dedup on the Archie-PR path. |
| AC12 | WAIVED-OK (BLOCKED) | Honestly blocked: 5 GITHUB_* env keys verified absent, no designated test repo. Remedies concretely named (dev creds + covered repo → run `github-mention` recipe; manual operator run; waiver naming AC13 fallback). Correctly did not self-waive — user decision required. |
| AC13 | WAIVED-OK (deploy-only) | Post-merge operator step recorded verbatim with concrete checklist and evidence location. |

Net: **11 VERIFIED, 2 WAIVED-OK, 0 UNCONVINCING / 0 FAILED.**

## Cross-cutting

1. Black-box ceiling: evidence strength = test-name specificity (why AC2 initially failed the bar). Addressed for AC2; AC1's collective naming accepted as minor.
2. Stale-stamp integrity concern (6 cycle-1 files with irreproducible counts): CLEARED — all 14 files re-stamped at `05fcf1a`, every count matches regenerated logs; old SHAs remain only in honest cycle-history lines.
3. Real-thread behavior (AC5/AC6 surfaces) is mock-proven pre-merge by design; hinges on the named AC12/AC13 path being executed.
4. Disclosed open items: `npm run build` not run by QA (run by the implement-stage gate instead); the slug-unset boot warning has no unit assertion and was unobservable without the AC12 boot.

## QA cycle history

- Cycle 1: AC5 + AC11 FAILED (plan-named cases missing from the suite — missing-case failures, all 897 tests green); AC7 naming ambiguity. Routed back to implement.
- Fix `8f70930`: 3 cases added, each mutation-proven load-bearing (watermark mutation failed only the new shape — split pins two distinct guards). Suite 900.
- Cycle 2: AC5/AC7/AC11 VERIFIED; reviewer ruled AC2 UNCONVINCING (granularity) + flagged stale stamps.
- Fix `05fcf1a`: AC2 split into 5 per-claim cases (mutation matrix incl. a strengthened vacuous link assertion). Suite 904. Evidence re-stamped.
- Re-rule: AC2 VERIFIED, integrity cleared, AC4 caveat cleared.
