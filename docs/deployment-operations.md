# Deployment & Operations

## Overview

Production deployment on Google Cloud Platform using Compute Engine VMs. Emphasizes security, simplicity, and cost-effectiveness for MVP through first year of operation.

## Infrastructure Architecture

### MVP Setup (Single VM)

```
GitHub Actions (CI/CD)
    ↓
Container Registry (Docker images)
    ↓
Compute Engine VM (e2-standard-2)
    - Ubuntu 24.04 LTS
    - Docker
    - Local SSD: 100GB
    ├─ /repos/           # Git repositories
    │   ├─ backend.git/  # Bare repo
    │   ├─ mobile.git/
    │   └─ website.git/
    ├─ /sessions/        # Task persistence
    └─ /app/             # Application code

Secrets: GCP Secret Manager
Monitoring: Cloud Logging + Cloud Monitoring
```

**Capacity:** 10-20 concurrent tasks
**Cost:** ~$75/month

## Security Architecture

### 1. Secrets Management

**GCP Secret Manager stores:**
- `ANTHROPIC_API_KEY` - Claude SDK access
- `SLACK_BOT_TOKEN` - Slack integration
- `SLACK_SIGNING_SECRET` - Webhook verification
- `GITHUB_APP_PRIVATE_KEY` - Repository access (read-only)
- `GITHUB_APP_ID` - GitHub App identifier

**Access pattern:**
```typescript
// Runtime: Fetch from Secret Manager
const anthropicKey = await secretManager.accessSecretVersion(
  'projects/PROJECT_ID/secrets/ANTHROPIC_API_KEY/versions/latest'
);
```

**Never:**
- ❌ Commit secrets to git
- ❌ Use environment variables directly
- ❌ Log secret values
- ❌ Store secrets in container images

### 2. Repository Access

**GitHub App (Recommended approach):**
- Fine-grained permissions: read-only to specific repos
- Scoped to sweatco organization
- Audit logs available
- Auto-rotating tokens

**Setup:**
1. Create GitHub App in sweatco organization
2. Grant read-only access to: backend, mobile, website repos
3. Install app on organization
4. Store App ID and Private Key in Secret Manager

**Alternative: Deploy Keys**
- One per repository
- Read-only SSH keys
- Manual rotation required

### 3. Network Security

**Inbound:**
- VM has public IP (for Slack webhooks)
- Firewall: Allow 443 (HTTPS) from Slack IPs only
- Slack webhook signature verification (required)

**Outbound:**
- Access to GitHub (git clone/pull)
- Access to Anthropic API
- Access to Slack API
- No restrictions needed (all trusted endpoints)

**Slack IP Allowlist:**
```
# Add to GCP Firewall rules
Source IPs: Slack webhook IPs (check Slack docs)
Protocol: TCP
Port: 443
```

### 4. Data Protection

**Data at rest:**
- VM disk encrypted (GCP default)
- Sessions contain: code analysis, Slack messages, findings
- No separate encryption needed (trust GCP)

**Data retention:**
- Keep completed tasks: 90 days
- Keep stopped tasks: 30 days
- Automatic cleanup via cron job

**Logs:**
- Never log actual code content
- Log file paths and line numbers only
- Redact API keys and tokens
- Retain logs: 30 days

### 5. Access Control

**VM Access:**
- SSH access via IAM (no password login)
- Only authorized engineers
- Audit logs enabled

**GCP IAM Roles:**
- Deployment service account: `roles/compute.instanceAdmin`
- Application runtime: `roles/secretmanager.secretAccessor`
- Engineers: `roles/compute.osLogin`

## Deployment Setup

### Initial VM Setup

**Create VM:**
```bash
gcloud compute instances create ai-engineer-vm-01 \
  --project=sweatco-ai-engineer \
  --zone=europe-west2-a \
  --machine-type=e2-standard-2 \
  --image-family=ubuntu-2404-lts-amd64 \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=100GB \
  --boot-disk-type=pd-ssd \
  --scopes=cloud-platform \
  --tags=ai-engineer,https-server \
  --metadata=enable-oslogin=TRUE
```

**Firewall rule:**
```bash
gcloud compute firewall-rules create allow-slack-webhooks \
  --project=sweatco-ai-engineer \
  --direction=INGRESS \
  --priority=1000 \
  --network=default \
  --action=ALLOW \
  --rules=tcp:443 \
  --source-ranges=<SLACK_IP_RANGES> \
  --target-tags=ai-engineer
```

**Initial VM configuration:**
```bash
# SSH into VM
gcloud compute ssh ai-engineer-vm-01 --zone=europe-west2-a

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER

# Install gcloud SDK (if not present)
curl https://sdk.cloud.google.com | bash

# Authenticate with artifact registry
gcloud auth configure-docker europe-west2-docker.pkg.dev

# Setup directories
sudo mkdir -p /repos /sessions /app
sudo chown $USER:$USER /repos /sessions /app

# Setup systemd service (see below)
```

### GitHub Actions CI/CD

