# Proposal: Forge — idea → verified PR development loop

> **Status:** Accepted — not yet implemented

## Summary

Forge is a staged development process that takes an idea — described in chat, filed as a GitHub issue, or embodied in an existing PR — and produces a verified, end-to-end-tested pull request. It runs as a Claude Code harness in this repo (skills + a `/forge` command + persisted per-run state), reusing three assets that already exist: **OpenSpec** as the plan artifact store, the **archie-debug MCP + REST API** as the headless E2E driver, and the **QA plugin's analyst → independent-reviewer pattern** as the verification model. Forge is the intended basis of Archie's future self-improvement loop: once stable as a local workflow, it ports into Archie itself (`archie-agent` already mounts both `archie-hq` and `archie-plugins`).

The name: raw idea in, forged into a tested artifact out. Commands read naturally as verbs — `/forge <idea>`, `/forge issue 150`, `/forge pr 112`, `/forge resume`.

## Motivation

Analysis of the 30 most recently merged PRs shows a consistent de-facto verification contract — typecheck + full vitest count + targeted new tests, then a candid "couldn't verify here" section — and five recurring gaps that get deferred to "confirm on deploy": the Slack round-trip, live SDK runtime behavior, GitHub Actions workflows, GitHub platform rendering, and production-only state. PR #132 exists solely to observe in production what #129 could not verify pre-deploy. Meanwhile the best PRs already do informally what Forge systematizes: #125 ran a 2-round design review plus an independent subagent review, #129 had an adversarial review pass, #138 mutation-checked its tests, #158 was verified live against a running instance.

The pieces of this process exist but are disconnected: OpenSpec captures plans but nothing drives implementation from them under verification; the QA plugin has a genuine two-pass review loop but it is advisory and never gates engineering work; the debug MCP can drive a live instance but no workflow uses it routinely; idea intake (`sweatcoin-idea-proposal`) dead-ends at a Notion row. Issues #160 (in-sandbox checks), #152 (built-in tool support), #147/#148 (plan mode + artifact UI), #143 (auto-review on Archie PRs), and #139 (merge policy) are all fragments of this same loop.

## Goals

- One repeatable process from idea to verified, tested, mergeable PR — quick and predictable in cost and shape.
- Every stage produces a persisted artifact, so a run is resumable and the process can be entered at any stage (including "finish and verify this existing PR").
- Verification is performed by fresh-context subagents with distinct roles, never by the author of the thing being verified, to counter model self-bias.
- Exactly two human touchpoints in the normal path: inception sign-off and the merge decision. The plan is published for visibility but does not block the run.

## Non-goals (for the initial version)

