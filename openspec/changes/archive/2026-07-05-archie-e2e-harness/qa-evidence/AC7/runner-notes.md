# AC7 runner notes — unit coverage of harness helpers (plain CI, no docker)

**Runner:** black-box QA (Forge Stage 4), 2026-07-04. Branch `forge/archie-e2e-harness` @ `1cb2497`.

## Command run

```
npm test
```

Run once, locally, with no docker dependency (docker was concurrently busy building the boot image; the suite neither required nor touched it). Exit code **0**.

## Output evidence (trimmed)

```
 Test Files  40 passed (40)
      Tests  592 passed (592)
   Duration  3.10s
```

Harness test files present in the run, with case counts (every case reported `✓`):

| File | Cases | Coverage themes observed in case names |
|---|---|---|
| `tools/e2e/config.test.ts` | 9 | base-URL precedence (ARCHIE_URL → PORT env → .env PORT → default), PORT parsing, timeout override chain (flag beats env beats default, loud rejection of invalid values) |
| `tools/e2e/boot.test.ts` | 22 | healthy poll, fail-fast on exited/restart-looping/missing container, cap expiry, diagnostics rendering, preflight (.env / ANTHROPIC_API_KEY), orchestration ordering (failed compose-up → zero /health fetches), arg parsing |
| `tools/e2e/evidence.test.ts` | 24 | schema validation (missing assertions, inconsistent result, unknown terminal_state, wrong schema tag, unsafe scenario name), markdown render, truncated-vs-invalid stdin classification, all-or-nothing writes, transactional pair rollback |
| `tools/e2e/teardown.test.ts` | 9 | compose-ps parsing (clean / NDJSON / array / malformed), survivor naming with non-zero exit, failed compose-down surfacing, unverifiable ps treated as failure |

These match the four files the verification plan names for AC7 (`config.test.ts`, `boot.test.ts`, `evidence.test.ts`, `teardown.test.ts`) and cover the plan's named behaviors (URL/timeout precedence; healthy / fail-fast / cap / diagnostics; schema validation, inconsistent-result rejection, markdown render; compose-ps parsing clean / survivor / malformed).

## Assertions checked

1. `npm test` exits 0 with no docker required — PASS (exit code 0; suite is vitest, ran during a concurrent docker build without interaction).
2. All four harness helper test files exist in the suite and pass — PASS (9 + 22 + 24 + 9 = 64 harness cases, all green).
3. Case names evidence coverage of the non-trivial helpers (boot, evidence writer, teardown, config resolution) — PASS.

Note: per instructions this AC records the test-run evidence only; no implementation analysis was performed (blindness rules — `tools/e2e/*.ts` sources not read).

## Verdict: PASS
