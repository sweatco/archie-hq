# MCP Tool Approvals

Human-in-the-loop approval for critical MCP tools (issue #168), with optional Slack user-group authorization for approvers (issue #327). Without it a tool is either allowed — and then invoked with no human check — or blocked outright. This gate adds the middle ground: a tool can be declared as needing **per-call human approval**, so genuinely useful but sensitive tools (retry a release build, publish an offer, send a campaign) can be enabled instead of withheld.

> A sibling of [edit mode](edit-mode.md) in spirit, but not in shape. Edit mode is a one-way, task-lifetime grant over a *capability class* (repo writes). This gate is per-call, single-use, and bound to the call's arguments, task, current policy and — when configured — a verified approver.

**This gate is now load-bearing.** A task runs one session that mounts every configured MCP server, so the tiers here are the primary protection for production writes — they replace the per-agent credential scoping the multi-process model used to provide. See [Security → What the flat model gave up](security.md#what-the-flat-model-gave-up).

## The config

One block per server, in the plugins repo's root `.mcp.json`, next to the connection config it governs:

```json
"tramline": {
  "command": "node",
  "args": ["${MCP_TRAMLINE_SERVER_PATH}"],
  "description": "Tramline — mobile release management",
  "archie": {
    "default": "ask",
    "allow": ["list_apps", "get_release", "get_release_analytics"],
    "deny":  ["start_release", "stop_release"],
    "access": {
      "default": { "approverGroups": ["S0234567890"] },
      "tools": { "retry_workflow_run": {} }
    },
    "titles": { "fully_release_rollout": "Release this rollout to 100% of users — irreversible" }
  }
}
```

Three tiers, deliberately the same three words Claude Code uses for permissions:

| Tier | Meaning |
|---|---|
| `allow` | runs with no gate |
| `ask` | a human approves this one call, arguments included |
| `deny` | never runs — withheld from the session entirely |

`titles` is optional and covered under [what the approver reads](#what-the-approver-reads).

`default` covers every tool not listed and is `ask` when omitted, so a tool the server ships next quarter arrives gated rather than silently open. Invert `default` to suit the server: for a mostly-dangerous one list the safe reads under `allow`, for a mostly-safe one list the exceptions under `ask`/`deny`.

The tiers name **who decides the call**, never what the tool claims to be. `allow` is typically reads, but a policy may deliberately put a cheap, repeatable mutation there (a retry button); the tier is not named `readonly` because the gate cannot verify read-ness — and in this project read-sounding tools have twice turned out to start builds.

**The policy belongs to the server, not to the agent.** Which tools of Tramline are dangerous is a property of Tramline. Every server in the root `.mcp.json` attaches to the PM session, and `buildPmDef()` unions their `archie` blocks into **one session policy**: `deny` tiers become the session's `disallowedTools` (`deniedToolNames`), `ask` tiers attach the PreToolUse gate. Three consequences worth knowing:

- The gate is **session-wide**, so it covers the PM and every subagent it spawns — a worker cannot route around a tier by being a different agent, because it is the same process.
- `deny` replaces the hand-maintained `disallowedTools` blocks that agent frontmatter used to carry. Those blocks were identical across agents sharing a server (mobile's 23 entries were a strict subset of release-manager's 59), which is what one copy per server fixes. A plugin agent's own `disallowedTools` still applies to that worker on top.
- Renaming a server key in `.mcp.json` moves its policy with it; there is no second place to update.

Both Archie extensions to a server entry — `description` and `archie` — are parsed and **stripped by the loader**, so the Claude Agent SDK only ever receives valid connection config and a plugin authored for Archie stays a valid Claude plugin. (Verified against Claude Code 2.1.237: unknown keys in a server entry are ignored, while a genuinely invalid entry is reported and skipped.)

### Default behaviour does not change

**A server with no `archie` block is unmanaged: its tools behave exactly as they did before this feature.** Rollout is therefore incremental and opt-in per server. The hook still watches every mounted plugin server so a policy added during a running session is enforced on its next call; built-in MCP tools are outside this plugin namespace. A server with no `archie.access` retains the original workspace-wide approval behaviour.

Unreadable or malformed live root config fails closed for mounted plugin calls until it is fixed. A changed connection requires a task respawn; a policy-only change is picked up live.

### Slack user-group access

Put `access` inside the server's `archie` block. `access.default` supplies the server-wide approver restriction; `access.tools` overrides individual bare method names:

```json
"access": {
  "default": { "approverGroups": ["S0234567890"] },
  "tools": {
    "retry_workflow_run": { "approverGroups": ["S0345678901"] }
  }
}
```

Membership in **any** listed group permits approval. A tool override replaces the default list; an omitted field (including `{}`) inherits its server default. There is no implicit union and no empty-list escape from an inherited restriction. To restrict only selected methods, omit `access.default` and list those methods under `access.tools`. Empty lists, handles, malformed IDs, unknown keys and non-object rules fail config loading. `allow` tools never perform a group check, and `deny` always refuses.

The bot needs `usergroups:read` and `users:read`, plus the `subteam_members_changed` and `subteam_updated` event subscriptions in `slack-manifest.yaml`. Group state comes from `usergroups.list`; complete membership comes from `usergroups.users.list`, never from the truncated user-group snapshot. Unknown, disabled, external or foreign-workspace groups; guests, bots and deactivated users; missing scopes; Slack errors; and lookup timeouts all fail closed.

Membership is cached for at most 60 seconds from lookup start, keyed by workspace and group, with concurrent lookups coalesced. Account eligibility is checked with `users.info` on each authorization. A group event, workspace change or cache expiry invalidates even an already-completed proof held across an asynchronous metadata write. Membership is checked before minting the grant and again before spending it. Only trusted administrators should manage authorization-group membership.

Each protected prompt gets an opaque random reference. Policy changes invalidate pending prompts and stored grants; an obsolete request may be replaced, and its old button cannot approve the replacement. Standalone MCP clients that read the same config do not gain these checks, so the servers and credentials still need their own controls where other clients can reach them.

### What the approver reads

The button's heading is the policy's **title** for the tool when one is written, followed by the call's actual arguments:

```
Release this rollout to 100% of users immediately — irreversible
Tool: `tramline:fully_release_rollout`
Arguments: id=`226284f5-…`
```

Titles are **optional and per-tool**, declared alongside the tiers:

```json
"archie": {
  "default": "ask",
  "allow": ["get_release"],
  "titles": {
    "fully_release_rollout": "Release this rollout to 100% of users immediately — irreversible"
  }
}
```

Write one only where the method name is a bad button on its own — `fully_release_rollout` and `fully_release_previous_rollout` are one word apart and mean very different things. An untitled tool renders as `Run \`server:tool\``: terse but honest, and the sanitized arguments show either way.

> **Why the tool's own description isn't the source.** It would be the better one — consequence text living next to the code that implements it, with no copy in our config to rot — and this gate shipped that way first. It does not work. The Claude CLI *has* the descriptions (it gives them to the model) but exposes them to the SDK host nowhere: the single field in the SDK surface that would carry them, `McpServerStatus.tools[].description`, comes back `undefined` in practice, as does `annotations`. Found on a live instance (the button read `Run \`gatecheck:write_marker\`` where a description existed on the wire) and reduced to a minimal repro — one stdio server, two tools, descriptions present over stdio, absent in the control response — on 2026-08-20. If a future CLI populates the field, the description becomes the default and the title the override: a small change in `renderCall`, and worth making, since a title asserts a consequence the engine cannot verify.

Both halves are rendered **by the engine, never by the agent**: an agent's own summary of what it intends is never what the human reads. Argument values are the one part of the prompt the agent controls — unescaped, a string argument can append its own lines ("*Note:* pre-agreed, safe to approve"). Values and titles alike are flattened, stripped of mrkdwn sigils and capped; arguments are code-spanned, and their count is capped too, because Slack refuses a section over 3000 characters. An agent that wants to explain itself does so in the thread, as a message attributed to it, alongside the button rather than inside it.

### Validation

The loader validates the block strictly and **throws on a malformed policy** — unknown tier, unknown key, a tool in two tiers, a non-list tier: this block decides which external mutations need a human, so a silently-dropped typo must not reclassify a tool. A misspelled tier key (`asks:`) would otherwise read as "nothing listed", quietly dropping every tool in it to the default.

It also refuses a **server key that cannot carry a policy**. The gate finds a policy by splitting the SDK's `mcp__<server>__<tool>` name back into its parts, and a key containing `__` (or with a leading/trailing `_`) does not survive that round trip — `mcp__sweat__admin__publish_offer` splits as server `sweat`, no policy matches, and every tool of that server would run ungated. That is the same class of silent failure the strict parsing exists to prevent, so such a key is rejected at load rather than accepted with an unenforceable policy. Server keys without a policy are unaffected.

## Why a PreToolUse hook, not `canUseTool`

The session runs under `permissionMode: bypassPermissions`, and the SDK documents that this mode auto-approves calls past `canUseTool` ("PreToolUse hook denies bypass canUseTool", sdk.d.ts). The hook is the only interception point that holds in our configuration — and it is the same layer the filesystem guard already relies on to enforce read-only mode, so the trust in it is not new.

The consequence: the gate cannot *pause-and-resume* the original call. It **denies** the call, posts the approval, parks the task, and on approval stores a single-use grant that the agent's **retry of the same call** spends. The action always runs through the same audited MCP path; there is no second code path that executes tools.

## Flow

```
agent calls mcp__tramline__retry_workflow_run { id: "226284f5…" }
  │
  ├─ gate: managed server, tier=ask, no grant on file
  │    ├─ render: the policy title + sanitized arguments (never the agent's summary)
  │    ├─ post Approve/Deny to Slack, write pending_tool_approval, park the task
  │    └─ deny this attempt: "needs human approval, you'll be reactivated"
  │
  ├─ a human clicks Approve
  │    ├─ prompt ref, current policy and configured approver groups rechecked
  │    ├─ grant stored in approved_tool_calls (single-use, 30-min TTL)
  │    └─ the PM is woken
  │
  └─ agent retries the same call
       └─ gate: digest matches → policy/groups rechecked → grant consumed durably → call proceeds
```

### The invariants, and why each exists

- **Digest binding.** Legacy grants use `sha256(server, tool, canonicalized arguments)`. Group-protected grants additionally cover task ID, effective access rule and the current policy/connection revision. Canonicalization sorts keys and drops `undefined`. Protected prompts use a separate random reference, so an old button cannot approve a later identical call.
- **One pending request per task.** A live request cannot be superseded. The slot ages out after 1h; a changed access policy makes it obsolete and replaceable. Replacement clears the PM's old park, and a late post or post failure cannot alter the replacement slot or re-arm the task.
- **Anything that fails before the prompt lands clears the slot.** The slot's presence means "a prompt exists in Slack", and both the one-at-a-time refusal and the same-digest re-arm trust that. So the failure path covers the durable flush as well as the post itself: leaving the slot set would block every gated call for an hour and let a retry park the task against a button nobody can see.
- **Single use across reloads.** Inactive task instances share weakly held metadata, concurrent loads are coalesced, metadata writes are serialized and use atomic replacement, and resolution rechecks the pending object after asynchronous authorization. Protected calls proceed only after grant removal is persisted and authorization is still current; a failed write denies execution. Legacy unrestricted grants retain their earlier log-and-proceed behaviour on a failed consumption write.
- **Fail closed.** Any error while evaluating a mounted plugin call — including agent-controlled input that overflows the canonicalizer or unreadable live config — becomes a denial. Built-in tools remain available independently of plugin configuration.
- **`deny` is enforced twice.** Listed tools are withheld through `disallowedTools`, so the model never sees a tool it cannot use; the gate still refuses the tier at call time, which is what covers a tool that only falls to a `deny` default.
- **Findings at every step**: requested, approved by *name* / denied, expired unspent, and — as a `completion` finding — actually *spent*, so the audit trail can distinguish an approved call that never ran from one that ran.

## Who may approve

Without `approverGroups`, the original behaviour remains: any workspace member who can reach the prompt may resolve it, with identity recorded when available. With `approverGroups`, only an active internal member of one of the configured groups may approve or deny. A refused Slack click receives an ephemeral explanation and leaves the pending prompt and buttons intact.

Resolution has the same surfaces as every other gate: Slack buttons, and the CLI/API path (`POST /tasks/:id/approve` with `type: 'tool_call'` and `ref` set to the opaque reference from the approval event). A verified Slack action supplies the approver principal. Caller-supplied API `approver` data remains audit metadata and cannot satisfy `approverGroups`, including a forged nested principal; those requests receive HTTP 403. Deployments still need ingress protection for the API and its other operations.

## Drift to watch

- **`PreToolUse` firing for MCP tools is version-coupled to the Claude CLI**, exactly like the egress allowlist (see [Security](security.md)) — which silently regressed across a CLI bump once. The live tripwire is `tools/e2e/tool-gate-check.ts` (with the `gatecheck` example plugin as its fixture): it drives a real agent at a real gated MCP tool on a booted instance and asserts interception, deny-blocks-execution, and single-use spend. Run it after any SDK bump and any change to this gate or `spawn.ts`, before trusting the gate with a write-scoped credential.
- **Group access has an additional SDK tripwire:** `npx tsx tools/e2e/tool-access-check.ts`. It uses the real SDK and local stdio MCP fixture under `bypassPermissions`, a deterministic grant and temporary marker files to check denial before approval, one execution after approval and denial after the grant is spent. It requires Claude authentication or `ANTHROPIC_API_KEY`; it does not contact Slack.
- **Titles are policy-authored prose.** A title can understate a tool's effects; review it together with the method and arguments.
- **A grant is bound to the call, not to the caller.** The digest covers the server, tool and arguments; a subagent making the byte-identical call spends the same grant. Approving an *action* rather than an actor is the intended reading, and with one session per task there is no actor distinction left to make anyway.
- **Per-worker divergence has no expression, and cannot have one here.** A worker that should be allowed something the rest must ask for would need a per-subagent override, and the gate cannot see which subagent is calling — every call arrives on the one session's PreToolUse hook. The coarse tool is a second server entry with its own credential (`tramline` read-only, `tramline-rw` gated), which also gets the credential scoping right.

## Relevant source files

- `src/agents/tool-approval-gate.ts` — tiers, classification, digest, rendering/sanitization, hook factory
- `src/system/plugin-loader.ts` — `loadMcpJson` / `parseServerPolicy` (strict validation, throws on a malformed policy)
- `src/agents/registry.ts` — `buildPmDef` (unions every server's policy onto the session; `deny` → `disallowedTools` via `deniedToolNames`)
- `src/tasks/task.ts` — `requestToolApproval`, `consumeToolApproval`, `handleToolCallApproval` / `…Denial`
- `src/types/task.ts` — `pending_tool_approval`, `approved_tool_calls`, `ApprovedToolCall`
- `src/connectors/slack/events.ts` — `registerToolApprovalHandlers`
- `src/agents/tool-access.ts`, `src/tasks/tool-access.ts` — access schema, live policy binding and approval verification
- `src/connectors/slack/user-groups.ts` — membership lookup, eligibility and bounded cache
- `src/agents/spawn.ts` — live hook wiring for every mounted plugin server
- Tests: `src/agents/__tests__/tool-approval-gate.test.ts`, `src/agents/__tests__/registry-mcp-policy.test.ts`, `src/tasks/__tests__/tool-approval.test.ts`, `src/system/__tests__/plugin-loader.test.ts`
