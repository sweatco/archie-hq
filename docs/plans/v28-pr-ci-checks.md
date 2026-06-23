# GitHub CI Check Visibility — Phase 1

## Context

When a repo agent creates a PR, it currently has no visibility into CI check results. The webhook layer subscribes to `workflow_run` but only forwards a thin `"workflow completed/failure"` line to PM, and `get_pr_status` exposes only `mergeable_state` (`unstable`/`blocked`/…) — not which specific checks failed. As a result the agent cannot diagnose or fix CI failures on its own PRs.

**Goal**: smallest change that lets the agent see check results. Design choice (refined with user): pull-based, not push-based. Webhook only pings PM that checks are ready; agent fetches detail on demand via one new tool. This avoids any infrastructure for forwarding large CI output through the knowledge log.

**Out of scope for this phase**: per-check log fetching (`get_check_logs`), file-spooling tool output, prompt updates beyond a single sentence. Defer until we see real failures.

## Approach

Three concrete changes inside `archie-hq` + one config change on GitHub + one tiny edit in `archie-plugins`.

### 1. Webhook — handle `check_suite.completed`, debounce, ping PM

**File**: `src/connectors/github/webhooks.ts`

- Extend `formatGitHubContext` to handle `eventType === 'check_suite'`:
  - Extract `payload.check_suite.head_sha`, `head_branch`, `conclusion`, `status`, `app.slug`.
  - Extract PR number from `payload.check_suite.pull_requests[0].number` if present (suite is attached to a PR).
  - Stamp `context.branch` from `head_branch` so existing `extractTaskIdFromBranch` works.
- Extend `routeGitHubEvent` switch with a `check_suite` case:
  - Only act on `action === 'completed'`. Other actions → `noop`.
  - Route to new `checks_ready` action.
- Extend `GitHubRouteResult` union with `{ action: 'direct'; handler: 'checks_ready'; taskId: string }`.
- Add `handleChecksReadyDirect(taskId, githubRepo, prNumber)` debouncer, mirroring `handleMergeCheckDirect` (webhooks.ts:212–237):
  - `const checksReadyTimers = new Map<string, NodeJS.Timeout>();`
  - Key: `${taskId}:${githubRepo}#${prNumber}` (per-PR, not per-task — multiple PRs on one task share neither timer nor message).
  - `CHECKS_READY_DEBOUNCE_MS = 20000` (20 s).
  - On each event for the key, clear+reset the timer; on fire, append a knowledge.log entry + wake PM with one line: `"CI checks updated on PR #{N} ({githubRepo}). Call get_pr_checks to inspect."`.

**File**: `src/connectors/github/events.ts`

- In `handleGitHubWebhook`, route `route.handler === 'checks_ready'` to `handleChecksReadyDirect(...)`.
- Add optional debug payload dump gated on `process.env.ARCHIE_DEBUG_GITHUB_WEBHOOKS === '1'`: write raw payload to `${WORKDIR}/logs/github-webhooks/${ts}-${eventType}-${action}.json`. Use existing `WORKDIR` constant from `src/system/workdir.ts`.

### 2. GitHub client — `listPRChecks`

**File**: `src/connectors/github/client.ts`

Add one method on `GitHubClient`:

```typescript
async listPRChecks(githubRepo: string, prNumber: number): Promise<PRChecksReport>
```

Steps inside the method:
1. `GET /repos/{owner}/{repo}/pulls/{pull_number}` → read `head.sha`.
2. `GET /repos/{owner}/{repo}/commits/{ref}/check-runs` (paginate if needed; in practice <30 per PR).
3. `GET /repos/{owner}/{repo}/commits/{ref}/status` (legacy combined status — covers CIs that publish statuses, not check-runs).
4. Normalize into:
   ```typescript
   interface PRCheckEntry {
     source: 'check_run' | 'status';
     name: string;
     app: string;            // app.slug or status context
     status: string;         // queued/in_progress/completed
     conclusion: string | null; // success/failure/cancelled/timed_out/neutral/action_required/skipped
     url: string | null;     // html_url / target_url
     output?: { title?: string; summary?: string; text?: string };
   }
   interface PRChecksReport {
     headSha: string;
     entries: PRCheckEntry[];
   }
   ```
5. Return; log a one-line summary (`logger.system`) with counts by conclusion.

Export the types from `tools.ts` (alongside existing `PRStatus`, `PRReview`).

### 3. Agent tool — `get_pr_checks`

**File**: `src/agents/tools.ts`

- Add `createGetPRChecksTool(agent, task)` following the shape of `createGetPRStatusTool` (tools.ts:610–628).
- Tool name: `get_pr_checks`. Schema: `{ pr_number: number }`.
- Behaviour: call `client.listPRChecks(...)`. Format output as text:
  - Header line: `"Checks for PR #{N} (head {sha7}):"`
  - One bullet per check: `"- [{conclusion ?? status}] {name} ({app}) — {url}"`.
  - For each entry with `conclusion ∈ {failure, cancelled, timed_out, action_required}` AND non-empty `output`: append a block:
    ```
    {name} output:
    title: {output.title}
    summary:
    {output.summary}
    text:
    {output.text}
    ```
  - No truncation. Inline full text. (User explicitly rejected pre-truncation; 65 KB cap per check × few failed checks fits comfortably in context.)
