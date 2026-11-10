# Slack group approvers for MCP tool calls

**Date:** 2026-10-23 · **Status: Implemented (this PR).**

## Acceptance criteria

| id | criterion | method |
|---|---|---|
| AC1 | The loader parses `archie.access.default.approverGroups` and `archie.access.tools.<tool>.approverGroups` as string lists; a per-tool list replaces the default; groups on a tool whose tier is not `ask` fail loading. | unit |
| AC2 | Slack Approve of a restricted call is judged at click time against the current loaded policy: a member gets today's grant; a non-member, a failed lookup, or a server missing from the current policy gets no grant, the slot and prompt stay, and the clicker gets an ephemeral refusal. | unit |
| AC3 | API/CLI approve of a restricted call returns 403 with no grant; anyone can Deny (Slack or API); unrestricted calls are unchanged. | unit |

## Design

Restrict who may approve an ask-tier MCP call to members of Slack user groups named in the plugins repo's root .mcp.json, judged at click time against the engine's current loaded policy. Small rewrite of #329 (fjqtt, issue #327).

Config (shape from #327), inside a server's existing `archie` block: `"access": { "default": { "approverGroups": ["S…"] }, "tools": { "<tool>": { "approverGroups": ["S…"] } } }`. A per-tool list replaces the default. plugin-loader.ts parseServerPolicy admits the `access` key and stores `McpServerPolicy.approverGroups?: { default?: string[]; tools: Record<string, string[]> }`, set only when `access` is present (existing deep-equality tests stay green). Only one validation is added: a per-tool entry whose effective tier (tiers[tool] ?? default) is not `ask` throws, because groups there would be silently meaningless. Pure resolver `approverGroupsFor(serverPolicy, tool): string[] | undefined` in tool-approval-gate.ts (own-property lookup on tools, then default).

Current loaded policy: main propagates plugin updates through `syncPlugins()` (plugin-sync.ts), which on a moved remote (or every call for a local checkout) re-scans and calls `initRegistry()`, rebuilding the cached PM def whose `mcpPolicy` is the union of root .mcp.json policies. At click time Task.handleToolCallApproval calls `await syncPlugins()` then reads `getPmDef().mcpPolicy` (in-memory). The gate's per-call path gains no file read; spawn keeps using `scanPmDef()`. If the file is missing or unparseable, main's initRegistry caches an empty def; the pending call's server is then absent from the policy and Approve is refused (fail closed) — no last-good machinery.

Approve (Task.handleToolCallApproval(approver, expectedDigest, slackUserId?)): after the existing stale and expired checks and before clearing the slot: `await syncPlugins()`; `const policy = getPmDef().mcpPolicy`; if it has no own entry for `pending.server` → refuse. Else `groups = approverGroupsFor(policy[pending.server], pending.tool)`; if set, allowed only when `slackUserId` and `approver` are both present (approver is undefined for external/guest clickers, per resolveApprover) and `await isInAnyUserGroup(slackUserId, groups)`. Refusal: logger.warn, append a 'decision' finding `Tool-call approval refused for <@U…|unknown>: <server>:<tool>`, leave the slot untouched, return `'forbidden'`. After the awaits, if `this.metadata.pending_tool_approval !== pending` return `'stale'` (re-compare preserves the read-compare-clear identity). Then mint the grant exactly as today. Return type `'resolved' | 'stale' | 'forbidden'`. requestToolApproval, consumeToolApproval and handleToolCallDenial are unchanged — anyone may deny.

Membership: `isInAnyUserGroup(userId, groupIds): Promise<boolean>` in slack/client.ts calls `getSlackClient().usergroups.users.list({ usergroup })` per group, returns true on first hit; any thrown error or non-ok response logs a warn and returns false (fail closed). No cache, no subteam events, no manifest change (usergroups:read already at slack-manifest.yaml:40).

Adapters: Slack `approve_tool_call` passes the clicker id (`userId` unless 'unknown') as `slackUserId`; on `'forbidden'` it posts `postEphemeral(body.channel.id, userId, TEXT, body.message?.thread_ts)` when body.channel?.id is set, TEXT = "Only members of the Slack groups allowed to approve this tool can approve it. Nothing was approved, and the request is still open.", and does NOT update the prompt. The API route never passes `slackUserId`, so a restricted approve gets `'forbidden'` → HTTP 403 `{ ok: false, error: 'This tool call can only be approved in Slack by a member of its approver groups.' }`, no `approval:resolved` emit. Unrestricted API approvals unchanged.

Rejected: #329's cache + subteam events, spend-time re-check, snapshotting groups on the slot, per-call .mcp.json reads, last-good caching, refusing no-thread tasks up front (such a call waits and expires like any unanswered approval).

Error paths: Slack lookup error → refused, request stays open; plugins refresh failure → refreshPlugins swallows it and keeps the cached def; a malformed policy makes initRegistry throw inside syncPlugins → the click handler's existing catch logs it and nothing is approved (pre-existing, fail closed).

Dependents: src/connectors/api/routes.ts:357 and src/connectors/slack/events.ts:693 are the only handleToolCallApproval callers and both branch on forbidden in T03; src/tasks/__tests__/tool-approval.test.ts:76 is extended in T02; src/agents/registry.ts:245 passes policies through as mcpPolicy unchanged; src/system/__tests__/plugin-loader.test.ts:177, src/agents/__tests__/tool-approval-gate.test.ts:19 and src/agents/__tests__/pm-overlay.test.ts:30 build or compare policies without the new optional field and stay valid. Test files that vi.mock registry.js without getPmDef (e.g. src/agents/__tests__/tool-contract.test.ts:47) or slack/client.js without isInAnyUserGroup (src/agents/__tests__/tool-contract.test.ts:51, src/connectors/__tests__/merge-approval-surfaces.test.ts:16) are unaffected because task.ts touches those exports only inside handleToolCallApproval, which those suites never call, and events.ts imports nothing new from the client.

## Tasks

### T01 — Parse archie.access approverGroups + resolver + membership helper

src/agents/tool-approval-gate.ts: add `approverGroups?: { default?: string[]; tools: Record<string, string[]> }` to McpServerPolicy (one-line doc comment); export `approverGroupsFor(serverPolicy: McpServerPolicy, tool: string): string[] | undefined` — `Object.hasOwn(tools, tool) ? tools[tool] : default`. src/system/plugin-loader.ts parseServerPolicy: add 'access' to allowedKeys and the unknown-key message; when entry.access !== undefined read `access.default?.approverGroups` and each `access.tools[tool].approverGroups` as given (no shape validation), throw `${where}.access.tools.${tool}: approverGroups only apply to ask-tier tools — "${tool}" is ${tier}.` when the tool's effective tier is not ask, and return approverGroups only when access was present. Add an `access` line to the doc-comment JSON example. src/connectors/slack/client.ts: add exported `isInAnyUserGroup(userId, groupIds)` near getUserInfo per the design, with a one-line doc comment that it is uncached and fail-closed on purpose.

**Files:** `src/agents/tool-approval-gate.ts`, `src/system/plugin-loader.ts`, `src/connectors/slack/client.ts`, `src/system/__tests__/plugin-loader.test.ts`, `src/agents/__tests__/tool-approval-gate.test.ts`, `src/connectors/slack/__tests__/client.test.ts`

**Tests:** npx vitest run src/system/__tests__/plugin-loader.test.ts src/agents/__tests__/tool-approval-gate.test.ts src/connectors/slack/__tests__/client.test.ts — new cases: access parsed (default + override), groups on an allow-tier tool throws; approverGroupsFor returns override / default / undefined; isInAnyUserGroup member-of-second → true, none → false, throws → false, ok:false → false (add `users: { list }` under the fake usergroups).

**Must not touch:** src/agents/spawn.ts; createToolApprovalHooks/decideCall; slack-manifest.yaml; the usergroups.list display lookup in client.ts

### T02 — Click-time group check in Task.handleToolCallApproval

src/tasks/task.ts: import getPmDef (alongside scanPmDef from '../agents/registry.js'), approverGroupsFor (from the gate import), isInAnyUserGroup (from the existing slack/client import). handleToolCallApproval(approver, expectedDigest, slackUserId?: string): Promise<'resolved' | 'stale' | 'forbidden'> implementing the design's Approve paragraph exactly; today's mint code below the check untouched. Update its doc comment in one or two lines. Do not call getPmDef or isInAnyUserGroup anywhere else in task.ts. Nothing else in task.ts changes.

**Files:** `src/tasks/task.ts`, `src/tasks/__tests__/tool-approval.test.ts`

**Tests:** npx vitest run src/tasks/__tests__/tool-approval.test.ts — mock '../../agents/registry.js' (getPmDef returning a def whose mcpPolicy has `tramline`; keep scanPmDef via importOriginal), '../../system/plugin-sync.js' (syncPlugins resolved), and isInAnyUserGroup in the slack client (importOriginal spread). Extend approve() with optional slackUserId. New cases: restricted + member → 'resolved' and grant; non-member / no slackUserId / approver undefined / lookup false → 'forbidden', slot kept, no grant, decision finding; groups changed in getPmDef after the request → judged on the new groups; server absent from current policy → 'forbidden'; slot replaced during the awaits → 'stale'; existing unrestricted tests stay green; deny still resolves for anyone.

**Must not touch:** requestToolApproval; consumeToolApproval; handleToolCallDenial; src/agents/spawn.ts; src/system/plugin-sync.ts; src/agents/registry.ts

### T03 — Slack button + API route handle 'forbidden'

src/connectors/slack/events.ts approve_tool_call: pass `userId !== 'unknown' ? userId : undefined` as the third argument; on 'forbidden' post the design's ephemeral and return without updating the prompt; TEXT as a const next to STALE_TOOL_APPROVAL_TEXT; resolved/stale paths and deny_tool_call unchanged. src/connectors/api/routes.ts tool_call branch: on an approve disposition of 'forbidden' respond 403 with the design's body and return; adjust the branch comment in one line to say restricted calls are Slack-only.

**Files:** `src/connectors/slack/events.ts`, `src/connectors/api/routes.ts`, `src/connectors/__tests__/tool-approval-surfaces.test.ts`

**Tests:** npx vitest run src/connectors/__tests__/tool-approval-surfaces.test.ts — new file modelled on src/connectors/__tests__/merge-approval-surfaces.test.ts: Slack approve passes the clicker id; 'forbidden' → postEphemeral to the clicker in the thread, no updateSlackMessageSafely; 'resolved' → message updated; API approve passes no Slack user id; API 'forbidden' → 403 and no approval:resolved; API deny unchanged.

**Must not touch:** deny_tool_call; other approval types in routes.ts; slack-manifest.yaml

## Verification plan

| ac | method | scenario | evidence | command |
|---|---|---|---|---|
| AC1 | unit | plugin-loader tests parse an access block (default + override) and reject groups on an allow-tier tool | vitest output in the QA scratchpad | `npx vitest run src/system/__tests__/plugin-loader.test.ts src/agents/__tests__/tool-approval-gate.test.ts` |
| AC2 | unit | tool-approval + surfaces tests (member, non-member, lookup failure, group change after posting, server missing). Live Slack (brain posts, operator clicks): gatecheck write_marker restricted to a group containing the operator → Approve works and the marker gains the nonce once; restricted to a group excluding the operator → ephemeral refusal, prompt stays, marker unchanged | vitest output; live: marker file, task findings, operator confirmation relayed by the brain | `npx vitest run src/tasks/__tests__/tool-approval.test.ts src/connectors/__tests__/tool-approval-surfaces.test.ts` |
| AC3 | unit | surfaces test: API approve of a restricted call → 403, no grant; API deny works. Live: in scenario (b) the operator's Deny resolves the prompt; tool-gate-check (unrestricted gatecheck, API approve) passes unchanged | vitest output; live tool-gate-check output and the denied task's finding | `npx vitest run src/connectors/__tests__/tool-approval-surfaces.test.ts` |

## Facts this design stands on

Each was checked against the code by an agent instructed to refute it.

| claim | citation | ruling |
|---|---|---|
| syncPlugins() calls initRegistry() whenever refreshPlugins() reports a change, and refreshPlugins returns true on every call for a local/symlinked plugins checkout | `src/system/plugin-sync.ts:33` | declared |
| initRegistry() assigns the cached pmDef from buildPmDef(), which reads getRootMcpConfig() and sets mcpPolicy to rootMcp.policies only when non-empty | `src/agents/registry.ts:160` | declared |
| Task spawn paths use scanPmDef(), not getPmDef() | `src/tasks/task.ts:326` | declared |
| loadMcpJson returns an empty config (no throw) when the file is missing or its JSON fails to parse, and throws on a malformed archie policy | `src/system/plugin-loader.ts:162` | declared |
| parseServerPolicy rejects unknown non-underscore keys via an allowedKeys set of default, titles and the tier names, and parses tiers before returning | `src/system/plugin-loader.ts:104` | declared |
| handleToolCallApproval clears the slot synchronously after the stale/expired checks and mints a grant; its only callers are the Slack approve_tool_call handler and the API route | `src/tasks/task.ts:1891` | declared |
| The Slack approve handler's resolveApprover returns undefined for external/guest users via isExternalUser | `src/connectors/slack/events.ts:667` | declared |
| postEphemeral(channel, user, text, threadTs?) is exported from slack/client.ts and already imported in events.ts | `src/connectors/slack/client.ts:1740` | declared |
| The API route's tool_call branch calls handleToolCallApproval(cleanApprover, ref), returns 409 on 'stale', and otherwise emits approval:resolved and returns ok | `src/connectors/api/routes.ts:356` | declared |
| slack-manifest.yaml already requests the usergroups:read bot scope | `slack-manifest.yaml:40` | declared |
| The tool-approval Task tests call prototype methods on a minimal fake task and do not mock registry.js or plugin-sync.js | `src/tasks/__tests__/tool-approval.test.ts:57` | declared |
| client.test.ts's fake WebClient defines usergroups with only list | `src/connectors/slack/__tests__/client.test.ts:21` | declared |
| merge-approval-surfaces.test.ts captures Slack actions with a fake Bolt app and the approve route by path, mocking Task as { Task: { get }, activeTasks } | `src/connectors/__tests__/merge-approval-surfaces.test.ts:44` | declared |
| tool-gate-check approves via POST /api/tasks/:id/approve with { type: 'tool_call', approve: true, ref } and the gatecheck example policy has no access key | `tools/e2e/tool-gate-check.ts:169` | declared |
