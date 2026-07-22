# Local Development Guide

## Quick Start

Archie needs a Claude credential, auto-detected in priority order: `ANTHROPIC_API_KEY`, then `CLAUDE_CODE_OAUTH_TOKEN`. At least one must be set or startup fails. Slack and GitHub App credentials are optional.

To use a Claude subscription instead of a metered API key, run `claude setup-token` and set the printed token as `CLAUDE_CODE_OAUTH_TOKEN`. This is intended for an individual running Archie **locally and interactively** on their own subscription — the same posture in which Claude Code supports a Pro/Max plan. On a plain reading of Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), any bot- or server-driven use of a subscription token is automated access reserved for an API key (*"Except when you are accessing our Services via an Anthropic API Key … to access the Services through automated or non-human means, whether through a bot, script, or otherwise"*) — and because a Slack deployment has the server initiate the access, that reading covers **even a single-user DM**. Use an `ANTHROPIC_API_KEY` under the Commercial Terms for any Slack-connected deployment, and confirm directly with Anthropic before relying on a subscription token for an automated path.

```bash
# 1. Setup environment
cp .env.example .env
# Set ANTHROPIC_API_KEY in .env

# 2. Ensure your SSH key is loaded (used for git inside Docker)
ssh-add

# 3. Setup plugins — pick ONE:
#    a) Auto-clone: leave ARCHIE_PLUGINS=<git-url> in .env (default)
#    b) Local symlink (for editing the plugins repo):
#         git clone git@github.com:<org>/<plugins-repo>.git ../archie-plugins
#         mkdir -p workdir && ln -s ../archie-plugins workdir/plugins
#         (then unset/comment out ARCHIE_PLUGINS in .env)

# 4. (Optional) Pre-clone repos with SSH so git uses your local keys.
#    If skipped, the server auto-clones each repo declared by plugins on startup.
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
npm run cli                                    # interactive TUI
ARCHIE_URL=http://localhost:3000 npm run cli   # override server URL
```

**Controls:**
- `↑/↓` — Navigate task list
- `Enter` — Open task detail
- `n` — Create new task
- `Tab` — Toggle message input
- `Esc` — Go back
- `q` — Quit

### OAuth CLI

For MCP servers that authenticate via OAuth, use the `oauth` subcommands. They run on the same host as the daemon (they share `SECRETS_DIR`) and require `ARCHIE_SECRETS_KEY` (and `ARCHIE_PUBLIC_URL` for `connect`).

```bash
npm run oauth:connect <server-name>   # begin authorize flow
npm run oauth:list                    # show connected servers
npm run oauth:refresh <server-name>   # force-refresh a token
npm run oauth:revoke  <server-name>   # delete a record
```

### REST API

In addition to the TUI, you can drive the server with HTTP directly:

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

**Repos** — declared by plugins. On startup the server auto-clones (or fetches and resets to the configured base branch) each repo into `workdir/repos/<key>`. If you want git operations to use your local SSH key instead of the GitHub App's HTTPS URL, pre-clone with an SSH remote first — `git fetch`/`reset` will reuse the existing remote.

```bash
mkdir -p workdir/repos
git clone git@github.com:<org>/<repo>.git workdir/repos/<key>
```

The `<key>` must match the `repoKey` declared by the plugin's repo-track agent.

If `ARCHIE_PLUGINS` is set to a git URL, the app auto-clones the plugins repo on startup and refreshes it from `origin` periodically. If `ARCHIE_PLUGINS` is unset, `workdir/plugins` must already exist (e.g. via the symlink approach above).

## Environment Variables

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-...           # Claude API key

# Optional - Slack (omit for CLI-only mode)
# SLACK_BOT_TOKEN=xoxb-...
# SLACK_SIGNING_SECRET=...                # Required for HTTP webhook mode
# SLACK_APP_TOKEN=xapp-...                # Set instead of (or alongside) SIGNING_SECRET to use Socket Mode

# Optional - GitHub App (omit to use local SSH keys for git)
# GITHUB_APP_ID=123456
# GITHUB_APP_SLUG=archie-hq
# GITHUB_APP_PRIVATE_KEY_PATH=./secrets/github-private-key.pem
# GITHUB_INSTALLATION_ID=12345678
# GITHUB_WEBHOOK_SECRET=your-webhook-secret

