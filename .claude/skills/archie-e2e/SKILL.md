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

> Running in a cloud sandbox / CI behind a TLS-intercepting proxy (e.g. Claude Code on the web)? See `docs/guides/e2e-in-cloud-sandbox.md` for the cold-start setup (CA trust, key mapping, bind-mount ownership, `setsid` for long-running processes). The steps below assume direct internet egress.

- Docker (Desktop or daemon) running locally; `docker compose version` works.
- `.env` at the repo root with a non-empty `ANTHROPIC_API_KEY`. **No Slack tokens are needed** — scenarios enter through the CLI/API channel.
- The `archie-debug` MCP available (registered in `.mcp.json` as `npx tsx tools/debug-mcp/server.ts`). The harness consumes it as-is and never modifies `tools/debug-mcp/`.
- For the edit-mode and merge-approval scenarios: at least one configured engineering repo in the workdir (see the recipes' prerequisite notes).
- macOS Docker Desktop caveat: a wedged `docker-credential-desktop` helper can stall `docker compose up --build` during registry auth — upstream of the harness's bounded wait, so boot appears to hang before any diagnostics. Verify with `docker-credential-desktop list </dev/null`; if it hangs, point `DOCKER_CONFIG` at a scratch dir without `credsStore` for the run (leave your real `~/.docker/config.json` untouched). The scratch config also drops the `desktop-linux` context, so additionally set `DOCKER_HOST=unix://$HOME/.docker/run/docker.sock` or every docker command will fail to reach the daemon (observed in the 2026-07-05 QA run).

**Rollback:** delete `.claude/skills/archie-e2e/` and `tools/e2e/` — the harness has no side effects and nothing else references them (plus one `e2e-evidence/` line in `.gitignore`).

## 1. Boot

```bash
npx tsx tools/e2e/boot.ts [--timeout-seconds N]
```

The boot runs a strict ordered sequence; each step gates the next, so no failure ever falls through into the poll loop:

1. **Preflight** (mandatory, first): `.env` exists at the repo root and `ANTHROPIC_API_KEY` is non-empty. Failure exits non-zero naming the missing item, with no compose invocation at all.
2. **Port preflight**: the target port is probed before any compose invocation (skipped when `ARCHIE_URL` is set explicitly — that target is the operator's to manage). Free → proceed. Published by **this project's own archie** (checked against the container's published ports, not mere existence) → `docker compose down` first and boot fresh on the same port (the harness never adopts a running instance — it may be stale code; every boot builds from the current checkout). Held by **anything else** (a foreign archie from another worktree, an unrelated service) → a free port is auto-picked and the boot relocates there, leaving the squatter untouched.
3. **Compose up, exit code trapped**: `docker compose up --build -d` (detached — `npm run docker:dev` is foreground, don't use it here), with `PORT` and `GIT_SHA` passed in the compose environment. A non-zero exit prints the diagnostics block and exits non-zero **before a single `/health` poll** — a failed build never spends any of the wait cap.
4. **Health poll**: `GET {baseUrl}/health` every 5s until 200. Bounded by a default cap of **600s**, overridable via `--timeout-seconds` or `E2E_BOOT_TIMEOUT_SECONDS` (flag beats env beats default). Each tick also checks `docker compose ps --format json`: an `archie` container that is exited, dead, restarting (crash loop), or missing fails immediately instead of waiting out the cap.
5. **Checkout attestation**: `/health` must report the `git_sha` the boot passed (`git rev-parse HEAD`, `-dirty` suffix on an unclean tree). A healthy instance reporting anything else fails the boot — positive proof the instance was composed from the checkout under test, not a stale build or another checkout. Quote the `Attested: instance composed from <sha>` line in evidence.

On success it prints the resolved base URL, the `/health` body, and a final `ARCHIE_URL=http://localhost:<port>` line. **When the port was auto-picked, the driver MUST target that URL — and note the MCP constraint:** the archie-debug MCP resolves its URL once at spawn (`ARCHIE_URL` → `PORT` env → `PORT` from `.env` → `http://localhost:3000`), so an MCP already attached to your session (spawned before boot) CANNOT be retargeted by exporting a variable afterwards. Either drive via a fresh stdio client you spawn yourself with `ARCHIE_URL` in its environment (`ARCHIE_URL=... npx tsx tools/debug-mcp/server.ts`, as the QA runner does), or restart the session/MCP so it picks the value up. On the default port none of this matters — the resolutions already agree.

**Failure diagnostics** (printed on any compose-up or poll-phase failure, always followed by a non-zero exit): the `docker compose ps` table plus the last 100 lines of the archie container's logs (`docker compose logs --no-color --tail=100 archie`). Read the log tail first — missing env keys, plugin clone failures, and crash loops all surface there.

**Boot time observations**: cold `--build` boot: ~45s build + ~2min to healthy (M-series Mac, 2026-07-05 QA run of forge run pr-167-mcp-file-bridge); warm boot (image cached): _not yet measured_. Tuning guidance: set `--timeout-seconds` to roughly **2× the observed cold time** (~330s) for CI-like runs, and near the warm time for tight iteration once measured. The generous 600s default remains a safe ceiling.

## 2. Drive scenarios (archie-debug MCP recipes)

Scenarios are agent-driven: you call the MCP tools directly, following these recipes. The recipe names below are canonical and **must be used verbatim as the evidence files' `scenario` field**.

**Constraints (all recipes):**

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
4. On `STATE=approval_requested`: read the approval type from the `APPROVAL_TYPE=` line of the `wait_for_task` output, then call `approve(task_id: <id>, type: "edit_mode", approve: true)` (this is the `POST /api/tasks/:id/approve` path).
5. Continue the `wait_for_task` loop; assert the task reaches `STATE=completed`.
6. Excerpts for evidence: events must show `approval:requested` (`data.approvalType: "edit_mode"`) followed by `approval:resolved` and eventually `task:completed`; the knowledge log records the approval decision line.

### Recipe: `merge-approval-deny`

An explicit merge request in a repo without `autoMerge: true` trips the `merge` approval gate, is denied via the API path, and no merge ever executes — the deny path keeps QA from really merging anything (pr-merge-policy AC3).

**Prerequisite:** same as `edit-mode-approval` — the workdir has at least one configured engineering repo, and that repo must not resolve to `autoMerge: true` (the shipped default: any repo whose declaring agents don't all set the flag). If the prerequisite is unmet, do NOT fake a pass — report the scenario as `BLOCKED`, stating: what is missing (no configured engineering repo in the workdir, or only auto-merge repos), what was attempted, and the remedy (configure a repo via the plugins setup, reboot, re-run). A BLOCKED scenario produces no evidence file; it appears in the run report only.

1. Mint a fresh nonce as above.
2. `create_task` with a small, real change request against a configured repo that ends in an open PR, e.g. `"[${NONCE}] In <repo>, add a comment line '// archie-e2e touch' to the top of README-adjacent file X and open a PR. Do not merge it."`
3. `wait_for_task(nonce: NONCE)`, then resume with `task_id` + `cursor` while `STATE=pending`. On `STATE=approval_requested` with `APPROVAL_TYPE=edit_mode`: `approve(task_id: <id>, type: "edit_mode", approve: true)` and keep waiting.
4. Wait until the task settles with the PR opened (`STATE=completed`, PM reply announcing the PR). Note the PR number and repo from the PM reply or the knowledge log — the approve call in step 7 needs exactly this identity.
5. `send_message(task_id: <id>, message: "[${NONCE}] Please merge that PR.")` — the PM delegates to the repo agent, whose `merge_pull_request` call posts the merge approval prompt instead of merging.
6. Resume the `wait_for_task` loop; assert `STATE=approval_requested` with `APPROVAL_TYPE=merge`. The knowledge log now carries the decision finding `Merge approval requested for <github>#<pr_number>` — this names the identity to resolve against.
7. `approve(task_id: <id>, type: "merge", approve: false, github: "<github>", pr_number: <pr_number>)` with the identity of the PR the scenario drove open — the API rejects merge-type resolutions that omit `github`/`pr_number`.
8. Continue the `wait_for_task` loop; assert the task settles (`STATE=completed`) and **no merge occurred**: the knowledge log contains the denial finding `Merge denied by user — PR not merged`, and neither the log nor the events contain a merged completion (`PR … merged on user approval`) for this PR.
9. Excerpts for evidence: events must show `approval:requested` (`data.approvalType: "merge"`) followed by `approval:resolved` (`data.approve: false`) with no merge in between; knowledge-log lines for the merge-approval request and the denial finding.

### Recipe: `github-mention`

A correctly signed synthetic `issue_comment.created` webhook mentioning the dev App slug creates a GitHub-born task seeded from the thread, and the acknowledgment (👀 reaction + task-naming comment) is visible on the real GitHub issue (github-mention-trigger brief AC12).

**Prerequisites:** dev GitHub App credentials in `.env` (`GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_INSTALLATION_ID`, `GITHUB_WEBHOOK_SECRET`); a test repo that is covered by a configured plugin AND reachable by the dev installation; and a GitHub account with **write** permission on that repo to author the triggering comment (`gh` authenticated as it). If any prerequisite is missing, do NOT fake a pass — report the scenario as `BLOCKED`, stating what is missing, what was attempted, and the remedy; per the brief's QA limitation the degradation paths (`manual` run with a hand-posted comment, or an explicit waiver naming AC13's post-merge verification as fallback) may be taken **only with the user's say-so** — stop and return to the user first. A BLOCKED scenario produces no evidence file; it appears in the run report only.

1. Boot as in §1. Confirm the boot log does NOT carry the `GITHUB_APP_SLUG is not set` warning (slug present → self-filter, mention trigger, and GitHub-born routing live).
2. Create a real issue in the test repo: `gh api repos/<o>/<r>/issues -f title="archie-e2e mention probe" -f body="Probe issue for the github-mention recipe."` — note `number` and the issue JSON (the payload needs `issue.number/title/body/html_url/user`).
3. Mint `NONCE=E2E-$(openssl rand -hex 4)`. Post the real triggering comment as the write-permission account: `gh api repos/<o>/<r>/issues/<n>/comments -f body="@<dev-slug> [${NONCE}] please investigate"` — capture the returned comment `id`, `body`, `html_url`, `user.login`. The comment must be real so the 👀 reaction (which targets this comment id) can land.
4. Build the synthetic `issue_comment.created` payload from the REAL issue + comment JSON (`action`, `issue`, `comment`, `repository.full_name`, `sender` = the comment author) — the dev App's webhook URL points elsewhere, so this POST is how the event reaches the instance under test. Sign the exact bytes and POST:

   ```bash
   SIG=$(node -e 'const c=require("crypto"),f=require("fs");process.stdout.write("sha256="+c.createHmac("sha256",process.env.GITHUB_WEBHOOK_SECRET).update(f.readFileSync(process.argv[1])).digest("hex"))' payload.json)
   curl -sS -X POST "$ARCHIE_URL/webhooks/github" -H 'x-github-event: issue_comment' -H "x-hub-signature-256: $SIG" -H 'content-type: application/json' --data-binary @payload.json
   ```

   Expect `{"received":true}`.
5. Observe via the archie-debug MCP: `wait_for_task(nonce: NONCE)` correlates the task (the mentioning comment is seeded verbatim into knowledge.log, so the nonce scan finds it). `get_log(task_id, tail: 40)` must contain the issue title, the issue body, the mentioning comment with its `[comment_id=…]` tag, and the thread link. Resume `wait_for_task(task_id, cursor)` until the task settles; a `PM_REPLY` on a GitHub-born task lands as an issue comment, not Slack.
6. Assert the real-GitHub ack: `gh api repos/<o>/<r>/issues/comments/<comment_id>/reactions` contains an `eyes` reaction by `<dev-slug>[bot]`, and `gh api repos/<o>/<r>/issues/<n>/comments` contains a comment authored `<dev-slug>[bot]` naming the created task id (and, once the PM replies, its reply as another comment).
7. Excerpts for evidence: the seeded knowledge-log lines (title/body/comment/link), the `task:created` event, and the fetched reaction + ack-comment JSON. Clean up: close the probe issue (`gh api -X PATCH repos/<o>/<r>/issues/<n> -f state=closed`).

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
| `scenario` | string, kebab-case | Canonical recipe name (`basic-nonce`, `edit-mode-approval`, `merge-approval-deny`, `github-mention`); names the output files. |
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
