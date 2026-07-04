## Why

Forge's QA stage (`.claude/skills/forge/stages/4-qa.md`) is designed to verify `live-e2e` acceptance criteria against a live instance booted from the branch under test, but the harness that boots and drives that instance does not exist. Every `live-e2e` AC currently degrades to a waiver — the single biggest recurring verification gap across merged PRs ("I did not start the app against the live API", "the deploy itself proves the fix"). The building blocks are already in place: the `archie-debug` MCP (`tools/debug-mcp/`) gives headless task creation, server-side nonce-correlated waiting, approval, and log/event reads; docker compose gives a reproducible boot; the workdir volume makes evidence directly readable. What is missing is the skill that sequences them — boot, drive, capture evidence, tear down — in a form Forge Stage 4 and any developer can invoke.

## What Changes

- Add a new Claude Code skill **`archie-e2e`** at `.claude/skills/archie-e2e/SKILL.md` that documents the full harness lifecycle: boot from branch, drive scenarios headlessly, capture evidence, tear down. This path currently belongs to PR #71's draft Slack-round-trip variant; this change **supersedes that path** — PR #71's Slack-specific material rebases on top later (see design).
- Add TypeScript helper CLIs under `tools/e2e/` (run via `npx tsx`, mirroring `tools/debug-mcp/` conventions): a **boot** command that runs `docker compose up --build -d` and performs a bounded `/health` wait with fail-fast container-exit detection and clear failure diagnostics; an **evidence** writer that validates and renders a documented per-scenario evidence schema; a **teardown** command that runs `docker compose down` and verifies no project containers remain.
- Scenario driving stays agent-driven through the existing `archie-debug` MCP consumed **as-is** (`create_task` with a planted nonce → `wait_for_task` by nonce, resumable via cursor → `approve` on `approval_requested` → `get_log`/`get_events` for assertions); the skill codifies the exact recipes. Zero changes to `tools/debug-mcp/`.
- Document the evidence file format (JSON schema `archie-e2e-evidence/v1` plus a rendered markdown companion) with a parameterizable destination so Forge Stage 4 can point it at `openspec/changes/<change>/qa-evidence/`.
- All non-trivial helper logic lives in dependency-injected TypeScript cores covered by vitest tests runnable in plain CI (no docker), following the `tools/debug-mcp/wait-for-task.test.ts` fake-client/fake-clock pattern.

## Capabilities

### New Capabilities

- `archie-e2e-harness`: boot-from-branch E2E harness — one documented invocation boots a live instance from a checkout and reports healthy or fails clearly; scenarios are driven headlessly via the archie-debug MCP with nonce correlation and approval handling; each scenario emits an evidence file in a documented, reviewer-sufficient format at a parameterizable destination; teardown leaves no project containers; helper logic is unit-tested in plain CI.

### Modified Capabilities

<!-- None. The debug MCP capability (debug-mcp-task-waiting) is consumed unchanged; no existing spec covers docker or skills. -->

## Impact

- **Code**: new files only — `.claude/skills/archie-e2e/SKILL.md`, `tools/e2e/*.ts` (+ `tools/e2e/*.test.ts`), one `.gitignore` line for the default local evidence directory. **No `src/` engine changes, no edits to `tools/debug-mcp/`, no new required env vars** (all tunables have defaults and are overridable via flags or optional env vars).
- **APIs**: consumes existing surfaces only — `GET /health`, the archie-debug MCP tools, and `docker compose` against the existing `docker-compose.yml`.
- **Consumers**: Forge Stage 4's QA runner gets a real harness instead of blanket waivers; developers get a documented one-command boot/verify/teardown loop. PR #71 (draft, `feature/e2e-harness`) loses the `.claude/skills/archie-e2e/` path and rebases its Slack round-trip on top of this skill.
- **Dependencies**: none new — node builtins, `tsx` (already a dependency), vitest (already the test runner).
