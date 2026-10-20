# E2E evidence — teardown-clean

- **Result:** PASS
- **ACs covered:** AC6
- **Terminal state:** `not_found`
- **Started:** 2026-07-04T19:04:10Z · **Finished:** 2026-07-04T19:04:40Z
- **Environment:** http://localhost:3000 · branch `forge/archie-e2e-harness` · commit `1cb2497`
- **Nonce:** `n/a (teardown lifecycle step — no task)` · **Task:** `n/a (teardown lifecycle step — no task)`

## Assertions

| id | description | expected | observed | pass |
|----|-------------|----------|----------|------|
| teardown-confirmation | Documented invocation (npx tsx tools/e2e/teardown.ts) stops everything and prints the confirmation line | 'Teardown clean: `docker compose ps --all` reports no containers for this project.' and exit 0 | exact confirmation line printed after container+network removal; EXIT_CODE=0 (run twice in the session — after the scenario session and after the broken-boot check — both clean) | PASS |
| independent-ps-empty | Independent `docker compose ps --all` shows no project containers | empty table (header only) | header-only output from `docker compose ps --all` run by the QA runner outside the harness; `docker ps --all --filter name=archie-hq` also empty — including the pre-existing 3-day-old exited container, which the boot replaced and down removed | PASS |

## Excerpts

### Knowledge log

```
Tearing down via `docker compose down` ...
 Container archie-hq-archie-1  Stopping
 Container archie-hq-archie-1  Stopped
 Container archie-hq-archie-1  Removing
 Container archie-hq-archie-1  Removed
 Network archie-hq_default  Removing
 Network archie-hq_default  Removed
Teardown clean: `docker compose ps --all` reports no containers for this project.
EXIT_CODE=0
--- final teardown after broken-boot check ---
Tearing down via `docker compose down` ...
 Container archie-hq-archie-1  Stopping
 Container archie-hq-archie-1  Stopped
 Container archie-hq-archie-1  Removing
 Container archie-hq-archie-1  Removed
 Network archie-hq_default  Removing
 Network archie-hq_default  Removed
Teardown clean: `docker compose ps --all` reports no containers for this project.
EXIT_CODE=0
```

### Events

```json
(none)
```

## Verdict

**PASS** — 2/2 assertions passed.
