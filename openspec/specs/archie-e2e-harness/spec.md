# archie-e2e-harness Specification

## Purpose
TBD - created by archiving change archie-e2e-harness. Update Purpose after archive.
## Requirements
### Requirement: Boot a live instance from a branch checkout with a bounded health wait

The harness SHALL provide a single documented invocation that, from a checkout of any branch with a valid `.env`, starts the instance detached (`docker compose up --build -d`) and waits for `GET /health` to return 200. The invocation SHALL run a strict ordered sequence: preflight (`.env` exists, `ANTHROPIC_API_KEY` non-empty) → compose up with the exit code trapped → health poll only after compose-up succeeds; a failed compose-up SHALL print diagnostics and exit non-zero before any health polling occurs. The wait SHALL be bounded by a finite default cap, overridable per invocation, and SHALL never hang: a branch whose container exits or restart-loops fails fast before the cap, and any failure prints clear diagnostics (compose `ps` state plus a bounded log tail) and exits non-zero. The base URL SHALL be resolved with the same precedence the archie-debug MCP uses (`ARCHIE_URL` → `PORT` env → `.env` PORT → `http://localhost:3000`).

#### Scenario: Healthy boot

- **WHEN** the boot command runs on a branch that builds and serves `/health`
- **THEN** it returns success, reporting the resolved base URL and the `/health` response body

#### Scenario: Compose up fails — no polling

- **WHEN** `docker compose up --build -d` exits non-zero
- **THEN** the command prints the diagnostics block and exits non-zero without a single `/health` poll, spending none of the wait cap

#### Scenario: Broken branch fails clearly, not by hanging

- **WHEN** the booted container exits or restart-loops before `/health` ever succeeds
- **THEN** the command fails before the wait cap with a non-zero exit and diagnostics containing the compose `ps` state and a log tail

#### Scenario: Wait cap reached

- **WHEN** the container stays up but `/health` never returns 200 within the cap
- **THEN** the command exits non-zero at the cap with the same diagnostics block, and the cap is overridable via a flag or optional env var

### Requirement: Drive scenarios headlessly via the archie-debug MCP

The harness SHALL drive scenarios through the existing archie-debug MCP without modifying it: plant a high-entropy nonce in the task message, create the task with `create_task`, correlate and wait with `wait_for_task` by nonce (resuming via cursor while pending), and read the knowledge log and events for assertions. A scenario run SHALL yield the task's terminal state and its knowledge log.

#### Scenario: Basic nonce scenario reaches a terminal state

- **WHEN** a scenario creates a task containing a fresh nonce and waits via `wait_for_task`
- **THEN** the run returns the correlated task id, its terminal state, and the knowledge log content for assertion

#### Scenario: Debug MCP is consumed unchanged

- **WHEN** the harness is added to the repo
- **THEN** no file under `tools/debug-mcp/` changes and the MCP remains import-free from `src/`

### Requirement: Handle the edit-mode approval gate

When a scenario's task reaches `approval_requested`, the harness SHALL approve it through the API path (the MCP `approve` tool over `POST /api/tasks/:id/approve`) and continue waiting, observing the task proceed to completion.

#### Scenario: Edit-mode gate approved and task completes

- **WHEN** `wait_for_task` reports `approval_requested` with type `edit_mode` and the harness calls `approve(task_id, edit_mode, true)`
- **THEN** continued waiting observes the task reach `completed`, with the approval and resume visible in the events

### Requirement: Capture per-scenario evidence in a documented format

Each scenario SHALL write an evidence file in the documented `archie-e2e-evidence/v1` format — scenario name, covered AC ids, timestamps, environment (base URL, branch, commit), nonce and task id, the assertions checked with expected/observed/pass, verbatim event and knowledge-log excerpts, terminal state, and an overall result consistent with the assertions — such that the file alone suffices for an independent reviewer to judge pass/fail. The writer SHALL validate payloads against the schema and reject incomplete evidence. Ingestion and writes SHALL be all-or-nothing: input is read fully before parsing, truncated or malformed input produces a clear error and no files, and the JSON/markdown pair is written atomically (temp-file + rename) so both land or neither does. The destination directory SHALL be parameterizable (flag or optional env var) with a gitignored local default, so Forge Stage 4 can target `openspec/changes/<change>/qa-evidence/`.

#### Scenario: Evidence file written and self-sufficient

- **WHEN** a scenario finishes and its payload is passed to the evidence writer
- **THEN** a canonical JSON file and a rendered markdown companion appear in the destination, containing every schema field including per-assertion expected/observed/pass and the excerpts they rest on

#### Scenario: Incomplete evidence rejected

- **WHEN** a payload is missing assertions or declares a result inconsistent with its assertion outcomes
- **THEN** the writer exits non-zero naming the validation errors and writes nothing

#### Scenario: Truncated input writes nothing

- **WHEN** the writer's stdin ends mid-JSON (truncated or malformed input)
- **THEN** it reports a clear truncation/parse error, exits non-zero, and leaves no evidence files (whole or partial) on disk

#### Scenario: Destination parameterizable

- **WHEN** the writer is invoked with an explicit out-dir
- **THEN** the evidence lands there instead of the default local directory

### Requirement: Tear down cleanly leaving no containers

The harness SHALL provide a teardown invocation that runs `docker compose down` and then verifies via `docker compose ps` that no containers remain for the project, failing non-zero and naming any survivors.

#### Scenario: Clean teardown verified

- **WHEN** teardown runs after a scenario session
- **THEN** `docker compose ps` reports no project containers and the command prints a confirmation suitable for evidence

#### Scenario: Survivors detected

- **WHEN** a project container still exists after `docker compose down`
- **THEN** the command exits non-zero listing the remaining container(s)

### Requirement: Helper logic is unit-tested in plain CI

All non-trivial harness logic (health waiting with fail-fast, base-URL and timeout resolution, evidence validation and rendering, compose-ps parsing) SHALL live in TypeScript functions with injected dependencies, covered by vitest tests that run in the repo's existing CI without docker, a running instance, or network access.

#### Scenario: Tests run without docker

- **WHEN** `npm test` runs in plain CI
- **THEN** the harness's tests execute against fake fetch/clock/exec dependencies and pass with no docker daemon available

### Requirement: Zero engine footprint

The harness SHALL be implemented entirely as a skill plus helper tooling: no changes under `src/`, no changes under `tools/debug-mcp/`, no Slack credentials required, and no new required environment variables (all tunables default sensibly and are overridable).

#### Scenario: Footprint confined to skill and tooling

- **WHEN** the change is diffed against its branch point
- **THEN** modifications are confined to `.claude/skills/archie-e2e/`, `tools/e2e/`, `.gitignore`, and docs — with `src/` and `tools/debug-mcp/` untouched

