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
- `ARCHIE_GITHUB_LOGIN`, `ARCHIE_GITHUB_USER_ID`, `ARCHIE_GITHUB_NAME` — the account Archie is *credited* as on commits and PRs, separate from the App it acts as (optional; falls back to the App bot). The user ID must be the account's numeric user ID, not the App ID — see `docs/architecture/github-integration.md`
- `ARCHIE_PLUGINS` — git URL for the plugins repo, cloned into `$ARCHIE_WORKDIR/plugins` on startup
- `ARCHIE_PLUGINS_BRANCH` — optional branch override (defaults to repo default)
- `ARCHIE_WORKDIR` — base working directory (defaults to `./workdir`; production mounts `/workdir`)
- `ARCHIE_SECRETS_KEY` — base64 master key for the OAuth secrets vault. Required when any OAuth records exist; validated at startup
- `ARCHIE_SECRETS_DIR` — overrides the secrets directory (defaults to `/app/secrets` in container)
- `ARCHIE_PUBLIC_URL` — public HTTPS URL for OAuth provider redirects (`${url}/oauth/callback`)
- `CLAUDE_PATH` — absolute path to the Claude Code `cli.js` (set to `/usr/local/bin/claude` in container)
- `PORT` — HTTP port (defaults to `3000`)

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

Deployment to the VM is the Jenkins job `sweatcoin-archie-hq-production-deploy`, defined in the [sweatcoin-infrastructure](https://github.com/sweatco/sweatcoin-infrastructure) repo, which runs the Ansible playbook `apps/archie-hq/deploy-production.yml`.

## Docker Configuration

- `Dockerfile.prod` — Production image (Node 24-slim, bubblewrap sandbox, non-root `archie` user)
- `Dockerfile.dev` — Development image (with hot reload, used by `docker-compose.yml`)
- `docker-compose.yml` — Local development compose (`npm run docker:dev`)

## Systemd Service

The application runs as a systemd service on the VM. The unit is **generated** by Ansible from `apps/archie-hq/templates/etc/systemd/system/archie-hq.service` in the infrastructure repo, so editing it on the host is overwritten by the next deploy — change the template. Roughly:

```ini
[Service]
Type=simple
ExecStart=/usr/bin/docker run --name archie-app \
  --init \
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

`--init` is required: the entrypoint execs `gosu`, so without it Node runs as PID 1 and never reaps the orphaned bwrap/socat/git processes every agent run leaves behind. They accumulate as zombies until the container hits its `pids` limit and can no longer fork — this took production down on 2026-08-28 (18,631 zombies against a ceiling of 18,707). Restarts reset the count, so frequent deploys masked it for months.

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
| `/workdir` | `/workdir` | Runtime state: `plugins/`, `repos/`, `sessions/`, `plugins-data/`, `triggers/`, `triggers-data/` (set via `ARCHIE_WORKDIR`) |
| `/data/claude` | `/home/archie/.claude` | Claude CLI config and session logs |
| `/data/claude/.claude.json` | `/home/archie/.claude.json` | Claude CLI feature flags |
| `/app/secrets` | `/app/secrets` | GitHub App private key + encrypted OAuth vault (read-write — daemon persists refreshed tokens) |

### Non-Root User

The container runs as user `archie` (non-root). The Claude Agent SDK's `bypassPermissions` mode refuses to execute as root. The entrypoint handles the privilege drop automatically.

On restart, the application automatically recovers in-progress tasks via `recoverActiveTasks()` in `src/tasks/recovery.ts`.

## Model Gateway (optional, off by default)

Agents can run on non-Anthropic models through a self-hosted, Anthropic-format gateway (LiteLLM). The whole feature is gated on `ARCHIE_MODEL_GATEWAY_URL`: unset, `buildModelGatewayEnv()` returns nothing, every `query()` call site is unchanged, and agents talk to `api.anthropic.com` exactly as before. Nothing in `Dockerfile.prod` references the gateway.

### Enabling it

Add to `/etc/archie/archie.env`:

```bash
ARCHIE_MODEL_GATEWAY_URL=http://litellm:4000
ARCHIE_MODEL_GATEWAY_TOKEN=<gateway client key>
ARCHIE_MODEL_GATEWAY_ALIAS_OPUS=openai/gpt-5.6-sol
ARCHIE_MODEL_GATEWAY_ALIAS_SONNET=openai/gpt-5.6-terra
ARCHIE_MODEL_GATEWAY_ALIAS_HAIKU=openai/gpt-5.6-luna
ARCHIE_MODEL_GATEWAY_CONTEXT_TOKENS=922000
ARCHIE_MODEL_GATEWAY_MAX_OUTPUT_TOKENS=128000
```

Setting all three `ALIAS_*` variables routes every agent. Omit them to route only agents whose own model names a non-Anthropic provider, leaving the PM on Claude.

The CLI does not know a gateway model's limits — it assumes 200K context and caps output at 32000. Declare the upstream's real numbers (a bare integer, or `model=tokens,model=tokens` for mixed tiers); the gateway's `GET /model/info` reports them.

**Disabling:** remove `ARCHIE_MODEL_GATEWAY_URL` and restart Archie. It takes effect on the next agent spawn; the gateway container can keep running, Archie simply ignores it.

### Running the gateway container

Build and publish the image (it bakes in the config and the streaming hook, so no bind mounts are needed):

```bash
docker build -t <registry>/archie-model-gateway:<tag> docker/litellm
```

The default Docker bridge has **no DNS between containers**, so `http://litellm:4000` will not resolve with two plain `docker run` containers. Pick one:

1. **User-defined network** (preferred). `docker network create archie`, then add `--network archie --network-alias litellm` to the gateway and `--network archie` to Archie's `ExecStart`. Requires editing Archie's unit.
2. **Share Archie's network namespace** (no change to Archie's unit). Run the gateway with `--network container:archie-app` and set `ARCHIE_MODEL_GATEWAY_URL=http://127.0.0.1:4000`. The gateway must start after Archie and dies with it, so add `After=`/`BindsTo=` on Archie's unit.
3. **Off-box gateway.** Point the URL at another host; no topology change at all.

