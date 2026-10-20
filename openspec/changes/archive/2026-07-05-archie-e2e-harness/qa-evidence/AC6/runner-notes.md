# AC6 runner notes — teardown leaves no containers

**Runner:** black-box QA (Forge Stage 4), 2026-07-04. Branch `forge/archie-e2e-harness` @ `1cb2497`.

## Command run (SKILL.md §4, exactly as documented)

```
npx tsx tools/e2e/teardown.ts
```

Run immediately after the AC2/AC3 scenario session. Output:

```
Tearing down via `docker compose down` ...
 Container archie-hq-archie-1  Stopping → Stopped → Removing → Removed
 Network archie-hq_default  Removing → Removed
Teardown clean: `docker compose ps --all` reports no containers for this project.
EXIT_CODE=0
```

## Independent confirmation (outside the harness)

```
$ docker compose ps --all
NAME      IMAGE     COMMAND   SERVICE   CREATED   STATUS    PORTS      # header only — empty
$ docker ps --all --filter name=archie-hq --format '{{.Names}} {{.Status}}'
                                                                       # empty
```

Note the pre-existing 3-day-old `Exited (1)` container was recreated by the boot and removed by this teardown — `--all` shows nothing, i.e. no stopped-but-not-removed survivors either.

Teardown was run a second time after AC1's bounded-timeout negative test (which starts containers by design); it exited 0 with the same confirmation line, and a final `docker compose ps --all` was again header-only. End state of the whole QA session: no project containers.

## Verdict: PASS

Harness-written evidence: `teardown-clean.{json,md}` in this directory (written via `npx tsx tools/e2e/evidence.ts`).
