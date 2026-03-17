> **Status: Implemented** — Core multi-agent system with Slack integration, triage, PM agent, repo agents, message queues, MCP tools, and file-based task persistence.

# MVP v1 Specification

## Overview

Read-only multi-agent bug investigation system with Backend + Mobile agents. Validates all core architectural concepts without the complexity of write operations.

**Timeline:** ~4 weeks
**Goal:** Prove multi-agent coordination for cross-repository code investigation

## What This Validates

✅ **Multi-agent coordination** - Backend ↔ Mobile communication
✅ **Task ownership pattern** - One agent leads, others assist
✅ **Two-channel communication** - Direct messages + shared log
✅ **PM Agent role** - Assignment, user communication
✅ **Triage routing** - New task vs existing
✅ **Task persistence** - Metadata, logs, state
✅ **Cross-repo investigation** - Issues spanning multiple codebases

## Architecture Scope

### Included Components

**Agents (4 total):**
- **Triage Agent** (Haiku) - Message classification
- **PM Agent** (Sonnet) - Task coordination, user communication
- **Backend Agent** (Sonnet) - Rails codebase investigation
- **Mobile Agent** (Sonnet) - React Native/iOS/Android investigation

**System Layer:**
- Slack webhook integration (receive @mentions)
- Message queues + async generators (streaming input)
- TaskRuntime in-memory state: `Map<task_id, {queues, queryObjects, generators}>`
- Task routing and lifecycle management

**Task Persistence:**
- Basic task folders: `sessions/task-{id}/`
- `metadata.json` - Task state (task_id, task_owner, participants, status)
- `shared-knowledge.log` - Chronological messages + findings

**MCP Tools:**
- `send_message_to_agent(target, message)` - Agent-to-agent communication
- `log_finding(entry, type)` - Write to shared log (discovery, decision, completion, blocker)
- `post_to_slack(message)` - PM posts to users
- `ask_user(question, options)` - Triage asks clarification

**Task States:**
- `in_progress` - Active investigation
- `completed` - Investigation done

**Code Access:**
- Read from main branch directly (no worktrees needed)
- Backend: Rails codebase at `/repos/backend/`
- Mobile: React Native codebase at `/repos/mobile/`
- Standard SDK tools: bash, file operations, grep

### Explicitly Excluded (Post-MVP)

❌ **Website Agent** - Not needed for initial validation
❌ **Memory Agent** - No summaries yet (PM reads log directly)
❌ **Git worktrees** - Read from main, no isolation needed
❌ **Multi-thread detection** - One Slack thread per task
❌ **Server restart recovery** - Restart = fresh start
❌ **`report_completion` tool** - PM auto-posts after inactivity
❌ **Write operations** - No commits, PRs, or code changes
❌ **30-min timeout protection** - Simple approach for MVP
❌ **Workspace context** - No team preferences file
❌ **Task assignment strategy** - Always assign Mobile or Backend based on keywords

## MVP User Flow

### Example: Cross-Repository Investigation

