## Context

Forge Stage 4 (`.claude/skills/forge/stages/4-qa.md`) prescribes: boot the branch under test (`docker compose up --build -d`, wait for `/health`), run nonce scenarios through the archie-debug MCP, approve edit-mode gates, record per-AC evidence into `qa-evidence/`, and tear down. Until now no harness implemented that loop, so every `live-e2e` AC was waived.

Everything the harness needs already exists and is verified in the research dossier:

- **archie-debug MCP** (`tools/debug-mcp/`, registered in `.mcp.json` as `npx tsx tools/debug-mcp/server.ts`): `create_task`, `wait_for_task` (server-side blocking, nonce correlation over the 25 most-recent tasks' knowledge logs, 45s cap with resumable cursor, approval detection), `approve` (`edit_mode` | `research_budget`), `get_log`, `get_events`. Import-free from `src/`, consumed as-is.
- **HTTP contract**: `GET /health` → 200 `{status:'ok', activeTasks}` (`src/index.ts:212-218`); `POST /api/tasks/:id/approve` resumes an edit-gated task (`src/connectors/api/routes.ts:218-276`).
- **Docker**: compose service `archie` built from `Dockerfile.dev`, port `${PORT:-3000}`, env from `.env`, workdir host-mounted at `./workdir`. `npm run docker:dev` is `docker compose up --build` — **foreground**, so the harness must invoke compose detached itself.
- **Test infra**: vitest with `include: ['src/**/*.test.ts', 'tools/**/*.test.ts']`; CI runs `typecheck` → `build` → `test` with no docker. `tools/debug-mcp/wait-for-task.test.ts` establishes the fake-client/fake-clock pattern.

This run is self-hosting: the built harness verifies its own ACs at Stage 4 against its own branch.

## Goals / Non-Goals

**Goals:**

- One documented invocation to boot a live instance from any branch checkout, with a bounded health wait and clear failure output (never a hang).
- Headless scenario driving via the archie-debug MCP: nonce → create → wait → approve → assert on knowledge log and events.
- A documented per-scenario evidence file format, sufficient on its own for an independent reviewer, with a parameterizable destination.
- Clean teardown with programmatic verification that no project containers remain.
- All non-trivial helper logic unit-testable in plain CI (no docker).

**Non-Goals:**

- No Slack ingress (PR #71's territory); no Slack credentials required.
- No cheap-model preset (dropped at inception; production-default models).
- No fork of or edit to `tools/debug-mcp/`; no `src/` engine changes; no new required env vars.
- No parallel-scenario support in v1 (serial scenarios only — the nonce scan window is 25 recent tasks).

## Decisions

**1. Skill path `.claude/skills/archie-e2e/` — supersede PR #71 at this path.**
PR #71 (draft, `feature/e2e-harness`) occupies the same directory with a Slack-round-trip variant. This run's skill **takes the path**: CLI/API ingress is the general-purpose harness Forge needs, and PR #71's own branch already deleted its `wait-task.sh` in favor of the MCP's `wait_for_task`, conceding the correlation layer. PR #71's surviving value is Slack-specific (`resolve-bot.sh`, DM ingress, Slack round-trip assertions) and is its to rebase on top of this skill later — e.g. as an additional scenario recipe or a sibling `archie-e2e-slack` section — rather than this run absorbing Slack scope. *Alternative:* coexist under a different name (`archie-e2e-api`) — rejected: Forge Stage 4 and issue #175 both name `archie-e2e`, and two half-harnesses at sibling paths would be worse than one canonical skill.

**2. Script logic lives in `tools/e2e/` as TypeScript CLIs run via `npx tsx`; no bash wrappers.**
Placing helpers in `tools/e2e/` (sibling to `tools/debug-mcp/`) means vitest's existing `tools/**/*.test.ts` include picks up their tests with zero config change, satisfying AC7 in plain CI. Each command follows the debug-mcp architecture: a pure, exported core function taking injected dependencies (`fetch`, clock, exec) in one module, unit-tested with fakes; a thin CLI `main` that wires real dependencies. Skill docs invoke them as `npx tsx tools/e2e/<cmd>.ts …`. Standalone scripts use plain stdout/stderr (unified-logger rule applies to `src/` only; `tools/debug-mcp/server.ts` is the precedent). *Alternatives:* scripts under `.claude/skills/archie-e2e/scripts/` (rejected — tests would need a new vitest include pattern and would stray from the tools/ precedent); bash helpers like PR #71's (rejected — untestable in this repo's CI; no BATS precedent, AC7 points at vitest).

**3. Boot: strict fail-fast sequence — preflight, then compose up with exit trapped, then (and only then) the bounded `/health` poll.**
`npx tsx tools/e2e/boot.ts` executes a mandatory ordered sequence; each step gates the next so no failure ever falls through into the poll loop:

1. **Preflight** (mandatory): `.env` exists at the repo root and `ANTHROPIC_API_KEY` is non-empty. Failure exits non-zero immediately, naming the missing item — no compose invocation at all.
2. **Compose up, exit code trapped**: run `docker compose up --build -d` (NOT `npm run docker:dev`, which is foreground). On a non-zero exit, collect diagnostics (`docker compose ps` output plus `docker compose logs --no-color --tail=100 archie`), print them, and exit non-zero **before entering the health poll loop** — a failed compose-up must not spend a single poll tick, let alone the 600s cap, polling a container that never started.
3. **Health poll** (only after compose-up succeeds): poll `GET {baseUrl}/health` every 5s until 200. The wait is bounded: default cap **600s**, generous because cold `--build` plus plugin auto-clone has no documented baseline (dossier §3 uncertainty), overridable via `--timeout-seconds` flag or optional `E2E_BOOT_TIMEOUT_SECONDS` env. Each poll tick also checks `docker compose ps --format json`: if the `archie` container has exited or is restart-looping, fail immediately rather than waiting out the cap.

On any failure in steps 2–3 the CLI prints the same diagnostics block — `docker compose ps` output plus the 100-line log tail — and exits non-zero; on success it prints the resolved base URL and the `/health` body. The testable core is `waitForHealth(deps, opts)` with injected `fetch`, `ps`-reader, and clock (fake-clock pattern), plus a pure diagnostics formatter; the compose-up-failure-never-polls ordering is asserted at the orchestration level with a fake exec. *Alternative:* trust the compose healthcheck (`docker compose ps` → `(healthy)`, PR #71's approach) — rejected as the primary signal: the healthcheck's 30s interval and 3-retry policy makes readiness detection slower and coarser than polling `/health` directly; container state is still consulted, but only for fail-fast.

**4. Base URL resolution mirrors the debug MCP.**
Precedence: `ARCHIE_URL` → `PORT` env → `PORT` read from `.env` at repo root → `http://localhost:3000` — the same rules as `tools/debug-mcp/server.ts:24-46`, so the harness and the MCP always agree on which instance they are talking to, including per-worktree ports. Implemented as a small pure `resolveBaseUrl(env, dotenvText)` in `tools/e2e/config.ts` (the MCP's resolver is not importable without edits to `tools/debug-mcp/`, which are off-limits; duplicating ~20 lines is the cheaper coupling).

**5. Scenario orchestration is agent-driven through the MCP; the skill codifies the recipes.**
No scripted scenario runner. The QA runner (Claude, per Stage 4) executes scenarios by calling archie-debug MCP tools directly, following recipes in SKILL.md: mint a nonce (`E2E-$(openssl rand -hex 4)`), `create_task` with the nonce embedded in the message, loop `wait_for_task(nonce)` resuming via `CURSOR` while `STATE=pending`, on `STATE=approval_requested` call `approve(task_id, type, true)` and continue waiting, then `get_log`/`get_events` for assertion excerpts. Two canonical recipes ship in v1: **basic** (read-only question → `completed`, PM reply observed) and **edit-mode** (a change request against a configured repo → `approval_requested` → approve → `completed`). The MCP already does the hard, testable parts server-side (correlation, bounded waits, state folding); a scripted runner would duplicate that behind a second interface while making scenarios rigid. *Alternative:* a `run-scenario.ts` CLI taking a scenario spec file — rejected for v1: it re-implements MCP client plumbing the agent already has, and Stage 4's QA-runner prompt is already agent-shaped. Revisit if scenario counts grow.

**6. Evidence format: canonical JSON (`archie-e2e-evidence/v1`) plus a rendered markdown companion, written by a validated helper.**
Each scenario produces `<scenario>.json` (machine-readable, the canonical record) and `<scenario>.md` (rendered from the JSON for human reviewers). The runner assembles a payload and pipes it to `npx tsx tools/e2e/evidence.ts --out-dir <dir>`, which **validates** the payload against the schema (rejecting incomplete evidence — a missing verdict or empty assertion list is an error, not a silently thin file) and writes both files. Schema, documented in SKILL.md and enforced in `tools/e2e/evidence.ts`:

```jsonc
{
  "schema": "archie-e2e-evidence/v1",
  "scenario": "edit-mode-approval",        // stable scenario name (kebab-case)
  "ac_ids": ["AC3"],                        // brief AC ids this scenario verifies
  "started_at": "2026-07-04T12:00:00Z",     // ISO timestamps
  "finished_at": "2026-07-04T12:03:10Z",
  "environment": {
    "base_url": "http://localhost:3000",
    "git_branch": "forge/archie-e2e-harness",
    "git_commit": "abc1234"
  },
  "nonce": "E2E-a1b2c3d4",
  "task_id": "task-20260704-1200-x1y2z3",
  "terminal_state": "completed",            // completed|stopped|approval_requested|pending|not_found
  "assertions": [                            // >=1 required
    {
      "id": "gate-fired",
      "description": "wait_for_task reports approval_requested with type edit_mode",
      "expected": "STATE=approval_requested, APPROVAL_TYPE=edit_mode",
      "observed": "STATE=approval_requested APPROVAL_TYPE=edit_mode (task-…)",
      "pass": true
    }
  ],
  "excerpts": {                              // verbatim material the assertions rest on
    "knowledge_log": ["[2026-07-04T12:00:01Z] [system] task created …"],
    "events": [{ "type": "approval:requested", "data": { "type": "edit_mode" } }]
  },
  "result": "pass"                           // pass|fail; must equal AND of assertion passes (validator enforces)
}
```

**Ingestion and writes are all-or-nothing.** Stdin is read fully into memory before any parse attempt; truncated or malformed JSON (including EOF mid-document) produces a clear, classed error ("truncated JSON input from stdin" / "invalid JSON: …"), a non-zero exit, and **no files written**. With `--in <file>`, the path's existence and readability are validated before open, with the same no-files-on-error guarantee. File writes are atomic via temp-file-plus-rename in the destination directory, and the pair is transactional: both `<scenario>.json` and `<scenario>.md` land, or neither does (render the markdown before committing either rename; on any failure, remove temp files). This matters because evidence gets committed into `qa-evidence/` — a partial or half-written file is silent poison for the independent reviewer who judges pass/fail from the file alone.

Destination is parameterizable: `--out-dir` flag (or optional `E2E_EVIDENCE_DIR` env), default `./e2e-evidence/` at the repo root (gitignored). Forge Stage 4 passes `--out-dir openspec/changes/<change>/qa-evidence/<AC-id>/`, which IS committed. *Alternatives:* markdown-only (rejected — AC4 wants a stable format an independent reviewer and future tooling can trust; frontmatter-in-markdown is a worse parser contract than JSON); JSON-only (rejected — reviewers read markdown; the render is mechanical so the pair costs nothing).

**7. Teardown: `docker compose down` + programmatic emptiness check.**
`npx tsx tools/e2e/teardown.ts` runs `docker compose down`, then `docker compose ps --format json` and fails (non-zero, listing survivors) if any container for the project remains; on success it prints a confirmation line suitable for pasting into evidence. The ps-output parser (`parseComposePs`) is a pure function unit-tested against captured fixture output, including the empty case and the leftover-container case. *Alternative:* document bare `docker compose down` (rejected — AC6 demands verified emptiness, and "ps output was empty" is exactly the evidence line the check produces).

**8. Boot-time bound stays overridable and gets an empirical note at implementation.**
The 600s default is a design-stage guess (dossier flags no cold-build baseline). Implementation records the observed cold and warm boot times in SKILL.md so operators can tune `--timeout-seconds` sensibly; the default only changes if observation shows 600s is materially wrong in either direction.

## Evidence directory layout

```
<out-dir>/
  <scenario>.json      # canonical, schema archie-e2e-evidence/v1
  <scenario>.md        # rendered for reviewers
```

One file pair per scenario; a scenario names the AC ids it covers, so Forge's per-AC layout (`qa-evidence/<AC-id>/`) is achieved by pointing `--out-dir` at the AC's directory per invocation (or once at `qa-evidence/` with scenarios carrying `ac_ids` — both work; Stage 4's convention wins).

## Risks / Trade-offs

- **Agent-driven scenarios are less deterministic than a scripted runner** → accepted for v1: the deterministic parts (waiting, correlation, state folding) already live server-side in the MCP; the skill's recipes pin the call sequence, and the evidence validator rejects structurally incomplete records. A scripted runner remains a follow-up if scenario drift shows up.
- **The edit-mode scenario depends on the workdir having at least one configured engineering repo** (the PM only requests edit mode when a code change targets a repo). SKILL.md documents this prerequisite and the recipe phrases the task against a repo the local plugin config declares. If the prerequisite fails, the scenario reports `BLOCKED`, not a fake pass.
- **App boot without Slack tokens is not empirically verified on this machine** (dossier §7): `.env.example` marks them optional, but if boot requires them the AC1 scenario surfaces it immediately via the diagnostics tail — which is the harness doing its job, not a harness defect.
- **The 600s boot cap is a design-stage guess** — no cold-build baseline exists (dossier §7). Worst case is a hanging-but-not-exited broken branch: preflight and trapped compose-up catch config and build failures instantly, the container-exit fail-fast catches crash loops mid-poll, so only a branch that boots but never serves `/health` burns the cap — once. Tuning guidance: after the first successful cold boot, set `--timeout-seconds` (or `E2E_BOOT_TIMEOUT_SECONDS`) to roughly 2× the observed cold time for CI-like runs, and near the warm time for tight iteration; implementation records both observations in SKILL.md (Decision 8). Bounded-with-diagnostics beats clever-but-wrong heuristics.
- **`resolveBaseUrl` duplicates ~20 lines of the debug MCP's resolution logic** → deliberate: the alternative is editing `tools/debug-mcp/` to export it, which is off-limits. The duplication is pinned by tests asserting the same precedence order.
- **JSON+markdown evidence pair can theoretically diverge** → the markdown is only ever produced by the renderer from the JSON in the same invocation; reviewers who suspect divergence read the JSON, which is canonical.
- **Serial-only scenarios, bounded nonce window**: `wait_for_task`'s nonce scan covers the 25 most-recent tasks — ample for one runner, unvalidated for parallel runs, and on a long-lived instance old nonces fall out of the window (remedy: fresh boot before a scenario session). Documented as a constraint in the SKILL.md recipes; parallelism is out of scope.
- **Evidence pair transactionality is in-process only** (review round 1, finding 5): deterministic temp names (`<scenario>.json.tmp`) assume no concurrent writer for the same scenario — accepted because runs are serial by constraint, which SKILL.md already mandates.
- **Raw excerpt lines containing a triple-backtick fence could break out of the code block in the rendered `.md`** (review round 1, finding 6): accepted — the canonical JSON is unaffected, and reviewers judge from the JSON whenever the rendering looks suspect.

## Migration Plan

Additive only — new skill, new `tools/e2e/` files, one `.gitignore` line. No persisted state, no engine surface. Rollout: merge, and Forge Stage 4's preflight finds `.claude/skills/archie-e2e/` and stops waiving `live-e2e` ACs. PR #71 rebases: it drops its `SKILL.md` in favor of this one and re-lands its Slack material as an extension. Rollback: delete the skill and `tools/e2e/` — nothing else references them.

## Open Questions

- Observed cold/warm boot times (fills in at implementation; drives whether 600s stays the default).
- Whether Stage 4 prefers one `--out-dir qa-evidence/` with `ac_ids` routing or per-AC invocations — both are supported; the self-hosted Stage 4 run picks one and the skill documents the choice.

(Resolved at critic round 1: the boot CLI's `.env`/`ANTHROPIC_API_KEY` preflight is mandatory — Decision 3 step 1.)
