## Why

Shared MCP credentials give every Slack user the same provider identity. In a
1:1 DM, Archie already has an unambiguous user identity and can safely use that
person's provider permissions instead.

## What Changes

- Add lazy per-user OAuth for MCP servers in 1:1 Slack DM tasks.
- Prefer usable shared credentials in DMs and escalate one server to personal
  credentials only when shared access is unavailable or insufficient.
- Keep authorization user interaction on the PM: specialists report the exact
  authorization challenge and the PM initiates any personal grant.
- Send the authorization link directly to the DM participant and park the task
  until the callback completes and its durable wake is delivered.
- Store user tokens by Slack user and reuse a DCR client only while its issuer,
  resource, and redirect URI remain bound to the configured server.
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
- Task metadata records the small set of MCP servers escalated to personal use
  and a bounded per-server forced-reauthorization count.
- The existing shared OAuth CLI and shared-token behavior remain available.