```
1. User in Slack:
   "@ai-engineer Login times out on iOS but works fine on Android"

2. Triage Agent:
   - Fetches thread history from Slack
   - Checks: grep for thread_id in sessions/*/metadata.json → Not found
   - Extracts keywords: "login", "timeout", "iOS", "Android"
   - Returns: {action: "new_task"}

3. System:
   - Creates sessions/task-1/ directory
   - Creates metadata.json:
     {
       "task_id": "task-1",
       "task_owner": null,
       "participants": [],
       "status": "in_progress",
       "slack_thread": "1234567890.123456",
       "created_at": "2024-01-15T10:00:00Z"
     }
   - Appends message to shared-knowledge.log:
     [2024-01-15T10:00:00Z] [slack:1234567890.123456] [user:john.smith] Login times out on iOS but works fine on Android
   - Creates TaskRuntime in memory with queues for PM, Backend, Mobile
   - Spawns PM Agent with streaming input

4. PM Agent:
   - Receives: "New task created, assign owner"
   - Reads shared-knowledge.log to understand request
   - Analyzes keywords: "iOS" + "Android" + "login" → Mobile issue, likely Backend involved
   - Calls: send_message_to_agent("mobile-agent", "You're task owner. Investigate iOS login timeout. Android works fine.")
   - Updates metadata.json: task_owner = "mobile-agent", participants = ["mobile-agent"]
   - Calls: post_to_slack("Looking into the iOS login timeout issue")

5. System:
   - Posts to Slack: "Looking into the iOS login timeout issue"
   - Queues message to Mobile Agent
   - Mobile Agent's generator yields message

6. Mobile Agent (task owner):
   - Receives: "You're task owner. Investigate iOS login timeout. Android works fine."
   - Reads mobile/src/auth/AuthService.tsx
   - Finds: iOS timeout constant = 30000 (30 seconds)
   - Reads mobile/src/auth/LoginScreen.tsx
   - Calls: log_finding("iOS login timeout set to 30s in AuthService.tsx:45", "discovery")
   - Calls: send_message_to_agent("backend-agent", "I found iOS timeout is 30s. How long does /auth/login take to respond?")
   - [Mobile Agent pauses, waits for Backend response]

7. System:
   - Appends to shared-knowledge.log:
     [2024-01-15T10:05:23Z] [mobile-agent] [discovery] iOS login timeout set to 30s in AuthService.tsx:45
   - Queues message to Backend Agent
   - Spawns Backend Agent if not already running
   - Backend Agent's generator yields message

8. Backend Agent:
   - Receives: "I found iOS timeout is 30s. How long does /auth/login take to respond?"
   - Updates metadata.json: participants = ["mobile-agent", "backend-agent"]
   - Reads backend/app/controllers/auth_controller.rb
   - Finds: External API call can take 20-45s
   - Calls: log_finding("Backend /auth/login calls external API, takes 20-45s under load", "discovery")
   - Responds to Mobile: "Backend can take 20-45s during peak hours. Android timeout?"
   - [Backend continues working, Mobile resumes]

9. System:
   - Appends to shared-knowledge.log:
     [2024-01-15T10:07:12Z] [backend-agent] [discovery] Backend /auth/login calls external API, takes 20-45s under load
   - Yields Backend's response to Mobile Agent

10. Mobile Agent:
    - Receives Backend's response
    - Reads mobile/src/auth/ for Android config
    - Finds: Android timeout = 60000 (60 seconds)
    - Calls: log_finding("Android timeout is 60s, that's why it works", "discovery")
    - Calls: log_finding("Root cause: iOS 30s timeout too short for backend that needs up to 45s", "decision")
    - Calls: log_finding("Investigation complete", "completion")

11. System:
    - Appends findings to shared-knowledge.log
    - Detects "completion" type
    - Waits 2 minutes for any additional activity
    - Queues message to PM: "Task owner completed investigation"

12. PM Agent:
    - Receives: "Task owner completed investigation"
    - Reads full shared-knowledge.log
    - Synthesizes findings into human-friendly summary
    - Calls: post_to_slack("Found the issue! iOS has a 30-second timeout but our backend login can take up to 45 seconds during peak load. Android works because it has a 60-second timeout. The backend makes an external API call that's causing the delay.")
    - Updates metadata.json: status = "completed"

13. System:
    - Posts PM's message to Slack
    - Removes TaskRuntime from memory (keeps disk state)
    - Task complete

14. User sees explanation in Slack
```

## Success Criteria

MVP is successful when it demonstrates:

1. ✅ **PM correctly assigns task owner** based on keywords
2. ✅ **Mobile coordinates with Backend** via `send_message_to_agent`
3. ✅ **Both agents read their respective codebases** using SDK tools
4. ✅ **Findings logged to shared-knowledge.log** with proper format
5. ✅ **PM synthesizes natural summary** for Slack (not verbose SDK output)
6. ✅ **Task persisted on disk** and recoverable (metadata + log)
7. ✅ **Agents pause/resume correctly** during `send_message_to_agent`

## Implementation Phases

### Week 1: Foundation

**Goal:** Basic infrastructure working

- [ ] Project setup (TypeScript/Node.js)
- [ ] Slack webhook integration
  - [ ] Receive @mention events
  - [ ] Fetch thread history
  - [ ] Post messages back to Slack
- [ ] Basic System layer
  - [ ] Message routing
  - [ ] TaskRuntime Map structure
  - [ ] Task folder creation
- [ ] Triage Agent (Haiku)
  - [ ] Classify: new_task only (no existing_task yet)
  - [ ] Return JSON: {action, task_id, confidence}
- [ ] Task persistence
  - [ ] Create sessions/task-{id}/ folders
  - [ ] Write metadata.json
  - [ ] Append to shared-knowledge.log

**Milestone:** Can receive Slack message, create task, and log it

### Week 2: Agents & Communication

**Goal:** Agents working with basic coordination

- [ ] PM Agent (Sonnet)
  - [ ] System prompt with role/responsibilities
  - [ ] Simple assignment logic (iOS/Android → Mobile, API/Database → Backend)
  - [ ] Read shared-knowledge.log
  - [ ] Call send_message_to_agent
  - [ ] Call post_to_slack
- [ ] Backend Agent (Sonnet)
  - [ ] System prompt with role/responsibilities
  - [ ] Read Rails codebase
  - [ ] Respond to direct messages
  - [ ] Call log_finding
- [ ] Mobile Agent (Sonnet)
  - [ ] System prompt with role/responsibilities
  - [ ] Read React Native codebase
  - [ ] Coordinate with Backend via send_message_to_agent
  - [ ] Call log_finding
- [ ] MCP Tools implementation
  - [ ] send_message_to_agent (pause/wait/resume)
  - [ ] log_finding (append to shared-knowledge.log)
  - [ ] post_to_slack (post to Slack API)

**Milestone:** Agents can communicate and investigate issues

### Week 3: Integration & Streaming

**Goal:** Full flow working end-to-end

- [ ] Message queues per agent
  - [ ] Queue implementation with nextMessage()
  - [ ] stop() for clean shutdown
