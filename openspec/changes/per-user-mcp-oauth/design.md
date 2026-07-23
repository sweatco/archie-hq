## Context

A 1:1 Slack DM has one stable human identity. Channel threads do not: they may
have multiple participants, and choosing an acting user requires bindings,
buttons, and conflict handling. Limiting per-user OAuth to DMs removes that
ambiguity.

## Goals / Non-Goals

**Goals:**

- Prefer shared MCP credentials when they satisfy the request.
- Let a DM task escalate a server to the participant's credentials after an
  authentication or permission failure.
- Start authorization lazily from the agent.
- Preserve shared credentials outside DMs.
- Keep provider discovery and storage provider-agnostic.

**Non-goals:**

- Per-user credentials in channels or multi-party conversations.
- Per-tool-call identity switching.
- Provider revocation APIs or offboarding automation.

## Decisions

### DM identity is the credential boundary

`SlackChannel.dm_user_id` records the other participant returned by Slack.
Only the default channel can supply the OAuth user, and it must be a 1:1 DM.
Task metadata stores only a set of server names explicitly escalated to that
user; no acting-user or authorization-request binding is needed.

At spawn:

- Unmarked server: use the shared token when usable. In a DM with no usable
  shared token, use an existing personal token or make the server requestable.
- Server marked personal in a DM: use only
  `oauth/users/<dm-user>/<server>.json`; missing or unusable credentials make
  the server requestable.
- Other task: retain shared-token behavior and ignore personal records.

### Authorization links are sent directly to the DM

`request_mcp_auth` rejects non-DM tasks. In a DM it first marks that server as
personal for the task. It restarts immediately when the user already has a
usable token. Otherwise it performs discovery, reuses or registers the shared
DCR client, writes a pending record, sends the URL to the default DM, and
parks the task.

The pending record carries `state`, `task_id`, and `slack_user_id`. On success,
the callback stores the user token, deletes the pending record, and wakes the
task. The next spawn derives the same user from the DM again.

### Storage separates clients from user tokens

```
oauth/
  _clients/<server>.json
  users/<slack-user-id>/<server>.json
  .pending/<state>.json
```

One DCR client serves all users of a server. Refresh locks are keyed by user
and server. The legacy `oauth/<server>.json` shared records remain unchanged.

## Risks / Trade-offs

- A task that starts in a channel and later opens a DM still uses shared
  credentials because its default channel is not a DM. This keeps the boundary
  explicit.
- Existing DM task metadata may lack `dm_user_id`; the next inbound DM message
  backfills it.
- An MCP server may express insufficient access in provider-specific ways. The
  agent escalates only after the MCP call reports an authentication or
  permission failure.
- Abandoned authorization leaves the task parked until the user sends another
  message or retries after the pending record expires.