- Automatic launch on PR-opened / issue-opened webhooks (later phase, see Rollout).
- Moving the inception interview into GitHub issue conversations (depends on issue tools, #150).
- Automatic rebase-and-resolve of sibling PRs on merge (later phase).
- Running inside Archie's production agents (port after the local workflow is proven).

## The stages

Run state lives in the OpenSpec change directory (`openspec/changes/<change>/`) plus a small `forge.yaml` recording the current stage, verdicts, and evidence links. Every artifact is committed with the change.

### Stage 0 — Inception (interactive)

Input: an idea, an issue number, or a PR number. An interviewer role produces an **inception brief**: problem, goals, non-goals, constraints, affected repos, risk class, and — the load-bearing part — **numbered, testable acceptance criteria**. The ACs written here are the contract every later stage verifies against; final QA checks these, not the implementer's claims. For each AC the interviewer forces the verification method to be declared up front: unit / integration / live-instance E2E / deploy-only-with-named-post-merge-step. The interviewer asks the user questions until requirements are unambiguous, and may perform **web research** where an external fact is load-bearing (SDK capabilities, Slack API limits, third-party service behavior) rather than asking the user something the web answers better. Ends with user sign-off on the brief — the first of the two human gates.

### Stage 1 — Research

Parallel fresh-context subagents, each with a distinct lens:

- **Codebase mapper** — subsystems touched, existing patterns to follow, `file:line` citations mandatory.
- **Prior-art scanner** — open PRs, closed PRs, issues, `docs/plans`, `docs/proposals`, the openspec archive. Prevents re-doing in-flight work or colliding with open PRs.
- **Constraints scanner** — architecture docs, security model, sandbox rules.
- **Web researcher** (when the brief flags external unknowns) — upstream SDK/API documentation and changelogs, with sources cited. Recent merged PRs repeatedly hinged on exactly this class of fact (SDK version→model mapping in #157, cache TTL semantics in #166).

Then one verification pass: an adversarial checker re-reads the dossier and tries to refute each factual claim against the actual code or cited source; unverifiable claims are cut. Research that hallucinates poisons everything downstream — this is the cheapest place to catch it. Output: research dossier in the change dir.

### Stage 2 — Plan

A planner (fresh context; input = brief + dossier only) produces the OpenSpec artifacts — `proposal.md`, `design.md`, `tasks.md`, spec deltas — plus a **verification plan** mapping every AC to its method and expected evidence. Two verification passes by *different* critics:

- **Pass A — completeness critic**: does the design satisfy every AC? Missing edge cases, migrations, rollback, recovery-path interactions?
- **Pass B — red team**: fresh context, instructed to refute — blast radius, security, a simpler-alternative challenge to fight overengineering, and "what does this break that no test covers?"

The planner revises; the loop is capped at 3 rounds. The finished plan is **published to the user but does not block**: the run proceeds directly into implementation. The user can interrupt and redirect at any time; the artifact also satisfies the plan-visibility ask in #147 and, post-merge, archives into `openspec/specs/` as living system documentation.

### Stage 3 — Implement

An implementer works through `tasks.md` sequentially, running typecheck + targeted tests per task and flipping checkboxes (a crashed run resumes at the first unchecked task). Then two verification passes by fresh-context reviewers who see **the diff and the plan, never the implementer's reasoning**:

- **Pass 1 — spec compliance**: every task done, every AC's code-level claim true, nothing beyond the plan (scope creep is a defect).
- **Pass 2 — adversarial bug hunt**: correctness review with a confirm/refute verdict per finding, including **mutation-checking new tests** (revert the fix, assert the test fails — codifying what #138 did by hand).

Findings route back to the implementer; capped at 3 rounds. Exit: clean typecheck, build, full suite, both reviewers pass.

### Stage 4 — QA (black-box, live instance)

The QA runner receives *only* the inception ACs and the verification plan — mirroring the QA plugin's deliberate-ignorance principle — and:

1. **Boots the system under test from the branch**: `docker compose up --build`, wait for `/health` healthy, seeded with a reproducible workdir fixture.
2. **Drives real scenarios** through the archie-debug MCP: plant a nonce, `create_task`, `wait_for_task`, approve edit mode via `POST /api/tasks/:id/approve` when the gate fires, read the knowledge log and event JSONL, assert each AC against observed behavior. This exercises the real SDK, real agent spawns, real persistence — the exact category merged PRs kept deferring.
3. **Records evidence per AC**: event excerpts, log lines, health output. ACs that genuinely cannot be verified locally (Slack rendering, prod-only state) are declared as waived with a named post-merge step — the existing candor convention, but as structured output.
4. **Second pass — QA verdict reviewer** (qa-reviewer pattern): independently reads the evidence and rules each AC verified / unverified / waived.

Failures route back to Stage 3 with the failing scenario attached, and the scenario is kept as a regression fixture for future runs — the seed of an accumulating eval suite and the self-improvement flywheel.

### Stage 5 — Ship

Assemble the PR in house style (What & why / How it works / Verification), with the **verification manifest** — the AC table with evidence links and explicit waivers — as the Verification section. Link the plan artifact, push, open the PR, watch CI, address review feedback, and apply per-repo merge policy (never auto-merge by default; #139). The merge decision is the second human gate. Post-merge: archive the OpenSpec change and file follow-ups for waived ACs.

## Entry points

- `/forge <idea>` — full run from Stage 0.
- `/forge issue <n>` — the issue body seeds the inception interview.
- `/forge pr <n>` — finish-this-PR mode: a reverse-inception pass reconstructs the brief and ACs from the PR description and linked issue (asking the user to confirm gaps — "what would make you comfortable merging this?"), then runs Stages 3→5: finish, verify, QA live, ship.
- `/forge resume` — continue the active run from its recorded stage.

## Concurrency: one run at a time

Forge runs **serially — WIP limit 1**. Parallel runs would fight over the shared local docker instance (one port, one workdir) during QA, would generate rebase churn against each other (the open-PR history shows changes repeatedly touching the same surfaces: `spawn.ts`, prompts, memory, task lifecycle), and would make cost and wall-clock unpredictable — the opposite of the goal. Parallelism lives *within* stages instead: research lenses fan out concurrently, review passes run concurrently where independent.

The serial discipline also sets the operating order: first drain the existing open-PR backlog via `/forge pr` (merge or close each), then work the issue backlog one at a time.

## Anti-bias mechanics

Every reviewer/critic/QA role is a fresh-context subagent that receives artifacts, never conversation history. Critics are prompted to refute, not appraise. The rings get progressively blinder: plan critics see brief + dossier + plan; implementation reviewers see plan + diff but not rationale; QA sees neither code nor diff — only ACs and the live instance. All loops are capped (2–3 rounds) and every pass emits a structured verdict, keeping runs predictable in cost and shape.

## Tooling to build (prioritized)

1. **E2E harness skill** (extends the draft archie-e2e work in #71 + the debug MCP): boot-from-branch, health-wait, nonce-task, API-approve, evidence capture, teardown. The single biggest unlock — it converts "live runtime not verifiable" into a routine check.
2. **Cheap-model E2E mode**: an env preset (e.g. `ARCHIE_E2E=1`) pinning the system-under-test's agents to cheaper models so QA runs don't burn premium tokens on scaffolding-level assertions.
3. **API/connector integration tests**: a supertest-style suite over the Express app (`src/connectors/api/routes.ts` is untested and the whole QA stage depends on it), plus signed synthetic webhook replay into `/github/webhooks` to test CI/review/merge routing without real GitHub events.
4. **Fixture seeding**: a reproducible `workdir` fixture set (test plugin, sample tasks, optional memory store); `scripts/pull-tasks.sh` already shows the shape.
5. **Test Slack workspace + Slack-read verification** (deferable): CLI/API ingress exercises nearly all PM logic without Slack; Slack-side rendering (Block Kit, canvases, status) is verified cheapest via a test workspace and Slack API reads, not browser control. Defer browser/headless tooling until something genuinely visual demands it.
6. **GitHub Actions dry-run**: for workflow-file changes, `act` or a dispatch-with-dry_run convention — closes the changelog PRs' recurring "re-run after merge" gap.

## Rollout phases

- **Phase 0 — backlog drain.** Build the skeleton (`/forge` command, `forge.yaml` state, Stages 0/2/3 wired to OpenSpec, both review passes) plus tooling items 1–2. Dogfood `/forge pr` on the existing open PRs, one at a time, until the backlog is merged or closed.
- **Phase 1 — issue-driven runs.** Work the issue backlog serially with full six-stage runs. Accumulate QA regression fixtures.
- **Phase 2 — rebase-on-merge.** When any PR merges, the active run (and remaining open PRs) rebase; conflict resolution is grounded in two inputs — the PR's own plan artifact (its intent) and the merged diff since the branch point — rather than blind textual resolution.
- **Phase 3 — automation.** Launch Forge automatically: PR-opened → `/forge pr` with the merge decision deferred to a human; issue-opened → a run whose inception interview happens **in the issue conversation** (requires GitHub issue tools, #150, and relates to `docs/proposals/github-mention-workflow.md`). Review comments on Forge-opened PRs are addressed automatically; when a human instead fixes the PR directly, they note in a PR comment what was changed and why, and Forge treats that as ground truth on its next pass rather than reverting it.

## Human touchpoints

Two in the normal path: inception sign-off and the merge decision. In between, the run proceeds autonomously and surfaces structured verdicts; it comes back to the user only if an AC proves unverifiable or the plan requires a genuine scope change.

## Relationship to existing work

- **OpenSpec / opsx skills** — Forge's Stage 2 is the existing propose flow, wrapped with critics and a verification plan; archive-on-merge is the existing archive flow.
- **archie-debug MCP (`wait_for_task`, spec `openspec/specs/debug-mcp-task-waiting/`)** — Stage 4's driver.
- **QA plugin (`archie-plugins/qa/`)** — the analyst → independent-reviewer two-pass model and black-box discipline, applied to engine verification.
- **PR #71 (archie-e2e skill)** — seed of tooling item 1.
- **Issues #147/#148** — plan visibility is delivered by the published Stage-2 artifact; a richer web view remains #148.
- **Issue #143** — an automated review on Archie PRs slots into Stage 5 as an additional reviewer signal.
