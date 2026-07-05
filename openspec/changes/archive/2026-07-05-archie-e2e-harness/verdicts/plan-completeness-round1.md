# Verdict — completeness critic, round 1

**Role:** plan-coverage verifier (fresh context). **Inputs:** brief, research dossier, plan artifacts. **Date:** 2026-07-04.

## Verdict: PASS

All ACs fully addressed with concrete, evidence-producing checks; plan internally consistent. Eight non-blocking clarifications for implementation.

### AC coverage

| AC | Design | Tasks | Verification | Verdict |
|----|--------|-------|--------------|---------|
| AC1 | Boot detached + bounded health poll, fail-fast, diagnostics | 2.1–2.4 | healthy + broken + timeout scenarios | PASS |
| AC2 | Nonce scenario via archie-debug MCP | recipes in SKILL.md, MCP untouched | basic recipe scenario | PASS |
| AC3 | approval gate detect + approve + resume | recipe documents full flow | edit-mode scenario | PASS |
| AC4 | `archie-e2e-evidence/v1` JSON + md, validated | 3.1–3.4 | schema-validated evidence + reviewer sufficiency check | PASS |
| AC6 | compose down + ps emptiness check | 4.1–4.3 | teardown scenario | PASS |
| AC7 | TS cores with injected deps, vitest plain CI | 1.2, 2.3, 3.3, 4.2 | `npm test` in CI | PASS |

### Non-blocking clarifications (fold in at revision/implementation)

1. Task 1.1: clarify whether `resolveBaseUrl(env, dotenvText)` receives `.env` pre-read (CLI does the disk read).
2. Task 2.4: mandate the `ANTHROPIC_API_KEY` preflight (design leaned yes — make it explicit).
3. Boot timeout 600s is a guess — SKILL.md documents `--timeout-seconds` tuning; revisit default after empirical measurement.
4. Task 5.3: document edit-mode scenario prerequisite (configured engineering repo in workdir) and the BLOCKED reporting shape.
5. SKILL.md: rollback note — delete `.claude/skills/archie-e2e/` + `tools/e2e/`, no side effects.
6. SKILL.md: explicit PR #71 supersede note.
7. Scenario names in recipes must exactly match evidence `scenario` field values.
8. Document the evidence-dir split: `./e2e-evidence/` local default (gitignored) vs committed `qa-evidence/` in Stage 4.

### Constraint spot-checks

Zero engine footprint, no new required env vars, CI-testable via existing vitest include, debug MCP untouched, DI for testing, self-hosting verification — all confirmed against dossier §6.
