## ADDED Requirements

### Requirement: Lazy authorization trigger via in-process tool

The system SHALL expose an in-process `request_mcp_auth` tool to agents that need an http/sse MCP server requiring OAuth for which no usable token is available. When invoked, the system SHALL park the requesting agent's work and post an interactive authorization wall message, rather than provisioning credentials ahead of time. No authorization flow SHALL be initiated until an agent explicitly requests it.

#### Scenario: Agent requests authorization for an unauthorized server

- **WHEN** an agent calls `request_mcp_auth("notion")` and no usable token exists for the resolved acting identity
- **THEN** the system parks the agent's current work and the owning Task posts an interactive authorization wall message ("Authorize Notion") to the task's default Slack thread

#### Scenario: No wall is posted absent a request

- **WHEN** a task runs and an agent never calls `request_mcp_auth` for a given server
- **THEN** the system initiates no authorization flow and posts no wall message for that server

### Requirement: Requestable servers advertised to agents

The system SHALL inform an agent, at spawn time, which of its configured http/sse MCP servers require authorization but have no usable token, so the agent knows it can call `request_mcp_auth` for them. Servers that are already usable (per-user token bound, or a shared operator token present) SHALL NOT be advertised as requestable.

#### Scenario: Unauthorized server is listed as requestable

- **WHEN** an agent is spawned with `notion` in its `mcpServers` frontmatter, `notion` requires auth, and no usable token is available
- **THEN** the agent's prompt lists `notion` among the servers it can request access to via `request_mcp_auth`

#### Scenario: Already-usable server is not advertised

- **WHEN** an agent is spawned with a server for which a usable token (per-user or shared) already exists
- **THEN** that server is not listed as requestable and its tools are available directly

### Requirement: Acting user identified by the wall button click

The system SHALL determine the acting user for a `(task, server)` pair as the Slack user who clicks the authorization wall's "Authorize" button, identified by the interaction payload's `body.user.id`. The system SHALL NOT infer the acting user from task authorship or message order.

#### Scenario: Clicking participant becomes the acting user

- **WHEN** a participant in the thread clicks the "Authorize Notion" button
- **THEN** the system records that participant's Slack user id as the acting user for `(task, notion)` and proceeds to authorize on their behalf

#### Scenario: Non-clicking participants are not bound

- **WHEN** multiple participants are present but only one clicks the button
- **THEN** only the clicking participant is bound as the acting user for that `(task, server)` pair

### Requirement: Ephemeral single-use authorization URL

When the acting user has no stored token for the requested server, the system SHALL run OAuth discovery and, on button click, deliver the authorize URL only to the clicking user (ephemeral response or direct message) and never post it into a shared channel. The pending authorization SHALL be single-use and expire after a bounded TTL.

#### Scenario: URL delivered privately to the clicker

- **WHEN** the clicking user has no stored Notion token and the wall button is clicked
- **THEN** the system generates a pending authorization bound to that user's Slack id and returns the authorize URL to that user via an ephemeral message or DM only

#### Scenario: Expired or reused authorization is rejected

- **WHEN** the callback is invoked with a `state` whose pending record is missing, already completed, or older than the TTL
- **THEN** the system rejects the exchange and does not write any token record

### Requirement: Per-user token and shared client storage

The system SHALL store OAuth access/refresh tokens per user at `oauth/users/<slackUserId>/<server>.json`, encrypted with the existing vault sealing (AES-256-GCM, `0o600`, atomic write). The DCR client registration SHALL be stored once per server at `oauth/_clients/<server>.json` and reused across all users of that server.

#### Scenario: First authorization registers the shared client and the user token

- **WHEN** the first user authorizes a server that has no existing client registration
- **THEN** the system writes the DCR client to `oauth/_clients/<server>.json` and the user's tokens to `oauth/users/<slackUserId>/<server>.json`

#### Scenario: Subsequent user reuses the shared client

