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

# 3. Set up workdir (repos are auto-cloned on startup via ARCHIE_PLUGINS)
mkdir -p workdir claude-data

# 4. Start the container
npm run docker:dev   # Development (hot reload)
```

## Running Modes

| Mode | Command | Use Case |
|------|---------|----------|
| **Development** | `npm run docker:dev` | Active development with hot reload |
| **Stop** | `npm run docker:stop` | Stop containers |

### Development Mode (Hot Reload)

```bash
npm run docker:dev
```

This:
- Uses `Dockerfile.dev` (keeps devDependencies)
- Mounts `./src` and `./prompts` for hot reload
- Runs as non-root user `archie` (required by `bypassPermissions`)
- Runs `npm run dev` (tsx watch)
- Sets `NODE_ENV=development`

Edit any file in `src/` or `prompts/` → save → container auto-restarts.

## Common Commands

```bash
# Stop containers
npm run docker:stop

# View logs
docker compose logs -f

# Shell into container (as archie)
docker compose exec -u archie archie sh

# Shell into container (as root, for debugging)
docker compose exec archie sh

# Check health
curl http://localhost:${PORT:-3000}/health
```

## Directory Structure

```
archie-hq/
├── .env                    # Your environment variables (git-ignored)
├── claude-data/            # Claude Code config/sessions (git-ignored)
│   ├── .claude.json        # CLI feature flags (auto-generated)
│   ├── projects/           # Per-project session logs
│   └── backups/            # Auto-backups of .claude.json
├── secrets/                # Private keys (git-ignored)
│   └── github-private-key.pem
└── workdir/                # All runtime state (git-ignored)
    ├── plugins/            # Auto-cloned from ARCHIE_PLUGINS
    ├── plugins-data/       # Persistent per-plugin data
    ├── repos/              # Base repo clones
    │   ├── backend/
    │   └── mobile/
    └── sessions/           # Per-task runtime data
        └── task-*/
            ├── shared/     # knowledge.log, metadata, events
            ├── agents/     # PM + plugin agent workspaces
            └── repos/      # Task-local worktrees
```

## Container Architecture

### Non-Root User

The container runs as the `archie` user (non-root). This is required because Claude Agent SDK's `bypassPermissions` mode refuses to execute as root. The Docker entrypoint:

1. Starts as root
2. Fixes SSH agent socket permissions (`chmod 0666`)
3. Drops to `archie` via `su-exec`
4. Executes the CMD

### Bubblewrap Sandbox

Agent Bash commands run inside a bubblewrap (bwrap) sandbox for filesystem and network isolation. This requires specific Docker capabilities:

```yaml
cap_add:
  - SYS_ADMIN           # Namespace creation and mount ops
security_opt:
  - seccomp=unconfined   # Allows bwrap's clone/unshare syscalls
  - apparmor=unconfined  # Allows bwrap's mount operations
  - systempaths=unconfined  # Removes /proc masking for PID namespace