- [ ] Async generators for streaming input
  - [ ] Generator loops forever, yields from queue
  - [ ] Pass to query({prompt: agentInput(queue)})
- [ ] TaskRuntime state management
  - [ ] Store QueryObject references for each agent
  - [ ] Store generator references
  - [ ] Cleanup on task completion
- [ ] PM auto-summary
  - [ ] Detect inactivity (2 min no log updates)
  - [ ] Trigger PM to read log and summarize
  - [ ] Post to Slack
- [ ] Complete end-to-end flow
  - [ ] Triage → PM → Mobile → Backend → PM → Slack

**Milestone:** Full user flow works from Slack to investigation to summary

### Week 4: Testing & Polish

**Goal:** Production-ready MVP

- [ ] Real codebase testing
  - [ ] Test with actual Rails backend
  - [ ] Test with actual React Native mobile app
  - [ ] Multiple test scenarios
- [ ] Edge case handling
  - [ ] Agent gets stuck
  - [ ] Slack API errors
  - [ ] Invalid thread IDs
  - [ ] Missing files
- [ ] Error handling & logging
  - [ ] System logs for debugging
  - [ ] Graceful failures
  - [ ] User-friendly error messages
- [ ] Documentation
  - [ ] Setup instructions
  - [ ] Configuration guide
  - [ ] Testing guide
- [ ] Demo preparation
  - [ ] Test scenarios documented
  - [ ] Demo script
  - [ ] Known limitations documented

**Milestone:** Ready to demo to stakeholders

## Technical Stack

**Runtime:**
- Node.js 20+
- TypeScript 5+

**Dependencies:**
- `@anthropic-ai/sdk` - Claude Agent SDK
- `@slack/web-api` - Slack integration
- `@slack/events-api` - Slack webhooks

**File Structure:**
```
src/
  system/
    server.ts           # Main entry point, webhook handler
    task-runtime.ts     # TaskRuntime state management
    task-manager.ts     # Task creation, persistence
    message-queue.ts    # Queue implementation
  agents/
    triage.ts          # Triage Agent (Haiku)
    pm.ts              # PM Agent (Sonnet)
    backend.ts         # Backend Agent (Sonnet)
    mobile.ts          # Mobile Agent (Sonnet)
  mcp/
    tools.ts           # MCP tool implementations
  slack/
    client.ts          # Slack API wrapper
    events.ts          # Webhook event handlers
  types/
    task.ts            # Task types
    agent.ts           # Agent types

sessions/              # Task persistence (gitignored)
repos/                 # Cloned repositories (gitignored)
  backend/
  mobile/
```

## Configuration

**Environment Variables:**
```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
ANTHROPIC_API_KEY=sk-ant-...
BACKEND_REPO_PATH=/path/to/backend
MOBILE_REPO_PATH=/path/to/mobile
PORT=3000
```

## Testing Strategy

**Unit Tests:**
- Message queue implementation
- Task persistence (create, update, read)
- MCP tool implementations

**Integration Tests:**
- Triage Agent classification
- PM Agent assignment logic
- Agent-to-agent messaging flow
- Slack webhook handling

**End-to-End Tests:**
- Complete user flow (Slack → Investigation → Summary)
- Multiple scenarios (iOS issue, Android issue, backend issue)

**Manual Testing:**
- Real Slack workspace
- Real codebases
- Different types of investigations

## Known Limitations (MVP v1)

1. **Single thread per task** - No multi-thread detection yet
2. **No restart recovery** - Server restart loses in-progress tasks
3. **No write operations** - Read-only investigation
4. **Basic PM logic** - Simple keyword-based assignment
5. **No Memory Agent** - PM reads full log (could be large)
6. **No timeout protection** - Tasks could run indefinitely
7. **Main branch only** - No git worktrees, reads from main
8. **Two repos only** - Backend + Mobile (no Website)

## Post-MVP Roadmap

**v1.1 - Memory & Summaries:**
- Add Memory Agent (Haiku) for task summarization
- Implement `report_completion` tool
- Better PM summary generation

**v1.2 - State Recovery:**
- Server restart recovery
- Resume in-progress tasks
- Multi-thread detection

**v1.3 - Website Agent:**
- Add third repository
- Three-agent coordination
- Task assignment strategy refinement

**v2.0 - Write Operations:**
- Git worktrees per task
- Code changes and commits
- Pull request creation
- Test execution

## Success Metrics

**MVP is successful if:**
1. Can investigate 80%+ of submitted issues
2. Agents coordinate correctly without getting stuck
3. Summaries are accurate and helpful
4. Task completion time < 5 minutes
5. No manual intervention needed for happy path
6. Stakeholders excited about next phase

---

**Related Documentation:**
- [Architecture Overview](architecture-overview.md) - Full system design
- [Agent Architecture](agent-architecture.md) - Agent specifications
- [System Orchestration](system-orchestration.md) - System layer details
- [Task Persistence](task-persistence.md) - Storage and state
- [Slack Integration](slack-integration.md) - UX layer details
