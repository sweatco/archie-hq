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
- Start authorization lazily from the PM after it receives the failed
  operation's authorization challenge directly or from a specialist.
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
Task metadata stores a set of server names explicitly escalated to that user
and a bounded per-server forced-reauthorization count. No acting-user binding
is stored: the user is derived again from the default DM on every spawn.

At spawn:

- Unmarked server: use the shared token when usable. In a DM with no usable
  shared token, use an existing personal token or make the server requestable.
- Server marked personal in a DM: use only
  `oauth/users/<dm-user>/<server>.json`; missing or unusable credentials make
  the server requestable.
- Other task: retain shared-token behavior and ignore personal records.

### Authorization links are sent directly to the DM

Only the PM receives `request_mcp_auth`; specialists send the PM the server name
and exact 401/403, insufficient-scope, and `WWW-Authenticate` scope context.
The tool rejects non-DM tasks. In a DM it marks the server as personal for the
task and restarts immediately only when an existing personal token is fresh and
covers the challenged scopes. Otherwise it performs discovery, reuses or
registers the shared DCR client, writes a pending record, sends the URL to the
default DM, suspends the working indicator, and parks the task.

Authorization requests are serialized by `(task, user, server)`; a duplicate
call returns the existing pending state and does not post a second link. A
forced reauthorization requests the union of the record's prior scopes and the
authoritative challenge scopes. The provider's returned `scope` value replaces
the requested approximation when supplied. A task allows at most two forced
reauthorization prompts per server, preventing an insufficient grant from
looping indefinitely.

The pending record carries the discovery and PKCE exchange data plus `state`,
`task_id`, and `slack_user_id`. On success, the callback atomically seals the
exchanged grant into the completed pending record. That record is a durable wake
outbox: it survives the pending reaper
and daemon restart, waits while the task is active or terminating, and is
drained after either `task:stopped` or `task:completed`. Startup recovery also
replays completed wakes. Draining installs the grant under the same user/server
lock used by refresh, enqueues the resumed PM message, saves task state, and
then deletes the outbox. A crash in the final gap may duplicate the continuation
nudge but cannot lose the grant or wake intent.

### Storage separates clients from user tokens

```
oauth/
  _clients/<server>.json
  users/<slack-user-id>/<server>.json
  .pending/<state>.json
```

One current DCR client record serves all users of a server only while issuer,
canonical resource, and redirect URI exactly match. Per-user token records
carry the same binding and are rejected at spawn/refresh on mismatch. Callback
writes and refreshes share a lock keyed by user and server. The legacy
`oauth/<server>.json` shared records and their injection behavior remain
unchanged.

## Risks / Trade-offs

- A task that starts in a channel and later opens a DM still uses shared
  credentials because its default channel is not a DM. This keeps the boundary
  explicit.
- Existing DM task metadata may lack `dm_user_id`; the next inbound DM message
  backfills it.
- An MCP server may express insufficient access in provider-specific ways. The
  PM escalates only after the MCP call reports an authentication or permission
  failure; a specialist must relay the exact challenge to the PM.
- Abandoned authorization leaves the task parked until the user sends another
  message. After the one-hour pending expiry a later request can issue a new
  link; completed but undelivered wakes do not expire.
- Revocation may leave an empty `oauth/users/<uid>/` directory. Listings decide
  user presence from actual token records, so an empty directory is invisible
  and cannot suppress the "no records" result.
