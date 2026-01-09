# Docker Setup for Archie HQ

This guide covers running Archie HQ in Docker for local development and production.

## Quick Start

```bash
# 1. Set up secrets
mkdir -p secrets
cp your-github-private-key.pem secrets/github-private-key.pem

# 2. Configure environment
cp .env.example .env
# Edit .env with your actual values

# 3. Clone repos (one time only)
git clone git@github.com:your-org/backend.git repos/backend
git clone git@github.com:your-org/mobile.git repos/mobile

# 4. Start the container
npm run docker:dev   # Development (hot reload)
npm run docker:prod  # Production
```

## Running Modes

| Mode | Command | Use Case |
|------|---------|----------|
| **Development** | `npm run docker:dev` | Active development with hot reload |
| **Production** | `npm run docker:prod` | Deployment |
| **Stop** | `npm run docker:stop` | Stop containers |

### Development Mode (Hot Reload)

```bash
npm run docker:dev
```

This:
- Uses `Dockerfile.dev` (keeps devDependencies)
- Mounts `./src` and `./prompts` for hot reload
- Runs `npm run dev` (tsx watch)
- Sets `NODE_ENV=development`

Edit any file in `src/` or `prompts/` → save → container auto-restarts.

### Production Mode

```bash
npm run docker:prod
```

This:
- Uses `Dockerfile.prod` (optimized, no devDependencies)
- Sets `NODE_ENV=production`
- Runs detached in background

## Common Commands

```bash
# Stop containers
npm run docker:stop

# View logs
docker compose logs -f

# Shell into container
docker compose exec archie sh

# Check health
curl http://localhost:${PORT:-3000}/health
```

## Directory Structure

```
archie-hq/
├── .env                    # Your environment variables (git-ignored)
├── claude-data/            # Claude Code config/sessions (git-ignored)
├── secrets/                # Private keys (git-ignored)
│   └── github-private-key.pem
├── repos/                  # Cloned repositories (git-ignored)
│   ├── backend/
│   └── mobile/
└── sessions/               # Persistent task data (git-ignored)
    └── task-*/
```

## Handling Secrets

Place your GitHub App private key in the `secrets/` directory:

```bash
cp ~/Downloads/archie-hq.private-key.pem secrets/github-private-key.pem
chmod 600 secrets/github-private-key.pem
```

The secrets directory is mounted read-only into the container.

### Required Environment Variables

Configure these in your `.env` file:

| Variable | Description | Example |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Claude API key | `sk-ant-...` |
| `SLACK_BOT_TOKEN` | Slack bot OAuth token | `xoxb-...` |
| `SLACK_SIGNING_SECRET` | Slack app signing secret | `abc123...` |
| `GITHUB_APP_ID` | GitHub App ID | `123456` |
| `GITHUB_INSTALLATION_ID` | GitHub App installation ID | `12345678` |
| `PORT` | Server port (optional) | `3000` |

These are automatically set by docker-compose to container paths:
- `CLAUDE_PATH` → `/usr/local/bin/claude`
- `BACKEND_REPO_PATH` → `/app/repos/backend`
- `MOBILE_REPO_PATH` → `/app/repos/mobile`
- `GITHUB_APP_PRIVATE_KEY_PATH` → `/app/secrets/github-private-key.pem`

## Handling Repositories

Clone repos once (locally or on server):

```bash
git clone git@github.com:your-org/backend.git repos/backend
git clone git@github.com:your-org/mobile.git repos/mobile
```

Repos are mounted as a volume at `/app/repos/`. They persist across container restarts and rebuilds. The app uses git fetch and worktrees, so repos need write access.

## Session Persistence

Sessions are stored in `./sessions/` and mounted as a volume. This ensures:

- Task data survives container restarts
- Knowledge logs are preserved
- Agent sessions can be resumed
- Git worktrees persist

### Backup Sessions

```bash
tar -czf sessions-backup-$(date +%Y%m%d).tar.gz sessions/
```

## Claude Code Configuration

Claude Code stores its configuration and session data in `~/.claude`. The container mounts `./claude-data` to `/root/.claude` for persistence.

The `claude-data/` directory is created automatically on first run. Claude Code sessions and settings persist across container restarts.

## ngrok Setup (Local Development)

To receive Slack/GitHub webhooks locally:

**Terminal 1** — Run container:
```bash
npm run docker:dev
```

**Terminal 2** — Start ngrok:
```bash
ngrok http ${PORT:-3000}
```

Then update:
- **Slack**: api.slack.com/apps → Event Subscriptions → `https://xxxx.ngrok.io/slack/events`
- **GitHub**: Repo Settings → Webhooks → `https://xxxx.ngrok.io/github/webhooks`

## Production Deployment

On your production server:

```bash
# First time setup
git clone git@github.com:your-org/archie-hq.git
cd archie-hq

# Clone target repos
git clone git@github.com:your-org/backend.git repos/backend
git clone git@github.com:your-org/mobile.git repos/mobile

# Set up secrets
mkdir -p secrets
cp /path/to/github-private-key.pem secrets/github-private-key.pem

# Configure environment
cp .env.example .env
nano .env  # fill in real values

# Start
npm run docker:prod
```

For subsequent deploys (code updates):

```bash
git pull
npm run docker:prod
```

## Troubleshooting

### Container won't start

```bash
docker compose logs archie

# Common issues:
# - Missing .env file
# - Invalid API keys
# - Missing repos directory
```

### CLAUDE_PATH error

If you see "Claude executable not found" with your local path, ensure docker-compose.yml has the override:
```yaml
environment:
  - CLAUDE_PATH=/usr/local/bin/claude
```

### Can't connect to Slack

- Ensure `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` are correct
- Check that the port is exposed and accessible
- For local dev, use ngrok

### Sessions not persisting

- Check that `./sessions` directory exists
- Verify volume mount in docker-compose.yml
- Check container logs for write errors

### Git worktree errors

- Ensure `repos/` is mounted writable (not `:ro`)
- Check that repos were cloned properly with `.git` directory
