# E2E evidence — boot-broken

- **Result:** PASS
- **ACs covered:** AC1
- **Terminal state:** `not_found`
- **Started:** 2026-07-04T19:05:30Z · **Finished:** 2026-07-04T19:10:30Z
- **Environment:** http://localhost:3000 · branch `forge/archie-e2e-harness` · commit `1cb2497`
- **Nonce:** `n/a (boot lifecycle step — no task)` · **Task:** `n/a (boot lifecycle step — no task)`

## Assertions

| id | description | expected | observed | pass |
|----|-------------|----------|----------|------|
| preflight-missing-env | Boot with no .env at the repo root fails immediately, naming the missing item, with no compose invocation | non-zero exit, clear message, instant return | 'preflight failed: .env not found at the repo root — copy .env.example and set ANTHROPIC_API_KEY'; EXIT_CODE=1; returned in seconds; no compose output | PASS |
| preflight-empty-key | Boot with ANTHROPIC_API_KEY emptied in .env fails immediately, naming the key | non-zero exit naming ANTHROPIC_API_KEY | 'preflight failed: ANTHROPIC_API_KEY is missing or empty in .env'; EXIT_CODE=1; no compose invocation | PASS |
| poll-cap-bounded | A non-serving state with --timeout-seconds 15 fails at the cap with diagnostics instead of hanging | 'Boot failed (timeout)' at ~15s, diagnostics block (compose ps + log tail), non-zero exit | 'Boot failed (timeout): /health did not return 200 within 15s (last: GET /health failed: fetch failed)' followed by '--- diagnostics: docker compose ps ---' and the 100-line archie log tail; EXIT_CODE=1 | PASS |

## Excerpts

### Knowledge log

```
preflight failed: .env not found at the repo root — copy .env.example and set ANTHROPIC_API_KEY
EXIT_CODE=1
preflight failed: ANTHROPIC_API_KEY is missing or empty in .env
EXIT_CODE=1
Booting archie via `docker compose up --build -d` (target http://localhost:3000) ...
Compose up succeeded — polling http://localhost:3000/health (cap 15s) ...
Boot failed (timeout): /health did not return 200 within 15s (last: GET /health failed: fetch failed)
--- diagnostics: docker compose ps ---
--- diagnostics: archie logs (last 100 lines) ---
--- end diagnostics ---
EXIT_CODE=1
```

### Events

```json
(none)
```

## Verdict

**PASS** — 3/3 assertions passed.
