# Stage 3: Create connectors/ and complete architecture simplification

## Context

Stages 1-2 are complete. The codebase has clean `agents/`, `tasks/` directories but external integration code is still scattered: Slack files in `src/slack/`, GitHub files in `src/github/`, and HTTP/webhook handling in `src/system/`. This final stage creates the `connectors/` directory — one subdirectory per external system — completing the architecture simplification proposal.

After this stage, the dependency direction is clean: `index.ts` → `connectors/` → `tasks/` → `agents/`.

## Design Decisions

**getIsShuttingDown()**: Currently in `system/server.ts`, imported by `tasks/task.ts` and `tasks/recovery.ts`. Moving server.ts to `connectors/slack/events.ts` would invert the dependency direction (tasks importing from connectors). Extract to `system/shutdown.ts` first.

**event-handler.ts merge**: Its only consumer is `server.ts`. Both become `connectors/slack/events.ts`. The `processSlackTriage`/`processGitHubTriage` functions become internal.

**webhook-router.ts split**: Contains both Slack routing (`routeSlackEvent`) and GitHub routing (`routeGitHubEvent`). Slack routing moves to `connectors/slack/events.ts` (same file that calls it — becomes internal). GitHub routing merges into `connectors/github/webhooks.ts`.

**singleton.ts merge**: 17 lines. `getGitHubClient()` folds into `connectors/github/client.ts`.

## Steps

### Step 1: Extract shutdown state → `system/shutdown.ts`

Create `src/system/shutdown.ts` with `getIsShuttingDown()` and `setShuttingDown()`.

Modify `src/system/server.ts`:
- Remove `let isShuttingDown = false` and `export function getIsShuttingDown()`
- Import `getIsShuttingDown` from `./shutdown.js` (read locally) and `setShuttingDown` (set in stopServer)
- Replace bare `isShuttingDown` reads (lines 95, 98, 109, 160, 199) with `getIsShuttingDown()`

Update 2 importers:
- `src/tasks/task.ts:40` — `'../system/server.js'` → `'../system/shutdown.js'`
- `src/tasks/recovery.ts:12` — `'../system/server.js'` → `'../system/shutdown.js'`

Typecheck.

### Step 2: Move `github/*` → `connectors/github/` + merge singleton

Move 4 files, merge 1, delete 1:

| Source | Target |
|--------|--------|
| `github/client.ts` + `github/singleton.ts` | `connectors/github/client.ts` |
| `github/webhook-utils.ts` | `connectors/github/webhooks.ts` |
| `github/merge-orchestrator.ts` | `connectors/github/merge.ts` |
| `github/worktree.ts` | `connectors/github/worktree.ts` |

Internal imports in moved files (all `../x` → `../../x`):
- `connectors/github/client.ts`: `../../agents/tools.js`, `../../system/logger.js`
- `connectors/github/webhooks.ts`: `./merge.js` (was `./merge-orchestrator.js`), `../../system/logger.js`
- `connectors/github/merge.ts`: `../../tasks/persistence.js`, `../../tasks/task.js`, `../../agents/prompts.js`, `./client.js` (same), `../../agents/registry.js`, `../../system/logger.js`, `../../agents/tools.js`
- `connectors/github/worktree.ts`: `../../system/logger.js`, `./client.js` (same)

Append singleton content to `connectors/github/client.ts` (lazy `getGitHubClient()` function, ~8 lines).

External consumer updates (5 files):
- `src/index.ts:13` — `./github/client.js` → `./connectors/github/client.js`
- `src/agents/tools.ts:20` — `../github/singleton.js` → `../connectors/github/client.js`
- `src/agents/tools.ts:23` — `../github/merge-orchestrator.js` → `../connectors/github/merge.js`
- `src/agents/spawn.ts:28` — `../github/worktree.js` → `../connectors/github/worktree.js`
- `src/system/server.ts:44` — `../github/webhook-utils.js` → `../connectors/github/webhooks.js`
- `src/system/webhook-router.ts:17` — `../github/webhook-utils.js` → `../connectors/github/webhooks.js`
- `src/system/event-handler.ts:25` — `../github/client.js` → `../connectors/github/client.js`

