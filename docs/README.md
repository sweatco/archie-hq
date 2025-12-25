# AI Engineer Documentation

Complete technical documentation for the multi-agent AI software engineering system.

## Quick Links

- [Architecture Overview](architecture-overview.md) - System design and concepts
- [Agent Architecture](agent-architecture.md) - AI agent specifications
- [System Orchestration](system-orchestration.md) - Backend implementation
- [Task Persistence](task-persistence.md) - Storage and state
- [Slack Integration](slack-integration.md) - User interface layer
- [Local Development](local-development.md) - Running locally
- [Deployment & Operations](deployment-operations.md) - Production setup

## System Overview

Multi-agent AI system where specialized agents collaborate on software engineering tasks across multiple repositories via Slack.

### Core Components

- **Triage Agent** - Lightweight Haiku-based classifier for incoming messages
- **PM Agent** - Task coordinator and user interface (Sonnet)
- **Backend Agent** - Ruby on Rails engineer (Sonnet)
- **Mobile Agent** - React Native/iOS/Android engineer (Sonnet)

### Technology Stack

- **Runtime**: Node.js with TypeScript
- **AI**: Claude Agent SDK (Sonnet 4.5, Haiku 4.5)
- **Integration**: Slack Bolt (HTTP webhooks)
- **Storage**: File-based sessions
- **Version Control**: Git

## Key Implementation Details

### Task ID Format

Tasks use human-readable IDs:
```
Format: task-DDMMYYYY-HHMM-xxxxxx
Example: task-23122025-1712-a3f9k2
```

