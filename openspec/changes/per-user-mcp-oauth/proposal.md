## Why

Shared MCP credentials give every Slack user the same provider identity. In a
1:1 DM, Archie already has an unambiguous user identity and can safely use that
person's provider permissions instead.

## What Changes

- Add lazy per-user OAuth for MCP servers in 1:1 Slack DM tasks.
- Prefer usable shared credentials in DMs and escalate one server to personal
  credentials only when shared access is unavailable or insufficient.
- Send the authorization link directly to the DM participant and park the task
  until the callback completes.
- Store user tokens by Slack user and reuse one DCR client per server.
- Reject per-user OAuth requests from channel, GitHub, and CLI tasks.

## Capabilities

### New Capabilities

- `per-user-mcp-oauth`: DM-only per-user authorization, storage, refresh,
  injection, revoke, and callback wake-up.

### Modified Capabilities

- None.

## Impact

- OAuth storage gains `oauth/users/` and `oauth/_clients/`.
- Agent spawn prefers shared credentials and honors per-task DM escalations.
- Slack DM metadata records the other participant's user id.
- Task metadata records the small set of MCP servers escalated to personal use.
- The existing shared OAuth CLI and shared-token behavior remain available.
