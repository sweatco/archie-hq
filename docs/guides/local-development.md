# Local Development Guide

## Quick Start

The only required env var is `ANTHROPIC_API_KEY`. Slack and GitHub App credentials are optional.

```bash
# 1. Setup environment
cp .env.example .env
# Set ANTHROPIC_API_KEY in .env

# 2. Ensure your SSH key is loaded (used for git inside Docker)
ssh-add

# 3. Setup plugins (symlink for local editing)
git clone git@github.com:<org>/<plugins-repo>.git ../archie-plugins
mkdir -p workdir
ln -s ../archie-plugins workdir/plugins

# 4. Clone repos with SSH (one per repo defined in plugins)
mkdir -p workdir/repos
git clone git@github.com:<org>/<repo>.git workdir/repos/<key>

# 5. Start server with Docker
npm run docker:dev

# 6. Use the CLI to create and monitor tasks (separate terminal)
npm run cli
```

## Prerequisites

- Docker
- Node.js 20+ (for CLI and local tooling)
- Git with SSH key configured for GitHub
- Anthropic API key ([console.anthropic.com](https://console.anthropic.com/settings/keys))

**Optional:**
- Slack App credentials (for Slack integration — see [Slack Bot Setup](#slack-bot-setup))
- GitHub App credentials (for PR tools — create PR, merge, review comments)
- ngrok (for Slack webhooks to reach localhost)

## Docker Development

Docker is the recommended way to run the server locally. Source code and prompts are mounted for hot reload. Your SSH agent is forwarded into the container for git operations.

```bash
# Ensure SSH key is loaded
ssh-add -l   # verify
ssh-add      # add if needed

# Start (with hot reload)
npm run docker:dev

# Follow logs
docker compose logs -f

# Stop
npm run docker:stop
```

The `docker-compose.yml`:
- Mounts `./workdir` into the container (repos, sessions)
- Resolves the `workdir/plugins` symlink and mounts the real directory
- Forwards your SSH agent socket for git push/fetch inside the container

## CLI

The CLI provides an interactive terminal UI for creating and monitoring tasks. The server must be running.

```bash
npm run cli
```

**Controls:**
- `↑/↓` — Navigate task list
- `Enter` — Open task detail
- `n` — Create new task
- `Tab` — Toggle message input
- `Esc` — Go back
- `q` — Quit

You can also use the REST API directly:

```bash
# Create a task
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"message": "Fix login timeout issue"}'

# Send a message to a task
curl -X POST http://localhost:3000/api/tasks/<task-id>/message \
  -H "Content-Type: application/json" \
  -d '{"message": "Check the auth logs"}'

# List recent tasks
curl http://localhost:3000/api/tasks
```

## Working Directory

All runtime state lives under `ARCHIE_WORKDIR` (default: `./workdir`).

**Plugins** — symlink to your local clone for easy editing:
```bash
git clone git@github.com:<org>/<plugins-repo>.git ../archie-plugins
mkdir -p workdir
ln -s ../archie-plugins workdir/plugins
```

**Repos** — pre-clone with SSH remotes so git uses your SSH keys. The `<key>` must match the key in the plugin's `repo-config.json`:
```bash
mkdir -p workdir/repos
git clone git@github.com:<org>/<repo>.git workdir/repos/<key>
```

On startup, the app detects existing repos and runs `git fetch --all` to update refs. It won't re-clone repos that already exist.

If `ARCHIE_PLUGINS` is set to a git URL, the app auto-clones the plugins repo instead of using the local directory.

## Environment Variables

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-...           # Claude API key

# Optional - Slack (omit for CLI-only mode)
# SLACK_BOT_TOKEN=xoxb-...
# SLACK_SIGNING_SECRET=...

# Optional - GitHub App (omit to use local SSH keys for git)
# GITHUB_APP_ID=123456
# GITHUB_APP_SLUG=archie-hq
# GITHUB_APP_PRIVATE_KEY_PATH=./secrets/github-private-key.pem
# GITHUB_INSTALLATION_ID=12345678
# GITHUB_WEBHOOK_SECRET=your-webhook-secret

# Optional - Plugins (omit if using local symlink)
# ARCHIE_PLUGINS=https://github.com/...

# Optional - Paths
# ARCHIE_WORKDIR=./workdir             # Default: ./workdir
# PORT=3000                            # Default: 3000
```

Without Slack credentials, the server runs in **CLI-only mode**.
Without GitHub App credentials, **PR tools are disabled** but agents can still read/write code, commit, and push via SSH.

## Slack Bot Setup

To enable Slack integration, use the app manifest at [`slack-manifest.yaml`](../../slack-manifest.yaml):

1. Go to https://api.slack.com/apps → **Create New App** → **From an app manifest**
2. Choose your workspace, select YAML, paste the manifest contents
3. Click **Create**, then **Install to Workspace**
4. Collect credentials:
   - **Bot Token** (OAuth & Permissions): `xoxb-...`
   - **Signing Secret** (Basic Information → App Credentials)
5. Add to `.env`:
   ```bash
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_SIGNING_SECRET=...
   ```

The bot needs these permissions:
- `app_mentions:read` — receive @mentions
- `chat:write` — post messages to threads
- `channels:history` — read thread history
- `users:read` — get user names

### ngrok

For Slack webhooks to reach your local server:

```bash
brew install ngrok  # macOS
ngrok http 3000
# Update Slack Event URL:
# https://api.slack.com/apps → Event Subscriptions → https://YOUR-URL.ngrok.io/slack/events
```

## Running Without Docker

```bash
npm install
npm run dev          # Development with hot reload
npm run build        # TypeScript compilation
npm run typecheck    # Type checking only
```

The server starts on `http://localhost:3000` with:
- `GET /api/tasks` — REST API for CLI and external clients
- `GET /api/events/stream` — SSE stream for real-time updates
- `POST /webhooks/slack` — Slack webhooks (if configured)
- `POST /webhooks/github` — GitHub webhooks (if configured)
- `GET /health` — Health check

## Debugging

Server console output shows all activity with color-coded, semantic logging:

```
[system]  — system events (cyan)
[slack]   — Slack integration (cyan)
[server]  — server events (dim)
[agent]   — agent messages with mode indicator [agent:rw] or [agent:ro]
```

Inspect task state:
```bash
ls workdir/sessions/                                    # All tasks
cat workdir/sessions/task-*/shared/metadata.json        # Task metadata
cat workdir/sessions/task-*/shared/knowledge.log        # Activity log
```

## Directory Structure

```
archie-hq/
├── src/                  # Application source
│   ├── connectors/       # External integrations
│   │   ├── slack/        # Slack Bolt app, client, events
│   │   ├── github/       # GitHub App, webhooks, merge
│   │   └── api/          # REST API + SSE for CLI
│   ├── agents/           # Agent spawn logic, tools, registry
│   ├── tasks/            # Task class, persistence, recovery
│   ├── system/           # Logger, plugin loader, triage, workdir
│   ├── cli/              # Interactive terminal UI (Ink/React)
│   ├── mcp/              # Research tools pipeline
│   ├── types/            # TypeScript types
│   └── utils/            # Utilities
├── prompts/              # Agent system prompts
├── workdir/              # Runtime state (gitignored)
│   ├── plugins/          # Symlink to archie-plugins (or auto-cloned)
│   ├── repos/            # Pre-cloned with SSH (or auto-cloned)
│   └── sessions/         # Task persistence
└── docs/                 # Documentation
```
