# Archie HQ

**A**utonomous **R**epository **C**ollaborative **H**yper **I**ntelligent **E**ngineer

Multi-agent AI system where specialized agents collaborate on software engineering tasks across multiple repositories via Slack.

## Quick Start

```bash
npm install
npm run dev
```

See [Local Development](docs/local-development.md) for detailed setup instructions.

## Architecture

Specialized AI agents coordinate like a human engineering team:

- **Triage Agent** (Haiku) - Message classification and routing
- **PM Agent** (Sonnet) - Task coordination, user communication, GitHub operations
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

- [Architecture Overview](docs/architecture-overview.md) - System design and concepts
- [Agent Architecture](docs/agent-architecture.md) - AI agent specifications
- [System Orchestration](docs/system-orchestration.md) - Backend implementation
- [Task Persistence](docs/task-persistence.md) - Storage and state
- [Slack Integration](docs/slack-integration.md) - UX layer
- [GitHub Integration](docs/github-integration-agreements.md) - PR workflow

**Operations:**

- [Local Development](docs/local-development.md) - Running locally
- [Deployment & Operations](docs/deployment-operations.md) - Production deployment

## Technology Stack

- **Runtime:** Node.js with TypeScript
- **AI:** Claude Agent SDK (Sonnet 4.5, Haiku 4.5)
- **Integrations:** Slack API, GitHub App
- **Storage:** File-based sessions
- **VCS:** Git worktrees

## License

Proprietary - Sweatco Ltd.
