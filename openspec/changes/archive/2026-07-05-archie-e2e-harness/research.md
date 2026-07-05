# Research dossier — archie-e2e-harness

Merged from three fresh-context lenses (codebase mapper, prior-art scanner, constraints scanner), 2026-07-04. Claims carry `file:line` citations against the repo at branch point `main@4cb1282` or PR/issue references. Fact-check verdict: `verdicts/research-verifier-round1.md`.

## 1. The archie-debug MCP (`tools/debug-mcp/`)

- Exposes 8 tools: `create_task`, `list_tasks`, `task_status`, `send_message`, `get_log`, `get_events`, `approve`, `wait_for_task` (`tools/debug-mcp/server.ts:59-228`).
- `create_task(message) → task_id` (`server.ts:59-66`); `approve(task_id, type: 'edit_mode'|'research_budget', approve: boolean)` (`server.ts:179-192`); `get_log(task_id, tail?)` returns knowledge log (`server.ts:136-155`); `get_events(task_id, after?)` returns events.jsonl entries with cursor pagination (`server.ts:157-177`).
- `wait_for_task(task_id?, nonce?, timeout_seconds?, cursor?)` blocks server-side; returns `TASK`, `STATE` (`completed|stopped|approval_requested|pending|not_found`), `APPROVAL_TYPE`, `ATTRIBUTION`, `PM_REPLY` lines, `CURSOR` on pending (`server.ts:194-228`, `wait-for-task.ts:7-12`).
- Nonce correlation: when `nonce` given without `task_id`, scans recent tasks (default 25) and substring-matches each task's knowledge log (`wait-for-task.ts:62-77`). Attribution = first knowledge-log line, capped 512 chars (`wait-for-task.ts:56-60,119-126`). Polls events every 2.5s, hard cap 45s per call, resumable via cursor (`wait-for-task.ts:129-175`). Approval detection via `approval:requested` event with `data.type` (`wait-for-task.ts:150-155`). PM replies = `message` events with `data.from === 'pm-agent'`, truncated to 300 chars each (`wait-for-task.ts:159-161,219-224`).
- Base URL precedence: `ARCHIE_URL` → `PORT` env → `PORT` read from `.env` at repo root → `http://localhost:3000` (`server.ts:24-46`). Worktrees get unique ports via `.config/wt.toml` `hash_port`, so per-checkout resolution already works.
- HTTP client (`archie-client.ts`): `POST /api/tasks {message} → {task_id}` (`:58-67`), `GET /api/tasks` (`:69-74`), `GET /api/tasks/{id} → {metadata, knowledgeLog, agents[]}` (`:76-80`), `GET /api/tasks/{id}/events?after=n` (`:91-98`), `POST /api/tasks/{id}/approve {type, approve, approver?}` (`:100-108`).
- Ejectability: `server.ts:4` — "Standalone stdio MCP server. No imports from src/."; `archie-client.ts:2` — "self-contained, no imports from src/". Only deps: `@modelcontextprotocol/sdk`, `zod`. Registered in `.mcp.json` as `npx tsx tools/debug-mcp/server.ts` (`.mcp.json:3-6`).
- Unit-tested with vitest using fake client + fake clock: `tools/debug-mcp/wait-for-task.test.ts:1-162` (state detection, nonce correlation, bounded/resumable waits, approval ordering). Merged via PR #158 (2026-07-01, commit `220e55a`); spec archived at `openspec/changes/archive/2026-07-01-debug-mcp-wait-for-task/`.

## 2. App HTTP API & on-disk state

