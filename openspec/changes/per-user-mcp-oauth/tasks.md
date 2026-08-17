## 1. Per-user OAuth records

- [x] 1.1 Add encrypted per-user token and shared-client storage.
- [x] 1.2 Add per-user refresh and targeted CLI revoke/list support.
- [x] 1.3 Include all OAuth record types in startup key validation.
- [x] 1.4 Bind per-user tokens and shared clients to issuer, resource, and
  redirect URI; serialize callback and refresh writes.
- [x] 1.5 Reject ambiguous revoke argv and ignore empty user directories in
  OAuth listings.

## 2. DM identity and injection

- [x] 2.1 Persist the other participant's Slack user id on 1:1 DM channels.
- [x] 2.2 Resolve per-user OAuth only from the task's default 1:1 DM.
- [x] 2.3 Prefer shared credentials in DMs and use existing personal
  credentials when no shared record is available.
- [x] 2.4 Persist per-task server escalation and inject only the DM user's
  credentials after escalation.
- [x] 2.5 Preserve shared-token injection for every non-DM task.

## 3. Authorization flow

- [x] 3.1 Add PM-only, DM-only `request_mcp_auth`; specialists relay exact
  authorization challenges to the PM.
- [x] 3.2 Run discovery, DCR, PKCE, and pending-record creation in the daemon.
- [x] 3.3 Send the authorization URL directly to the DM and park the task.
- [x] 3.4 Reuse an existing personal token without starting OAuth.
- [x] 3.5 Store a new user token and deliver callback wakes through a durable,
  restart-replayed outbox.
- [x] 3.6 Deduplicate pending attempts and bound scope-aware forced
  reauthorization.

## 4. Verification

- [x] 4.1 Cover per-user storage and refresh isolation.
- [x] 4.2 Cover shared-first, escalated DM, and non-DM injection behavior.
- [x] 4.3 Cover default-DM identity resolution.
- [ ] 4.4 Verify the complete flow against a real OAuth MCP server.
  - Configure the official Notion Streamable HTTP endpoint
    (`https://mcp.notion.com/mcp`) as `notion` in `.mcp.json`. Use an isolated
    `ARCHIE_SECRETS_DIR`, a publicly reachable `ARCHIE_PUBLIC_URL`, operator
    Notion identity A, and Slack DM user B with a private page not shared to A.
  - Run `npm run oauth:connect -- notion` and authorize A. Confirm a DM with B
    uses the shared grant for a page A can access.
  - Request B's private page; capture the shared permission failure,
    specialist-to-PM challenge handoff, PM-only
    authorization link, callback, automatic wake, and successful personal call.
  - Restart the daemon after authorization and confirm the same task still uses
    the personal grant. From the same configured daemon environment, force one
    personal refresh without printing its result:
    `./node_modules/.bin/tsx -e '(async()=>{const {ensureFreshUserToken}=await import("./src/system/oauth/refresh.ts");await ensureFreshUserToken("<slack-user-id>","notion","https://mcp.notion.com/mcp",{force:true})})()'`.
    Confirm `updated_at` advances and the MCP call still succeeds.
  - Run
    `npm run oauth:revoke -- notion --user <slack-user-id>`; confirm the user's
    record disappears, shared/client/other-user records remain, and the next
    personal need prompts again without falling back to shared credentials.
  - Record the provider, task id, timestamps, resource, and redacted logs before
    checking this item. Do not record tokens or client secrets.
