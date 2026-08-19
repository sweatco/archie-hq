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
- `ARCHIE_RUNNERS_CONFIG` — optional mounted Tart runner profile configuration; absence disables runners
- `ORCHARD_SERVICE_ACCOUNT_NAME` / `ORCHARD_SERVICE_ACCOUNT_TOKEN` — required when runners are enabled
- Profile-specific guest password variables named by each runner profile’s `passwordEnv`

### Tart Runners

Runner deployments require outbound HTTPS and WebSocket access from Archie to the Orchard controller and Apple Silicon workers registered with Orchard. Mount the operator-owned JSON file read-only into the container, set `ARCHIE_RUNNERS_CONFIG` to its container path, and keep Orchard and guest credentials only in the environment file. See [Tart Runners](../architecture/runners.md) for the schema and lifecycle.

On macOS 15 and newer, run each Orchard worker through the supported privileged-helper form: start `orchard worker run` as root with `--user <regular-host-user>`. This keeps Tart state under the regular account, drops the worker's privileges, and leaves only Orchard's small local-network connection helper privileged. Do not rely on an SSH-launched unprivileged worker: macOS Local Network privacy can let an interactive shell reach a NAT guest while denying the worker's exec and port-forward sockets. Production profiles use `networkMode: "softnet"`; the `nat` mode is an explicitly unisolated lab-only fallback. Archie enforces this boundary at startup: `NODE_ENV=production` rejects NAT profiles and insecure Orchard HTTP.

The TeamCity E2E host can be exercised before sudo is available with the pinned patch in `scripts/teamcity/orchard-0.56.1-external-netcat.patch`. It applies only to Orchard tag `0.56.1` and adds an explicit development-only `--unsafe-external-netcat-dialer` flag. Build it from the exact tag, run its dialer tests, ad-hoc sign the resulting local binary if required by the host, and keep the unauthenticated development controller reachable only through an SSH localhost tunnel. This lab transport is intentionally separate from the official binary and data directory and must not be promoted to staging or production.

The pinned source commit is `1c241832f5710f68d395c91c414ca55afcb0468a`. Build and sign it with the checked helper; the helper refuses a different or dirty checkout, applies the patch, runs the dialer tests, builds, signs, and prints the binary SHA-256:

```bash
git clone --branch 0.56.1 --depth 1 https://github.com/openai/orchard.git orchard-lab
./scripts/teamcity/build-orchard-lab.sh orchard-lab ./orchard.lab
```

Copy the printed checksum and verify it again after transferring the binary to the TeamCity host. Start the lab binary in the foreground with an isolated data directory:

```bash
./orchard.lab dev \
  --data-dir /Users/customer/archie-runner/orchard-data-netcat \
  --resources org.cirruslabs.logical-cores=8 \
  --unsafe-external-netcat-dialer
```

The unsafe flag forces the development controller to bind `127.0.0.1:6120`; do not add a public proxy. From the Archie test client, forward that loopback socket with `ssh -N -L 16120:127.0.0.1:6120 <teamcity-host>` and point the lab profile at `http://127.0.0.1:16120/v1`. Use a dedicated lab `instanceId`, workdir, profile, and controller data directory. Before stopping either foreground process, release the canary, require `GET /v1/vms` to return an empty array, verify no matching Tart VM remains on the worker, and then stop the SSH tunnel and Orchard with `Ctrl-C`.

Start with one digest-pinned iOS profile, one allowed mobile agent, and `maxConcurrent: 1`. Verify provisioning, repository sync, `xcodebuild`, Simulator boot/install/launch, artifact collection, reconnectable long-running exec, VNC, task completion, and VM deletion before increasing capacity.

Run only one runner-enabled Archie replica for an `instanceId` and workdir. Capacity accounting and locks are process-local, and duplicate replicas can delete each other's VMs during orphan reconciliation. Keep the runner controller single-replica until distributed leases and leader election exist.

### Repository Access

GitHub access is via a GitHub App installation token (auto-rotating, through Octokit), scoped to the repositories the App is installed on. Archie's read-only-by-default posture is enforced by its own edit-mode gate, not by changing GitHub permissions at runtime. For the complete App setup — the exact repository permissions, webhook events, and env vars — see the [GitHub App Setup guide](github-setup.md).

### Network Security

- **Inbound:** public IP for webhooks, firewall restricted to Slack IPs on port 443. Not required when running Slack in Socket Mode — events arrive over the bot's outbound WebSocket.
- **Outbound:** GitHub, Anthropic API, Slack API (all trusted). Socket Mode also relies on a long-lived outbound WebSocket to `wss-primary.slack.com`.
- Slack webhook signature verification enforced (HTTP mode); Socket Mode events are authenticated by the app-level token used to open the connection.
- GitHub webhook signature verification enforced

## CI/CD Pipeline

Continuous integration runs via GitHub Actions: on every push and pull request it installs dependencies, type-checks, builds, runs the test suite, and runs a [gitleaks](https://github.com/gitleaks/gitleaks) secret scan over the working tree and full history. A merge that fails any of these gates is blocked. The workflow lives at `.github/workflows/ci.yml`.

Building and publishing the production container image also runs via GitHub Actions. `.github/workflows/docker-publish.yml` runs on pushes to `main` and via manual `workflow_dispatch`, builds `Dockerfile.prod` with Docker Buildx, and publishes to GitHub Container Registry as `ghcr.io/<owner>/<repo>:main-<commit-sha>`.

Deployment to the VM remains operator-driven: the operator pulls the published image tag on the host, restarts the service, and verifies health via `GET /health`.

Before disabling runners or rolling back to a build without runner support, stop new runner-using work, inventory every `archie-<instanceId>-*` VM in Orchard, release active leases, and confirm the inventory is empty. Removing `ARCHIE_RUNNERS_CONFIG` disables reconciliation, so it must be the final rollback step rather than the first.

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
  --mount type=bind,src=/etc/archie/runners.json,dst=/app/config/runners.json,readonly \
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
| `/etc/archie/runners.json` | `/app/config/runners.json` | Optional runner profiles (read-only; set `ARCHIE_RUNNERS_CONFIG=/app/config/runners.json`) |

### Non-Root User

The container runs as user `archie` (non-root). The Claude Agent SDK's `bypassPermissions` mode refuses to execute as root. The entrypoint handles the privilege drop automatically.

On restart, the application automatically recovers in-progress tasks via `recoverActiveTasks()` in `src/tasks/recovery.ts`.

## Monitoring

### Health Check

```
GET /health → 200 { status: "ok", activeTasks: N, runners: { enabled, degraded, activeLeases } }
GET /health → 503 { status: "shutting_down", activeTasks: N, runners: { enabled, degraded, activeLeases } }
GET /health/runners → 200 when disabled or healthy; 503 when enabled and degraded
```

The handlers are mounted directly in `src/index.ts`. External uptime monitoring should poll `/health` every minute. Runner-enabled deployments should also poll `/health/runners` and alert on sustained failure.

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