```

These are already configured in `docker-compose.yml`. Without them, all Bash commands will fail with `Operation not permitted`.

**Ubuntu 24.04+ hosts** also need a kernel sysctl to allow unprivileged user namespaces inside containers:

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
# Persist across reboots:
echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/99-archie-bwrap.conf
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
| `SLACK_SIGNING_SECRET` | Slack signing secret — HTTP webhook mode | `abc123...` |
| `SLACK_APP_TOKEN` | Slack app-level token — Socket Mode (alternative to signing secret; no inbound webhook URL needed) | `xapp-...` |
| `GITHUB_APP_ID` | GitHub App ID | `123456` |
| `GITHUB_INSTALLATION_ID` | GitHub App installation ID | `12345678` |
| `ARCHIE_PLUGINS` | Git URL for plugins repo | `git@github.com:org/archie-plugins.git` |
| `PORT` | Server port (optional) | `3000` |

These are automatically set by docker-compose:
- `CLAUDE_PATH` → `/usr/local/bin/claude`
- `ARCHIE_WORKDIR` → `/workdir`
- `SSH_AUTH_SOCK` → `/run/host-services/ssh-auth.sock`

## Handling Repositories

Repos are auto-cloned on startup based on plugin `repo-config.json` files. They live under `workdir/repos/` and persist across container restarts. The app uses git fetch and worktrees internally — task-specific worktrees are created at `workdir/sessions/<taskId>/repos/<repoKey>/`.

## Claude Code Configuration

Claude Code stores its configuration in `~/.claude` (mapped to `./claude-data`) and `~/.claude.json` (mapped to `./claude-data/.claude.json`). Both persist across container restarts.

The `claude-data/` directory is created automatically on first run. If `.claude.json` is missing, Claude CLI regenerates it (you'll see a warning about a missing config file — this is harmless).

## ngrok Setup (Local Development)

To receive Slack/GitHub webhooks locally over HTTP. If you're running Slack in **Socket Mode** (`SLACK_APP_TOKEN` set), Slack events arrive over an outbound WebSocket and ngrok is only needed for GitHub.

**Terminal 1** — Run container:
```bash
npm run docker:dev
```

**Terminal 2** — Start ngrok:
```bash
ngrok http ${PORT:-3000}
```

Then update:
- **Slack** (HTTP mode only): api.slack.com/apps → Event Subscriptions → `https://xxxx.ngrok.io/slack/events`
- **GitHub**: Repo Settings → Webhooks → `https://xxxx.ngrok.io/github/webhooks`

## Production Deployment

### Container Requirements

Production containers **must** be started with these Docker flags:

```bash
docker run \
  --cap-add SYS_ADMIN \
  --security-opt seccomp=unconfined \
  --security-opt apparmor=unconfined \
  --security-opt systempaths=unconfined \
  ...
```

**AWS Fargate is NOT compatible** — it does not support `cap_add: SYS_ADMIN`. Use **EC2-backed ECS or EKS**.

### Persistent Volumes

| Container Path | Purpose | Required |
|---------------|---------|----------|
| `/workdir` | Runtime state: repos, sessions, plugins | Yes |
| `/home/archie/.claude` | Claude CLI config and session logs | Yes |
| `/home/archie/.claude.json` | Claude CLI feature flags | Yes |
| `/app/secrets` | GitHub App private key (read-only) | If using GitHub App |

### ECS/EKS Task Definition

For ECS with EC2 launch type:

```json
{
  "linuxParameters": {
    "capabilities": {
      "add": ["SYS_ADMIN"]
    }
  },
  "dockerSecurityOptions": [
    "seccomp=unconfined",
    "apparmor=unconfined",
    "systempaths=unconfined"
  ]
}
```

For EKS, use a pod security context:

```yaml
securityContext:
  capabilities:
    add: ["SYS_ADMIN"]
```

With a custom seccomp/apparmor profile or the `Unconfined` pod security standard.

## Troubleshooting

### Bash commands fail with "Operation not permitted"

Bubblewrap sandbox can't create namespaces. Ensure Docker capabilities are set:
```yaml
cap_add:
  - SYS_ADMIN
security_opt:
  - seccomp=unconfined
  - apparmor=unconfined
  - systempaths=unconfined
```

### "cannot be used with root/sudo privileges"

The Claude Agent SDK's `bypassPermissions` mode requires a non-root user. Ensure the entrypoint drops to `archie` via `su-exec`. Check: `docker exec archie-hq whoami` should not return `root`.

### ".claude.json not found" warning

Harmless — Claude CLI regenerates this file on first run. To silence it, ensure `./claude-data/.claude.json` exists (copy from `claude-data/backups/` if available).

### SSH "Permission denied (publickey)" (dev only)

The SSH agent socket is mounted from macOS Docker Desktop. The entrypoint fixes permissions, but if it fails:
```bash
docker exec archie-hq chmod 0666 /run/host-services/ssh-auth.sock
```

### Git fetch fails

- **Dev**: Ensure your SSH key is loaded (`ssh-add`) and SSH agent forwarding is working
- **Prod**: Ensure `GIT_ASKPASS` is configured and GitHub App credentials are valid

### Container won't start

```bash
docker compose logs archie

# Common issues:
# - Missing .env file
# - Invalid API keys
# - Missing workdir directory
```
