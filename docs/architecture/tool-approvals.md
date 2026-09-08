# MCP Tool Approvals

Per-call human approval for critical MCP tools (#168), with optional Slack user group authorization for approvers (#327). The engine checks the policy before a tool executes, including calls made by the PM or a delegated agent.

Unlike [edit mode](edit-mode.md), this grant is per-call, single-use, and bound to the call's arguments. Group-restricted grants also carry the task, effective access rule, and policy revision.

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
    "titles": { "fully_release_rollout": "Release this rollout to 100% of users — irreversible" }
  }
}
```

Three tiers, deliberately the same three words Claude Code uses for permissions:

| Tier | Meaning |
|---|---|
| `allow` | runs without a confirmation or group check |
| `ask` | a human approves this one call, arguments included |
| `deny` | never runs — withheld from every agent that mounts the server |

`titles` is optional and covered under [what the approver reads](#what-the-approver-reads).

`default` covers every tool not listed and is `ask` when omitted, so a tool the server ships next quarter arrives gated rather than silently open. Invert `default` to suit the server: for a mostly-dangerous one list the safe reads under `allow`, for a mostly-safe one list the exceptions under `ask`/`deny`.

The tiers name **who decides the call**, never what the tool claims to be. `allow` is typically reads, but a policy may deliberately put a cheap, repeatable mutation there (a retry button); the tier is not named `readonly` because the gate cannot verify read-ness — and in this project read-sounding tools have twice turned out to start builds.

**The policy belongs to the server, not to the agent.** Which tools of Tramline are dangerous is a property of Tramline: every agent that mounts it gets the same policy, with no per-agent copy to keep in sync. Three consequences worth knowing:

- The **PM is covered** like any other agent — its overlay's servers resolve through the same `resolveAgentMcpServers`.
- `deny` replaces the hand-maintained `disallowedTools` blocks in agent frontmatter. Those blocks were identical across agents sharing a server (mobile's 23 entries were a strict subset of release-manager's 59), which is what one copy per server fixes. Frontmatter `disallowedTools` still works and is merged on top — an agent can still refuse a tool nobody else refuses.
- Renaming a server key in `.mcp.json` moves its policy with it; there is no second place to update.

Both Archie extensions to a server entry — `description` and `archie` — are parsed and **stripped by the loader**, so the Claude Agent SDK only ever receives valid connection config and a plugin authored for Archie stays a valid Claude plugin. (Verified against Claude Code 2.1.237: unknown keys in a server entry are ignored, while a genuinely invalid entry is reported and skipped.)

### Default behaviour does not change

A server with no `archie` block remains unmanaged; a server with no `archie.access` retains its existing approval behavior. Hooks cover every mounted plugin server so an access policy added during a running session is enforced on the next call. Built-in MCP tools are outside this plugin namespace. Unreadable or malformed root config fails closed for mounted plugin calls until it is fixed; it does not block built-in messaging tools.

### Slack user group access

Put `access` **inside the server's `archie` block**. `access.default` supplies restrictions for the whole server; `access.tools` overrides individual fields for a bare method name. IDs below are examples: replace them with user group IDs from the bot's workspace, not handles or channel IDs.

```json
"archie": {
  "default": "ask",
  "allow": ["get_release"],
  "access": {
    "default": {
      "approverGroups": ["S0234567890"]
    },
    "tools": {
      "fully_release_rollout": {
        "approverGroups": ["S0345678901"]
      }
    }
  }
}
```

- `approverGroups` checks the person clicking Approve/Deny on an `ask` tool. It does not turn an `allow` tool into an `ask` tool.
- Membership in **any** listed group permits approval.
- A tool override replaces the default list. An omitted field (including `{}`) inherits its server default. There is no implicit union or empty-list escape from an inherited restriction. To restrict only selected methods, omit `access.default` and list those methods under `access.tools`.
- Empty lists, handles, malformed IDs, unknown keys, or non-object rules fail config loading. A `deny` tier always refuses, regardless of group membership.

**Shared and automated tasks.** Anyone, including an automated trigger, can propose a call. Thread authors and trigger identities carry no tool authorization. An eligible approver must explicitly approve the specific call; other participants can continue the task without changing that approval. Delegated agents share the same task-bound, single-use grant.

**Membership verification.** The bot needs `usergroups:read` and `users:read` (both already in `slack-manifest.yaml`). Apply the manifest's `subteam_members_changed` and `subteam_updated` subscriptions and redeploy the app configuration. Those events invalidate the cache; correctness does not depend on receiving their member snapshots. Group state comes from [`usergroups.list`](https://docs.slack.dev/reference/methods/usergroups.list/), and complete membership from [`usergroups.users.list`](https://docs.slack.dev/reference/methods/usergroups.users.list/). All configured groups must be readable, active, and in the home workspace. Unknown/disabled groups, guests, bots, deactivated accounts, missing scopes, rate-limit delays or lookup errors deny access. Each Slack lookup has a five-second deadline.

Group membership is cached for at most **60 seconds from lookup start**, keyed by workspace and group, with concurrent lookups coalesced. Account eligibility is checked with `users.info` on each authorization. A group event, workspace change, or expiry invalidates even a completed check held across an asynchronous metadata write. Membership is rechecked before granting approval and again before spending it. Without a delivered event, revocation can take up to the cache window; there is no stale-cache fallback after expiry.

Only trusted administrators should manage membership of authorization groups; a group that users can add themselves to does not provide a useful access restriction.

**Policy refresh.** Each mounted plugin call reads the current root `.mcp.json`. Policy changes invalidate protected prompts/grants; a new request replaces an obsolete pending prompt, and its old button cannot approve the replacement. Connection changes require an agent respawn. There is no background Git pull on every call: changes in the plugins repository take effect after the normal plugin synchronization updates the local file.

Archie enforces this extension at its own invocation boundary. Standalone MCP clients that read the same plugin config do not gain these checks; MCP servers and credentials still need their own access controls where other clients can reach them.

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

Every agent runs under `permissionMode: bypassPermissions`, and the SDK documents that this mode auto-approves calls past `canUseTool` ("PreToolUse hook denies bypass canUseTool", sdk.d.ts). The hook is the only interception point that holds in our configuration — and it is the same layer the filesystem guard already relies on to enforce read-only mode, so the trust in it is not new.

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
  │    ├─ prompt ref matches; approver groups and policy rechecked
  │    ├─ grant stored in approved_tool_calls (single-use, 30-min TTL)
  │    └─ the requesting agent is woken
  │
  └─ agent retries the same call
       └─ gate: digest matches → policy/groups rechecked → grant consumed and saved → call proceeds
```

