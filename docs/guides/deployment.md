# Deployment & Operations

## Infrastructure

Single-VM deployment, containerized with Docker.

```
Jenkins (CI/CD)
    ↓
Container Registry (Docker images)
    ↓
VM host
    ├── /workdir/         # Working directory (plugins, repos, sessions)
    ├── /app/secrets/     # GitHub App key + encrypted OAuth vault
    └── /app/             # Application container

Secrets: env file + mounted /app/secrets volume
Monitoring: container logs + /health endpoint
```

**Capacity:** 10-20 concurrent tasks

## Security

### Secrets Management

Secrets are injected via the container's environment file plus the mounted
`/app/secrets` volume. See `.env.example` for the full list. Required at runtime:

- `ANTHROPIC_API_KEY` — Claude API access (required; startup fails without it)
- `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` — Slack integration in HTTP webhook mode (optional; CLI-only mode if both omitted)
- `SLACK_APP_TOKEN` — `xapp-...` app-level token; set this *instead of* `SLACK_SIGNING_SECRET` to use Socket Mode and deploy without an inbound webhook URL
- `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_INSTALLATION_ID` — GitHub App identifiers
- `GITHUB_APP_PRIVATE_KEY_PATH` — path to PEM file (mount under `/app/secrets`)
- `GITHUB_WEBHOOK_SECRET` — webhook signature verification (PR tools disabled if unset)
- `ARCHIE_PLUGINS` — git URL for the plugins repo, cloned into `$ARCHIE_WORKDIR/plugins` on startup
- `ARCHIE_PLUGINS_BRANCH` — optional branch override (defaults to repo default)
- `ARCHIE_WORKDIR` — base working directory (defaults to `./workdir`; production mounts `/workdir`)
- `ARCHIE_SECRETS_KEY` — base64 master key for the OAuth secrets vault. Required when any OAuth records exist; validated at startup
- `ARCHIE_SECRETS_DIR` — overrides the secrets directory (defaults to `/app/secrets` in container)
- `ARCHIE_PUBLIC_URL` — public HTTPS URL for OAuth provider redirects (`${url}/oauth/callback`)
- `CLAUDE_PATH` — absolute path to the Claude Code `cli.js` (set to `/usr/local/bin/claude` in container)
- `PORT` — HTTP port (defaults to `3000`)

### Repository Access

GitHub App with fine-grained, read-only permissions scoped to the organization. Edit mode grants write access through the app's installation token. Auto-rotating tokens via Octokit.

### Network Security

- **Inbound:** public IP for webhooks, firewall restricted to Slack IPs on port 443. Not required when running Slack in Socket Mode — events arrive over the bot's outbound WebSocket.
- **Outbound:** GitHub, Anthropic API, Slack API (all trusted). Socket Mode also relies on a long-lived outbound WebSocket to `wss-primary.slack.com`.
- Slack webhook signature verification enforced (HTTP mode); Socket Mode events are authenticated by the app-level token used to open the connection.
- GitHub webhook signature verification enforced

## CI/CD Pipeline

