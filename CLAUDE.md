# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Important

Please familiarize with the codebase. The `docs/architecture/` folder describes the current system accurately. The `docs/plans/` folder contains historical development plans. The `docs/proposals/` folder contains unimplemented ideas.

## Project Overview

Multi-agent AI software engineering system built with Claude Agent SDK. Specialized agents collaborate on tasks across multiple repositories via Slack integration.

## Technology Stack

- **Runtime**: Node.js with TypeScript
- **Agent Framework**: Claude Agent SDK
- **Integrations**: Slack API, GitHub App (Octokit)
- **Storage**: File-based sessions
- **Version Control**: Git

## Architecture Overview

Slack / CLI / GitHub → Task → PM agent → subagents it spawns

- **One agent per task**: the PM, a single Claude Agent SDK session resumed across turns. It is the only agent Archie spawns itself and the only one that can talk to users.
- **Delegation** goes through the SDK's built-in `Agent` tool — either an agent type a plugin defines (loaded natively, `plugin:agent`) or the general-purpose worker with a model named per spawn. Subagents run inside the PM's own process; only their final report reaches its context.
- **Repos are mounted, not declared**: `mount_repo("owner/repo")` clones into the task on demand. Read-only until edit mode is approved, which flips the clones writable and resumes the PM's session.
- **Wakes carry their content** — a Slack message or GitHub event reaches the PM as the text itself. `knowledge.log` is a write-only record for memory extraction and audit; the PM never reads it.
- **Plugins** contribute skills and agent definitions, loaded natively by the SDK. MCP servers, the network allowlist and the PM's overlay stay engine-owned in the plugins repo's root `.mcp.json`, `archie.json` and `pm.md`.
- `docs/` contains architecture docs, guides, historical plans, and proposals

## Working Directory

All runtime state (plugins, base clones, sessions, caches, triggers) lives under `ARCHIE_WORKDIR` (default: `./workdir`). The app auto-clones plugins from the `ARCHIE_PLUGINS` git URL on startup, and warm-clones the repos the plugins repo's `archie.json` marks `warm: true`; everything else is cloned on demand by `mount_repo`. See `src/system/workdir.ts` for the bootstrap logic.

## Development Setup

```bash
npm install          # Install dependencies
npm run dev          # Development server with hot reload
npm run build        # TypeScript compilation
npm run typecheck    # Type checking only
```

See `docs/guides/local-development.md` for full setup instructions.

## E2E harness

A live boot-from-branch E2E harness ships here (the `archie-e2e` skill + `tools/e2e/`). To verify a branch against a running instance, load the `archie-e2e` skill instead of hand-rolling a boot. In a fresh checkout or cloud sandbox it can *look* unavailable (preflight / Docker / TLS errors) until it's prepared — that's a setup gap, not a missing capability, so load the skill; for a cloud sandbox behind a TLS-intercepting proxy the runbook is `docs/guides/e2e-in-cloud-sandbox.md`.

## Logging

Use the unified logger (`src/system/logger.ts`) for all console output. Never use `console.log/error/warn` directly. The logger provides color-coded, semantic logging methods for agents, system events, and errors.

## Writing Conventions

**Never hard-wrap prose.** In Markdown and other prose (docs, `CHANGELOG.md`, PR descriptions, comments), write each paragraph or bullet as a single line and let it soft-wrap. Do not insert manual line breaks to hit a column width — they make edits and diffs noisy. Only code (fenced blocks, indented samples) may span fixed-width lines.

## Changelog

`CHANGELOG.md` is generated automatically — **do not maintain it by hand.** A scheduled GitHub Actions workflow (`.github/workflows/daily-changelog.yml`) summarizes each day's merged PRs into a dated entry and commits it to `main` on its own. Do not add, edit, or remove `CHANGELOG.md` entries as part of your work — not on a feature branch, not in a PR, not "while you're in there." The way to shape what appears is to write a clear PR description: that is the source the automation reads. Quiet days with nothing merged are skipped on purpose, so gaps between dates are expected and not something to fill in. The only legitimate reason to touch `CHANGELOG.md` or its workflow directly is to fix the automation itself.

## Git Workflow

**IMPORTANT**: Only create commits when explicitly requested by the user. Never commit code automatically.

When creating commits (only when asked):

- **Use atomic commits**: Each commit should represent a single logical change
- **Group related changes**: If multiple files change for the same feature, commit them together
- **Clear commit messages**: Use descriptive messages that explain what changed and why
- **Exclude drafts**: Don't commit draft documentation or proposals unless specifically requested
