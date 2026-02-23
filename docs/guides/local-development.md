# Local Development Guide

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Clone repos
git clone git@github.com:sweatco/backend.git repos/backend
git clone git@github.com:sweatco/mobile.git repos/mobile

# 3. Setup environment
cp .env.example .env
# Edit .env with your API keys

# 4. Start server
npm run dev

# 5. Expose with ngrok (separate terminal)
ngrok http 3000

# 6. Update Slack Event URL with ngrok URL
# https://api.slack.com/apps → Event Subscriptions → https://YOUR-URL.ngrok.io/slack/events

# 7. Test in Slack: @Archie investigate login timeout
```

## Prerequisites

- Node.js 20+
- Git
- Anthropic API key ([console.anthropic.com](https://console.anthropic.com/settings/keys))
- Slack workspace with bot configured

**Optional:**
- ngrok (required for Slack webhooks to reach localhost)
- GitHub App credentials (for PR management features)

## Repository Setup

Clone repositories as **regular clones** (not bare) so agents can read code files directly.

```bash
mkdir -p repos
git clone git@github.com:sweatco/backend.git repos/backend
git clone git@github.com:sweatco/mobile.git repos/mobile
```

Verify code is accessible:
```bash
ls repos/backend/app/models/    # Should show files
ls repos/mobile/src/screens/    # Should show files
```

The `ARCHIE_REPOS_DIR` environment variable (default: `/repos`) controls where agents look for repositories. Repo paths are configured per-plugin in `plugins/*/repo-config.json`.

## Slack Bot Setup

Use the app manifest at [`slack-manifest.yaml`](../../slack-manifest.yaml):

1. Go to https://api.slack.com/apps → **Create New App** → **From an app manifest**
2. Choose your workspace, select YAML, paste the manifest contents
3. Click **Create**, then **Install to Workspace**
4. Collect credentials:
   - **Bot Token** (OAuth & Permissions): `xoxb-...`
   - **Signing Secret** (Basic Information → App Credentials)

The bot needs these permissions:
- `app_mentions:read` — receive @mentions
- `chat:write` — post messages to threads
- `channels:history` — read thread history
- `users:read` — get user names

## Environment Variables

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-...           # Claude API key
SLACK_BOT_TOKEN=xoxb-...              # Slack bot token
SLACK_SIGNING_SECRET=...              # Slack webhook verification

# Optional - GitHub App
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY=...                # GitHub App private key (PEM)
GITHUB_INSTALLATION_ID=...
GITHUB_WEBHOOK_SECRET=...             # GitHub webhook verification

# Optional - Paths
ARCHIE_PLUGINS_DIR=./plugins          # Plugin directory (default: ./plugins)
ARCHIE_REPOS_DIR=/repos               # Base repo directory (default: /repos)
PORT=3000                             # Server port (default: 3000)

# Optional - Development
NODE_ENV=development
NO_COLOR=1                            # Disable colored log output
```

## ngrok Setup

For Slack webhooks to reach your local server:

```bash
# Install
brew install ngrok  # macOS

# Start tunnel (separate terminal)
ngrok http 3000
# → https://abc123.ngrok.io

# Update Slack Event URL:
# https://api.slack.com/apps → Event Subscriptions → https://abc123.ngrok.io/slack/events
```

Free ngrok URLs change on restart. Paid ngrok provides static URLs.

## Running the Server

```bash
# Development with hot reload
npm run dev

# Production build
npm run build && npm start

# Type checking
npm run typecheck
```

The server starts on `http://localhost:3000` with:
- `POST /slack/events` — Slack webhooks
- `POST /webhooks/github` — GitHub webhooks
- `GET /health` — Health check (returns active task count)
- Interactive message handlers for edit mode approval buttons

## Docker Development

```bash
# Development (with hot reload)
npm run docker:dev

# Production
npm run docker:prod

# Stop
npm run docker:stop
```

See [`DOCKER.md`](../../DOCKER.md) for detailed Docker configuration.

## Testing in Slack

1. Invite the bot to a channel: `/invite @Archie`
2. Send a test message: `@Archie hello`
3. Check server logs for the message being processed
4. The bot should respond in the thread

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
ls sessions/                                    # All tasks
cat sessions/task-*/shared/metadata.json        # Task metadata
cat sessions/task-*/shared/knowledge.log        # Activity log
```

## Directory Structure

```
archie-hq/
├── src/                  # Application source
│   ├── agents/           # Agent spawn logic
│   ├── system/           # Core infrastructure
│   ├── mcp/              # MCP tools
│   ├── slack/            # Slack client
│   ├── github/           # GitHub client
│   ├── types/            # TypeScript types
│   └── utils/            # Utilities
├── prompts/              # Agent system prompts
├── plugins/              # Domain plugins
├── sessions/             # Task persistence (gitignored)
├── repos/                # Git repositories (gitignored)
└── docs/                 # Documentation
```