- `POST /api/tasks` creates task via `Task.create()`, links CLI channel, sends `newTask` prompt to PM (`src/connectors/api/routes.ts:170-190`).
- `POST /api/tasks/{id}/approve` with `{type: 'edit_mode', approve: true, approver?}` calls `task.handleEditModeApproval(approver)`: sets `metadata.edit_allowed = true`, records `edit_approved_by`, appends system decision line to knowledge log, resumes PM with `existingTask` prompt, emits `approval:resolved` (`src/connectors/api/routes.ts:218-276`, `src/tasks/task.ts:1232-1255`).
- `GET /health` → 200 `{status:'ok', activeTasks}` or 503 when shutting down (`src/index.ts:212-218`).
- Knowledge log: `${ARCHIE_WORKDIR}/sessions/{taskId}/shared/knowledge.log`, append-only lines `[{ISO}] [{source}] [{type}?] {message}` (`src/tasks/persistence.ts:63,214-231`).
- Events: `${ARCHIE_WORKDIR}/sessions/{taskId}/shared/events.jsonl`, one JSON object per line with `{type, taskId, timestamp, agentName?, data}` (`src/tasks/persistence.ts:67,771`, `src/system/event-bus.ts:10-25`).
- Metadata: `${ARCHIE_WORKDIR}/sessions/{taskId}/shared/metadata.json`, statuses `in_progress|stopped|completed` (`src/tasks/persistence.ts:62`, `TaskStatus` at `src/types/task.ts:5`).
- Task ID format: `task-{YYYYMMDD}-{HHMM}-{random6}` (`src/tasks/persistence.ts:77-82`).
- Key events for E2E assertions: `task:created`, `task:resumed`, `message` (`data.from='pm-agent'`), `approval:requested` (`data.type`), `approval:resolved`, `task:completed`, `task:stopped` (`src/system/event-bus.ts:10-17`; full EventType union also includes `agent:active`, `agent:inactive`, `agent:log`, `agent:bg_task`, `status`, `pr_card`, `reminder:*`).
- Edit-mode lifecycle: PM calls `request_edit_mode` → interactive buttons → task pauses; approval (Slack button or API) resumes with agents respawned on branch `archie/{taskId}`; edit-mode clones are NOT cleaned up on stop (`docs/architecture/edit-mode.md:13-75`).

## 3. Docker setup

- Compose service `archie`, build from `Dockerfile.dev`, port `${PORT:-3000}:${PORT:-3000}`, env from `.env`, restart `unless-stopped` (`docker-compose.yml:19-48`).
- Container env overrides: `CLAUDE_PATH=/usr/local/bin/claude`, `ARCHIE_WORKDIR=/workdir`, `SSH_AUTH_SOCK`, `NODE_ENV=development` (`docker-compose.yml:43-48`).
- Volumes: `./workdir:/workdir` (sessions/repos/plugins state — host-readable), `./src` + `./prompts` hot-reload mounts, `./secrets`, `./claude-data:/home/archie/.claude`, SSH agent socket (`docker-compose.yml:50-74`).
- Healthcheck: `curl -fsS http://localhost:${PORT:-3000}/health`, interval 30s, timeout 10s, retries 3, start_period 10s (`docker-compose.yml:76-81`).
- Sandbox needs `SYS_ADMIN` + seccomp/apparmor/systempaths unconfined for bubblewrap (`docker-compose.yml:27-36`); no Fargate (`DOCKER.md:196`).
- `Dockerfile.dev`: node:24-trixie-slim, non-root `archie` (uid 1001), CMD `npm run dev` (tsx watch) (`Dockerfile.dev:3,42-43,65`). `Dockerfile.prod` same base, CMD `node dist/index.js`.
- `.env` keys: `ANTHROPIC_API_KEY` required; `PORT=3000` default; Slack tokens optional; GitHub App vars; `ARCHIE_WORKDIR`, `ARCHIE_PLUGINS` (`.env.example:1-90`).
- No boot-time baseline documented; healthcheck window implies ~10-60s expected (`docker-compose.yml:76-81`). **Uncertainty:** cold `--build` and plugin auto-clone can push past this; needs empirical bound at implementation.

## 4. Skills & test infrastructure

- Skills live at `.claude/skills/{name}/SKILL.md` with YAML frontmatter (`name`, `description`) + markdown body; forge skill demonstrates multi-file layout with `stages/` subdirectory (`.claude/skills/forge/SKILL.md:1-74`).
- Tests: vitest; `npm test` → `vitest run --reporter=verbose` (`package.json`). CI on push/PR: `npm ci` → `npm run typecheck` → `npm run build` → `npm test`, plus gitleaks (`.github/workflows/ci.yml:14-26`). No docker in CI.
- No shell-test (BATS) precedent in repo; AC7's plain-CI testability points at TypeScript logic + vitest, following `wait-for-task.test.ts` fake-client/fake-clock pattern.
- `tsconfig.scripts.json` exists for `scripts/` compilation (rootDir `./scripts`, node types).

