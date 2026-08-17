## ADDED Requirements

### Requirement: Per-user OAuth is limited to 1:1 Slack DMs

The system SHALL use per-user MCP OAuth only when the task's default channel is
a 1:1 Slack DM with a resolved participant id. Channel, GitHub, and CLI tasks
SHALL continue to use shared credentials and SHALL reject per-user OAuth
requests.

#### Scenario: DM task resolves its participant

- **WHEN** a task's default channel is a 1:1 Slack DM with participant U
- **THEN** the system resolves U as the task's MCP OAuth user

#### Scenario: Channel task does not resolve a user

- **WHEN** a task's default channel is a Slack channel thread, even if the task
  also has a linked DM
- **THEN** the system does not resolve a per-user MCP OAuth identity

### Requirement: DMs prefer shared credentials until explicitly escalated

For an OAuth MCP server in a DM task, the system SHALL inject a usable shared
token by default, even when the participant has a personal token. If no shared
record is available, the system SHALL use a usable existing personal token or
make the server requestable. After the task explicitly escalates the server,
the system SHALL use only the participant's personal token for that server.

#### Scenario: DM has shared and personal credentials

- **WHEN** DM participant U has a personal token for S and a usable shared token
  also exists
- **THEN** the system injects the shared token for S

#### Scenario: DM has no shared credentials

- **WHEN** no shared record exists for S and DM participant U has a usable
  personal token
- **THEN** the system injects U's personal token for S

#### Scenario: DM server is escalated

- **WHEN** task T in U's DM marks S for personal access
- **THEN** the system injects only U's usable personal token for S and does not
  fall back to the shared token

#### Scenario: Non-DM task has shared credentials

- **WHEN** a non-DM task uses server S and a usable shared token exists
- **THEN** the system injects the shared token

### Requirement: Lazy DM authorization

The system SHALL expose `request_mcp_auth` only to the PM to escalate a server
lazily after a shared MCP call reports an authentication or permission failure.
Specialists SHALL report the server and exact authorization challenge to the PM
instead of initiating user interaction. The tool SHALL work only in a 1:1 DM
and persist that server as personal for the task. It SHALL restart immediately
only when a fresh personal token covers the challenged scopes; otherwise it
SHALL send a single-use authorization URL to that DM, suspend the working
indicator, and park the task until the callback succeeds.

#### Scenario: DM user already has a personal token

- **WHEN** the PM in a DM task calls `request_mcp_auth` for S after shared
  access fails and the participant has a usable personal token
- **THEN** the system marks S as personal and restarts the task without starting
  a new OAuth flow, provided the token covers every challenged scope

#### Scenario: PM requests a server in a DM

- **WHEN** the PM in a DM task calls `request_mcp_auth` for an OAuth server
- **THEN** the daemon marks the server as personal, performs discovery and PKCE
  setup, sends the URL to the default DM, and parks the task

#### Scenario: Specialist encounters an authorization challenge

- **WHEN** a specialist's MCP call returns an authentication, permission, or
  insufficient-scope challenge
- **THEN** the specialist reports the server and exact challenge context to the
  PM, and the specialist does not receive `request_mcp_auth`

#### Scenario: PM requests a server outside a DM

- **WHEN** the PM in a channel, GitHub, or CLI task calls `request_mcp_auth`
- **THEN** the tool rejects the request without starting OAuth

#### Scenario: Duplicate authorization request

- **WHEN** the same task and DM user already have an unexpired pending attempt
  for S
- **THEN** another request for S posts no second link and parks on the existing
  attempt

#### Scenario: Personal grant lacks challenged scopes

- **WHEN** S is already personal or its existing personal grant lacks an exact
  scope from the failed challenge
- **THEN** reauthorization requests the union of prior and challenged scopes
  rather than restarting with the rejected grant

#### Scenario: Reauthorization remains insufficient

- **WHEN** a task has already delivered two forced reauthorization prompts for
  S and personal access still fails
- **THEN** the system reports a permanent permission failure and does not issue
  another prompt

#### Scenario: Provider reports granted scopes

- **WHEN** the token or refresh response includes a `scope` value
- **THEN** the stored record uses that returned scope set instead of assuming
  every requested scope was granted

### Requirement: Per-user storage and refresh

The system SHALL store tokens at `oauth/users/<slackUserId>/<server>.json` and
one current DCR client record per server at `oauth/_clients/<server>.json`.
Per-user records and DCR clients SHALL bind issuer, canonical resource, and
exact redirect URI; injection and refresh SHALL reject mismatches. Records
SHALL use the existing encrypted, atomic, mode-`0o600` vault format. Callback
writes and refreshes SHALL be serialized by user and server.

#### Scenario: Two users authorize the same server

- **WHEN** users U and V authorize server S
- **THEN** the system stores separate token records for U and V and reuses S's
  shared client registration only while its issuer/resource/redirect binding
  matches

#### Scenario: One user's refresh fails

- **WHEN** U's refresh for S fails
- **THEN** V's record and ability to use S remain unaffected

#### Scenario: Configured resource changes

- **WHEN** U's stored token or S's client registration is bound to a different
  canonical resource, issuer, or redirect URI than the current configuration
- **THEN** the personal credential is not injected and the DM must authorize
  against the current binding

### Requirement: Callback stores the token and wakes the DM task

The pending record SHALL persist the discovery/PKCE exchange data together with
`state`, `task_id`, and `slack_user_id`. On a valid callback, the system SHALL
atomically seal the exchanged grant into the completed record as a durable wake
outbox. It SHALL wait for active or terminating task instances to quiesce,
install the per-user grant, wake the PM after either stopped or completed
teardown, and delete the outbox only after the wake is enqueued and task state
is saved. Startup SHALL replay completed
outboxes. Missing, expired, or reused state SHALL be rejected.

#### Scenario: Callback completes after daemon restart

- **WHEN** the daemon restarts after issuing the URL and later receives a valid
  callback
- **THEN** it resolves the user and task from the pending record, seals the
  exchanged grant as a completed wake, and delivers that grant and wake

#### Scenario: Callback races task teardown

- **WHEN** a callback completes while the originating task is active or between
  active-cache removal and its stopped/completed event
- **THEN** the durable wake remains pending and is delivered after teardown

#### Scenario: Daemon restarts after callback completion

- **WHEN** the callback sealed a completed grant but the daemon stopped before
  installing it or waking the task
- **THEN** startup replay wakes the task and removes the outbox after durable
  delivery

#### Scenario: Callback state is reused

- **WHEN** a completed callback state is submitted again
- **THEN** the system rejects it and does not wake the task again

### Requirement: Targeted revocation

The system SHALL allow deleting one user's token for one server without
affecting other users, the shared client registration, or the shared token.

#### Scenario: Operator revokes one user

- **WHEN** the operator runs
  `npm run oauth:revoke -- <server> --user <slackUserId>`
- **THEN** only that user's token record is deleted

#### Scenario: npm consumes the user flag

- **WHEN** revoke receives more than one positional value because npm consumed
  `--user`
- **THEN** the command exits with usage and deletes neither the shared nor a
  per-user record

#### Scenario: Final user record is deleted

- **WHEN** revocation removes the last token record under a user's directory
- **THEN** `oauth:list` treats that directory as empty and does not omit the
  overall "no records" result
