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

The system SHALL expose `request_mcp_auth` to escalate a server lazily after a
shared MCP call reports an authentication or permission failure. The tool SHALL
work only in a 1:1 DM and persist that server as personal for the task. It SHALL
restart immediately when a usable personal token already exists; otherwise it
SHALL send a single-use authorization URL to that DM and park the task until
the callback succeeds.

#### Scenario: DM user already has a personal token

- **WHEN** an agent in a DM task calls `request_mcp_auth` for S after shared
  access fails and the participant has a usable personal token
- **THEN** the system marks S as personal and restarts the task without starting
  a new OAuth flow

#### Scenario: Agent requests a server in a DM

- **WHEN** an agent in a DM task calls `request_mcp_auth` for an OAuth server
- **THEN** the daemon marks the server as personal, performs discovery and PKCE
  setup, sends the URL to the default DM, and parks the task

#### Scenario: Agent requests a server outside a DM

- **WHEN** an agent in a channel, GitHub, or CLI task calls `request_mcp_auth`
- **THEN** the tool rejects the request without starting OAuth

### Requirement: Per-user storage and refresh

The system SHALL store tokens at `oauth/users/<slackUserId>/<server>.json` and
one reusable DCR client per server at `oauth/_clients/<server>.json`. Records
SHALL use the existing encrypted, atomic, mode-`0o600` vault format. Refreshes
SHALL be isolated by user and server.

#### Scenario: Two users authorize the same server

- **WHEN** users U and V authorize server S
- **THEN** the system stores separate token records for U and V and reuses S's
  shared client registration

#### Scenario: One user's refresh fails

- **WHEN** U's refresh for S fails
- **THEN** V's record and ability to use S remain unaffected

### Requirement: Callback stores the token and wakes the DM task

The pending record SHALL persist `state`, `task_id`, and `slack_user_id`. On a
valid callback, the system SHALL store the token for that user, delete the
pending record, and wake that task. Missing, expired, or reused state SHALL be
rejected.

#### Scenario: Callback completes after daemon restart

- **WHEN** the daemon restarts after issuing the URL and later receives a valid
  callback
- **THEN** it resolves the user and task from the pending record, stores the
  token, and wakes the task

#### Scenario: Callback state is reused

- **WHEN** a completed callback state is submitted again
- **THEN** the system rejects it and does not wake the task again

### Requirement: Targeted revocation

The system SHALL allow deleting one user's token for one server without
affecting other users, the shared client registration, or the shared token.

#### Scenario: Operator revokes one user

- **WHEN** the operator runs `oauth:revoke <server> --user <slackUserId>`
- **THEN** only that user's token record is deleted