- Register the tool in `createRepoToolsMcpServer()` (tools.ts:1154–1184) alongside the existing PR tools.
- Add `mcp__repo-tools__get_pr_checks` to the repo-agent `allowedTools` list (in `src/agents/spawn.ts` around line 300 — the existing PR-tool allowlist block).
- Update `src/agents/__tests__/tool-contract.test.ts` to include the new tool (the test verifies MCP server registration matches the allowlist).

### 4. GitHub App configuration (manual, by user)

In the GitHub App settings page:

- **Repository permissions**:
  - Checks → Read-only (NEW)
  - Actions → Read-only (NEW)
  - Commit statuses → Read-only (NEW, for legacy `status` API)
  - Pull requests → Read & write (already set)
  - Contents → Read & write (already set)
- **Subscribe to events**:
  - Check suite (NEW)
  - (do NOT need `Check run` — suite-complete is the batch signal we use)
  - Workflow run (already set; harmless to keep)

After saving, each installation must re-accept new permissions at https://github.com/organizations/<your-org>/settings/installations. Until accepted, `check-runs` API calls return 403.

### 5. Prompt update (separate, in `archie-plugins`)

**File**: `archie-plugins/pm/skills/engineering-team/SKILL.md`

Add one sentence under the PR-handling section: `"When a 'CI checks updated' event arrives or get_pr_status returns mergeableState=unstable, call get_pr_checks(pr_number) to read failed checks before deciding how to fix."`

Ship as a separate commit in that repo. Standalone — does not block the archie-hq PR.

## Critical Files

- `src/connectors/github/webhooks.ts` — context extraction, routing, new debouncer
- `src/connectors/github/events.ts` — route dispatch + optional payload dump
- `src/connectors/github/client.ts` — new `listPRChecks` method
- `src/agents/tools.ts` — new tool + MCP server registration
- `src/agents/spawn.ts` — allowedTools list (~line 300)
- `src/agents/__tests__/tool-contract.test.ts` — keep test in sync
- `src/system/workdir.ts` — read `WORKDIR` for debug dump path
- `archie-plugins/pm/skills/engineering-team/SKILL.md` — prompt sentence

## Reused Existing Patterns

- `mergeCheckTimers` debouncer (webhooks.ts:212–237) — copy shape for `checksReadyTimers`.
- `formatGitHubContext` (webhooks.ts:56) — extend, same style as existing event branches.
- `createGetPRStatusTool` (tools.ts:610) — template for `createGetPRChecksTool`.
- `appendGitHubEvent` + `task.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent')` (events.ts:143–144) — same wake-PM pattern.
- `getAgentDef` lookup + `task.metadata.repositories[repoKey].branch_states[*].pr_number` traversal (merge.ts:74–85) — already proven for resolving repoKey↔PR.

## Verification

1. **Unit**: extend `tool-contract.test.ts` to assert `mcp__repo-tools__get_pr_checks` is both registered and allowed.
2. **Type/build**: `npm run typecheck && npm run build`.
3. **Local webhook fire** (offline): write a minimal Node script that POSTs a sample `check_suite.completed` payload (capture one with the debug dump first) to `http://localhost:PORT/webhooks/github` with a valid HMAC. Confirm:
   - Log line `"GitHub webhook: check_suite/completed ..."` appears.
   - Debouncer fires once after 20 s when multiple events arrive within 20 s of each other.
   - Task knowledge log records `"CI checks updated on PR #N"`.
4. **End-to-end**:
   - Enable App permissions (section 4).
   - Push a deliberately failing branch (e.g., `npm run lint` failure) on a repo handled by a repo-agent.
   - Wait for PR creation by the agent.
   - Confirm `check_suite.completed` webhook arrives (verify in logs), debounce window elapses, PM is pinged.
   - Confirm PM agent (or a manual tool invocation) calls `get_pr_checks` and the output contains the failing check name + `output.summary` text.
5. **Debug dump**: set `ARCHIE_DEBUG_GITHUB_WEBHOOKS=1` for one task, push to the failing branch, confirm `workdir/logs/github-webhooks/*.json` files appear and contain the raw payload for inspection. (This is also how we capture the sample payload for step 3.)

## Rollout Notes

- All code changes are additive; no existing behavior changes. `workflow_run` route stays as-is.
- If the GitHub App permission re-acceptance is forgotten, `listPRChecks` will surface a 403 error message to the agent — degrade visible, not silent.
- Defer `get_check_logs` and any output truncation/file-spool logic until a real failure proves `output.summary`+`output.text` insufficient.
