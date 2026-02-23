# Deployment & Operations

## Infrastructure

Single-VM deployment on GCP Compute Engine, containerized with Docker.

```
GitHub Actions (CI/CD)
    ↓
Container Registry (Docker images)
    ↓
Compute Engine VM (e2-standard-2)
    ├── /repos/           # Git repositories
    ├── /sessions/        # Task persistence
    └── /app/             # Application container

Secrets: GCP Secret Manager
Monitoring: Cloud Logging + Cloud Monitoring
```

**Capacity:** 10-20 concurrent tasks
**Cost:** ~$100-200/month (VM + API usage)

## Security

### Secrets Management

All secrets stored in GCP Secret Manager:
- `ANTHROPIC_API_KEY` — Claude API access
- `SLACK_BOT_TOKEN` — Slack integration
- `SLACK_SIGNING_SECRET` — Webhook verification
- `GITHUB_APP_PRIVATE_KEY` — Repository access
- `GITHUB_APP_ID` — GitHub App identifier

### Repository Access

GitHub App with fine-grained, read-only permissions scoped to the organization. Edit mode grants write access through the app's installation token. Auto-rotating tokens via Octokit.

### Network Security

- **Inbound:** Public IP for webhooks, firewall restricted to Slack IPs on port 443
- **Outbound:** GitHub, Anthropic API, Slack API (all trusted)
- Slack webhook signature verification enforced
- GitHub webhook signature verification enforced

## CI/CD Pipeline

GitHub Actions deploys on push to main:

1. Build Docker image
2. Push to GCP Artifact Registry
3. SSH to VM, pull new image
4. Restart systemd service
5. Health check verification

See `Jenkinsfile.build` for the build pipeline configuration.

## Docker Configuration

Production uses multi-stage Docker builds:

- `Dockerfile.prod` — Production image (optimized, minimal)
- `Dockerfile.dev` — Development image (with hot reload)
- `docker-compose.yml` — Base compose configuration
- `docker-compose.prod.yml` — Production overrides
- `docker-compose.dev.yml` — Development overrides

## Systemd Service

The application runs as a systemd service on the VM:

```ini
[Service]
Type=simple
ExecStart=/usr/bin/docker run --name archie-app \
  -p 3000:3000 \
  -v /repos:/repos \
  -v /sessions:/sessions \
  europe-west2-docker.pkg.dev/PROJECT/archie/app:latest
Restart=always
RestartSec=10
```

On restart, the application automatically recovers in-progress tasks via `recoverActiveTasks()` in `src/system/task-recovery.ts`.

## Monitoring

### Health Check

```
GET /health → { status: "ok", activeTasks: N }
```

External uptime monitoring via Cloud Monitoring (every 1 min, alert if down > 5 min).

### Logging

The unified logger (`src/system/logger.ts`) provides color-coded, semantic output:
- Agent activity with mode indicators (`[agent:rw]` / `[agent:ro]`)
- Tool call tracking
- Inter-agent message logging
- Error and warning highlighting

Application logs flow to Cloud Logging for querying and alerting.

### Key Metrics

- CPU/Memory utilization (alert on sustained high usage)
- Active task count
- Agent error rate
- API latency (Anthropic, Slack, GitHub)

## Backup & Recovery

### Session Backup

Automated daily backup to Cloud Storage:
```bash
gsutil -m rsync -r /sessions gs://PROJECT-backups/sessions/$(date +%Y-%m-%d)/
```

### Recovery Procedures

**App crash:** Systemd auto-restarts. In-progress tasks resume from disk state via session recovery (~10 seconds).

**VM failure:** Create new VM, install Docker, restore sessions from Cloud Storage, clone repos from GitHub, deploy latest image (~30 minutes).

## Scaling

### Vertical (Current)

Start with `e2-standard-2` (2 vCPU, 8GB, ~$60/month). Scale up as needed:
- `e2-standard-4` (4 vCPU, 16GB, ~$120/month)
- `e2-standard-8` (8 vCPU, 32GB, ~$240/month)

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
ls /sessions/
cat /sessions/task-*/shared/metadata.json | jq .status
```

### Incident Response

- **Secrets leak:** Rotate immediately in GCP Secret Manager, rotate GitHub App credentials
- **High API costs:** Check active task count, look for stuck agents, review logs for loops
- **VM compromised:** Stop VM, snapshot for forensics, launch new VM from backup, rotate all secrets
