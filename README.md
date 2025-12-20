# AI Software Engineer

Multi-agent AI system where specialized agents collaborate on software engineering tasks across multiple repositories via Slack.

## Quick Start

**Status:** Architecture phase - implementation starting soon

See [MVP v1 Plan](plans/mvp-v1.md) for implementation details.

## Architecture

Specialized AI agents coordinate like a human engineering team:

- **PM Agent** - Task coordination and user communication
- **Backend Agent** - Ruby on Rails engineering
- **Mobile Agent** - React Native/iOS/Android engineering
- **Website Agent** - Node.js/React engineering
- **Triage Agent** - Message classification (Haiku)
- **Memory Agent** - Task summarization (Haiku)

**Key Features:**
- Direct agent-to-agent communication
- Task ownership pattern
- Per-task context isolation
- Git worktrees for parallel execution
- File-based persistence

## Documentation

**Architecture:**
- [Architecture Overview](docs/architecture-overview.md) - System design and concepts
- [Agent Architecture](docs/agent-architecture.md) - AI agent specifications
- [System Orchestration](docs/system-orchestration.md) - Backend implementation
- [Task Persistence](docs/task-persistence.md) - Storage and state
- [Slack Integration](docs/slack-integration.md) - UX layer
- [Deployment & Operations](docs/deployment-operations.md) - GCP deployment, security, scaling

**Implementation Plans:**
- [MVP v1](plans/mvp-v1.md) - Initial 4-week implementation plan

## Technology Stack

- **Runtime:** Node.js with TypeScript
- **AI:** Claude Agent SDK (Sonnet 4.5, Haiku 4.5)
- **Integration:** Slack API
- **Storage:** File-based sessions
- **VCS:** Git worktrees

## Development

Coming soon - see [MVP v1 Plan](plans/mvp-v1.md) for timeline.

## License

Proprietary - Sweatco Ltd.
