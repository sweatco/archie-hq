# Contributing to Archie HQ

Thanks for your interest in contributing! Archie HQ is the open-source core engine of a multi-agent AI system built on the Claude Agent SDK — a PM agent that orchestrates specialist agents, plus a plugin system that adds new domains.

The project is licensed under **AGPL-3.0-or-later**, and contributions are accepted under that same license. By opening a pull request, you agree that your contribution is licensed under AGPL-3.0-or-later. (You can use and modify Archie internally without restriction; note that running a *modified* version as a network service triggers AGPL's source-disclosure obligations.)

## Prerequisites

- **Node.js >= 20**
- **npm >= 11** (the repo commits `package-lock.json`)
- An **Anthropic API key** to run the engine locally

Slack and GitHub are optional integrations — you do **not** need them to build, test, or run Archie locally.

## Getting set up

```bash
git clone https://github.com/<your-org>/archie-hq.git
cd archie-hq
npm install
cp .env.example .env        # then set ANTHROPIC_API_KEY in .env
npm run example:setup       # symlinks examples/plugins -> workdir/plugins
```

`example:setup` links the bundled example plugin set (a PM overlay + skill and a small "helper" plugin) into your workdir so you have something to run against immediately.

## The dev loop

Run the engine with hot reload in one terminal, then drive it from the interactive CLI in another:

```bash
npm run dev    # terminal 1: tsx watch src/index.ts
npm run cli    # terminal 2: interactive terminal UI
```

This is the fastest way to try a change end-to-end without Slack or GitHub.

Before you push, make sure the checks that CI runs pass locally:

```bash
npm run typecheck
npm run build
npm test
```

## Code style

- **TypeScript** throughout.
- Use the **unified logger** at `src/system/logger.ts` for all output — never `console.log` / `console.error` / `console.warn` directly. The logger gives consistent, color-coded, semantic output.
- Add the **SPDX header** as the first line of every new source file:
  ```ts
  // SPDX-License-Identifier: AGPL-3.0-or-later
  ```
- **Keep changes focused.** One logical change per PR makes review faster and history cleaner.

## Branch & PR workflow

1. **Fork or branch** off the default branch (don't commit to it directly).
2. Make **atomic commits** — each commit is one coherent, self-contained change with a clear message.
3. Open a **pull request** describing what changed and why.
4. **CI must pass.** The GitHub Actions workflow at `.github/workflows/ci.yml` runs `typecheck`, `build`, `test`, and a **gitleaks** secret scan over the full history on every push and PR.
5. **Expect review.** A maintainer will review your PR; please be responsive to feedback.

**Never commit secrets.** Keep `.env`, API keys, and tokens out of commits — gitleaks will flag them, and once something lands in history it's hard to remove. If you accidentally expose a credential, rotate it.

## Where to add things

- **Domain behavior** — new agents, skills, or PM workflows — almost always belongs in a **plugin**, not in the engine. Plugins are how Archie gains new capabilities without changing core code. See the bundled **`writing-plugins`** skill at [`examples/plugins/.claude/skills/writing-plugins/SKILL.md`](examples/plugins/.claude/skills/writing-plugins/SKILL.md). Note that production domain plugins typically live in a separate (often private) repo; the engine ships only the example plugin set under `examples/plugins/`.
- **Engine changes** — orchestration, agent runtime, integrations, CLI, session handling — go in `src/`. If you're adding a feature here, a quick issue or discussion first helps align on approach before you invest in a PR.

## Reporting security issues

Please do **not** open public issues for security vulnerabilities or include exploit details in issues or PRs. Follow the responsible-disclosure process in [SECURITY.md](SECURITY.md).