Gateway unit for option 1:

```ini
[Service]
Type=simple
ExecStart=/usr/bin/docker run --name archie-model-gateway \
  --network archie --network-alias litellm \
  -e OPENAI_API_KEY=<provider key> \
  -e LITELLM_MASTER_KEY=<gateway client key, matches ARCHIE_MODEL_GATEWAY_TOKEN> \
  <registry>/archie-model-gateway:<tag>
Restart=always
RestartSec=10
```

Give it only these two variables. It does not need — and must not be handed — Archie's env file, which holds the Slack tokens, GitHub App key, and MCP credentials.

### Caveats

- **Cost is not reported for gateway-routed turns.** The SDK prices any model it does not recognise with a first-party Claude rate card, so its figure is wrong rather than missing (measured: an OpenAI model came back priced at Opus 5's rates). Those turns record `cost_unavailable` and are excluded from cost totals; token counts are unaffected.
- **Version coupling.** The streaming hook in `docker/litellm/` depends on `/v1/messages` reaching LiteLLM's `async_post_call_streaming_iterator_hook` as raw SSE. Pin the base image and re-run a live task after any bump.
- **`unrecognized_model` diagnostic** appears once per spawn because model ids keep their real provider-prefixed names. That is log noise, not a failure — the alternative (serving the upstream under Claude's ids) hides which model actually answered.
- **Local development** uses the `model-gateway` Compose profile, so `npm run docker:dev` does not start the gateway. Note a plain `docker compose down` does **not** stop a profile-gated container; use `COMPOSE_PROFILES=model-gateway docker compose down`.

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
