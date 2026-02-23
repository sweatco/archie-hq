> **Status: Not implemented** — The Redis/GroupMQ durable queue architecture was not built. The system uses in-memory MessageQueue per agent (from v1). Task state recovery relies on v10's restart mechanism instead.

# MVP 4: Queue-Based Architecture & Graceful Deployment

**Status**: Planned
**Goal**: Replace in-memory event handling with durable queue-based architecture enabling zero-downtime deployments and reliable event processing.

## Key Design Decisions

### Reuse Existing Logic

This MVP is primarily an infrastructure change, not a logic change. The goal is to wrap existing event handling code with queue-based durability:

- **Keep existing routing logic** - [src/github/events.ts](../src/github/events.ts) already has `routeGitHubEvent()` and `handleGitHubWebhook()` with correct deterministic routing
- **Keep existing triage logic** - [src/agents/triage.ts](../src/agents/triage.ts) already handles Slack and GitHub comment triage
- **Keep existing task handlers** - [src/slack/events.ts](../src/slack/events.ts) has `handleNewTask()`, `handleExistingTask()`, `handleCancelTask()`
- **Extract, don't rewrite** - Move existing functions to workers, don't duplicate or change business logic

The workers should call into existing code, not replace it.

### Two Queue Architecture

Two queues enable graceful deployments with long-running PM agents:

**Why two queues?**
- PM agents run for hours - can't block triage processing
- During deployment, old pod's PM must finish before new pod takes over
- Spawn queue provides distributed locking per task (FIFO ensures one PM at a time)
- Messages are durable in `shared-knowledge.log` - PM reads on start

**Triage Queue** (grouped by thread/task):
- Slack events grouped by thread ID (FIFO within thread)
- GitHub `issue_comment` grouped by taskId (extracted from PR via `findTaskByPRNumber()`)
- Fast processing (~2s per job): classify + append to log + queue spawn or notify
- Parallel processing across different threads/tasks

**Spawn Queue** (grouped by taskId):
- One spawn job per task at a time (GroupMQ FIFO per group)
- Spawn job **blocks until PM finishes** (hours) - acts as distributed lock
- PM reads full `shared-knowledge.log` on start - sees all messages
- Clean handoff: new pod queues spawn, waits behind old pod's blocking job

**Local State** (per pod, in-memory):
- `pendingSpawns: Set<taskId>` - spawn jobs we've queued (not yet started)
- `activeTasks: Map<taskId, PM>` - PMs running on this pod
- O(1) checks, no Redis iteration needed

**Deterministic GitHub Events** (approval, push, CI):
- Route directly to existing handlers (no queue needed)
- These are fast, non-blocking operations (merge checks, notifications)
- PM agent receives notifications via `notifyNewInput()`

### Technology Choice: GroupMQ + Redis