# Optional - Plugins (omit if using local symlink at workdir/plugins)
# ARCHIE_PLUGINS=https://github.com/...
# ARCHIE_PLUGINS_BRANCH=main           # Override default branch

# Optional - OAuth-backed MCP servers (required if any oauth records exist)
# ARCHIE_SECRETS_KEY=                  # base64(32 bytes); see .env.example
# ARCHIE_PUBLIC_URL=                   # public HTTPS URL of this daemon
# ARCHIE_SECRETS_DIR=                  # override secrets dir (default: /app/secrets in Docker, ./secrets locally)

# Optional - Paths
# ARCHIE_WORKDIR=./workdir             # Default: ./workdir
# PORT=3000                            # Default: 3000
```

See [`.env.example`](../../.env.example) for the full list, including per-MCP plugin tokens (Atlassian, Bugsnag, TeamCity, Firebase, Rollbar) that get substituted into `plugins/.mcp.json`.

Without Slack credentials, the server runs in **CLI-only mode**.
Without GitHub App credentials, **PR tools are disabled** but agents can still read/write code, commit, and push via SSH. To enable PR tools, follow the **[GitHub App Setup guide](github-setup.md)** — it covers creating the App, the exact repository permissions and webhook events, the private key, installation, and the env vars above.

## Slack Bot Setup

To enable Slack integration, use the app manifest at [`slack-manifest.yaml`](../../slack-manifest.yaml):

1. Go to https://api.slack.com/apps → **Create New App** → **From an app manifest**
2. Choose your workspace, select YAML, paste the manifest contents
3. Click **Create**, then **Install to Workspace**
4. Collect credentials:
   - **Bot Token** (OAuth & Permissions): `xoxb-...`
   - **Signing Secret** (Basic Information → App Credentials) — for HTTP webhook mode
   - **App-Level Token** (Basic Information → App-Level Tokens) with the `connections:write` scope — for Socket Mode
5. Add to `.env`. Pick one of the two modes:
   ```bash
   # HTTP webhook mode (needs ngrok or a public URL — see below)
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_SIGNING_SECRET=...

   # OR Socket Mode (no public URL, no ngrok)
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   ```

The bot needs these permissions:
- `app_mentions:read` — receive @mentions
- `chat:write` — post messages to threads
- `channels:history` — read thread history
- `users:read` — get user names

### ngrok (HTTP webhook mode only)

If you went with **Socket Mode**, skip this section — events arrive over an outbound WebSocket and no public URL is needed.

For HTTP webhook mode, expose your local server to Slack:

```bash
brew install ngrok  # macOS
ngrok http 3000
# Update Slack Event URL:
# https://api.slack.com/apps → Event Subscriptions → https://YOUR-URL.ngrok.io/slack/events
```

For Socket Mode you also need to flip `socket_mode_enabled: true` in `slack-manifest.yaml` and re-import the manifest at https://api.slack.com/apps → your app → App Manifest. See the header comment in `slack-manifest.yaml` for the full checklist.

## Running Without Docker

```bash
npm install
npm run dev          # Development with hot reload (tsx watch)
npm run build        # TypeScript compilation (tsc)
npm run typecheck    # Type checking only (tsc --noEmit)
npm run lint         # ESLint
npm test             # Run vitest suite
npm run test:watch   # vitest in watch mode
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
│   │   ├── oauth/        # OAuth callback route for MCP servers
│   │   └── api/          # REST API + SSE for CLI
│   ├── agents/           # Agent spawn logic, tools, registry
│   ├── tasks/            # Task class, persistence, recovery
│   ├── system/           # Logger, plugin loader, workdir, secrets vault, OAuth
│   │                     # (triage agent file is present but currently disabled)
│   ├── cli/              # Interactive terminal UI (Ink/React) + oauth CLI
│   ├── mcp/              # Research tools pipeline
│   ├── types/            # TypeScript types
│   └── utils/            # Utilities
├── prompts/              # Agent system prompts
├── secrets/              # Local secrets dir (GitHub App key, OAuth vault)
├── workdir/              # Runtime state (gitignored)
│   ├── plugins/          # Symlink to archie-plugins (or auto-cloned via ARCHIE_PLUGINS)
│   ├── plugins-data/     # Persistent per-plugin data
│   ├── repos/            # Auto-cloned (or pre-cloned with SSH)
│   └── sessions/         # Task persistence (shared/metadata.json, shared/knowledge.log)
└── docs/                 # Documentation
```
