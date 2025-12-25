# Local Development Guide

## TL;DR - Quick Setup

```bash
# 1. Install dependencies
npm install

# 2. Clone repos (regular, not bare!)
git clone git@github.com:sweatco/backend.git repos/backend
git clone git@github.com:sweatco/mobile.git repos/mobile

# 3. Setup environment
cp .env.example .env
# Edit .env with your API keys (see below)

# 4. Start server
npm run dev

# 5. Expose with ngrok (separate terminal)
ngrok http 3000

# 6. Update Slack app Event URL with ngrok URL
# https://api.slack.com/apps → Event Subscriptions
# Set to: https://YOUR-NGROK-URL.ngrok.io/slack/events

# 7. Test in Slack
# @AI Engineer investigate login timeout
```

## Overview

Run the AI Engineer system locally for development and testing without deploying to GCP. Supports testing with or without Slack integration.

## Prerequisites

- Node.js 20+
- Git
- Anthropic API key (from https://console.anthropic.com/settings/keys)
- Slack workspace (for full integration testing)

**Optional:**
- ngrok (required for Slack webhooks to reach localhost)
- Slack paid workspace (free workspaces work fine for development)

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Setup Local Repositories

**IMPORTANT:** For MVP/local development, clone repositories as **regular clones** (not bare) so agents can read actual code files.

```bash
mkdir -p repos

# Clone as REGULAR repositories (agents need working files)
git clone git@github.com:sweatco/backend.git repos/backend
git clone git@github.com:sweatco/mobile.git repos/mobile
```

After cloning, verify you can see actual code:
```bash
ls repos/backend/app/models/    # Should show Ruby files
ls repos/mobile/src/screens/    # Should show React Native files
```

**Why regular clones for MVP?**
- Agents need to read actual code files (`.rb`, `.tsx`, etc.)
- Bare repositories (`--bare`) only contain Git data, no working directory
- Production will use bare repos + Git worktrees, but MVP uses simple regular clones

**For testing without real repos:**
```bash
# Create minimal test repositories with sample code
./scripts/create-test-repos.sh
```

### 3. Create Slack Bot (Required for Full Testing)

**EASY WAY:** Use the app manifest file at [`slack-manifest.yaml`](../slack-manifest.yaml)

#### Quick Setup with Manifest

1. Go to https://api.slack.com/apps
2. Click **"Create New App"** → **"From an app manifest"**
3. Choose your workspace
4. Select **YAML** tab
5. Copy/paste the contents from [`slack-manifest.yaml`](../slack-manifest.yaml)
6. **IMPORTANT:** You'll need to update the Request URL later with your ngrok URL (see Step 5)
7. Click **"Create"**
8. Review permissions and click **"Install to Workspace"**
9. Authorize the app

#### Get Your Credentials

After creating the app, get these two values:

**1. Bot Token** (OAuth & Permissions page):
```
xoxb-1234567890-1234567890123-abcdefghijklmnopqrstuvwx
```

**2. Signing Secret** (Basic Information page → App Credentials):
```
a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6
```

**What permissions does the bot get?**
- `app_mentions:read` - Receive @mentions
- `chat:write` - Post messages to threads
- `channels:history` - Read thread history
- `users:read` - Get user names

**What events does it subscribe to?**
- `app_mention` - When bot is @mentioned
- `message.channels` - Thread replies (without @mention)

### 4. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and fill in your actual values:
```bash
# Required - Get from https://console.anthropic.com/settings/keys
ANTHROPIC_API_KEY=sk-ant-api03-...

# Required - From Slack App settings (see Step 3 above)
SLACK_BOT_TOKEN=xoxb-1234567890-1234567890123-abcdefghijklmnopqrstuvwx
SLACK_SIGNING_SECRET=a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6

# Required - Absolute paths to your repository clones
BACKEND_REPO_PATH=/Users/khmelev/Projects/swc/ai-engineer/repos/backend
MOBILE_REPO_PATH=/Users/khmelev/Projects/swc/ai-engineer/repos/mobile

# Optional - Server port (default: 3000)
PORT=3000
```

### 5. Expose Local Server to Slack (via ngrok)

For Slack webhooks to reach your local server, you need to expose it publicly:

#### Install ngrok

```bash
# macOS
brew install ngrok

# Or download from https://ngrok.com/download
```

#### Start ngrok tunnel

```bash
# In a separate terminal
ngrok http 3000
```

You'll see output like:
```
Forwarding  https://abc123.ngrok.io -> http://localhost:3000
```

#### Update Slack Event URL

1. Copy your ngrok URL: `https://abc123.ngrok.io`
2. Go to your Slack App settings: https://api.slack.com/apps
3. Navigate to **Event Subscriptions**
4. Update Request URL to: `https://abc123.ngrok.io/slack/events`
5. Slack will verify the URL (make sure your server is running!)
6. Click **Save Changes**

**Note:** Free ngrok URLs change each restart. Paid ngrok ($10/month) gives static URLs.

### 6. Run Development Server

```bash
npm run dev
```

Server starts on `http://localhost:3000`

You should see:
```
AI Engineer - Multi-Agent Software Engineering System
======================================================

Backend repo: /Users/khmelev/Projects/swc/ai-engineer/repos/backend
Mobile repo: /Users/khmelev/Projects/swc/ai-engineer/repos/mobile

AI Engineer server is running on port 3000
Webhook endpoint: POST /slack/events
Health check: GET /health
```

### 7. Test Slack Integration

1. In Slack, invite the bot to a channel: `/invite @AI Engineer`
2. Send a test message: `@AI Engineer hello`
3. Check server logs - you should see the message being processed
4. Bot should respond in the thread

## Development Modes

### Mode 1: CLI Testing (No Slack)

Test agents directly via HTTP API:

```bash
# Create new task
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Investigate login timeout on iOS",
    "user": "test-user"
  }'

# Response:
# {"task_id": "task-1", "status": "in_progress"}

# Check task status
curl http://localhost:3000/api/tasks/task-1

# View task log
curl http://localhost:3000/api/tasks/task-1/log

# Add message to existing task
curl -X POST http://localhost:3000/api/tasks/task-1/messages \
  -d '{"message": "Also happening on Android now"}'
```

### Mode 2: Mock Slack (Fast testing)

Use mock Slack API for testing without real Slack workspace:

```bash
# Enable mock mode
SLACK_MOCK=true npm run dev

# Simulates Slack messages
curl -X POST http://localhost:3000/test/slack-message \
  -d '{
    "text": "@ai-engineer Fix login timeout",
    "user": "U123",
    "thread_ts": "1234567890.123456"
  }'
```

Mock Slack posts responses to console instead of real Slack.

### Mode 3: Real Slack (Full integration)

Expose local server to Slack via ngrok:

```bash
# Terminal 1: Start server
npm run dev

# Terminal 2: Expose via ngrok
ngrok http 3000
# Outputs: https://abc123.ngrok.io

# Configure Slack App:
# Event Subscriptions URL: https://abc123.ngrok.io/slack/events
```

Now Slack webhooks reach your local server.

**Tip:** Use ngrok free tier for development. Pro version ($10/month) gives static URLs.

## Testing Strategies

### Unit Tests

Test individual components:

```bash
# Message queue
npm test -- message-queue.test.ts

# Task persistence
npm test -- task-manager.test.ts

# MCP tools
npm test -- mcp-tools.test.ts
```

### Integration Tests

Test agent interactions:

```bash
# Mock agents (fast)
npm test -- agents.integration.test.ts

# Real agents (uses Anthropic API, slower/costs)
ANTHROPIC_API_KEY=sk-ant-... npm test -- agents.real.test.ts
```

### End-to-End Tests

```bash
# With mock repos
npm run test:e2e

# With real repos
REPOS_PATH=/path/to/real/repos npm run test:e2e
```

### Manual Testing

```bash
# Interactive REPL for testing
npm run repl

> const task = await createTask("Fix auth timeout");
> await sendMessageToAgent(task.id, "mobile-agent", "Investigate iOS");
> const log = await readTaskLog(task.id);
> console.log(log);
```

## Mock Components

### Mock Triage Agent

```typescript
// For fast testing, skip real Haiku calls
const mockTriage = {
  classify: (message: string) => {
    if (message.includes('status')) return {action: 'status_request'};
    return {action: 'new_task'};
  }
};
```

### Mock Anthropic API

```typescript
// For testing without API costs
const mockAnthropic = {
  query: async (prompt: string) => {
    // Return canned responses based on prompt patterns
    if (prompt.includes('assign owner')) {
      return 'I assign backend-agent as task owner';
    }
  }
};
```

Enable via: `ANTHROPIC_MOCK=true npm run dev`

## Directory Structure

```
repos/              # Local git repositories (gitignored)
  backend.git/
  mobile.git/
  website.git/

sessions/           # Local task data (gitignored)
  task-1/
    metadata.json
    shared-knowledge.log
    worktrees/
      backend/
      mobile/

logs/              # Application logs (gitignored)
  system.log
  agents.log
```

## Troubleshooting

### Slack Webhook Not Working

**Problem:** Slack says "Your URL didn't respond with the challenge parameter"

**Solutions:**
1. Make sure your dev server is running (`npm run dev`)
2. Check ngrok is forwarding to correct port: `ngrok http 3000`
3. Verify `.env` has correct `SLACK_SIGNING_SECRET`
4. Check server logs for errors

**Test webhook manually:**
```bash
curl -X POST http://localhost:3000/health
# Should return: {"status":"ok"}
```

### Bot Not Responding

**Problem:** Bot doesn't respond to @mentions

**Check:**
1. Bot is invited to channel: `/invite @AI Engineer`
2. Event Subscriptions are enabled in Slack App settings
3. Server logs show the incoming message
4. Check for errors in console output

**Debug mode:**
```bash
# See all Slack events
npm run dev | grep "\[Slack\]"
```

### Repository Path Issues

**Problem:** Agents can't read code files

**Check:**
```bash
# Verify repos exist and have code
ls -la repos/backend/app/
ls -la repos/mobile/src/

# Make sure they're regular clones, not bare
test -d repos/backend/.git && echo "Regular clone ✓" || echo "Bare repo ✗"
```

**Fix:**
See "Fix Bare Repository Issue" section below.

### ANTHROPIC_API_KEY Invalid

**Problem:** API calls fail with authentication error

**Solution:**
1. Get a valid API key from https://console.anthropic.com/settings/keys
2. Make sure it starts with `sk-ant-api03-`
3. Update `.env` file
4. Restart server

## Debugging

### View Logs

```bash
# Server console output (shows all agent activity)
# Just run: npm run dev

# Specific task logs
cat sessions/task-24122025-1430-abc123/shared-knowledge.log
cat sessions/task-24122025-1430-abc123/metadata.json | jq
```

### Debug Agent Behavior

```bash
# The server outputs all activity to console by default
# Look for these log patterns:
# [Slack] - Incoming messages
# [Triage] - Classification results
# [PM Agent] - PM activity
# [Backend Agent] - Backend agent activity
# [Mobile Agent] - Mobile agent activity
# [System] - Task lifecycle events
```

### Inspect Task State

```bash
# View all tasks
ls sessions/

# View task metadata
cat sessions/task-1/metadata.json | jq

# View task log
cat sessions/task-1/shared-knowledge.log

# View worktree state
cd sessions/task-1/worktrees/backend
git status
```

## Hot Reload

Development server watches for changes:

```bash
npm run dev  # Uses nodemon or similar

# Edit src/agents/pm.ts
# Server auto-restarts
# Active tasks preserved (sessions on disk)
```

## Common Development Tasks

### Reset Everything

```bash
# Clear all tasks and state
rm -rf sessions/*
npm run dev
```

### Fix Bare Repository Issue

If you accidentally cloned repositories as bare (no code files visible):

```bash
# Remove bare repositories
rm -rf repos/backend repos/mobile

# Clone as regular repositories
git clone git@github.com:sweatco/backend.git repos/backend
git clone git@github.com:sweatco/mobile.git repos/mobile

# Verify you can see code
ls repos/backend/app/
ls repos/mobile/src/
```

### Test Specific Agent

```bash
# Run single agent in isolation
npm run agent:test -- --agent=backend --prompt="Investigate auth timeout"
```

### Simulate Multi-Agent Flow

```bash
# Script to test full flow
npm run simulate -- scenarios/auth-timeout.json
```

## Tips

**Fast iteration:**
- Use mock mode for rapid testing
- Use real agents for behavior validation
- Keep test repos small (faster to read)

**Cost optimization:**
- Mock Anthropic API for unit tests
- Use Haiku for testing (cheaper than Sonnet)
- Limit context size during development

**Debugging stuck agents:**
- Check logs/agents.log for errors
- Inspect TaskRuntime state (add debug endpoint)
- Check message queues aren't blocked

## Environment Variables Reference

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-...           # Claude SDK

# Local paths
REPOS_PATH=./repos                     # Git repositories
SESSIONS_PATH=./sessions               # Task persistence
LOG_PATH=./logs                        # Application logs

# Slack (optional)
SLACK_BOT_TOKEN=xoxb-...              # Slack integration
SLACK_SIGNING_SECRET=...              # Webhook verification
SLACK_MOCK=false                      # Use mock Slack API

# GitHub (optional)
GITHUB_APP_ID=123456                  # GitHub App ID
GITHUB_APP_PRIVATE_KEY_PATH=...       # Path to private key

# Development
NODE_ENV=development                   # Environment
PORT=3000                             # Server port
DEBUG=agents:*                        # Debug namespaces
ANTHROPIC_LOG=debug                   # SDK debug mode
ANTHROPIC_MOCK=false                  # Use mock API
```

## Next Steps

Once local development is working:
1. Test with real codebases
2. Iterate on agent prompts
3. Refine task assignment logic
4. Deploy to staging (GCP VM)
5. Deploy to production

---

**Related Documentation:**
- [MVP v1 Plan](../plans/mvp-v1.md) - Implementation timeline
- [Deployment & Operations](deployment-operations.md) - Production deployment
- [Architecture Overview](architecture-overview.md) - System design
