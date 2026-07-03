# Secrets vault and OAuth-based MCP authentication

This document describes how Archie stores credentials for OAuth-based MCP
servers (Notion, Linear, Atlassian, etc.) and how those credentials reach
agents at spawn time. Static API keys (`MCP_*` env vars substituted into
`plugins/.mcp.json`) are unchanged and are documented in
[`plugin-system.md`](./plugin-system.md).

There are two credential models, and they coexist:

- **Shared (operator) connections** — one token per server, provisioned by
  an operator via `npm run oauth:connect`. Every agent and every Slack user
  shares it.
- **Per-user connections** — one token per (Slack user, server), created
  lazily from Slack itself: an agent hits an authorization wall, a user
  clicks the wall's button, authorizes with their own account, and the task
  proceeds with *that person's* permissions. See
  [Per-user, Slack-initiated OAuth](#per-user-slack-initiated-oauth).

## Goals

The vault and connect flow are deliberately **provider-agnostic**:

- `.mcp.json` stays exactly as the MCP server's docs describe — server
  name + transport + URL, no Archie-specific syntax. The per-user-vs-shared
  distinction is inferred at runtime (record presence + the spec probe),
  never declared in `.mcp.json`.
- The codebase contains zero per-service configuration. Connecting a new
  OAuth server is `npm run oauth:connect <name>` (shared) or one button
  click in Slack (per-user) — nothing else.
- Discovery follows the MCP authorization spec: RFC 9728 protected-resource
  metadata + RFC 8414 authorization-server metadata + RFC 7591 Dynamic
  Client Registration + OAuth 2.1 / PKCE. We use
  [`oauth4webapi`](https://github.com/panva/oauth4webapi) for the
  protocol-level work; everything else (vault, storage, inject, CLI) is
  custom.

## Storage layout

All persistent secrets live under `SECRETS_DIR`, which defaults to
`/app/secrets` (the docker-mounted volume) when present and
`<repo>/secrets` for local development. Override with `ARCHIE_SECRETS_DIR`.

```
${SECRETS_DIR}/
├── github-private-key.pem      # deploy-time, hand-placed
└── oauth/                      # mode 0o700
    ├── notion.json             # legacy shared vault record (one per MCP server)
    ├── linear.json
    ├── _clients/               # shared DCR client registrations (per-user flow)
    │   └── notion.json         #   client_id/client_secret — registered once, all users
    ├── users/                  # per-user token records
    │   ├── U012ABC/
    │   │   └── notion.json     #   U012ABC's own Notion tokens
    │   └── U045XYZ/
    │       ├── notion.json
    │       └── linear.json
    └── .pending/               # short-lived in-flight authorize attempts
        └── <state>.json
```

The `secrets/oauth/` subtree is git-ignored.

The client/token split is the textbook multi-tenant OAuth shape: one DCR
client per server (`_clients/<server>.json`), N per-user authorization-code
flows against it. Deleting `users/<uid>/<server>.json` revokes exactly one
user; deleting `users/<uid>/` offboards them entirely — the shared client
and everyone else's tokens are untouched. Legacy shared records keep their
client credentials bundled inside their own envelope, unchanged.

### Encryption

All sensitive fields are sealed with AES-256-GCM. The master key comes
from `ARCHIE_SECRETS_KEY` (32 random bytes, base64-encoded). Append one
straight to `.env` so the value never lands on stdout or in shell
history (prefix the line with a space when `HIST_IGNORE_SPACE` is on):

```sh
 echo "ARCHIE_SECRETS_KEY=$(openssl rand -base64 32 | tr -d '\n')" >> .env
```

The startup check (`src/index.ts`) calls `validateMasterKey()` whenever
any vault record exists — legacy shared, per-user (`oauth/users/**`), or
shared client (`oauth/_clients/**`) — *or* `ARCHIE_SECRETS_KEY` is set
(`anyOAuthRecordExists()` in `storage.ts`), so a misconfigured deployment
fails fast instead of erroring at agent-spawn time.

### Vault record (`oauth/<server-name>.json`)

```jsonc
{
  "server_name": "notion",
  "label": "production",        // optional, set via --label on connect
  "expires_at": 1730000000,     // unix seconds; refresh leeway = 60s
  "created_at": 1729000000,
  "updated_at": 1730000000,
  "issuer": "https://api.notion.com",
  "token_endpoint": "https://api.notion.com/v1/oauth/token",
  "scopes": ["..."],
  "envelope": {
    "ciphertext": "...", "iv": "...", "tag": "..."
  }
}
```

Plaintext fields stay unencrypted so `oauth:list` and the spawn-time
expiry check don't need the key just to peek.

The encrypted blob:

```jsonc
{
  "access_token": "...",
  "refresh_token": "...",       // optional — some providers don't issue one
  "client_id": "...",
  "client_secret": "...",       // present when DCR returned a confidential client
  "token_type": "Bearer"        // verbatim from token endpoint
}
```

Client credentials live in the encrypted blob — they're per-server secrets
created by DCR, not deploy-time config.

### Per-user token record (`oauth/users/<uid>/<server>.json`)

Same plaintext meta as the shared record plus `slack_user_id`. The sealed
blob holds only `access_token` / `refresh_token` / `token_type` — client
credentials live in the shared client record instead:

### Shared client record (`oauth/_clients/<server>.json`)

Plaintext `server_name` / `issuer` / timestamps; sealed `client_id` /
`client_secret`. Written once by the first per-user authorization of a
server (mutexed, so concurrent first clicks share one DCR round-trip) and
reused by every later user. If `ARCHIE_PUBLIC_URL` ever changes, delete the
client record — providers pin the registered redirect URI.

## Connect flow

```
operator        CLI (oauth:connect)      daemon (running)      OAuth provider
   │                   │                       │                     │
   │ npm run connect   │                       │                     │
   │ ────────────────► │  discovery + DCR      │                     │
   │                   │  write pending file   │                     │
   │ ◄── authorize URL │                       │                     │
   │                                                                 │
   │ open URL in browser ──────────────────────────────────────────► │
   │                                           │                     │
   │                                           │ ◄── GET /callback ──│
   │                                           │  exchange code,     │
   │                                           │  write vault,       │
   │                                           │  delete pending     │
   │                   │                       │                     │
   │ ◄─ poll FS until ─│                       │                     │
   │    vault appears  │                       │                     │
```

Two processes coordinate via the shared `SECRETS_DIR` filesystem. They do
**not** talk over HTTP; the only OAuth-related HTTP route is
`GET /oauth/callback`, which is the publicly-reachable URL the provider
redirects to.

### CLI side (the connect command)

`src/cli/oauth.ts` → `beginConnect()` in `src/system/oauth/connect.ts`:

1. Read `<plugins>/.mcp.json`, find the server, extract its URL.
2. Probe the URL — expect a 401 with `WWW-Authenticate: Bearer
   resource_metadata="<url>"`.
3. Fetch RFC 9728 protected-resource metadata.
4. Fetch RFC 8414 authorization-server metadata (with the OIDC
   `.well-known/openid-configuration` fallback some issuers still use).
5. If `--client-id` was passed, use it; otherwise call the
   `registration_endpoint` for Dynamic Client Registration.
6. Generate state + PKCE, write `${SECRETS_DIR}/oauth/.pending/<state>.json`
   (mode `0o600`; plaintext meta — `state`, `server_name`, `issuer`,
   `token_endpoint`, `authorization_endpoint`, `scopes`, `redirect_uri`,
   `created_at` — alongside an envelope sealing the PKCE verifier and
   client credentials).
7. Print the authorize URL.
8. Poll for completion: when the pending file is gone and a vault record
   exists for the server, success. If `error` shows up on the pending
   file, surface it.

### Daemon side (the callback handler)

`src/connectors/oauth/routes.ts` mounts `GET /oauth/callback` on the
existing Express app. On request:

1. Look up the pending file by `state`.
2. Verify the attempt isn't expired (TTL: 1 hour).
3. POST to `token_endpoint` with `grant_type=authorization_code`,
   the code, the PKCE verifier, and the (possibly DCR-issued) client
   credentials.
4. Write the encrypted vault record, atomically.
5. Delete the pending file.
6. Render a small success page so the operator can close the tab.

A periodic reaper inside the same process (15-min interval, plus a
sweep at startup) deletes pending files older than the TTL.

### Required env vars

| Variable             | Required                  | Purpose                                                            |
|----------------------|---------------------------|--------------------------------------------------------------------|
| `ARCHIE_SECRETS_KEY` | Yes (when OAuth is used)  | 32-byte base64 master key for the vault.                           |
| `ARCHIE_PUBLIC_URL`  | Yes (for `oauth:connect`) | Public HTTPS URL of the daemon — used as the `redirect_uri` base.  |
| `ARCHIE_SECRETS_DIR` | No                        | Override storage location. Defaults to `/app/secrets`.             |

## Per-user, Slack-initiated OAuth

Per-user OAuth ties MCP credentials to the specific human who authorized
them, so an agent acts with *that person's* provider permissions instead of
a broad service account. Nothing is provisioned ahead of time — the flow is
lazy and starts inside a task.

### The acting user and the binding boundary

The **acting user** for a `(task, server)` pair is *whoever clicks the
authorization wall's button* — Slack authenticates the clicker
(`body.user.id`), so identity is never inferred from task authorship or
message order. The completed binding is persisted on the task
(`TaskMetadata.mcp_auth_bindings`, server → Slack user id).

The binding is the **policy boundary** for credential resolution:

```
resolve (task, server) at spawn:
  BOUND to a user       → that user's token only; if it is missing, revoked,
                          or fails refresh → re-wall. NEVER the shared token.
  UNBOUND, single human
    with a stored token → auto-bind it, skip the wall (returning users
                          never re-authorize)
  UNBOUND + shared record → inject the shared operator token (cold default)
  UNBOUND + nothing     → spec-probe the URL; OAuth-requiring servers are
                          held out of the SDK map and advertised to the
                          agent as requestable
```

The bound-pair rule closes the silent-downgrade hole: once a task runs as a
user, losing that user's token re-walls rather than quietly regaining broad
shared access. A cold server with a shared token is used optimistically; if
a call then fails with 401/403/insufficient-scope, the agent escalates via
`request_mcp_auth` — shared is the convenient default *until it is
insufficient*.

### The wall flow

```
agent needs "notion", no usable credential
  │ request_mcp_auth("notion")            in-process tool (agent-tools server,
  ▼                                        every agent has it)
Task parks (deferTeardown → task.stop()), records the request in
metadata.mcp_auth_requests[authRequestId], posts the wall:
  "🔐 notion access needed — <reason>   [ Authorize notion ]"
  │
  │ a user clicks (Bolt action `authorize_mcp`) — Slack gives body.user.id
  ▼
daemon: external/guest users rejected; then per (task, server) mutex:
  clicker already has a stored usable token → complete immediately, no browser
  else beginUserConnect(): discovery → shared client (read-or-DCR) → PKCE
       → pending record {state, auth_request_id, task_id, slack_user_id, …}
       → authorize URL delivered EPHEMERALLY to the clicker only
  │
  │ user authorizes at the provider
  ▼
GET /oauth/callback?state=…: exchange code → write users/<uid>/<server>.json
  → delete pending → resolve the exact parked request by auth_request_id
  (Task.get() loads from disk — restart-survivable), bind, edit the wall to
  "✅ connected — authorized by @user", wake the task
  │
  ▼
task resumes; the next spawn injects the acting user's token
```

Correlation is durable by construction: the pending record carries
`auth_request_id` + `task_id` + `slack_user_id`, so the public callback —
a cold HTTP request that only knows `state` — resolves the exact parked
request. Two concurrent tasks authorizing the same user+server can't
cross-bind, a daemon restart between click and callback loses nothing, and
completion is idempotent (a replayed callback finds the request consumed
and no-ops). Simultaneous clicks serialize on a per-`(task, server)` mutex;
the first completion wins, and a second user who finishes authorizing
anyway simply gets their own token stored for future use.

The wall message keeps its button after a click (only the ephemeral URL is
personal), so someone else can still volunteer if the clicker abandons.
Abandoned requests expire with the pending TTL (1 hour) and the agent can
simply request again.

Pieces: `request_mcp_auth` tool (`src/agents/tools.ts`), wall + click +
completion methods (`src/tasks/task.ts`), pure metadata transitions
(`src/tasks/mcp-auth.ts`), daemon connect (`beginUserConnect` in
`src/system/oauth/connect.ts`), button handler
(`src/connectors/slack/events.ts`), callback completion
(`src/connectors/oauth/routes.ts`).

### Security notes

- The authorize URL is a bearer capability tied to a Slack identity: it is
  delivered only ephemerally to the clicking user, `state` is single-use,
  and the pending attempt expires after 1 hour.
- External / guest Slack users (Slack Connect, restricted accounts) cannot
  authorize — the click handler rejects them before any connect work.
- Agents never see tokens; injection happens in the daemon at spawn time,
  same as the shared model.

## Spawn-time injection

`src/system/oauth/inject.ts` is called once per agent spawn, just before
the SDK options are built (`src/agents/spawn.ts`). The task supplies the
acting-user context (`task.getMcpAuthInjectContext()`): completed bindings
plus the auto-bind candidate — the task's single human participant, when
one is unambiguously resolvable from the knowledge log.

For each `mcpServers` entry whose transport is `http` or `sse`, resolution
follows the precedence above. Mechanics shared by both models:

- Tokens are refreshed when within 60s of expiry (`ensureFreshToken()` for
  shared records, `ensureFreshUserToken()` for per-user ones — the latter
  reads client credentials from the shared client record and mutexes per
  `oauth:user:<uid>:<server>`, so one user's dead refresh token never
  affects another's).
- `headers.Authorization = "<scheme> <token>"`; the scheme is normalized —
  `bearer` becomes `Bearer` — because some providers (Notion, etc.)
  strict-match it.
- If the operator already supplied an `Authorization` (or lowercase
  `authorization`) header in `.mcp.json`, the entry is left alone —
  explicit operator intent wins.
- Entries with no usable credential are removed from the map (the SDK
  would only spew 401s) and returned as `requestable`; spawn appends a
  prompt section telling the agent which servers it can `request_mcp_auth`.
  Agents whose servers run on shared credentials also get a hint to
  escalate on 401/403/insufficient-scope errors.
- Non-http/sse MCP entries (stdio, in-process SDK servers like
  `createBaseAgentMcpServer`) are untouched — stdio entries keep their
  existing `${MCP_*}` env-var substitution path.

## Reconnect / revoke

Reconnect (shared): just run `npm run oauth:connect <name>` again. The new
vault record overwrites the old one atomically. Per-user reconnects happen
organically — the next wall click mints a fresh authorization.

Revoke: `npm run oauth:revoke <name>` deletes the shared record;
`npm run oauth:revoke <name> --user <slackUserId>` deletes exactly one
user's token, leaving other users and the shared client intact. A bound
task whose user was revoked re-walls on its next need — it does not fall
back to the shared token. (Neither form calls a provider revocation
endpoint — operators wanting that should revoke at the provider's admin
console.) `npm run oauth:list` shows both shared and per-user records.

## Failure modes worth knowing

- **No DCR support.** Some servers (older / enterprise) don't expose
  `registration_endpoint`. The CLI fails with a clear message before
  writing any pending file, and the operator can rerun with
  `--client-id` / `--client-secret` referencing a manually-registered
  client.
- **Server isn't spec-compliant.** No 401 with `WWW-Authenticate`, or
  metadata missing required endpoints — the CLI errors out and points
  at the offending URL.
- **Inactivity timeouts** (Atlassian, MS, ~90 days). Without a keep-warm
  scheduler, the next spawn after a long idle period will hit a refresh
  failure and that one MCP gets dropped. Reconnect with the CLI to fix.
- **Missing `ARCHIE_PUBLIC_URL`.** `oauth:connect` fails fast — the
  daemon must be reachable at a stable HTTPS URL because the OAuth
  provider redirects browsers there.

## Out of scope (today)

- Background refresh / keep-warm schedulers.
- Provider revocation endpoint calls.
- Audit logs.
- Automatic offboarding purge of a departed user's tokens (the per-user
  revoke primitive exists; wiring it to an offboarding signal does not).
- Per-message / per-tool-call identity switching — the SDK bakes one
  `Authorization` header per server per spawn, so the acting identity is a
  task-level property by construction.
