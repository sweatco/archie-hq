# Verdict — research verifier, round 1

**Role:** adversarial fact-checker (fresh context). **Input:** `research.md` + repo read access. **Date:** 2026-07-04.

**Result: 60 CONFIRMED / 6 WRONG / 2 UNVERIFIABLE** out of 68 claims examined. All substantive technical facts held; defects were date errors and citation imprecision.

## WRONG (fixed in research.md after this verdict)

1. PR #158 merge date — claimed 2026-06-30, actually 2026-07-01 (commit `220e55a`). Fixed.
2. Task status type citation — claimed `src/types/task.ts:93-109,194`; `TaskStatus` is actually at `src/types/task.ts:5`. Fixed.
3. Key-events list omitted `task:resumed` (defined at `src/system/event-bus.ts:11`). Added.
4. Dockerfile.dev user-creation citation — claimed `:41-47`, actual `:42-43`. Fixed.
5. Model-defaults citation — substance correct, definition is at `src/agents/model-label.ts:28`. Fixed.
6. PR #71 opened date flagged unverifiable-from-git — orchestrator re-verified via `gh pr view 71 --json createdAt` → `2026-06-03T14:23:26Z`. Claim stands, upgraded to CONFIRMED.

## UNVERIFIABLE → re-checked by orchestrator

- `docs/proposals/forge.md:106,127` citations — re-verified by grep: line 106 (E2E harness skill) and line 127 (debug MCP as Stage 4 driver) exact. CONFIRMED.
- Open PR/issue orthogonality (#63, #172, #173, #176, #50, #160) — sourced from `gh pr list`/`gh issue list` during the prior-art lens run; verifier had no metadata access. Kept, marked as gh-sourced.

## Bonus finding

- `npm run docker:dev` EXISTS on main: `package.json:23` → `docker compose up --build` — note: **without `-d`** (foreground). The brief's "docker compose up --build -d" invocation differs; harness must use `-d` explicitly or its own wrapper. Added to research.md.

All CONFIRMED-only content retained; dossier updated accordingly.
