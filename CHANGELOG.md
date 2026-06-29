# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

These changes are staged for the first tagged release (`v0.1.0`). When cutting
the release, rename this section to `## [0.1.0] - YYYY-MM-DD` and start a fresh
`[Unreleased]` section above it.

### Added

- Multi-agent orchestration: a PM agent that delegates to specialist agents and
  synthesizes their results.
- Plugin architecture — add a new domain by dropping in a plugin directory, with
  no core code changes. Supports repo agents (git/GitHub/PRs) and plugin agents
  (workspace + MCP tools).
- Slack integration (Bolt) and an interactive CLI for driving the engine without
  Slack or GitHub.
- GitHub App integration for repo agents: branches, commits, and automated PR
  creation, gated behind human-approved edit mode.
- OS-level sandbox (bubblewrap on Linux, sandbox-exec on macOS) with per-agent
  filesystem isolation, network deny-all from agent Bash, and tool denylists.
- Web research pipeline with structured output and prompt-injection defense.
- Agent-to-agent messaging and a shared knowledge log for findings and audit
  trail.
- File-based session persistence and recovery under `ARCHIE_WORKDIR`.
- Bundled example plugin set so a fresh clone is runnable with only an Anthropic
  API key.
- Community health and project docs: README, CONTRIBUTING, SECURITY,
  CODE_OF_CONDUCT, issue/PR templates, and architecture docs under `docs/`.
- CI workflow (typecheck, build, test, gitleaks secret scan) and CodeQL
  analysis.

[Unreleased]: https://github.com/sweatco/archie-hq/commits/main
