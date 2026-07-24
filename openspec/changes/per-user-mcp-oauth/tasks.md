## 1. Per-user OAuth records

- [x] 1.1 Add encrypted per-user token and shared-client storage.
- [x] 1.2 Add per-user refresh and targeted CLI revoke/list support.
- [x] 1.3 Include all OAuth record types in startup key validation.

## 2. DM identity and injection

- [x] 2.1 Persist the other participant's Slack user id on 1:1 DM channels.
- [x] 2.2 Resolve per-user OAuth only from the task's default 1:1 DM.
- [x] 2.3 Prefer shared credentials in DMs and use existing personal
  credentials when no shared record is available.
- [x] 2.4 Persist per-task server escalation and inject only the DM user's
  credentials after escalation.
- [x] 2.5 Preserve shared-token injection for every non-DM task.

## 3. Authorization flow

- [x] 3.1 Add DM-only `request_mcp_auth` that marks a server for personal use.
- [x] 3.2 Run discovery, DCR, PKCE, and pending-record creation in the daemon.
- [x] 3.3 Send the authorization URL directly to the DM and park the task.
- [x] 3.4 Reuse an existing personal token without starting OAuth.
- [x] 3.5 Store a new user token and wake the task from the callback.

## 4. Verification

- [x] 4.1 Cover per-user storage and refresh isolation.
- [x] 4.2 Cover shared-first, escalated DM, and non-DM injection behavior.
- [x] 4.3 Cover default-DM identity resolution.
- [ ] 4.4 Verify the complete flow against a real OAuth MCP server.