Continuous integration runs via GitHub Actions (`.github/workflows/ci.yml`): on every push and pull request it installs dependencies, type-checks, builds, runs the test suite, and runs a [gitleaks](https://github.com/gitleaks/gitleaks) secret scan over the working tree and full history. A merge that fails any of these gates is blocked.

Building and publishing the production container image is operator-driven and intentionally left to your own registry/automation:

1. Build the image from `Dockerfile.prod` and push it to your container registry (e.g. `<registry>/archie-hq:latest`)
2. Pull the new tag on the host and restart the service
3. Verify health via `GET /health`

You can wire image build/publish into the same GitHub Actions workflow (or your CI of choice) using your registry credentials as repository secrets.

## Docker Configuration

- `Dockerfile.prod` — Production image (Node 24-slim, bubblewrap sandbox, non-root `archie` user)
- `Dockerfile.dev` — Development image (with hot reload, used by `docker-compose.yml`)
- `docker-compose.yml` — Local development compose (`npm run docker:dev`)

## Systemd Service

The application runs as a systemd service on the VM:

```ini
[Service]
Type=simple
ExecStart=/usr/bin/docker run --name archie-app \
  --env-file /etc/archie/archie.env \
  -p 3000:3000 \
  --cap-add SYS_ADMIN \
  --security-opt seccomp=unconfined \
  --security-opt apparmor=unconfined \
  --security-opt systempaths=unconfined \
  -v /workdir:/workdir \
  -v /app/secrets:/app/secrets \
  -v /data/claude:/home/archie/.claude \
  -v /data/claude/.claude.json:/home/archie/.claude.json \
  <registry>/archie-hq:latest
Restart=always
RestartSec=10
```

### Docker Capabilities (Required)

The bubblewrap sandbox needs these Docker flags to create Linux namespaces:

| Flag | Purpose |
|------|---------|
| `--cap-add SYS_ADMIN` | Namespace creation and mount operations |
| `--security-opt seccomp=unconfined` | Allows bwrap's `clone`/`unshare` syscalls |
| `--security-opt apparmor=unconfined` | Allows bwrap's mount operations |
| `--security-opt systempaths=unconfined` | Removes `/proc` masking for PID namespace isolation |

Without these, all agent Bash commands fail with `Operation not permitted`.

**Host kernel requirement (Ubuntu 24.04+):** Ubuntu 24.04 restricts unprivileged user namespaces via AppArmor by default, which breaks bwrap even with `apparmor=unconfined` on the container. Set this sysctl on the **host** before starting the container:

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
# Persist across reboots:
echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/99-archie-bwrap.conf
```

**AWS Fargate is NOT compatible** — it does not support `cap_add: SYS_ADMIN`. Use EC2-backed ECS or EKS.

### Persistent Volumes

| Host Path | Container Path | Purpose |
|-----------|---------------|---------|
| `/workdir` | `/workdir` | Runtime state: `plugins/`, `repos/`, `sessions/`, `plugins-data/` (set via `ARCHIE_WORKDIR`) |
| `/data/claude` | `/home/archie/.claude` | Claude CLI config and session logs |
| `/data/claude/.claude.json` | `/home/archie/.claude.json` | Claude CLI feature flags |
| `/app/secrets` | `/app/secrets` | GitHub App private key + encrypted OAuth vault (read-write — daemon persists refreshed tokens) |

### Non-Root User

The container runs as user `archie` (non-root). The Claude Agent SDK's `bypassPermissions` mode refuses to execute as root. The entrypoint handles the privilege drop automatically.

On restart, the application automatically recovers in-progress tasks via `recoverActiveTasks()` in `src/tasks/recovery.ts`.

## Monitoring

### Health Check

```
GET /health → 200 { status: "ok", activeTasks: N }
GET /health → 503 { status: "shutting_down", activeTasks: N }   # while draining on SIGTERM/SIGINT
```

The handler is mounted directly in `src/index.ts`. External uptime monitoring should poll
every minute and alert on sustained failure.

### Logging

The unified logger (`src/system/logger.ts`) provides color-coded, semantic output:
- Agent activity with mode indicators (`[agent:rw]` / `[agent:ro]`)
- Tool call tracking
- Inter-agent message logging
- Error and warning highlighting

Application logs are written to stdout/stderr; ship them off the VM with your preferred
log forwarder (`docker logs`, journald, or a sidecar) for querying and alerting.

### Key Metrics

- CPU/Memory utilization (alert on sustained high usage)
- Active task count
- Agent error rate
- API latency (Anthropic, Slack, GitHub)

## Backup & Recovery

### Session Backup

Sessions persist as files under `$ARCHIE_WORKDIR/sessions`. Snapshot or rsync that
directory (and `/app/secrets` for the OAuth vault + GitHub App key) to your backup
target on a daily schedule.

### Recovery Procedures

**App crash:** Systemd auto-restarts. On startup, `recoverActiveTasks()` (`src/tasks/recovery.ts`,
called from `src/index.ts`) replays in-progress tasks from disk state.

**VM failure:** Create new VM, install Docker, restore `/workdir/sessions` and
`/app/secrets` from backup, deploy latest image. Repos and plugins auto-clone on startup
via `bootstrapWorkdir()` and `cloneRepos()` in `src/system/workdir.ts`.

## Scaling

### Vertical (Current)

Run on a single VM sized for ~10-20 concurrent tasks (2-4 vCPU, 8-16 GB RAM is typical).
Scale up the host if CPU/memory utilisation stays high.

### Horizontal (Future)

Task-based routing across multiple VMs with hash-based assignment. Requires the distributed queue architecture described in [plans/v4](../plans/v4-queue-architecture.md) — not yet implemented. See [proposals/distributed-queues.md](../proposals/distributed-queues.md).

## Operations Runbook

```bash
# View logs
sudo journalctl -u archie -f

# Restart service
sudo systemctl restart archie

# Check active tasks
curl http://localhost:3000/health

# Inspect task state
ls /workdir/sessions/
```

### Incident Response

- **Secrets leak:** Rotate the affected values in the env file and `/app/secrets`, redeploy, and rotate the GitHub App credentials and `ARCHIE_SECRETS_KEY` if the OAuth vault is implicated
- **High API costs:** Check active task count via `/health`, look for stuck agents, review logs for loops
- **VM compromised:** Stop VM, snapshot for forensics, launch new VM from backup, rotate all secrets