Delete `src/github/` directory. Typecheck.

### Step 3: Move `slack/*` → `connectors/slack/`

Move 2 files:

| Source | Target |
|--------|--------|
| `slack/client.ts` | `connectors/slack/client.ts` |
| `slack/callbacks.ts` | `connectors/slack/callbacks.ts` |

Internal imports (moved files):
- `connectors/slack/client.ts`: `../../types/index.js`, `../../system/logger.js`
- `connectors/slack/callbacks.ts`: `../../system/logger.js`

External consumer updates (5 files):
- `src/system/server.ts:18-24` — `../slack/client.js` → `../connectors/slack/client.js`
- `src/system/server.ts:25` — `../slack/callbacks.js` → `../connectors/slack/callbacks.js`
- `src/system/event-handler.ts:17-24` — `../slack/client.js` → `../connectors/slack/client.js`
- `src/system/webhook-router.ts:18` — `../slack/client.js` → `../connectors/slack/client.js`
- `src/tasks/task.ts:43` — `../slack/callbacks.js` → `../connectors/slack/callbacks.js`
- `src/agents/tools.ts:21` — `../slack/callbacks.js` → `../connectors/slack/callbacks.js`

Delete `src/slack/` directory. Typecheck.

### Step 4: Move + merge `server.ts` + `event-handler.ts` → `connectors/slack/events.ts`

The biggest step. `server.ts` (417 lines) + `event-handler.ts` (308 lines) merge into one file.

Merge approach:
- Copy `server.ts` content as base
- Append `event-handler.ts` content below
- Deduplicate imports (both import from tasks/task, tasks/persistence, agents/prompts, connectors/slack/client, system/logger)
- `processSlackTriage` and `processGitHubTriage` lose `export` (now internal)
- Remove the `import { processSlackTriage, processGitHubTriage } from './event-handler.js'` since they're local

Internal imports for the merged file at `src/connectors/slack/events.ts`:
- `./client.js` (Slack client — same dir)
- `./callbacks.js` (Slack callbacks — same dir)
- `../../tasks/task.js`
- `../../tasks/persistence.js`
- `../../agents/prompts.js`
- `../../agents/registry.js`
- `../../system/logger.js`
- `../../system/shutdown.js`
- `../../system/triage.js`
- `../github/webhooks.js` (routeGitHubEvent, handleMergeCheckDirect, formatGitHubContext, formatGitHubEventMessage)
- `../github/client.js` (createGitHubClient — used by GitHub triage)
- `../../types/index.js` (SlackThread, SlackMessage)

External consumer update (1 file):
- `src/index.ts:8` — `./system/server.js` → `./connectors/slack/events.js`

Delete `src/system/server.ts` and `src/system/event-handler.ts`. Typecheck.

### Step 5: Split + merge `webhook-router.ts` → events.ts + webhooks.ts

`webhook-router.ts` contains two halves:

**Slack half** (→ `connectors/slack/events.ts`):
- `routeSlackEvent()` function + `SlackRouteResult` type
- Needs `getBotId` from `./client.js` (add import to events.ts)
- Becomes internal (already called only within events.ts)

**GitHub half** (→ `connectors/github/webhooks.ts`):
- `routeGitHubEvent()` function + `GitHubRouteResult` type + `InternalRouteAction` type + `determineRouteAction()` + `getGitHubAppBotUsername()`
- Needs `findTaskByPRNumber`, `loadMetadata` from `../../tasks/persistence.js` (add to webhooks.ts imports)
- Uses `formatGitHubContext`, `extractBranchFromPayload`, `extractTaskIdFromBranch` — already in webhooks.ts

**Remove re-exports** from webhook-router.ts: `formatGitHubContext`, `formatGitHubEventMessage`, `handleMergeCheckDirect`, `GitHubEventContext` — events.ts already imports these directly from `../github/webhooks.js` (step 4).