### The invariants, and why each exists

- **Digest binding.** Legacy grants use `sha256(server, tool, canonicalized arguments)`. Protected grants also cover task ID, effective access rule and current policy/connection revision. Canonicalization sorts keys and drops `undefined`. Protected prompts use a separate random reference so an old button cannot approve a later identical call.
- **One pending request per task.** A live request cannot be superseded. The slot ages out after 1h; a changed access policy also makes it obsolete. Replacement prompts have distinct references. Only the agent that raised the request re-arms its park on a retry; other agents wait. Replacement clears the old agent's park, and a late post or post failure cannot alter the replacement slot or park.
- **Anything that fails before the prompt lands clears the slot.** The slot's presence means "a prompt exists in Slack", and both the one-at-a-time refusal and the same-digest re-arm trust that. So the failure path covers the durable flush as well as the post itself: leaving the slot set would block every gated call for an hour and let a retry park the task against a button nobody can see.
- **Single use across task reloads.** Inactive task instances share weakly held metadata, and loads are coalesced. After asynchronous authorization, resolution compares the pending slot again and consumption synchronously removes the grant before yielding. Task metadata writes are serialized and use atomic replacement. Protected calls proceed only after the removal is saved and authorization is still current; a failed write denies execution. This covers process restarts, not power-loss durability or multiple Archie processes sharing one sessions directory. Legacy unrestricted grants retain their earlier log-and-proceed behavior on a failed consumption write.
- **Fail closed.** Any error while evaluating a mounted plugin call — including agent-controlled input that overflows the canonicalizer — becomes a denial. Non-plugin tools remain available independently of plugin configuration.
- **`deny` is enforced twice.** Listed tools are withheld through `disallowedTools`, so the model never sees a tool it cannot use; the gate still refuses the tier at call time, which is what covers a tool that only falls to a `deny` default.
- **Findings at every step**: requested, approved by *name* / denied, expired unspent, and — as a `completion` finding — actually *spent*, so the audit trail can distinguish an approved call that never ran from one that ran.