**`.github/workflows/deploy.yml`:**
```yaml
name: Deploy to GCP

on:
  push:
    branches: [main]

env:
  PROJECT_ID: sweatco-ai-engineer
  REGION: europe-west2
  VM_NAME: ai-engineer-vm-01
  VM_ZONE: europe-west2-a

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Authenticate to Google Cloud
        uses: google-github-actions/auth@v2
        with:
          credentials_json: ${{ secrets.GCP_SERVICE_ACCOUNT_KEY }}

      - name: Set up Cloud SDK
        uses: google-github-actions/setup-gcloud@v2

      - name: Configure Docker for Artifact Registry
        run: gcloud auth configure-docker ${{ env.REGION }}-docker.pkg.dev

      - name: Build Docker image
        run: |
          docker build -t ${{ env.REGION }}-docker.pkg.dev/${{ env.PROJECT_ID }}/ai-engineer/app:${{ github.sha }} .
          docker tag ${{ env.REGION }}-docker.pkg.dev/${{ env.PROJECT_ID }}/ai-engineer/app:${{ github.sha }} \
                     ${{ env.REGION }}-docker.pkg.dev/${{ env.PROJECT_ID }}/ai-engineer/app:latest

      - name: Push Docker image
        run: |
          docker push ${{ env.REGION }}-docker.pkg.dev/${{ env.PROJECT_ID }}/ai-engineer/app:${{ github.sha }}
          docker push ${{ env.REGION }}-docker.pkg.dev/${{ env.PROJECT_ID }}/ai-engineer/app:latest

      - name: Deploy to VM
        run: |
          gcloud compute ssh ${{ env.VM_NAME }} \
            --zone=${{ env.VM_ZONE }} \
            --command="
              docker pull ${{ env.REGION }}-docker.pkg.dev/${{ env.PROJECT_ID }}/ai-engineer/app:latest && \
              sudo systemctl restart ai-engineer
            "

      - name: Health check
        run: |
          sleep 10
          gcloud compute ssh ${{ env.VM_NAME }} \
            --zone=${{ env.VM_ZONE }} \
            --command="curl -f http://localhost:3000/health || exit 1"
```

**GitHub Secrets needed:**
- `GCP_SERVICE_ACCOUNT_KEY` - Service account JSON with deployment permissions

### Systemd Service

**`/etc/systemd/system/ai-engineer.service`:**
```ini
[Unit]
Description=AI Engineer Multi-Agent System
After=docker.service
Requires=docker.service

[Service]
Type=simple
User=ai-engineer
WorkingDirectory=/app
ExecStartPre=-/usr/bin/docker stop ai-engineer-app
ExecStartPre=-/usr/bin/docker rm ai-engineer-app
ExecStart=/usr/bin/docker run --name ai-engineer-app \
  --rm \
  -p 3000:3000 \
  -v /repos:/repos \
  -v /sessions:/sessions \
  -e GCP_PROJECT_ID=sweatco-ai-engineer \
  europe-west2-docker.pkg.dev/sweatco-ai-engineer/ai-engineer/app:latest
ExecStop=/usr/bin/docker stop ai-engineer-app
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**Enable and start:**
```bash
sudo systemctl enable ai-engineer
sudo systemctl start ai-engineer
sudo systemctl status ai-engineer
```

## Monitoring & Observability

### Cloud Logging

**Application logs automatically sent to Cloud Logging:**
```typescript
// Use structured logging
console.log(JSON.stringify({
  severity: 'INFO',
  message: 'Task started',
  task_id: 'task-123',
  task_owner: 'backend-agent'
}));
```

**Log queries:**
```
# View all application logs
resource.type="gce_instance"
resource.labels.instance_id="ai-engineer-vm-01"

# Errors only
severity>=ERROR

# Specific task
jsonPayload.task_id="task-123"
```

### Cloud Monitoring

**Key metrics to monitor:**
- CPU utilization (alert if > 80% for 10 min)
- Memory utilization (alert if > 85%)
- Disk utilization (alert if > 80%)
- Task completion rate
- Agent errors
- API latency (Anthropic, Slack, GitHub)

**Alert policies:**
```bash
# CPU alert
gcloud alpha monitoring policies create \
  --notification-channels=CHANNEL_ID \
  --display-name="High CPU Usage" \
  --condition-display-name="CPU > 80%" \
  --condition-threshold-value=0.8 \
  --condition-threshold-duration=600s
```

### Health Checks

**Application health endpoint:**
```typescript
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    activeTasks: activeTasks.size
  });
});
```

**External monitoring:**
- Cloud Monitoring uptime check (every 1 min)
- Alert if down for > 5 minutes

## Backup & Recovery

### Session Backup

**Automated backup to Cloud Storage:**
```bash
# Daily cron job on VM
0 2 * * * /usr/bin/gsutil -m rsync -r /sessions gs://sweatco-ai-engineer-backups/sessions/$(date +\%Y-\%m-\%d)/
```

**Retention:**
- Daily backups: 30 days
- Weekly backups: 90 days

### Recovery Procedures

**VM failure (total loss):**
1. Create new VM (same specs)
2. Install Docker, configure systemd
3. Restore sessions from Cloud Storage backup
4. Clone repos fresh from GitHub
5. Deploy latest image via GitHub Actions

**Time to recover:** ~30 minutes

**Partial failure (app crash):**
- Systemd auto-restarts app
- In-progress tasks resume from disk state
- Time to recover: ~10 seconds

## Scaling Strategy

### Vertical Scaling (First 6-12 months)

**When CPU/Memory consistently high:**
```bash
# Stop VM
gcloud compute instances stop ai-engineer-vm-01 --zone=europe-west2-a