## 5. Prior art

- **PR #71** (draft, `feature/e2e-harness`, opened 2026-06-03): Slack round-trip smoke skill. On that branch: `.claude/skills/archie-e2e/SKILL.md` + `scripts/check-env.sh` (validates `ANTHROPIC_API_KEY` + Slack tokens, reports PORT), `scripts/ensure-archie.sh` (runs `npm run docker:dev`, polls `docker compose ps` for `(healthy)`, 60 × 3s retries), `scripts/resolve-bot.sh` (Slack `auth.test`). Its `wait-task.sh` was already deleted on-branch (commit `96d9305`) in favor of the MCP `wait_for_task` — exactly what the archived debug-mcp proposal anticipated (`openspec/changes/archive/2026-07-01-debug-mcp-wait-for-task/proposal.md:26`).
- Reusable from PR #71: check-env/ensure-archie boot+health patterns; nonce minting (`openssl rand -hex 4`); evidence-table format. Slack-specific parts (`resolve-bot.sh`, DM ingress) stay out of scope.
- **Name collision:** PR #71's skill dir is also `.claude/skills/archie-e2e/`. This run supersedes that path for CLI/API ingress; PR #71 remains draft Slack territory — the plan stage must state the supersede/coexist decision explicitly.
- **Forge expectations:** `docs/proposals/forge.md:106,127` names this harness as Stage 4's driver; `.claude/skills/forge/stages/4-qa.md:1-36` prescribes boot → nonce scenario → approve → evidence in `qa-evidence/{AC-id}/` → teardown, with blind QA-runner and independent verdict-reviewer roles.
- **No collisions in flight:** PR #63 (docker mount fix, helps), PR #172/#173/#176 (memory/OAuth/security, orthogonal), issues #50 (Slack unit tests) and #160 (in-sandbox checks) orthogonal. Issue #175 is this run's tracker.

## 6. Binding constraints

1. Debug MCP stays import-free from `src/`, consumed as-is — no fork, no edits (`tools/debug-mcp/server.ts:4`, brief non-goals).
2. Footprint: `.claude/skills/` + helper scripts (+ docs/`.env.example` at most); no `src/` engine changes (brief).
3. AC7: helper-script logic testable in plain CI — vitest, no docker (`.github/workflows/ci.yml:23-26`).
4. No Slack credentials required; CLI/API ingress only. Tasks created via API get CLI-channel attribution, not Slack (`src/connectors/api/routes.ts:170-190`).
5. Docker caps (`SYS_ADMIN`, unconfined profiles) are mandatory for the instance; harness documents, doesn't work around (`docker-compose.yml:27-36`).
6. Health wait must be bounded with clear failure output (brief AC1); `/health` is the contract (`src/index.ts:212-218`).
7. Model defaults untouched: PM → opus, others → sonnet[1m] (`src/agents/model-label.ts:28`); no cheap-model preset (inception decision).
8. All TypeScript must pass `npm run typecheck` + `npm run build` + `npm test` in CI.
9. Repo conventions: no hard-wrapped prose in docs; unified logger applies to `src/` code only — standalone scripts may use plain stdout/stderr (`CLAUDE.md`, `tools/debug-mcp/server.ts:49-50` precedent).
10. Evidence must be derivable from knowledge log + events.jsonl via MCP tools; workdir is host-mounted at `./workdir` so files are also directly readable (`docker-compose.yml:50-52`).

## 7. Open uncertainties (carried to plan stage)

- Evidence file schema does not exist anywhere — must be designed (AC4 requires "documented format").
- Boot-time bound under cold build/plugin clone: no data; AC1's bounded wait needs a generous but finite cap.
- Whether the app boots fully healthy with NO Slack tokens at all (constraints lens says optional per `.env.example:8-31`; not empirically verified on this machine).
- Nonce-window: `wait_for_task` scans 25 recent tasks; fine for serial scenarios, untested for parallel runs.
- ~~`npm run docker:dev` presence on main~~ — resolved by verifier: EXISTS at `package.json:23` as `docker compose up --build` — **foreground, no `-d`**. Harness must invoke compose detached itself (or wrap); PR #71's `ensure-archie.sh` backgrounds it differently on its branch.