## Who may approve

Without `approverGroups`, the existing approval behavior is retained: clicker identity is attribution, with no approver membership restriction. With `approverGroups`, only an eligible member of the configured groups can resolve the prompt. Failed verification sends an ephemeral refusal to the clicker and leaves the pending request and buttons intact.

Slack buttons and `POST /tasks/:id/approve` both use the Task-level verifier. Pass `type: 'tool_call'` and the opaque `ref` from the approval event (a UUID for protected prompts, digest for legacy prompts). A verified Slack action supplies the approver's workspace and user identity. The API's caller-supplied `approver` object remains audit metadata; it cannot satisfy `approverGroups`, including a forged nested principal. Such approval attempts return HTTP 403. Deployments still need ingress protection for the API and its other operations.

## Drift to watch

- **`PreToolUse` firing for MCP tools is version-coupled to the Claude CLI**, exactly like the egress allowlist (see [Security](security.md)) — which silently regressed across a CLI bump once. The live tripwire is `tools/e2e/tool-gate-check.ts` (with the `gatecheck` example plugin as its fixture): it drives a real agent at a real gated MCP tool on a booted instance and asserts interception, deny-blocks-execution, and single-use spend. Run it after any SDK bump and any change to this gate or `spawn.ts`, before trusting the gate with a write-scoped credential.
- **Group access has an additional SDK tripwire:** `npx tsx tools/e2e/tool-access-check.ts`. It uses the real SDK and local stdio MCP fixture under `bypassPermissions`, a deterministic grant and temporary marker files to check denial before approval, one execution after approval, and denial after the grant is spent. It requires Claude authentication or `ANTHROPIC_API_KEY`; it does not contact Slack. Automated tests separately exercise Slack API responses and button/API handlers with mocks.
- **Titles are policy-authored prose.** A title can understate a tool's effects; review it together with the method and arguments.
- **A grant is not bound to the agent that requested it.** The digest covers the server, tool and arguments; another agent on the same task making the byte-identical call could spend it. Approving an *action* rather than an actor is the intended reading, but `requested_by` in the audit trail names the requesting agent, which may differ from the executor. (Only the agent that owns the *pending slot* can re-arm its park.)
- **Per-agent divergence has no expression yet.** If one agent should be allowed something its peers must ask for, that needs an agent-level override layered on the server policy — deliberately not built, because no current agent pair diverges. Until then the coarse tool is a second server entry with its own credential (`tramline` read-only, `tramline-rw` gated), which also gets the credential scoping right.

## Relevant source files

- `src/agents/tool-approval-gate.ts` — tiers, classification, digest, rendering/sanitization, hook factory
- `src/system/plugin-loader.ts` — `loadMcpJson` / `parseServerPolicy` (strict validation, throws on a malformed policy)
- `src/agents/registry.ts` — `resolveAgentMcpServers` (policy per mounted server, `deny` → `disallowedTools`)
- `src/tasks/task.ts` — `requestToolApproval`, `consumeToolApproval`, `handleToolCallApproval` / `…Denial`
- `src/types/task.ts` — `pending_tool_approval`, `approved_tool_calls`, `ApprovedToolCall`
- `src/connectors/slack/events.ts` — `registerToolApprovalHandlers`
- `src/agents/tool-access.ts` — access schema, inheritance and identity types
- `src/tasks/tool-access.ts` — live policy and approval verification
- `src/connectors/slack/user-groups.ts` — membership lookup, eligibility and bounded cache
- `src/agents/spawn.ts` — hook wiring for mounted plugin servers
- Tests: `src/agents/__tests__/tool-approval-gate.test.ts`, `src/agents/__tests__/registry-mcp-policy.test.ts`, `src/tasks/__tests__/tool-approval.test.ts`, `src/system/__tests__/plugin-loader.test.ts`