# Change machine type
gcloud compute instances set-machine-type ai-engineer-vm-01 \
  --machine-type=e2-standard-4 \
  --zone=europe-west2-a

# Start VM
gcloud compute instances start ai-engineer-vm-01 --zone=europe-west2-a
```

**Upgrade path:**
- Start: e2-standard-2 (2 vCPU, 8GB) - ~$60/month
- Scale: e2-standard-4 (4 vCPU, 16GB) - ~$120/month
- Scale: e2-standard-8 (8 vCPU, 32GB) - ~$240/month

### Horizontal Scaling (When needed, 12+ months out)

**Task-based routing approach:**
```
Load Balancer
    ↓
    ├─→ VM 1 (handles task-1, task-4, task-7...)
    ├─→ VM 2 (handles task-2, task-5, task-8...)
    └─→ VM 3 (handles task-3, task-6, task-9...)

Each VM: Independent disk
Sessions: Backed up to Cloud Storage
Routing: Hash(task_id) → VM assignment
```

**Cost:** 3x VM + Load Balancer = ~$200-300/month

**Alternative: Shared storage via Cloud Filestore:**
- All VMs share same /repos and /sessions
- Need locking for concurrent git operations
- Cost: ~$400/month (VMs + Filestore)

**Choose based on:**
- Usage patterns (concurrent vs sequential)
- Budget constraints
- Complexity tolerance

## Operations Runbook

### Common Tasks

**View logs:**
```bash
# Via gcloud
gcloud logging read "resource.type=gce_instance" --limit=50

# Via SSH
gcloud compute ssh ai-engineer-vm-01 --zone=europe-west2-a
sudo journalctl -u ai-engineer -f
```

**Restart service:**
```bash
gcloud compute ssh ai-engineer-vm-01 --zone=europe-west2-a
sudo systemctl restart ai-engineer
```

**Deploy specific version:**
```bash
# SSH to VM
docker pull europe-west2-docker.pkg.dev/sweatco-ai-engineer/ai-engineer/app:COMMIT_SHA
# Update systemd to use specific tag
sudo systemctl restart ai-engineer
```

**Check active tasks:**
```bash
# SSH to VM
ls /sessions/
# Or via health endpoint
curl http://localhost:3000/health
```

**Cleanup old tasks:**
```bash
# Delete tasks older than 90 days
find /sessions -name "task-*" -type d -mtime +90 -exec rm -rf {} \;
```

### Incident Response

**If secrets leak:**
1. Rotate immediately in GCP Secret Manager
2. Update GitHub App credentials if affected
3. Check Cloud Logging for unauthorized access
4. Review recent tasks in /sessions for suspicious activity

**If VM compromised:**
1. Stop VM immediately
2. Create snapshot for forensics
3. Launch new VM from backup
4. Rotate all secrets
5. Review and patch vulnerability

**If high API costs (Anthropic):**
1. Check active tasks count
2. Review logs for unusual patterns
3. Check for stuck agents (infinite loops)
4. Implement rate limiting if needed

## Cost Optimization

### Current Costs (MVP)

**Fixed:**
- VM e2-standard-2: ~$60/month
- SSD 100GB: ~$10/month
- Static IP: ~$5/month
- Cloud Logging: ~$5/month

**Variable:**
- Network egress: ~$5-10/month
- Cloud Storage (backups): ~$2/month
- Anthropic API: ~$20-100/month (usage-based)

**Total: ~$100-200/month**

### Optimization Tips

**Reduce API costs:**
- Use Haiku for triage/memory (cheaper)
- Cache common analysis results
- Set per-task budget limits

**Reduce compute costs:**
- Use preemptible VM (if can handle restarts)
- Shutdown during low-usage hours (if applicable)
- Right-size VM based on actual usage

**Reduce storage costs:**
- Aggressive session cleanup
- Compress old sessions
- Archive to Nearline/Coldline storage

## Security Checklist

**Pre-launch:**
- [ ] All secrets in Secret Manager
- [ ] GitHub App configured (read-only)
- [ ] Firewall rules restrictive (Slack IPs only)
- [ ] Slack webhook signature verification enabled
- [ ] VM SSH via IAM (no passwords)
- [ ] Logging enabled
- [ ] Monitoring alerts configured
- [ ] Backup automated

**Ongoing:**
- [ ] Review logs weekly for anomalies
- [ ] Rotate secrets quarterly
- [ ] Update OS/Docker monthly
- [ ] Review IAM permissions quarterly
- [ ] Test recovery procedures quarterly

---

**Related Documentation:**
- [Architecture Overview](architecture-overview.md)
- [System Orchestration](system-orchestration.md)
- [MVP v1 Plan](../plans/mvp-v1.md)