[GroupMQ](https://github.com/Openpanel-dev/groupmq) provides:
- Free, MIT-licensed alternative to BullMQ Pro
- Native FIFO per-group support via `groupId`
- Automatic job retry on failure
- Stalled job detection and recovery
- BullMQ-compatible API

**Why not alternatives:**
- BullMQ Pro: Paid license for group feature
- Kueue: Designed for batch jobs, not event-driven processing
- SQS FIFO: AWS-specific, adds cloud dependency
- Lambda: 15-minute timeout incompatible with long-running agents

---

## Scope

**In Scope:**

- GroupMQ integration with Redis
- Two queues: triage (FIFO per thread/task) + spawn (FIFO per task, blocking)
- Webhook routing logic (preclassify + deterministic routing)
- Triage worker: classify + append to log + queue spawn or notify local PM
- Spawn worker: blocking job that runs PM until completion
- Local state tracking (pendingSpawns Set, activeTasks Map)
- Graceful shutdown handling (stop workers, wait for spawn jobs)
- Zero-downtime deployment with clean task handoff

**Out of Scope (future MVPs):**

- Horizontal scaling (multiple pods)
- Auto-scaling based on queue depth (KEDA)
- Dead letter queue handling
- Queue metrics/monitoring dashboard

---

## Architecture Overview

```
                              ┌──────────────────────────────────────────────────────┐
                              │                   Kubernetes Pod                      │
                              │                                                       │
┌────────────┐                │  Preclassify → triageQueue.add()                     │
│   Slack    │ ──────────────→│       ↓                                               │
└────────────┘                │  Return 200                                           │
                              │                                                       │
                              │  ┌──────────┐                      ┌──────────┐      │
                              │  │  Triage  │                      │  Spawn   │      │
                              │  │  Queue   │                      │  Queue   │      │
                              │  │(Slack:   │                      │(grouped  │      │
                              │  │by thread,│                      │by taskId)│      │
                              │  │GitHub:   │                      │          │      │
                              │  │by taskId)│                      │          │      │
                              │  └────┬─────┘                      └────┬─────┘      │
                              │       │                                  │            │
┌────────────┐                │  Preclassify → Route:                    │            │
│   GitHub   │ ──────────────→│    • issue_comment → triageQueue ────────│            │
└────────────┘                │    • approval/push → direct handler      │            │
                              │       ↓                                  │            │
                              │  Return 200                              │            │
                              │                                          │            │
                              │  Triage Workers (~2s per job) ───────────│            │
                              │    • Classify (LLM call)                 │            │
                              │    • Append message to shared-knowledge.log          │
                              │    • Route:                              │            │
                              │      - activeTasks.has() → notifyNewInput()          │
                              │      - pendingSpawns.has() → skip (spawn queued)     │
                              │      - else → spawnQueue.add() ──────────┘            │
                              │                                                       │
                              │  Spawn Workers (blocks for hours) ────────────────────│
                              │    • pendingSpawns.delete() + activeTasks.set()      │
                              │    • Run PM until completion (reads log on start)    │
                              │    • activeTasks.delete() on finish                  │
                              │                                                       │
                              │  Local State (in-memory) ─────────────────────────────│
                              │    • pendingSpawns: Set<taskId>                      │
                              │    • activeTasks: Map<taskId, PM>                    │
                              │                                                       │
                              └──────────────────────────────────────────────────────┘
                                                        ↓
                                                      Redis
```

### GitHub Event Routing (Deterministic)

Mirrors existing logic from [src/github/events.ts](../src/github/events.ts):

| Event Type | Action/State | Route | Handler |
|------------|--------------|-------|---------|
| `pull_request_review` | `approved` | `merge_check` | Direct (no queue) |
| `pull_request_review` | `changes_requested` | `existing_task` | Direct (no queue) |
| `pull_request_review` | `commented` | `existing_task` | Direct (no queue) |
| `pull_request_review_comment` | * | `existing_task` | Direct (no queue) |
| `issue_comment` | `created` | `triage_comment` | Triage Queue |
| `pull_request` | `opened`/`synchronize` | `merge_check` | Direct (no queue) |
| `push` | * | `merge_check` | Direct (no queue) |
| `workflow_run` | `completed` + `failure` | `existing_task` | Direct (no queue) |
| `workflow_run` | `completed` + `success` | `merge_check` | Direct (no queue) |

Only `issue_comment` requires triage because PR comments can be conversational noise ("thanks!", "LGTM").

**Direct handlers** are fast, non-blocking operations that notify PM agents or trigger merge checks. They don't need queuing because they complete in milliseconds.

---

## Architecture Changes

### 1. New Dependencies

```bash
npm install groupmq ioredis
```

### 2. Redis Connection

**New file**: `src/system/redis.ts`

Singleton Redis connection with `maxRetriesPerRequest: null` (required for GroupMQ).

### 3. Queue Definitions

**New file**: `src/system/queues.ts`

```typescript
// Triage queue: events requiring classification (Slack + GitHub issue_comment)
// Grouped by thread (Slack) or taskId (GitHub) for FIFO within conversation
// Fast processing (~2s per job)
export const triageQueue = new Queue('triage-events', { connection });

// Spawn queue: PM agent lifecycle management
// Grouped by taskId - ensures only one PM per task at a time
// Blocking jobs (hours) - acts as distributed lock
export const spawnQueue = new Queue('spawn-tasks', { connection });
```

### 4. Webhook Router

**New file**: `src/system/webhook-router.ts`

Fast, code-only routing logic.

**Reuses existing code:**
- `routeGitHubEvent()` from [src/github/events.ts](../src/github/events.ts) - extract and reuse, don't rewrite
- `extractTaskIdFromBranch()` from [src/github/events.ts](../src/github/events.ts)
- `findTaskByPRNumber()` from [src/system/task-manager.ts](../src/system/task-manager.ts)

```typescript
export type SlackRouteResult =
  | { action: 'discard'; reason: string }
  | { action: 'triage' };  // Slack always needs triage

export type GitHubRouteResult =
  | { action: 'discard'; reason: string }
  | { action: 'triage' }  // issue_comment needs triage
  | { action: 'direct'; handler: 'merge_check' | 'existing_task'; taskId: string };

// Slack: discard bot messages, otherwise triage
export function routeSlackEvent(event): SlackRouteResult

// GitHub: reuse existing routeGitHubEvent() logic
// Most events route to direct handlers, only issue_comment needs triage
export async function routeGitHubEvent(eventType, payload): Promise<GitHubRouteResult>
```

**Discard logic:** Reuses existing checks already in codebase (bot messages, untracked repos/branches, etc.). No new filtering rules.

### 5. Webhook Handler Changes

**File**: [src/system/server.ts](../src/system/server.ts)

Replace direct processing with queue-based routing:

```typescript
// Slack: enqueue to triage (unless bot message)
app.event('app_mention', async ({ event }) => {
  const route = routeSlackEvent(event);
  if (route.action === 'discard') return;
  // route.action === 'triage'
  const threadId = event.thread_ts || event.ts;
  await triageQueue.add(
    { source: 'slack', payload: event },
    { groupId: threadId }  // FIFO within same thread
  );
});

// GitHub: route based on event type
app.post('/github/webhooks', async (req, res) => {
  const route = await routeGitHubEvent(eventType, payload);
  if (route.action === 'discard') return res.status(200).json({ processed: false });

  if (route.action === 'triage') {
    // Only issue_comment needs triage (to filter conversational noise)
    const taskId = await findTaskByPRNumber(payload.repository.full_name, payload.issue.number);
    if (!taskId) return res.status(200).json({ processed: false }); // PR not linked to task
    await triageQueue.add(
      { source: 'github', payload, taskId },
      { groupId: taskId }  // FIFO within same task
    );
  } else {
    // Direct handlers: fast, non-blocking, no queue needed
    if (route.handler === 'merge_check') {
      await checkAndMergeLinkedPRs(route.taskId);
    } else {
      await handleExistingTaskEvent(route.taskId, payload);
    }
  }
  return res.status(200).json({ processed: true });
});
```

### 6. Triage Worker

**New file**: `src/workers/triage-worker.ts`

Classifies messages, appends to log, and routes to local PM or spawn queue. Completes quickly (~2 seconds) to keep the queue moving.

**Responsibilities:**
- Run LLM triage to classify intent (~1-2 seconds)
- Append message to `shared-knowledge.log` (durable storage)
- Route based on local state:
  - `activeTasks.has(taskId)` → notify local PM
  - `pendingSpawns.has(taskId)` → skip (spawn already queued)
  - else → queue spawn job

**Calls existing functions:**
- `triageSlackMessage()` from [src/agents/triage.ts](../src/agents/triage.ts)
- `triageGitHubComment()` from [src/agents/triage.ts](../src/agents/triage.ts)
- `fetchThreadHistory()`, `getChannelInfo()`, `getUserInfo()` from [src/slack/client.ts](../src/slack/client.ts)
- `createTask()`, `appendSlackMessage()`, `appendGitHubComment()` from [src/system/task-manager.ts](../src/system/task-manager.ts)
- `notifyNewInput()`, `stopTask()` from [src/system/task-runtime.ts](../src/system/task-runtime.ts)

**Webhook router calls (direct handlers):**
- `checkAndMergeLinkedPRs()` from [src/github/events.ts](../src/github/events.ts) - merge check handler
- `handleExistingTaskEvent()` from [src/github/events.ts](../src/github/events.ts) - existing task notification handler

```typescript
// Local state (per pod, in-memory)
const pendingSpawns = new Set<string>();  // Tasks we've queued for spawn
const activeTasks = new Map<string, PM>(); // Tasks with running PM

const triageWorker = new Worker('triage-events', async (job) => {
  const { source, payload } = job.data;

  if (source === 'slack') {
    // Slack message handling
    const threadId = payload.thread_ts || payload.ts;
    const threadHistory = await fetchThreadHistory(payload.channel, threadId);
    const channelInfo = await getChannelInfo(payload.channel);
    const userInfo = await getUserInfo(payload.user);

    // 1. Triage (LLM call, ~1-2 seconds)
    const result = await triageSlackMessage(payload, threadHistory);

    if (result.action === 'noop') return; // Discard

    // 2. Execute action
    switch (result.action) {
      case 'new_task': {
        // Create task metadata
        const slackThread = { thread_id: threadId, channel_id: payload.channel, last_processed_ts: payload.ts };
        const metadata = await createTask(slackThread, backendRepoPath, mobileRepoPath);
        const taskId = metadata.task_id;

        // Append to shared-knowledge.log (durable)
        await appendSlackMessage(taskId, channelInfo, threadId, userInfo, payload.text);

        // Queue spawn job
        pendingSpawns.add(taskId);
        await spawnQueue.add({ taskId }, { groupId: taskId });
        break;
      }

      case 'existing_task': {
        const taskId = result.task_id;

        // Append to shared-knowledge.log (durable)
        await appendSlackMessage(taskId, channelInfo, threadId, userInfo, payload.text);

        // Route based on local state
        if (activeTasks.has(taskId)) {
          // PM running locally - notify it
          await notifyNewInput(taskId);
        } else if (pendingSpawns.has(taskId)) {
          // Spawn already queued - PM will read log when it starts
        } else {
          // No local PM, no pending spawn - queue one
          pendingSpawns.add(taskId);
          await spawnQueue.add({ taskId }, { groupId: taskId });
        }
        break;
      }

      case 'cancel_task': {
        const taskId = result.task_id;
        if (activeTasks.has(taskId)) {
          await stopTask(taskId);
        }
        break;
      }
    }
  } else {
    // GitHub issue_comment handling
    const { taskId } = job.data;  // Already resolved in webhook handler
    const result = await triageGitHubComment(payload);

    if (result.action === 'noop') return; // Discard (conversational noise)

    // Append to shared-knowledge.log (durable) - same as Slack
    await appendGitHubComment(taskId, payload);

    // Route based on local state (taskId already known)
    if (activeTasks.has(taskId)) {
      await notifyNewInput(taskId);
    } else if (!pendingSpawns.has(taskId)) {
      pendingSpawns.add(taskId);
      await spawnQueue.add({ taskId }, { groupId: taskId });
    }
  }

  // Job completes in ~2 seconds, queue moves on to next job
}, { concurrency: 5 });
```

**Key insight:** Messages are always appended to `shared-knowledge.log` first. This is durable storage. The PM reads the full log on start, so no messages are lost even during deployment handoff.

### 7. Spawn Worker

**New file**: `src/workers/spawn-worker.ts`

Manages PM agent lifecycle. Each job **blocks until PM finishes** (hours), acting as a distributed lock per task.

**Responsibilities:**
- Transition task from `pendingSpawns` to `activeTasks`
- Initialize runtime and start PM agent
- Block until PM completes
- Cleanup `activeTasks` on finish

```typescript
const spawnWorker = new Worker('spawn-tasks', async (job) => {
  const { taskId } = job.data;

  // Transition: pending → active
  pendingSpawns.delete(taskId);
  activeTasks.set(taskId, null);  // Mark as starting

  // Initialize and run PM
  await initializeTaskRuntime(taskId);
  const pm = await createPMAgent(taskId);
  activeTasks.set(taskId, pm);

  // BLOCKS until PM finishes (could be hours)
  await pm.run();

  // Cleanup
  activeTasks.delete(taskId);

  // Job completes - next spawn job for this taskId can now run
}, { concurrency: 10 });
```

**Key insight:** GroupMQ FIFO per `groupId` ensures only one spawn job runs per task at a time. If Pod A has a spawn job blocking for task-abc, Pod B's spawn job for the same task waits in queue. When Pod A finishes, Pod B's job runs and reads the full log (including any messages that arrived during handoff).

### 8. Application Lifecycle & Graceful Shutdown

**File**: [src/system/server.ts](../src/system/server.ts)

```typescript
// Startup
await startHttpServer();
startTriageWorker();
startSpawnWorker();

// Shutdown (SIGTERM)
async function gracefulShutdown() {
  logger.system('Received SIGTERM, starting graceful shutdown...');

  // 1. Stop accepting new webhooks
  isShuttingDown = true;

  // 2. Stop triage worker (waits for current job to complete)
  await triageWorker.close();
  logger.system('Triage worker stopped');

  // 3. Wait for spawn worker to finish (blocks until all PMs complete)
  // This is the key: spawn jobs block for hours, so we wait for them
  await spawnWorker.close();
  logger.system('Spawn worker stopped, all PM agents completed');

  // 4. Cleanup
  await closeRedisConnection();
  await stopHttpServer();
  logger.system('Shutdown complete');
}

process.on('SIGTERM', gracefulShutdown);
```

**Shutdown sequence:**
1. **Stop accepting webhooks** - Set `isShuttingDown = true`, return 503 for new requests
2. **Stop triage worker** - `worker.close()` waits for current job to complete, then stops
3. **Wait for spawn worker** - `worker.close()` waits for all spawn jobs (PM agents) to complete
4. **Cleanup** - Close Redis connection, stop HTTP server

**Kubernetes considerations:**
- Set `terminationGracePeriodSeconds` high enough for PM agents to complete (e.g., 3600 for 1 hour)
- If pod is force-killed after grace period, spawn jobs return to queue via stalled job recovery
- New pod will pick up the spawn job and PM will read full log (no messages lost)

### 9. Environment Variables

**File**: `.env.example`

```bash
# Redis (for queue management)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
```

### 10. Docker Compose Update

**File**: [docker-compose.yml](../docker-compose.yml)

Add Redis service:

```yaml
services:
  archie:
    # ... existing config ...
    environment:
      # Add Redis connection
      - REDIS_HOST=redis
      - REDIS_PORT=6379
    depends_on:
      redis:
        condition: service_healthy

  redis:
    image: redis:7-alpine
    container_name: archie-redis
    restart: unless-stopped
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes  # Enable AOF persistence
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 3

volumes:
  redis-data:
```

**Key points:**
- `redis:7-alpine` - Small, production-ready image
- `--appendonly yes` - Enable AOF persistence so queued jobs survive Redis restart
- `depends_on` with health check - Archie waits for Redis to be ready
- Named volume `redis-data` - Persists queue data across container restarts

**Production consideration:** For production, consider using managed Redis (AWS ElastiCache, etc.) instead of self-hosted container. Update [docker-compose.prod.yml](../docker-compose.prod.yml) accordingly when deploying to production.

---

## Deployment Flow

### Zero-Downtime Deployment

```
Time    Old Pod                          New Pod                         Spawn Queue (task-abc)
────    ────────────────────────         ────────────────────────        ────────────────────────
T0      Running normally                 -                               [job-1 ACTIVE on Old]
        - triage worker
        - spawn worker (job-1 blocking)
        - PM for task-abc running

T1      -                                Starts up                       [job-1 ACTIVE on Old]
                                         - triage worker connects
                                         - spawn worker connects

T2      Receives SIGTERM                 Processing triage jobs          [job-1 ACTIVE on Old]
        - stops triage worker
        - waits for spawn worker

T3      Spawn worker blocking...         Message for task-abc arrives    [job-1 ACTIVE on Old]
                                         - triage: existing_task         → [job-2 WAITING from New]
                                         - append to log ✓
                                         - pendingSpawns.add('abc')
                                         - spawnQueue.add()

T4      PM finishes naturally            Another message arrives         [job-2 WAITING from New]
        - spawn job completes            - append to log ✓
        - pod exits                      - pendingSpawns.has()? YES
                                         - skip spawn ✓

T5      -                                job-2 runs                      [job-2 ACTIVE on New]
                                         - pendingSpawns.delete()
                                         - activeTasks.set()
                                         - PM starts, reads full log
                                         - sees ALL messages ✓
```

**Key properties:**
- No duplicate PMs (GroupMQ FIFO per task)
- No lost messages (all appended to log before routing)
- Clean handoff (new pod waits behind old pod's blocking job)

### Crash Recovery

1. Triage jobs in progress have visibility timeout → return to queue
2. Spawn jobs in progress have visibility timeout → return to queue
3. New pod picks them up
4. PM reads full `shared-knowledge.log` on start (no messages lost)

---

## Testing Checklist

**Webhook Router:**

- [ ] Slack bot messages discarded
- [ ] Slack valid events route to triage queue
- [ ] GitHub untracked repo/branch events discarded
- [ ] GitHub `issue_comment` routes to triage queue
- [ ] GitHub `pull_request_review` handled directly (no queue)
- [ ] GitHub `push` handled directly (no queue)

**Triage Worker:**

- [ ] Consumes from triage-events queue (FIFO per thread/task)
- [ ] `new_task` creates task, appends to log, queues spawn
- [ ] `existing_task` appends to log, routes correctly:
  - [ ] `activeTasks.has()` → `notifyNewInput()`
  - [ ] `pendingSpawns.has()` → skip (no duplicate spawn)
  - [ ] else → queue spawn
- [ ] `cancel_task` stops local PM via `stopTask()`
- [ ] `noop` discarded
- [ ] Rapid follow-up messages processed in order (thread grouping)
- [ ] Worker completes quickly (~2 seconds per job)

**Spawn Worker:**

- [ ] Consumes from spawn-tasks queue (FIFO per taskId)
- [ ] Transitions task from `pendingSpawns` to `activeTasks`
- [ ] PM reads full `shared-knowledge.log` on start
- [ ] Job blocks until PM completes
- [ ] Cleanup: removes from `activeTasks` on finish

**Local State:**

- [ ] `pendingSpawns` Set tracks queued spawn jobs
- [ ] `activeTasks` Map tracks running PMs
- [ ] O(1) lookups for routing decisions

**Graceful Shutdown:**

- [ ] SIGTERM triggers shutdown sequence
- [ ] Triage worker stops (waits for current job)
- [ ] Spawn worker stops (waits for all PMs to complete)
- [ ] No lost events during deployment

**Deployment Handoff:**

- [ ] New pod queues spawn job behind old pod's blocking job
- [ ] Messages appended to log during handoff
- [ ] `pendingSpawns.has()` prevents duplicate spawn jobs
- [ ] New PM reads full log when old pod finishes
- [ ] No duplicate PMs (GroupMQ FIFO ensures serialization)

**Integration:**

- [ ] Slack webhook → triage queue → triage worker → spawn queue → PM
- [ ] GitHub comment → triage queue → triage worker → spawn/notify
- [ ] GitHub approval → direct handler → PM notification
- [ ] Rolling deployment with zero message loss

---

## File Changes Summary

**New files:**

- `src/system/redis.ts` - Redis connection management
- `src/system/queues.ts` - Queue definitions (triage + spawn queues)
- `src/system/webhook-router.ts` - Preclassification and routing logic
- `src/workers/triage-worker.ts` - Triage worker (classify + append + route)
- `src/workers/spawn-worker.ts` - Spawn worker (PM lifecycle, blocking)

**Modified files:**

- [src/system/server.ts](../src/system/server.ts) - Queue-based webhook handling, graceful shutdown
- [src/system/task-runtime.ts](../src/system/task-runtime.ts) - Expose `pendingSpawns`, `activeTasks` for routing
- [src/system/task-manager.ts](../src/system/task-manager.ts) - `createTask()` called from triage worker (no logic changes)
- [docker-compose.yml](../docker-compose.yml) - Add Redis service with persistence
- `.env.example` - Add Redis configuration

**Note:** Triage functions in [src/agents/triage.ts](../src/agents/triage.ts), task runtime functions (`notifyNewInput()`, `stopTask()`), task manager functions (`appendSlackMessage()`, `appendGitHubComment()`, `createTask()`), and Slack client functions (`fetchThreadHistory()`, `getChannelInfo()`, `getUserInfo()`) are already exported.

**Removed (Phase 3):**

- `src/system/message-queue.ts` - In-memory queue no longer needed

---

## Dependencies

**New npm packages:**

- `groupmq` - Queue management with group support
- `ioredis` - Redis client

**Infrastructure:**

- Redis instance (local for dev, managed for prod)
- Redis persistence enabled for production (RDB or AOF)

---

## Future Enhancements (Post-MVP 4)

- **PM agent resume**: Resume interrupted PM agents after crash/restart
- **Horizontal scaling**: Multiple pods processing same queues
- **KEDA auto-scaling**: Scale pods based on queue depth
- **Dead letter queue**: Handle permanently failed jobs
- **Queue dashboard**: BullBoard or custom UI for monitoring
- **Rate limiting**: Prevent queue flooding from webhook bursts