- **WHEN** a second user authorizes the same server
- **THEN** the system reuses the existing `oauth/_clients/<server>.json` registration and writes only the second user's token record

### Requirement: Acting-user binding persisted per task

The system SHALL persist the resolved acting user for each authorized server on the task, keyed by server name, so that subsequent spawns within the same task inject the same user's credentials for that server.

#### Scenario: Binding drives later spawns in the same task

- **WHEN** `(task, notion)` is bound to user U and any agent in that task is later spawned with `notion`
- **THEN** the system injects U's Notion token for that server on every subsequent spawn within the task

### Requirement: Injection precedence with binding as the policy boundary

At spawn time, for each http/sse MCP server, the system SHALL resolve credentials by first determining whether `(task, server)` is bound to an acting user, then selecting credentials as follows:

- If the pair **is bound** (user-scoped): inject the acting user's per-user token when fresh or refreshable; otherwise treat the server as unauthorized (requestable). A bound pair SHALL NOT fall back to a shared operator token.
- If the pair **is unbound** (cold): inject a shared operator token if one exists; otherwise treat the server as unauthorized (requestable).

Existing shared per-server records SHALL continue to work unchanged for unbound, sufficient cases.

#### Scenario: Bound pair uses only the per-user token

- **WHEN** `(task, notion)` is bound to user U and U's token is usable, even if a shared operator token also exists
- **THEN** the system injects U's per-user token

#### Scenario: Bound pair re-walls instead of falling back to shared

- **WHEN** `(task, notion)` is bound to user U but U's token is missing, revoked, or fails to refresh, and a shared operator token exists
- **THEN** the system treats the server as unauthorized (requestable) and does NOT inject the shared operator token

#### Scenario: Cold server uses the shared token without a wall

- **WHEN** `(task, server)` is unbound and a shared operator token exists
- **THEN** the system injects the shared operator token and does not post a wall

#### Scenario: No credentials available

- **WHEN** `(task, server)` is unbound and no shared token exists for a server the agent needs
- **THEN** the system treats the server as unauthorized and the agent may request authorization via the wall

### Requirement: Escalation from shared to per-user on access denial

When a cold server is served by a shared operator token and a call to that server fails with an authorization or permission error (e.g. 401, 403, or insufficient scope), the agent SHALL be able to escalate by calling `request_mcp_auth` for that server, which posts the wall and binds the acting user's own credentials. The system SHALL NOT continue to rely on the shared token for that `(task, server)` once it has escalated and bound an acting user.

#### Scenario: Shared token insufficient triggers escalation

- **WHEN** an agent's call to a shared-token server returns an authorization/permission failure and the agent calls `request_mcp_auth` for that server
- **THEN** the system posts the authorization wall, and on completion binds the acting user's per-user token to `(task, server)` and uses it for subsequent calls

### Requirement: Auto-bind on existing token without a wall

When an acting user can be resolved and already holds a stored, usable token for the requested server, the system SHALL bind it and make the server available without posting a wall message or re-running authorization.

#### Scenario: Returning user skips the wall

- **WHEN** an agent requires a server for which the resolvable acting user already has a stored token
- **THEN** the system binds that token to `(task, server)` and makes the server usable without posting a wall or re-authorizing

### Requirement: Provider-agnostic applicability

The authorization wall capability SHALL apply to any http/sse MCP server that requires authorization, detected via the existing 401 / `WWW-Authenticate` protected-resource probe. The system SHALL NOT require per-service configuration to enable it.

#### Scenario: Newly added OAuth server works without code changes

- **WHEN** an http/sse MCP server that requires auth is added to `.mcp.json` and referenced by an agent
- **THEN** the wall capability applies to it with no per-service configuration

#### Scenario: Non-authenticating server is untouched

- **WHEN** an http/sse MCP server does not respond with a 401 / `WWW-Authenticate` challenge
- **THEN** the system does not treat it as requiring authorization and injects no credentials

### Requirement: Daemon-side discovery and DCR

