# Brief — archie-e2e: boot-from-branch E2E harness for live-instance QA

**Source:** [issue #175](https://github.com/sweatco/archie-hq/issues/175) · **Run:** `archie-e2e-harness` · **Date:** 2026-07-04

## Problem

Forge's QA stage (`.claude/skills/forge/stages/4-qa.md`) is designed to verify acceptance criteria against a live instance booted from the branch under test, but the harness that boots and drives that instance doesn't exist. Every `live-e2e` AC currently degrades to a waiver. This is the single biggest recurring verification gap across merged PRs ("I did not start the app against the live API", "best confirmed against a test workspace", "the deploy itself proves the fix").

This run is self-hosting: the harness's own ACs get verified at Stage 4 by executing the built harness against its own branch.

## Goals

A Claude Code skill in this repo, named **`archie-e2e`**, giving Forge Stage 4 — and any developer — four capabilities:

1. **Boot from branch**: from a checkout of any branch, one documented invocation runs `docker compose up --build -d`, waits for `/health` to report healthy (bounded wait, clear failure output), and confirms readiness.
2. **Drive scenarios headlessly** via the existing `archie-debug` MCP (`tools/debug-mcp/`): plant a nonce in the task message → `create_task` → `wait_for_task` (by nonce) → on `approval_requested`, approve edit mode via the `approve` tool / `POST /api/tasks/:id/approve` → read the knowledge log and event JSONL for assertions.
3. **Capture evidence** per scenario in a stable on-disk format (scenario name, assertions checked, event/log excerpts, pass/fail) that Forge can link from a PR's verification manifest.
4. **Tear down** cleanly (`docker compose down`), leaving no running containers.

## Non-goals

- **Cheap-model preset** — dropped at inception (2026-07-04). Runs use production-default models (Sonnet). No engine changes to model resolution. Issue AC5 dropped with it.
- **Slack ingress** — CLI/API ingress covers the PM loop without Slack; the Slack round-trip remains PR #71's territory.
- **Forking the debug MCP** — the harness consumes it as-is; the MCP stays ejectable and import-free from `src/`.
- **Engine changes** — expected footprint is `.claude/skills/` + helper scripts. If something turns out to need an engine change, flag it at plan stage, don't sneak it in.

## Constraints

- Debug MCP (`tools/debug-mcp/server.ts`) must stay import-free from `src/`.
- Requires local docker and a valid `ANTHROPIC_API_KEY`; must run entirely on the operator's machine.
- Prior art: PR #71 (draft, `feature/e2e-harness`) built a Slack round-trip smoke skill with helper scripts (`check-env.sh`, `resolve-bot.sh`, `ensure-archie.sh`, `wait-task.sh`). Research stage decides: adopt/extend or supersede (its nonce-correlation predates the debug MCP's server-side `wait_for_task`).

## Affected repos & risk class

- **Repo:** `sweatco/archie-hq` only.
- **Blast radius:** `.claude/skills/`, helper scripts, possibly `.env.example`/docs. No `src/` engine changes expected.
- **Risk class:** skills/tooling (below engine).

## Acceptance criteria

IDs match issue #175; AC5 dropped (cheap-model preset out of scope).

| ID | Criterion | Method |
|----|-----------|--------|
| AC1 | From a clean checkout of a branch with valid `.env`, a single documented invocation boots the instance and reports healthy; a broken branch produces a clear failure, not a hang. | live-e2e |
| AC2 | A scenario run creates a task with a nonce through the debug MCP, waits, and returns the task's terminal state plus its knowledge log. | live-e2e |
| AC3 | An edit-mode scenario detects `approval_requested`, approves via the API path, and observes the task proceed to completion. | live-e2e |
| AC4 | Each scenario writes an evidence file in the documented format; the file alone is enough for an independent reviewer to judge pass/fail. | live-e2e |
| AC6 | After a run, no containers from the harness remain (`docker compose ps` empty for the project). | live-e2e |
| AC7 | Any non-trivial helper scripts the harness adds are covered by tests runnable in plain CI (no docker). | unit |

**End-to-end proof:** Stage 4 of this run executes the built harness against its own branch — the evidence files it produces are the verification manifest for its own PR.