Update `connectors/slack/events.ts`:
- Remove import of `routeSlackEvent` from webhook-router (it's now local)
- Verify `routeGitHubEvent` import points to `../github/webhooks.js`

Delete `src/system/webhook-router.ts`. Typecheck.

### Step 6: Clean stale dist files + verify

```bash
rm -rf dist/github dist/slack dist/system/server.* dist/system/event-handler.* dist/system/webhook-router.*
npm run build
```

Verify no stale imports:
```bash
grep -r "slack/client\|slack/callbacks" src/ --include="*.ts" | grep -v connectors
grep -r "github/client\|github/singleton\|github/merge-orchestrator\|github/webhook-utils\|github/worktree" src/ --include="*.ts" | grep -v connectors
grep -r "system/server\|system/event-handler\|system/webhook-router" src/ --include="*.ts" | grep -v shutdown
```

## Final File Layout

```
src/
  index.ts
  connectors/
    slack/
      client.ts           (was slack/client.ts)
      callbacks.ts         (was slack/callbacks.ts)
      events.ts            (merged: system/server.ts + system/event-handler.ts + routeSlackEvent)
    github/
      client.ts            (merged: github/client.ts + github/singleton.ts)
      webhooks.ts          (merged: github/webhook-utils.ts + GitHub routing from webhook-router.ts)
      worktree.ts          (was github/worktree.ts)
      merge.ts             (was github/merge-orchestrator.ts)
  agents/
    agent.ts, message-queue.ts, prompts.ts, registry.ts, spawn.ts, tools.ts
  tasks/
    task.ts, persistence.ts, recovery.ts
  system/
    shutdown.ts            (NEW: extracted from server.ts)
    logger.ts, plugin-loader.ts, triage.ts, workdir.ts
  mcp/
    research-tools.ts
  types/
    agent.ts, index.ts, task.ts
  utils/
    prompt-loader.ts
```

## Files

| File | Action | Description |
|------|--------|-------------|
| `src/system/shutdown.ts` | NEW | Extract `getIsShuttingDown` / `setShuttingDown` |
| `src/system/server.ts` | MOVE+MERGE → `connectors/slack/events.ts` | HTTP server + event handling |
| `src/system/event-handler.ts` | MERGE → `connectors/slack/events.ts` | Triage processing |
| `src/system/webhook-router.ts` | SPLIT → `events.ts` + `webhooks.ts` | Slack/GitHub routing split |
| `src/slack/client.ts` | MOVE → `connectors/slack/client.ts` | Slack API wrapper |
| `src/slack/callbacks.ts` | MOVE → `connectors/slack/callbacks.ts` | Callback registry |
| `src/github/client.ts` | MOVE+MERGE → `connectors/github/client.ts` | + singleton |
| `src/github/singleton.ts` | MERGE → `connectors/github/client.ts` | Absorbed |
| `src/github/webhook-utils.ts` | MOVE+MERGE → `connectors/github/webhooks.ts` | + GitHub routing |
| `src/github/merge-orchestrator.ts` | MOVE → `connectors/github/merge.ts` | PR merge logic |
| `src/github/worktree.ts` | MOVE → `connectors/github/worktree.ts` | Git worktrees |
| `src/index.ts` | EDIT | 2 import rewrites |
| `src/tasks/task.ts` | EDIT | 2 import rewrites |
| `src/tasks/recovery.ts` | EDIT | 1 import rewrite |
| `src/agents/tools.ts` | EDIT | 3 import rewrites |
| `src/agents/spawn.ts` | EDIT | 1 import rewrite |

## Verification

1. `npm run typecheck` — no type errors
2. `npm run build` — compiles cleanly
3. No stale imports to old paths (grep checks above)
4. `src/github/` and `src/slack/` directories deleted
5. `src/system/` contains only: `shutdown.ts`, `logger.ts`, `plugin-loader.ts`, `triage.ts`, `workdir.ts`
