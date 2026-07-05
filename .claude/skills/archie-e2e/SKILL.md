---
name: archie-e2e
description: Boot a live Archie instance from the current branch, drive E2E scenarios headlessly through the archie-debug MCP (nonce → create_task → wait_for_task → approve), capture per-scenario evidence files, and tear down cleanly. Use for Forge Stage 4 QA, verifying a branch against a live instance, running the basic or edit-mode E2E scenario, or when asked to "run the e2e harness", "boot archie for testing", or "verify this AC live".
---

# archie-e2e — boot-from-branch E2E harness

Verify acceptance criteria against a live Archie instance booted from the branch under test. The lifecycle is four steps, each with one documented invocation:

1. **Boot** — `npx tsx tools/e2e/boot.ts` builds and starts the instance detached, waits for `/health`.
2. **Drive** — execute scenario recipes through the `archie-debug` MCP (no scripts; you make the MCP calls).
3. **Evidence** — pipe a per-scenario payload to `npx tsx tools/e2e/evidence.ts`, which validates and writes the JSON + markdown pair.
4. **Teardown** — `npx tsx tools/e2e/teardown.ts` stops everything and verifies no project containers remain.

## Prerequisites

- Docker (Desktop or daemon) running locally; `docker compose version` works.
- `.env` at the repo root with a non-empty `ANTHROPIC_API_KEY`. **No Slack tokens are needed** — scenarios enter through the CLI/API channel.
- The `archie-debug` MCP available (registered in `.mcp.json` as `npx tsx tools/debug-mcp/server.ts`). The harness consumes it as-is and never modifies `tools/debug-mcp/`.
- For the edit-mode scenario only: at least one configured engineering repo in the workdir (see the recipe's prerequisite note).
- macOS Docker Desktop caveat: a wedged `docker-credential-desktop` helper can stall `docker compose up --build` during registry auth — upstream of the harness's bounded wait, so boot appears to hang before any diagnostics. Verify with `docker-credential-desktop list </dev/null`; if it hangs, point `DOCKER_CONFIG` at a scratch dir without `credsStore` for the run (leave your real `~/.docker/config.json` untouched).

**Rollback:** delete `.claude/skills/archie-e2e/` and `tools/e2e/` — the harness has no side effects and nothing else references them (plus one `e2e-evidence/` line in `.gitignore`).

## 1. Boot

```bash
npx tsx tools/e2e/boot.ts [--timeout-seconds N]
```

The boot runs a strict ordered sequence; each step gates the next, so no failure ever falls through into the poll loop:

1. **Preflight** (mandatory, first): `.env` exists at the repo root and `ANTHROPIC_API_KEY` is non-empty. Failure exits non-zero naming the missing item, with no compose invocation at all.
2. **Compose up, exit code trapped**: `docker compose up --build -d` (detached — `npm run docker:dev` is foreground, don't use it here). A non-zero exit prints the diagnostics block and exits non-zero **before a single `/health` poll** — a failed build never spends any of the wait cap.
3. **Health poll**: `GET {baseUrl}/health` every 5s until 200. Bounded by a default cap of **600s**, overridable via `--timeout-seconds` or `E2E_BOOT_TIMEOUT_SECONDS` (flag beats env beats default). Each tick also checks `docker compose ps --format json`: an `archie` container that is exited, dead, restarting (crash loop), or missing fails immediately instead of waiting out the cap.

On success it prints the resolved base URL and the `/health` body — paste both into evidence. The base URL resolution matches the archie-debug MCP exactly (`ARCHIE_URL` → `PORT` env → `PORT` from `.env` → `http://localhost:3000`), so the harness and the MCP always target the same instance, including per-worktree ports.

**Failure diagnostics** (printed on any compose-up or poll-phase failure, always followed by a non-zero exit): the `docker compose ps` table plus the last 100 lines of the archie container's logs (`docker compose logs --no-color --tail=100 archie`). Read the log tail first — missing env keys, plugin clone failures, and crash loops all surface there.

**Boot time observations** (fills in at the first live run — Stage 4 of the harness's own change): cold `--build` boot: _not yet measured_; warm boot (image cached): _not yet measured_. Tuning guidance: once measured, set `--timeout-seconds` to roughly **2× the observed cold time** for CI-like runs, and near the warm time for tight iteration. Until then the generous 600s default stands.

## 2. Drive scenarios (archie-debug MCP recipes)

Scenarios are agent-driven: you call the MCP tools directly, following these recipes. The recipe names below are canonical and **must be used verbatim as the evidence files' `scenario` field**.

**Constraints (both recipes):**

- **Serial only** — run one scenario at a time; parallel runs are unvalidated.
- **Nonce window** — `wait_for_task`'s nonce scan covers only the **25 most-recent tasks**, so on a long-lived instance old nonces fall out of the window; remedy: fresh boot before a scenario session.
- Mint each nonce fresh: `E2E-$(openssl rand -hex 4)`.

### Recipe: `basic-nonce`

A read-only question reaches `completed` with an observable PM reply. Verifies the create → correlate → wait → assert loop (brief AC2).

1. Mint `NONCE=E2E-$(openssl rand -hex 4)`.
2. `create_task` with the nonce embedded in the message, e.g. `"[${NONCE}] What agents are configured in this instance? Reply with a short list and do not modify anything."`
3. `wait_for_task(nonce: NONCE)` — first call correlates the nonce to a task id and returns `TASK=<id>`.
4. While `STATE=pending`: call `wait_for_task(task_id: <id>, cursor: <CURSOR from the previous call>)` again — each call waits up to ~45s server-side and returns a resumable `CURSOR`.
5. Terminal: assert `STATE=completed`, and a `PM_REPLY` line was observed (or fetch `get_events(task_id)` and assert a `message` event with `data.from === 'pm-agent'`).
6. Excerpts for evidence: `get_log(task_id, tail: 40)` for the knowledge log (must contain the nonce), `get_events(task_id)` for `task:created` … `task:completed`.

### Recipe: `edit-mode-approval`

A change request against a configured repo trips the edit-mode gate, is approved via the API path, and proceeds to completion (brief AC3).

**Prerequisite:** the workdir has at least one configured engineering repo (the PM only requests edit mode when a code change targets a repo the plugin config declares). If the prerequisite is unmet, do NOT fake a pass — report the scenario as `BLOCKED`, stating: what is missing (no configured engineering repo in the workdir), what was attempted, and the remedy (configure a repo via the plugins setup, reboot, re-run). A BLOCKED scenario produces no evidence file; it appears in the run report only.

1. Mint a fresh nonce as above.
2. `create_task` with a small, real change request against a configured repo, e.g. `"[${NONCE}] In <repo>, add a comment line '// archie-e2e touch' to the top of README-adjacent file X and open a PR."`
3. `wait_for_task(nonce: NONCE)`, then resume with `task_id` + `cursor` while `STATE=pending`.
4. On `STATE=approval_requested`: confirm the approval type via `get_events` (the `approval:requested` event carries `data.approvalType: "edit_mode"`; the `wait_for_task` text output may not include an `APPROVAL_TYPE=` line), then call `approve(task_id: <id>, type: "edit_mode", approve: true)` (this is the `POST /api/tasks/:id/approve` path).
5. Continue the `wait_for_task` loop; assert the task reaches `STATE=completed`.
6. Excerpts for evidence: events must show `approval:requested` (`data.type: "edit_mode"`) followed by `approval:resolved` and eventually `task:completed`; the knowledge log records the approval decision line.

## 3. Capture evidence

Each scenario produces a `<scenario>.json` (canonical) + `<scenario>.md` (rendered for reviewers) pair, written by the validated writer:

```bash
# assemble the payload, then:
cat payload.json | npx tsx tools/e2e/evidence.ts --out-dir <dir>
# or: npx tsx tools/e2e/evidence.ts --in payload.json --out-dir <dir>
```

**Destination:** `--out-dir` flag → `E2E_EVIDENCE_DIR` env → default `./e2e-evidence/` at the repo root. The default is **gitignored** local scratch; Forge Stage 4 passes `--out-dir openspec/changes/<change>/qa-evidence/`, which **is** committed. One out-dir with `ac_ids` routing inside the files is the default convention; per-AC directories (`qa-evidence/<AC-id>/`) also work by pointing `--out-dir` per invocation.

**All-or-nothing semantics:** stdin is read fully before parsing; truncated or malformed JSON produces a classed error ("truncated JSON input from stdin" / "invalid JSON from stdin: …"), a non-zero exit, and no files. An invalid payload exits non-zero naming every validation error and writes nothing. The pair is written atomically (temp-file + rename) and transactionally — both files land or neither. A half-written evidence file is silent poison for the reviewer judging pass/fail from the file alone; the writer makes that state unrepresentable.

### Schema: `archie-e2e-evidence/v1` (field by field)

| Field | Type | Meaning |
|---|---|---|
| `schema` | `"archie-e2e-evidence/v1"` | Schema tag, exact string. |
| `scenario` | string, kebab-case | Canonical recipe name (`basic-nonce`, `edit-mode-approval`); names the output files. |
| `ac_ids` | string[], non-empty | Brief AC ids this scenario verifies, e.g. `["AC2"]`. |
| `started_at` / `finished_at` | ISO 8601 strings | Scenario wall-clock bounds. |
| `environment.base_url` | string | Resolved base URL the scenario ran against. |
| `environment.git_branch` | string | Branch under test (`git branch --show-current`). |
| `environment.git_commit` | string | Commit under test (`git rev-parse --short HEAD`). |
| `nonce` | string | The minted nonce, e.g. `E2E-a1b2c3d4`. |
| `task_id` | string | Correlated task id from `wait_for_task`. |
| `terminal_state` | enum | `completed \| stopped \| approval_requested \| pending \| not_found`. |
| `assertions` | array, non-empty | Each: `id`, `description`, `expected`, `observed` (all non-empty strings), `pass` (boolean). |
| `excerpts.knowledge_log` | string[] | Verbatim knowledge-log lines the assertions rest on. |
| `excerpts.events` | array | Verbatim event objects (from `get_events`) the assertions rest on. |
| `result` | `"pass" \| "fail"` | Overall verdict; the validator enforces it equals the AND of assertion passes. |

The markdown companion is rendered mechanically from the JSON in the same invocation (metadata header, assertion table, fenced excerpts, verdict); the JSON is canonical if they ever seem to diverge.

## 4. Teardown

```bash
npx tsx tools/e2e/teardown.ts
```

Runs `docker compose down`, then verifies via `docker compose ps --all --format json` that **no containers remain for the project** — survivors (including stopped-but-not-removed ones) are listed by name and the command exits non-zero. On success it prints a confirmation line suitable for pasting into evidence: `Teardown clean: docker compose ps --all reports no containers for this project.` Never end a scenario session without a clean teardown exit.
