# Stage 4 — QA

**Purpose:** black-box verification of the acceptance criteria against a live instance, by roles that have never seen the code.

**Inputs for QA roles:** ONLY `brief.md` (the ACs) and `verification-plan.md`. Not the diff, not the design, not this conversation. This blindness is the point.

## Preflight

Check what's available in this environment:

- The **E2E harness skill** (look for `.claude/skills/archie-e2e/` or a successor named in `verification-plan.md`). Until it exists, `live-e2e` ACs cannot be machine-verified — see Degradation below.
- **Docker**: `docker compose version` works and a `.env` with the required keys exists.
- The **archie-debug MCP** (`.mcp.json` → `archie-debug`).

## Procedure (when live QA is possible)

Spawn the **QA runner**, fresh-context:

> You are a black-box QA engineer. Inputs: the acceptance criteria and the verification plan; the archie-debug MCP; docker. You have NOT seen the implementation and must not read the diff. For each AC with method `live-e2e` or `integration`: (1) boot the system under test from this branch (`docker compose up --build -d`, wait for `/health` healthy; prefer the cheap-model env preset if the repo defines one); (2) execute the plan's scenario — plant a nonce in the task message, `create_task`, `wait_for_task`, approve edit mode via `approve` when the gate fires, read the knowledge log and events; (3) record evidence per AC into `qa-evidence/<AC-id>/` — the exact assertions checked, event/log excerpts, pass/fail. `unit`/`integration` ACs already covered by the suite: record the test file + case name as evidence. Tear down when done (`docker compose down`). Report per-AC: VERIFIED (evidence attached) / FAILED (repro attached) / BLOCKED (say what's missing).

Then spawn the **QA verdict reviewer**, fresh-context:

> You audit QA evidence. Inputs: acceptance criteria, verification plan, `qa-evidence/`. For each AC, judge whether the recorded evidence actually demonstrates the criterion — not whether the runner says it does. Rule each: VERIFIED / UNCONVINCING (evidence doesn't show what's claimed) / WAIVED-OK (a declared waiver with a credible named post-merge step). Verdict to `verdicts/qa-reviewer-round1.md`.

FAILED or UNCONVINCING ACs route back to Stage 3 with the failing scenario attached (set `stage: implement` and reset `stage_rounds.implement` to 0 — new findings, fresh review budget). At most 2 QA cycles per run; a third failure goes to the user. Keep the failing scenario: copy it into `qa-evidence/regressions/` — future runs replay these.

**Mapping onto `forge.yaml` statuses** (the only vocabulary that persists): runner VERIFIED + reviewer VERIFIED → `verified`; suite-covered (a named test case exists — this also settles `integration` ACs that the suite already exercises; otherwise the runner executes them) → `verified` with the test name as evidence; runner BLOCKED or reviewer WAIVED-OK → `waived` with the named step; runner FAILED or reviewer UNCONVINCING → `failed` (routes back). ACs with method `manual` → ask the user to perform the check now, else `waived` with the step named. `deploy-only` → `waived`.

## Degradation (no harness / no docker / no keys)

Do not fake it. For each AC that cannot be machine-verified here, set `status: waived` in `forge.yaml` with a **named** verification step ("run scenario X after deploy", "verify on local docker via Y") in `evidence`. Waivers surface verbatim in the PR's verification manifest — the existing house convention of candor, as structured output. If EVERY live AC is waived, say so plainly to the user before shipping.

## Exit criteria

Every AC is verified / waived-with-named-step / covered-by-suite, and the verdict reviewer signed off on the evidence. Update AC statuses in `forge.yaml`, commit evidence + verdicts, set `stage: ship`.
