# Changelog

Archie ships continuously, so changes are grouped by the **date they landed** on `main` rather than by version. Each entry leads with the **value** it delivers, then adds **technical detail**; pure plumbing stays technical. The [starting-point snapshot](#before-this-log--the-starting-point) at the bottom is where Archie stood before the first entry.

<!-- This file is generated automatically — do NOT edit it by hand. The `.github/workflows/daily-changelog.yml` workflow summarizes each day's merged PRs into a dated entry and commits it to `main` on its own. To shape how a change reads here, write a clear PR description — that is the source the automation reads. Quiet days with nothing merged are intentionally skipped (no entry), so gaps between dates are expected. Hand edits drift from the automation and may be overwritten; the only reason to touch this file directly is to repair a mistake the automation made. -->

## [Unreleased]

_Changes on `main` that haven't been summarized into a dated entry yet._

## 2026-07-08

- **Repos can now require a human ask before Archie merges a PR, instead of merging the instant it turns green.** A new per-repo `autoMerge` flag defaults to off everywhere: Archie holds a ready PR and posts a single "ready to merge" nudge instead of merging it; asking Archie to merge arms auto-merge, and it lands the moment GitHub reports the PR clean, no repeat approval needed. _Technical: repo frontmatter `autoMerge` boolean threaded through the registry; new `merge` approval type resolved atomically across Slack/API/CLI; per-PR `merge_armed`/`merge_ready_notified` markers reset on branch reuse to close a fail-open path; 8/9 ACs verified live, AC9 (first real post-deploy merge-on-request) waived to an operator step. PR #187._
- **Approving edit mode now actually grants write access — previously an already-running agent kept its read-only mount and every write silently failed after approval.** The repo agent is torn down and respawned with a writable clone the moment edit mode is approved, resuming the same session. _Technical: `edit_allowed` flushed synchronously before respawn so the re-spawn reads the fresh flag; new restart and boot-race regression tests. PR #191._
- **A background job that finishes mid-turn no longer leaves a task stuck as "waiting on a reply" for up to an hour.** A Bash/subagent task settling while the agent was mid-turn fell through a gap that never marked it done, so the idle-check kept treating the agent as busy until the wall-clock cap. _Technical: a turn-end `Stop` hook reconciles `agent.backgroundTasks` against the SDK's authoritative in-flight list instead of relying on notification-text parsing. PR #195._
- **Agents can no longer silently lose a "keep monitoring this" request.** Session-only `Cron*` tools looked durable but die with the ephemeral agent subprocess — one incident lost a stock-monitoring reminder for 6 days before a human caught it. _Technical: `CronCreate`/`CronList`/`CronDelete` blocked in every agent's `disallowedTools`; `set_reminder`'s description now steers agents to it as the durable, disk-persisted alternative. PR #196._
- **Forge can now review someone else's open PR end-to-end without taking ownership of the branch.** `/forge review <n>` (and its lighter `qa-only` depth) runs the same spec-compliance, bug-hunt, and live-e2e verification as a normal run, but never commits, pushes, or touches the branch — findings land in chat first and only post to GitHub on explicit approval. PR #194.
- **Archie can now be built and run behind a corporate TLS-intercepting egress proxy**, unblocking cloud/CI sandboxes that previously failed `npm ci` on the proxy's certificate or couldn't reach the Anthropic API at all. _Technical: opt-in CA trust (`secrets/extra-ca.crt`) installed into the dev image and forwarded to every spawned agent CLI via `NODE_USE_SYSTEM_CA`; `ssh-keyscan` made best-effort so a blocked port 22 no longer fails the build. PR #190._
- _Technical: fixed a fresh-clone Docker build failure (`secrets/.gitkeep` re-included so the CA-trust `COPY` step never hits an empty directory), and added a `CLAUDE.md` signpost so agents stop mistaking a not-yet-prepared sandbox for a missing e2e harness. PRs #199, #197._
- _Technical: dependency bumps — npm minor/patch group (Claude Agent SDK, Anthropic SDK, AWS Bedrock runtime client, Slack Web API, `@types/node`, tsx, vitest) and GitHub Actions minor/patch group (CodeQL, `claude-code-action`, Docker setup/login/build-push actions). PRs #189, #188._

## 2026-07-07

- **Three trust-boundary vulnerabilities — one critical, two high — found by an adversarial review are fixed before the memory-v2 branch lands on main.** A crafted GitHub webhook branch name containing shell metacharacters (single quotes, semicolons, `$()`) could execute arbitrary commands as the server user via `findTaskByBranch`'s `execSync` grep call; the PM's `fetch_slack_reference` tool could download any file the bot token could reach, not just those related to the active task; and a `getUserInfo` failure during canvas-creator lookup silently promoted external-authored canvases to internal, injecting untrusted content into PM prompts. _Technical: all four grep-based metadata scanners (`findTaskByThread`, `ByPRNumber`, `ByBranch`, `findTasksByStatus`) unified into a pure-filesystem `scanMetadataFiles` with JSON-encoded needles — `child_process` removed from the module entirely; `fetch_slack_reference` gated behind `collectCanvasFileAllowlist` derived from task metadata (each adopted channel canvas plus exactly the files it references); canvas classification now fails closed — prior classifications survive transient lookup failures, new canvases are skipped with a warning and retried on the next TTL scan. 13 new tests covering shell-metacharacter branch routing, fail-closed adoption, and allowlist union. PR #176._

## 2026-07-06

- **The `archie-e2e` harness no longer burns a full Docker build on a taken port, QA evidence now carries positive proof of which commit was under test, and `wait_for_task` correctly surfaces `APPROVAL_TYPE` on live instances for the first time.** Boot preflight probes the target port before any compose invocation — a stale archie is torn down and rebuilt from scratch, a foreign squatter causes auto-relocation to a free port, and an explicit `ARCHIE_URL` skips the check entirely. `GIT_SHA` (`rev-parse HEAD`, `-dirty` on unclean trees) is threaded through compose and verified against `/health` on boot; any mismatch hard-fails the harness so it never silently test the wrong code. The `wait_for_task` `APPROVAL_TYPE` bug (core read `e.data['type']`; engine emits `{ text, approvalType }`) was hidden by unit fixtures using the same wrong key — both now mirror the real event shape, and the edit-mode recipe reads the type directly from `wait_for_task` output. _Technical: compose `environment:` entry makes `PORT` authoritative inside the container (previously `env_file` silently diverged from the shell mapping on any override); `isConnectionRefused()` extracted as a pure helper, pinned for plain-cause, dual-stack `AggregateError`, and not-refused shapes; SKILL.md gains the macOS `DOCKER_HOST=unix://$HOME/.docker/run/docker.sock` credential remedy and real cold-boot timing (~45 s build, ~2 min to healthy on M-series). PR #186._

## 2026-07-05

- **Plugin agents can now forward binary files directly to MCP tools without passing bytes through the model's context.** The new `send_file_to_mcp_tool` tool accepts file paths (not raw bytes), base64-encodes them (up to 10 MB combined), and forwards a `tools/call` to one of the agent's already-connected HTTP MCP servers — reusing existing OAuth credentials, honoring the agent's sandbox read limits and tool-level restrictions. First consumer: the offer image-swap workflow (pairs with `set_offer_image` in sweatcoin-backend #13905). _Technical: wired to plain plugin agents only via an exported `shouldAttachFileBridge` predicate; stdio and legacy-SSE servers rejected; TOCTOU-safe ceiling (stat then re-check on read); `disallowedTools` and explicit allowlists enforced; 18-case focused test suite; Forge-verified with a live-e2e AC (7,028-byte PNG delivered byte-exact to a stub MCP server, SHA-256 confirmed). PR #167._

- **Forge's live-instance QA stage now has its own harness — live-e2e acceptance criteria are verified against a real running Archie instance instead of waved.** The new `archie-e2e` skill plus TypeScript CLIs boot Archie from any branch in Docker, drive PM-loop scenarios headlessly through the `archie-debug` MCP (nonce → `create_task` → `wait_for_task` → `approve`), capture per-scenario evidence files in a canonical JSON + rendered-markdown format an independent reviewer can judge, and tear down cleanly. This was also Forge run #1: the harness verified its own ACs against the branch under test. _Technical: `tools/e2e/` (`boot.ts` with bounded health-poll and fail-fast diagnostics, `evidence.ts` with atomic temp+rename writes and schema validation, `teardown.ts` with verified-empty compose-ps check); no `src/` or runtime changes; 64 new test cases (fake-clock/fake-exec, no Docker in CI); 6/6 ACs live-verified. PR #178._

- **Forge's `pr` mode now runs a research-grounded inception instead of trusting the PR author's description.** Before showing the brief, it runs a mandatory research pass — a diff mapper (what the code actually does vs. the PR's claims), a codebase-context lens (touched subsystems, existing coverage), and a base-branch drift check — all fact-checked by the Stage 1 verifier; contradictions are surfaced explicitly at sign-off. The same change moves archiving from post-merge to the merge gate: one final archive commit on the PR branch folds the spec delta and sets `stage: done`, so code and spec reach `main` atomically with no follow-up archive PR. _Technical: prompt-text-only changes to `stages/0-inception.md`, `stages/5-ship.md`, and `SKILL.md`. PR #183._

- **Forge gates now render their full content in chat before asking for approval, and unverifiable ACs are disclosed at inception.** The orchestrator must include the complete brief (or verification manifest) in the approval message — never a pointer to a file it wrote. Any AC the QA stage can't verify itself (`manual`, `deploy-only`, `live-e2e` without Docker) is listed in a "QA limitations" callout at inception sign-off, so the operator accepts the trade-off up front. A follow-up fix (PR #185) closed the same gap in pr-mode specifically: the reverse-inception subsection no longer contains its own mid-flow confirmation ask — the exit gate is the only gate, in both modes. _Technical: prompt-text changes to `SKILL.md`, `stages/0-inception.md`, `stages/5-ship.md`; `.gitattributes` marks `openspec/changes/**` as `linguist-generated` so run artifacts collapse in GitHub PR diffs. PRs #177, #185._

- _Technical: Forge run-state archives for both completed runs moved to `openspec/changes/archive/` — archie-e2e-harness (Forge run #1, PR #182) and pr-167-mcp-file-bridge (PR #184) — spec deltas folded, `stage: done` set, one-run-at-a-time guard released._

## 2026-07-04

- **Operators now have a repeatable, adversarially-verified loop — Forge — for taking any idea, GitHub issue, or existing PR to a tested, verified pull request.** The `/forge` command walks through inception (testable acceptance criteria with named verification methods: `unit`/`integration`/`live-e2e`/`manual`/`deploy-only`), fact-checked research, critic-hardened planning, adversarial implementation review, and black-box QA against a live instance via the `archie-debug` MCP; `live-e2e` ACs that need infrastructure not yet built are waived with a named post-merge step rather than silently skipped. Operation is local and operator-driven — one run at a time, two human gates (inception sign-off and merge decision), no Archie runtime change. _Technical: ships as `.claude/skills/forge/` (orchestrator `SKILL.md` + six self-contained stage files carrying verbatim role prompts) and `.claude/commands/forge.md`; run state in `forge.yaml` on a `forge/*` branch; entry points: idea, issue, pr (finish-mode), resume, abandon; `docs/proposals/forge.md` contains the full design rationale; Stage 1 machinery dry-run verified on a real target (30 cited claims, 29 confirmed, 0 wrong); a consistency review caught 3 blocking gaps — all fixed before merge (PR #174)._

## 2026-07-01

- **Debugging a task no longer requires busy-polling — one call blocks server-side until it settles.** The `archie-debug` MCP gains a `wait_for_task` tool that correlates a task by ID or nonce, then waits server-side until it reaches `completed`, `stopped`, or `approval_requested` (capped at ~45 s, resumable via cursor), returning the final state, attribution line, and any PM replies in one shot. _Technical: events are folded in order — `task:resumed` cancels a stale `task:stopped`, an unresolved `approval:requested` outranks the gate's deferred stop, and `completed` always wins; incremental polling via the existing `/events?after=` cursor; 13 unit tests; no Archie runtime change (PR #158)._

- **The daily changelog now writes itself.** A scheduled GitHub Actions workflow gathers merged-PR context (title, body, linked issues, commit subjects, diffstat) for the previous day, drafts the dated entry via Claude, and splices it into `CHANGELOG.md` on `main` automatically. _Technical: split into isolated `generate` (holds the Anthropic key, never the deploy key) and `publish` (runs no model, checks out fresh, pushes via deploy key) jobs; drafted entry crosses the job boundary as an env var to prevent injection; insert script is idempotent, tolerant of minor model noise, and refuses a malformed entry (PR #155)._

- _Technical: changelog workflow prompt refined in two follow-on passes — added a consolidation rule (fold minor plumbing into combined `_Technical:_` bullets, 3–6 bullet target) and then reframed it as theme-based grouping capped at three technical bullets (PRs #164, #165); dry-run mode added so a draft can be previewed in the run summary without committing to `main` (PR #163)._

## 2026-06-30

- **Specialist and plugin agents now run on Sonnet 5.** All specialist and plugin agents move from Sonnet 4.6 to Sonnet 5 — frontier-class with native 1M context — on the next deploy, with no configuration change required. _Technical: bumped `@anthropic-ai/claude-agent-sdk` to 0.3.197 (Claude Code v2.1.197), which resolves the `sonnet` alias to Sonnet 5; updated the Slack footer display label from "Sonnet 4.6" to "Sonnet 5" and its tests. PM stays on `opus` → Opus 4.8, unchanged._

- **Agents self-heal from API Overloaded errors instead of silently hanging for up to an hour.** When a turn ends with an SDK error (e.g. API "Overloaded" after the SDK exhausts its own retries), the agent now marks itself inactive immediately and enters the normal quiescence/recovery path — retrying the work rather than sitting orphaned. Previously this caused 44-minute stalls observed in production. _Technical: in the spawn loop, a `result` event with a non-success subtype calls `updateAgentState(false)`, guarded on `agent.session.active` to prevent double-fire with the `Stop` hook._

- **Concurrent task triggers no longer cause duplicate agent spawns.** When a GitHub webhook, Slack reply, and startup recovery all fire for the same parked task in one async tick, exactly one set of agents spawns — previously each trigger built its own `Task` instance and raced, leading to duplicate PR actions and looping agents. _Technical: `Task.sendMessage` funneled through a per-`taskId` keyed lock; the first caller activates and registers the canonical instance, the rest enqueue onto it. Regression test added._

- _Technical: CHANGELOG rewritten as a 30-day day-by-day history with value-first entries (PR #154); GitHub issue templates cleaned up to a single Type badge, dropping the redundant title prefix and label (PR #146); `archie-debug` MCP port resolution now reads from `ARCHIE_URL`, `PORT` env, or repo `.env` instead of hardcoding `localhost:3000` (PR #134); Docker dev healthcheck switched to `curl` (installed in the image) because `wget` is absent from the base image (PR #133); CI changelog job now pushes via deploy key to clear the protected-branch ruleset; dependency bumps: `@anthropic-ai/sdk` 0.105→0.107, `@aws-sdk/client-bedrock-runtime` 3.1075→3.1076, `@types/node` 26.0.0→26.0.1; no-hard-wrap prose convention added to CLAUDE.md._

## 2026-06-29

- **Every change Archie makes is traceable to the person who approved it.** Commits made in edit mode are now authored as the human who approved edit mode, with an Archie co-author trailer — a clean, auditable attribution chain. _Technical: swapped the Claude commit trailer for an Archie one, added an author diagnostic, and hardened the author injection against spoofing (review follow-up)._

- **Agents can build and test projects that pull dependencies.** Repo build sandboxes in edit mode may now reach trusted package registries, so dependency installs and builds work inside the sandbox. _Technical: network allowlist for trusted package registries within the edit-mode sandbox._

- _Technical: README and first-impression polish (positioning as an "AI employee", "why a team, not a single agent", "runs on one server"), PR template rewritten to the repo's house style, and the changelog switched to this date-based model._

## 2026-06-28

- **Archie keeps a living project context per Slack channel.** A per-channel "Archie" canvas gives the PM durable project context for each channel, so it stays oriented across separate threads in the same channel. _Technical: `feat(slack)` channel-canvas plus a channel-canvas PM skill shipped as an engine core skill._

- **A live PR status card in the thread — no one has to poll CI.** Pull requests now post a self-updating Slack card showing CI and review state, refreshing as events arrive. _Technical: dedicated card block with instant post and CI counts; refreshes on more events (subscribe to `check_run` + `status` webhooks); task resolved by branch; a keyed-lock mutex serializes card writes; PM/agents told not to poll CI._

- **Transparency into which models did the work.** A response footer lists every distinct model used in a turn. _Technical: footer aggregates and beautifies the model list._

- **Clearer progress on long-running work.** Background tasks surface as a single chat entry that moves from running → done, and agents stay shown as active while background work is pending. _Technical: also fixed the CLI dropping events that arrive in the same tick._

- _Technical: persisted the v30 repositories-shape migration once (at persist, not per load) and quieted its log; added completion-quiescence unit tests._

## 2026-06-27

- **Tasks reliably finish and recover instead of hanging.** Reworked task completion to a "completion-as-quiescence" model. _Technical: run deferred teardown on agent exit (not only on `result`), fixed the recovery loop when a task completes during deferred teardown, and added a design doc._

## 2026-06-26

- **Agents handle much larger tasks and codebases without losing context.** Specialist agents default to the 1M-context model and dynamic agents spawn on Opus. _Technical: non-PM agents default to `sonnet[1m]`; dynamic agents default to Opus._

- **Long jobs have room to finish.** The per-task wall-clock cap was raised from 30 to 60 minutes.

- _Technical: plugin submodule robustness (sync submodule URLs before update, force submodule init on every startup, mount symlinked skill dirs into the agent workspace); added `pull-tasks.sh` to download task sessions by id or day over SSH; added then disabled a context-probe debug proxy._

## 2026-06-25

- **You can see what Archie is doing in real time.** A live "Archie is…" status indicator in Slack reflects current agent activity — which domain it's in, whether it's coordinating, what external system it's touching — instead of a silent wait. _Technical: driven by agent activity; phrasing derived from MCP metadata; mirrored to the CLI and logs; kept alive past Slack's ~2-minute timeout; gated behind `ARCHIE_LIVE_STATUS`. Branded rotating loading messages added too._

- **Approve edit mode once and it covers the whole task.** Edit mode is now a clear task-lifetime grant and `request_edit_mode` is idempotent. _Technical: also fixed a stream-closed loop when edit mode is approved very fast._

- **The PM can pull in an engineer for any configured repo on the fly.** New on-demand repo-agent spawning. _Technical: `list_available_repos` and `spawn_repo_agent` tools (data + infra + prompt), with the dynamic agent reachable in the same session._

- **Agents can read a repo's security alerts.** Added code-scanning (CodeQL) alert tools for repo agents.

- _Technical: TypeScript 6 / Docker prod-build fixes and a batch of dependency bumps (typescript, @types/node, react, ink, dotenv, GitHub Actions)._

## 2026-06-24

- **Archie is now open source.** v1 open-source preparation under AGPL-3.0. _Technical: de-identification, bundled example plugins, docs, and CI; dropped a stale license note from the README._

- _Technical: CI hardening — Dependabot config plus an advanced CodeQL workflow, Docker build migrated into GitHub Actions, and pinned action versions._

## 2026-06-23

- **Research requests come back with fuller answers.** Fixed and tuned the web research pipeline. _Technical: send `max_output_tokens` to Perplexity for Anthropic models, raise the default to 64000, and fix the research preset classifier always falling back to pro-search._

## 2026-06-22

- _Technical: sync plugin submodules on refresh._

## 2026-06-20

- **One agent can work across several related repositories.** Multi-repo agents declare and eager-mount multiple repos. _Technical: also migrated repo-agent branches to an `archie/` prefix and symlinked plugin skills for repo agents, not just plugin agents._

## 2026-06-18

- **The PM routes "check Jira / look at Rollbar" to the teammate that actually has access.** Each agent's external (MCP) integrations are surfaced in the PM's live context. _Technical: added `pull-remote-data.sh` to fetch memory and sessions over SSH._

## 2026-06-15

- **External integrations stay connected.** OAuth reliability fixes. _Technical: replay the RFC 8707 resource indicator on token requests; stop the CLI refresh from corrupting `updated_at`/`expires_at`; log MCP connection failure reasons instead of a bare `FAILED`._

## 2026-06-11

- **Archie doesn't bleed one request's work into unrelated threads.** The PM now contains work within the current task/thread by default. _Technical: also repaired the idle-recovery target so waiting tasks don't hit the wall-clock cap._

## 2026-06-08

- _Technical: pass `HOME` in the agent environment so hook `~` paths expand._

## 2026-06-05

- _Technical: added OpenSpec workflow commands and skills (dev tooling)._

## 2026-06-02

- **Editing a Slack message Archie is following is picked up.** Tasks wake on message edits in followed threads. _Technical: drop the previous text from edit-log entries._

- _Technical: large agent-spawn/tools refactor — PM tools split into comms/orchestration/scheduling, shared agent-tools hoisted into the MCP default, plain-plugin config made the default with repo/branch deviations, and dead code removed._

## 2026-06-01

- **Archie works in private channels and group DMs.** Added private channel and group DM support to the Slack manifest (and dropped the unused `message.mpim` subscription).

- **Plugin changes go live without a restart.** Plugin updates are picked up on a task's next ping, the PM context shows the plugins-repo version, and refresh uses a HEAD check instead of a TTL. _Technical: dropped repo cloning from plugin sync; sync only when a task reloads from disk, not in-flight._

- _Technical: pinned npm to v11 across environments and fixed Docker `npm ci` (complete lockfile + Express param types)._

## Before this log — the starting point

Where Archie HQ stood before the first dated entry (late May 2026) — the foundation everything above built on.

### Already in place

- **An AI employee you work with in Slack.** Delegate a task in a Slack thread (or the local CLI) and Archie gets it done, then reports back. To users it presents as a single assistant that writes as "I" — the multi-agent machinery underneath is never exposed. It is **non-proactive** (only acts in response to a Slack message or GitHub webhook, never on its own) and **interruptible** (tasks can be stopped, resumed, and recovered).

- **A team of agents, not one chatbot.** A **PM agent** (Opus) reads the request, loads the relevant skill, and delegates to specialist agents (Sonnet). A designated **task owner** coordinates the work — sequentially or in parallel — and synthesizes the result. Agents talk to each other peer-to-peer and write discoveries, decisions, and blockers to a shared **knowledge log** that every agent reads for context.

- **Plugin architecture — add a department, not a fork.** New domains and abilities are added by dropping a plugin directory into the plugins repo; the engine discovers and loads them at startup with no core code changes. A plugin can contribute repo agents, plugin agents, a PM overlay, agent skills, hooks, and MCP server bindings.

- **Repo agents for engineering work.** Agents bound to a GitHub repository work in isolated shared git clones. They are **read-only by default**; once a human approves **edit mode**, the agent gets a feature branch, commits, and opens and manages its own pull requests.

- **Plugin agents for every other domain.** Marketing, analytics, ops, support, research, and more — lightweight agents that get a workspace, skills, and any MCP tools you wire up, with no git infrastructure.

- **GitHub integration with a merge orchestrator.** A webhook-driven PR workflow routes reviews, comments, CI results, and pushes to the right task, and merges pull requests automatically once they're ready. Force pushes are disallowed and pushing is blocked from agent Bash.

- **Human approval gate for any change.** Agents cannot modify code until a human approves edit mode via Slack buttons — the read-only-to-edit transition is an explicit, auditable step.

- **OS-level sandbox with defense-in-depth.** Each agent runs under per-agent filesystem isolation (bubblewrap on Linux, sandbox-exec on macOS), a network deny-all from agent Bash, and tool denylists — so a misbehaving or prompt-injected agent stays contained.

- **Web research pipeline.** Multi-agent web research with structured output and prompt-injection defenses, bounded by per-task budgets.

- **Per-task isolation and recovery.** Every task is its own runtime with isolated message queues, task-scoped budgets (research requests, inter-agent messages, wall-clock timeout), and metadata plus the knowledge log persisted to disk. Tasks recover automatically after a restart.

- **Persistent memory (optional, behind `ARCHIE_MEMORY`).** A cross-task memory layer so agents "arrive informed" instead of starting cold each time — user preferences, a rolling activity index, per-task summaries, and a graph of entity pages for the systems and concepts the work keeps touching. Plain Markdown, no database, removable as a single unit.

- **Encrypted secrets and OAuth.** External integrations connect via an OAuth flow, with tokens stored in an encrypted vault validated by a master key at startup.

- **Runs without Slack or GitHub.** A bundled example plugin set and an interactive CLI make a fresh clone runnable with only an Anthropic API key; Slack and GitHub are optional integrations.

- **Deployment and CI.** Docker Compose for dev and prod, an image published to GitHub Container Registry on every `main` build, and CI that runs typecheck, build, and tests. _(Dependabot, the CodeQL scan, the Docker-in-GitHub-Actions build, and AGPL-3.0 open-sourcing all arrived during the window above.)_

[Unreleased]: https://github.com/sweatco/archie-hq/commits/main
