# Archie HQ

**A**utonomous **R**esponsive and **C**ollaborative **H**yper **I**ntelligent **E**mployee

Multi-agent AI system where specialized agents collaborate on tasks across multiple domains via Slack.

## Quick Start

```bash
# Local development (requires Node.js 20+)
npm install
npm run dev

# Or with Docker
npm run docker:dev
```

See [Docker Setup](DOCKER.md) for container deployment or [Local Development](docs/guides/local-development.md) for running without Docker.

## Architecture

Specialized AI agents coordinate like a human engineering team:

- ~~**Triage Agent** (Haiku) - Message classification and routing~~ (currently disabled)
- **PM Agent** (Opus) - Task coordination, user communication
- **Backend Agent** (Sonnet) - Ruby on Rails engineering
- **Mobile Agent** (Sonnet) - React Native/iOS/Android engineering

**Key Features:**

- Direct agent-to-agent communication via message queues
- Shared knowledge log for findings and decisions
- Git worktrees for parallel task execution
- Human approval flow for code changes
- Automated PR creation and merge orchestration
- File-based task persistence

## Documentation

**Architecture:**

- [Architecture Overview](docs/architecture/overview.md) - System design and concepts
- [Agent Architecture](docs/architecture/agents.md) - AI agent specifications
- [System Orchestration](docs/architecture/orchestration.md) - Backend implementation
- [Task Persistence](docs/architecture/persistence.md) - Storage and state
- [Edit Mode](docs/architecture/edit-mode.md) - Approval flow, worktrees, and git workflow
- [Slack Integration](docs/architecture/slack-integration.md) - UX layer
- [GitHub Integration](docs/architecture/github-integration.md) - PR workflow
- [Plugin System](docs/architecture/plugin-system.md) - Plugin structure and agent registration
- [Web Research](docs/architecture/web-research.md) - Multi-agent research pipeline
- [Security](docs/architecture/security.md) - Research budget, defense layers

**Operations:**

- [Docker Setup](DOCKER.md) - Container deployment
- [Local Development](docs/guides/local-development.md) - Running without Docker
- [Deployment](docs/guides/deployment.md) - Production deployment

## Technology Stack

- **Runtime:** Node.js with TypeScript
- **AI:** Claude Agent SDK (Opus, Sonnet, Haiku)
- **Integrations:** Slack API, GitHub App
- **Storage:** File-based sessions
- **VCS:** Git worktrees

## License

Proprietary - Sweatco Ltd.