Generated in [src/system/task-manager.ts:20-38](../src/system/task-manager.ts#L20-L38)

### Working Directory Configuration

Each agent has a specific working directory for tool execution:

| Agent | Working Directory | Purpose |
|-------|------------------|---------|
| Triage | `sessions/` | Search historical task metadata |
| PM | `sessions/task-{id}/` | Direct access to task logs |
| Backend | `/repos/backend` | Backend repository operations |
| Mobile | `/repos/mobile` | Mobile repository operations |

Configured via the `cwd` option in Claude Agent SDK's `query()` function.

### Session Recovery

Agents maintain conversation context across task reactivation:

1. **Session Capture**: When agent starts, `init` event provides `session_id`
2. **Persistence**: Session ID stored in `metadata.json` under `agent_sessions`
3. **Recovery**: On reactivation, session ID loaded and passed via `resume` option

**Implementation:**
- Session capture: [src/agents/backend.ts:134-136](../src/agents/backend.ts#L134-L136)
- Session storage: [src/system/task-runtime.ts:220-223](../src/system/task-runtime.ts#L220-L223)
- Session loading: [src/system/task-runtime.ts:269-274](../src/system/task-runtime.ts#L269-L274)
- Session passing: [src/system/task-runtime.ts:233](../src/system/task-runtime.ts#L233)

### Task Lifecycle

**States:**
- `in_progress` - Agents actively working
- `stopped` - User cancelled or error occurred
- `completed` - PM called report_completion

**Activation Model:**
- `isActive = true` ONLY when agents are processing
- Question-only tasks: PM answers → calls `report_completion` → deactivates
- User adds details → task reactivates automatically
- Session context preserved across reactivations

### Message Flow

```
Slack Event → handleSlackMessage()
    ↓
triageMessage() → classify intent
    ↓
Route by action:
├─ new_task → createTask() → spawn PM → assign owner
├─ existing_task → append to log → notify PM
├─ status_request → notify PM for status
├─ cancel_task → stopTask()
└─ noop → do nothing
```

**Entry Point**: [src/system/server.ts](../src/system/server.ts)

**Message Handler**: [src/slack/events.ts:47-113](../src/slack/events.ts#L47-L113)

### Agent Communication

**Direct Messaging** (`send_message_to_agent`):
- Adds message to target agent's queue
- Target agent processes when ready
- Asynchronous, non-blocking

**Shared Knowledge Log** (`log_finding`):
- Appends to `sessions/task-{id}/shared-knowledge.log`
- Visible to all agents and PM
- Types: discovery, decision, completion, blocker

**Slack Posting** (`post_to_slack` - PM only):
- Posts to all Slack threads linked to task
- Natural human-like communication
- Brief and user-friendly

### File Structure

```
sessions/
  task-23122025-1712-a3f9k2/
    metadata.json              # Task info, participants, session IDs
    shared-knowledge.log       # All agent findings and decisions
    memory/                    # Future: agent-specific context
```

**metadata.json structure:**
```json
{
  "task_id": "task-23122025-1712-a3f9k2",
  "task_owner": "mobile-agent",
  "participants": ["pm-agent", "mobile-agent"],
  "slack_threads": [{
    "thread_id": "1234567890.123456",
    "channel_id": "C01234567",
    "last_processed_ts": "1234567890.123457"
  }],
  "agent_sessions": {
    "pm-agent": "session-abc123",
    "mobile-agent": "session-xyz789"
  },
  "repositories": {
    "backend": { "path": "/repos/backend" },
    "mobile": { "path": "/repos/mobile" }
  },
  "status": "in_progress",
  "created_at": "2025-12-23T17:12:00.000Z",
  "updated_at": "2025-12-23T17:15:30.000Z"
}
```

### In-Memory State (TaskRuntime)

**Purpose**: Fast access to active tasks without disk I/O

**Structure**:
```typescript
{
  taskId: string,
  metadata: TaskMetadata,           // Cached from disk
  queues: {                         // Message queues
    pm: MessageQueue,
    backend: MessageQueue,
    mobile: MessageQueue
  },
  handles: {                        // Running agent handles
    pm?: AgentHandle,
    backend?: AgentHandle,
    mobile?: AgentHandle
  },
  sessions: {                       // Session IDs for resume
    pm?: string,
    backend?: string,
    mobile?: string
  },
  spawned: {                        // Which agents are active
    pm: boolean,
    backend: boolean,
    mobile: boolean
  },
  isActive: boolean,                // Are agents working?
  lastActivity: Date,
  completionDetected: boolean
}
```

**Lookup Performance**: O(n) where n ≈ 10-20 active tasks

### Thread History Optimization

**Problem**: Avoid fetching same thread multiple times

**Solution**:
1. Fetch thread history once in `handleSlackMessage()`
2. Pass to both `triageMessage()` and handlers
3. Track `last_processed_ts` per thread
4. Only append new messages on reactivation

**Implementation**: [src/slack/events.ts:78-79](../src/slack/events.ts#L78-L79)

### Idempotent Operations

**Task Stop/Complete Guards**: Prevent double-stopping/completing

```typescript
if (!runtime.isActive) {
  console.log(`Already stopped/completed`);
  return;  // Guard prevents duplicate operations
}
runtime.isActive = false;
// ... cleanup
```

**Implementation**: [src/system/task-runtime.ts:338-341](../src/system/task-runtime.ts#L338-L341)

## Common Patterns

### Task Manager vs Task Runtime

**Task Manager** ([src/system/task-manager.ts](../src/system/task-manager.ts)):
- File-based persistence layer
- CRUD operations on `metadata.json` and logs
- Stateless, slow (disk I/O)
- Data survives restarts

**Task Runtime** ([src/system/task-runtime.ts](../src/system/task-runtime.ts)):
- In-memory state management
- Message queues and agent coordination
- Stateful, fast (memory)
- Lost on restart (must reload)

### MCP Tools

Custom tools that agents call to interact with the system:

**PM Agent Tools**:
- `assign_task_owner` - Designate task owner
- `send_message_to_agent` - Message another agent
- `post_to_slack` - Communicate with user
- `report_completion` - Signal task done

**Repo Agent Tools** (Backend, Mobile):
- `send_message_to_agent` - Coordinate with peers
- `log_finding` - Write to shared log

**Implementation**: [src/mcp/tools.ts](../src/mcp/tools.ts)

### Streaming Generators

Agents use async generators for continuous message processing:

```typescript
// Create message queue
const queue = new MessageQueue();

// Create generator that yields from queue
const inputGenerator = createAgentInputGenerator(queue);

// Agent runs continuously
query({
  prompt: inputGenerator,
  options: { /* ... */ }
});

// Add messages to queue
queue.addMessage("New user input");

// Stop when done
queue.stop();  // Generator exits, agent stops
```

**Benefits**:
- Agent stays alive, processes multiple messages
- No need to restart for each user input
- Maintains conversation context

## Development Workflow

### Running Locally

See [Local Development](local-development.md) for setup instructions.

### Testing Changes

```bash
# Type checking
npm run typecheck

# Build
npm run build

# Run in development mode
npm run dev
```

### Key Files to Know

- [src/index.ts](../src/index.ts) - Entry point
- [src/system/server.ts](../src/system/server.ts) - HTTP webhook server
- [src/slack/events.ts](../src/slack/events.ts) - Unified message handler
- [src/agents/triage.ts](../src/agents/triage.ts) - Message classifier
- [src/agents/pm.ts](../src/agents/pm.ts) - PM agent orchestrator
- [src/system/task-runtime.ts](../src/system/task-runtime.ts) - Runtime state
- [src/system/task-manager.ts](../src/system/task-manager.ts) - Persistence

## Architecture Decisions

### Why streaming generators for agents?

**Alternative**: Spawn new agent for each message
**Chosen**: Single long-running agent with streaming input

**Reasoning**:
- Maintains conversation context naturally
- Reduces startup overhead
- Matches how agents would work in production
- Simpler state management

### Why file-based storage?

**Alternative**: Database (PostgreSQL, MongoDB)
**Chosen**: JSON files on disk

**Reasoning**:
- Simple MVP implementation
- Easy debugging (read files directly)
- No database setup/maintenance
- Sufficient for expected load (~100 tasks/day)
- Easy migration path to DB later

### Why PM controls task completion?

**Alternative**: Task owner calls `report_completion` directly
**Chosen**: Owner messages PM, PM evaluates and completes

**Reasoning**:
- PM can push back, ask for more work
- Quality control before marking complete
- PM has full context of user expectations
- Matches real-world PM workflow

### Why separate triage agent?

**Alternative**: PM handles triage too
**Chosen**: Dedicated Haiku-based triage agent

**Reasoning**:
- Cost optimization (Haiku cheaper than Sonnet)
- Speed (Haiku faster for simple classification)
- Clear separation of concerns
- Can run triage before PM initialization

## Future Enhancements

- [ ] Database backend for task storage
- [ ] Agent-specific memory folders
- [ ] Git worktrees for parallel work
- [ ] Website agent for frontend work
- [ ] Memory agent for summarization
- [ ] Multi-repository coordination improvements
- [ ] Metrics and observability
- [ ] Agent performance monitoring

## Contributing

See main [README.md](../README.md) for contribution guidelines.

## License

Proprietary - Sweatco Ltd.