The system SHALL perform OAuth discovery, dynamic client registration, and PKCE/state setup in the running daemon in response to the wall button click, without requiring an operator CLI invocation. The operator CLI connect path SHALL remain available for shared/operator connections.

#### Scenario: Discovery and DCR run in the daemon on click

- **WHEN** a user clicks the wall button for a server with no cached client registration
- **THEN** the daemon runs discovery and DCR, caches the shared client, writes the pending record, and issues the authorize URL — with no operator CLI involvement

### Requirement: Durable callback-to-task correlation

The pending authorization record and the task metadata SHALL both persist a durable correlation for each wall request — at minimum a unique `auth_request_id`, the `task_id`, the `server_name`, and the acting `slack_user_id` — so the public callback can resolve the exact parked `(task, server)` request from `state` alone. Resolution SHALL NOT rely on `slack_user_id` alone (which is ambiguous across concurrent tasks) nor on in-memory state (which does not survive a daemon restart). Completion SHALL be idempotent: a replayed or duplicate callback for an already-consumed request SHALL be a no-op.

#### Scenario: Concurrent requests for the same user and server are disambiguated

- **WHEN** two tasks each have an outstanding wall request for the same user and server, and one callback arrives
- **THEN** the system resolves the specific `(task, server)` request via its `auth_request_id`/`task_id` and binds and wakes only that task

#### Scenario: Callback resolves after a daemon restart

- **WHEN** the daemon restarts between the button click and the callback
- **THEN** the callback resolves the parked request from the persisted pending record and task metadata, loads the task from persistence, and completes the binding and wake

#### Scenario: Duplicate callback is a no-op

- **WHEN** a callback is delivered twice for the same `state` (e.g. provider retry or tab reload)
- **THEN** the second delivery does not write a second token, does not rebind, and does not re-wake the task

### Requirement: Park and wake around authorization

The system SHALL park the requesting agent's work while authorization is pending and, upon successful callback completion, record the acting-user binding and reactivate the task so the agent resumes with the newly available token injected. Reactivation SHALL load the task from persistence so it is unaffected by any restart between click and callback.

#### Scenario: Agent resumes after authorization completes

- **WHEN** the OAuth callback completes successfully for a parked `(task, server)` request
- **THEN** the system writes the user's token, records the `(task, server)` acting-user binding, clears the outstanding request, and reactivates the task so the agent is re-spawned with the token injected

#### Scenario: Task remains parked on abandoned authorization

- **WHEN** the user never completes the authorization and the pending record expires
- **THEN** the parked work is not resumed with credentials, the outstanding request is cleared, and the agent may request authorization again

### Requirement: Per-user token refresh and expiry re-wall

The system SHALL refresh a per-user token when it is near expiry using that user's refresh token, isolated per user. When refresh fails for a bound acting user's token, the system SHALL treat that `(task, server)` as unauthorized and eligible for a fresh wall, and SHALL NOT fall back to a shared operator token for that bound pair (per the binding policy boundary), rather than failing the whole task or affecting other users.

#### Scenario: Expired token refreshed transparently

- **WHEN** an acting user's token is within the refresh leeway of expiry at spawn time and a valid refresh token exists
- **THEN** the system refreshes it, writes back the updated record, and injects the fresh token

#### Scenario: Failed refresh re-walls the bound pair without shared fallback

- **WHEN** refresh fails for a bound acting user's token and a shared operator token also exists for that server
- **THEN** the system treats that `(task, server)` as unauthorized so the agent can request re-authorization, does NOT inject the shared token, and does not drop other servers or other users' bindings

### Requirement: Per-user revocation and self-service disconnect

The system SHALL support removing a specific user's stored token for a server without affecting other users or the shared client registration.

#### Scenario: Revoking one user leaves others intact

- **WHEN** user U's token for a server is revoked
- **THEN** the system deletes `oauth/users/U/<server>.json` and leaves the shared client and other users' token records intact
