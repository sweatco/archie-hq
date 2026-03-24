# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Important

Please familiarize with the codebase. The `docs/architecture/` folder describes the current system accurately. The `docs/plans/` folder contains historical development plans. The `docs/proposals/` folder contains unimplemented ideas.

## Project Overview

Multi-agent AI software engineering system built with Claude Agent SDK. Specialized agents collaborate on tasks across multiple repositories via Slack integration.

## Technology Stack

- **Runtime**: Node.js with TypeScript
- **Agent Framework**: Claude Agent SDK (Sonnet 4.5, 1M context)
- **Integrations**: Slack API, GitHub App (Octokit)
- **Storage**: File-based sessions
- **Version Control**: Git

## Architecture Overview

Slack messages → PM Agent → Specialist Agents (Backend, Mobile)

- **Triage agent** (Haiku) is currently disabled — messages route directly to PM
- **PM agent** manages tasks, assigns owners, communicates with users via Slack
- **Specialist agents** (Backend/Mobile) investigate and modify codebases (readonly by default, edit mode after approval)
- **Plugin agents** handle non-engineering domains (generic, no git infrastructure)
- Agents communicate via message queues and shared `shared-knowledge.log`
- `docs/` contains architecture docs, guides, historical plans, and proposals

## Working Directory

All runtime state (plugins, repos, sessions) lives under `ARCHIE_WORKDIR` (default: `./workdir`). The app auto-clones plugins from `ARCHIE_PLUGINS` git URL and repos declared by plugins on startup. See `src/system/workdir.ts` for the bootstrap logic.

## Development Setup

```bash
npm install          # Install dependencies
npm run dev          # Development server with hot reload
npm run build        # TypeScript compilation
npm run typecheck    # Type checking only
```

See `docs/guides/local-development.md` for full setup instructions.

## Logging

Use the unified logger (`src/system/logger.ts`) for all console output. Never use `console.log/error/warn` directly. The logger provides color-coded, semantic logging methods for agents, system events, and errors.

## Git Workflow

**IMPORTANT**: Only create commits when explicitly requested by the user. Never commit code automatically.

When creating commits (only when asked):

- **Use atomic commits**: Each commit should represent a single logical change
- **Group related changes**: If multiple files change for the same feature, commit them together
- **Clear commit messages**: Use descriptive messages that explain what changed and why
- **Exclude drafts**: Don't commit draft documentation or proposals unless specifically requested
