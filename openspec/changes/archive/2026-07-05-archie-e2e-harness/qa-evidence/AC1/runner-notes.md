# AC1 runner notes — boot from branch (healthy + broken)

**Runner:** black-box QA (Forge Stage 4), 2026-07-04. Branch `forge/archie-e2e-harness` @ `1cb2497`. Specs used: brief.md, verification-plan.md, SKILL.md only (implementation not read).

## Healthy path

Command (SKILL.md §1, exactly as documented):

```
npx tsx tools/e2e/boot.ts
```

Output (key lines) and exit code:

```
Booting archie via `docker compose up --build -d` (target http://localhost:3000) ...
Compose up succeeded — polling http://localhost:3000/health (cap 600s) ...
Healthy: http://localhost:3000
/health body: {"status":"ok","activeTasks":0}
EXIT_CODE=0
```

Wall time: **≈3m40s** (19:52:55 → 19:56:34 UTC+1) with docker image layers cached from a 3-day-old build; this is effectively a warm-image boot dominated by container startup (npm deps + plugin/repo bootstrap). No true cold (no-cache) boot was timed. A stale `Exited (1)` container from 3 days ago was present before boot; boot recreated it as documented.

Assertions: single documented invocation → healthy report with resolved base URL + /health body (PASS); base URL matched .env `PORT=3000` (PASS); exit 0 (PASS).

### Environment caveat (machine issue, not the harness)

The very first boot attempt on this machine wedged inside `docker compose up --build` because macOS `docker-credential-desktop get` hung indefinitely (reproduced standalone: a direct `docker-credential-desktop get` call also hung past a 10s timeout). Worked around by pointing `DOCKER_CONFIG` at a scratch config (no credsStore, anonymous registry metadata) + explicit `DOCKER_HOST` for the successful runs. The user's `~/.docker/config.json` was **not** modified. Two harness-relevant observations:

1. The boot's bounded-wait guarantee covers the health-poll phase (cap) and compose-up exit codes — but a registry/credential hang **inside** `docker compose up --build` is upstream of both and can stall the boot indefinitely. AC1's "broken branch fails clearly, not a hang" still holds (branch content wasn't the cause), but operators on Docker Desktop may want this failure mode noted in SKILL.md's prerequisites.
2. During the workaround detour, a run with an unreachable daemon produced exactly the documented behavior: compose-up failure trapped, diagnostics block printed, exit 1, zero health polls.

## Broken paths (all run after final teardown; repo state restored after each)

1. **`.env` absent** (temporarily renamed, restored immediately): `preflight failed: .env not found at the repo root — copy .env.example and set ANTHROPIC_API_KEY`, exit 1, returned in seconds, no compose invocation. PASS.
2. **`ANTHROPIC_API_KEY` emptied** (sed on .env, restored from backup, restore verified): `preflight failed: ANTHROPIC_API_KEY is missing or empty in .env`, exit 1, no compose invocation. PASS.
3. **Bounded poll failure** (`--timeout-seconds 15` against the just-torn-down project — app needs ~40s+ to serve): `Boot failed (timeout): /health did not return 200 within 15s (last: GET /health failed: fetch failed)` followed by the documented diagnostics block (`docker compose ps` table + last-100-line archie log tail), exit 1 — returned at the cap, no hang. Containers started by this negative test were removed by a follow-up `teardown.ts` run (clean, exit 0). PASS.

## Harness-written evidence

`boot-healthy.{json,md}` and `boot-broken.{json,md}` in this directory, both produced by `npx tsx tools/e2e/evidence.ts` (see AC4 notes for a schema-fit observation about non-task lifecycle steps).

## Verdict: PASS
