# E2E evidence — boot-healthy

- **Result:** PASS
- **ACs covered:** AC1
- **Terminal state:** `not_found`
- **Started:** 2026-07-04T18:52:55Z · **Finished:** 2026-07-04T18:56:34Z
- **Environment:** http://localhost:3000 · branch `forge/archie-e2e-harness` · commit `1cb2497`
- **Nonce:** `n/a (boot lifecycle step — no task)` · **Task:** `n/a (boot lifecycle step — no task)`

## Assertions

| id | description | expected | observed | pass |
|----|-------------|----------|----------|------|
| single-invocation-boots | One documented invocation (npx tsx tools/e2e/boot.ts) builds, starts detached, and waits for health | boot exits 0 after printing the resolved base URL and /health body | 'Healthy: http://localhost:3000' and '/health body: {"status":"ok","activeTasks":0}' printed; EXIT_CODE=0 | PASS |
| base-url-resolution | Base URL resolution matches the MCP (PORT from .env) | target http://localhost:3000 (PORT=3000 in .env) | boot line: 'Booting archie via `docker compose up --build -d` (target http://localhost:3000)' | PASS |
| wall-time-bounded | Healthy boot completes well within the 600s default cap | < 600s | ~3m40s from invocation to Healthy (log written 18:52:55–18:56:34 UTC; image layers cached from prior build) | PASS |

## Excerpts

### Knowledge log

```
Booting archie via `docker compose up --build -d` (target http://localhost:3000) ...
Compose up succeeded — polling http://localhost:3000/health (cap 600s) ...
Healthy: http://localhost:3000
/health body: {"status":"ok","activeTasks":0}
EXIT_CODE=0
```

### Events

```json
(none)
```

## Verdict

**PASS** — 3/3 assertions passed.
