# Secrets vault and OAuth-based MCP authentication

This document describes how Archie stores credentials for OAuth-based MCP
servers (Notion, Linear, Atlassian, etc.) and how those credentials reach
agents at spawn time. Static API keys (`MCP_*` env vars substituted into
`plugins/.mcp.json`) are unchanged and are documented in
[`plugin-system.md`](./plugin-system.md).

There are two credential models, and they coexist:

- **Shared (operator) connections** — one token per server, provisioned by
  an operator via `npm run oauth:connect`. Used by tasks outside 1:1 DMs.
- **Per-user connections** — one token per (Slack user, server), available
  only in 1:1 Slack DMs. The DM participant authorizes through a link sent
  to that DM, and the task proceeds with their permissions. See
  [Per-user, Slack-initiated OAuth](#per-user-slack-initiated-oauth).

## Goals

The vault and connect flow are deliberately **provider-agnostic**:

- `.mcp.json` stays exactly as the MCP server's docs describe — server
  name + transport + URL, no Archie-specific syntax. The per-user-vs-shared
  distinction comes from whether the task's default channel is a 1:1 DM.
- The codebase contains zero per-service configuration. Connecting a new
  OAuth server is `npm run oauth:connect <name>` (shared) or one link from a
  Slack DM (per-user) — nothing else.
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
`client_secret`. Written once by the first per-user authorization and reused
by every later user. An existing shared record's client is reused when
available; otherwise the daemon uses DCR. If `ARCHIE_PUBLIC_URL` ever changes,
delete the client record — providers pin the registered redirect URI.

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
| `ARCHIE_PUBLIC_URL`  | Yes (for OAuth connects) | Public HTTPS URL of the daemon — used as the `redirect_uri` base.  |
| `ARCHIE_SECRETS_DIR` | No                        | Override storage location. Defaults to `/app/secrets`.             |

## Per-user, Slack-initiated OAuth

Per-user OAuth is deliberately limited to tasks whose default channel is a
1:1 Slack DM. The DM channel supplies the user identity directly; channel
threads, multi-party conversations, GitHub tasks, and CLI tasks never use
per-user credentials. Shared credentials remain the default everywhere,
including DMs.

### DM flow

```
DM spawn → inject shared oauth/<server>.json when usable
  │ missing, or an MCP call returns an auth/permission error
  ▼
agent calls request_mcp_auth("server")
  │ mark this server as personal for the task
  │ reuse users/<dm-user>/<server>.json when usable; otherwise send OAuth URL
  │ task restarts immediately or parks until authorization completes
  ▼
OAuth callback → store user token → delete pending record → wake task
  │
  ▼
next spawn injects the DM user's token for that server
```

The pending record persists only `state`, `task_id`, and `slack_user_id` for
the callback. Task metadata stores only the names of servers explicitly
escalated to personal credentials; there are no acting-user bindings or
outstanding authorization requests there. The authorization state is
single-use and expires after one hour. Agents never see tokens; the daemon
sends the URL to the existing DM and injects tokens at spawn.

## Spawn-time injection

`src/system/oauth/inject.ts` is called once per agent spawn, just before
the SDK options are built (`src/agents/spawn.ts`). For each `http` or `sse`
entry:

- A DM task uses the shared operator token by default. If no shared token is
  available, an existing personal token is used or the server is requestable.
- After `request_mcp_auth` explicitly escalates a server, that task uses only
  the DM participant's token for it. Missing, revoked, or unrefreshable
  personal tokens make the server requestable; the task does not silently
  return to shared access.
- Every other task uses the shared operator token; `request_mcp_auth` rejects
  calls outside a 1:1 DM.
- Tokens refresh within 60 seconds of expiry. Per-user refreshes are isolated
  by `(user, server)` and use the shared client registration.
- If the operator already supplied an `Authorization` (or lowercase
  `authorization`) header in `.mcp.json`, the entry is left alone —
  explicit operator intent wins.
- Non-http/sse MCP entries (stdio, in-process SDK servers like
  `createBaseAgentMcpServer`) are untouched — stdio entries keep their
  existing `${MCP_*}` env-var substitution path.

## Reconnect / revoke

Reconnect (shared): run `npm run oauth:connect <name>` again. Per-user
reconnects happen when a DM task next calls `request_mcp_auth`.

Revoke: `npm run oauth:revoke <name>` deletes the shared record;
`npm run oauth:revoke <name> --user <slackUserId>` deletes exactly one
user's token, leaving other users and the shared client intact. That user's
DM tasks already escalated to personal access request authorization again on
the next need and do not fall back to the shared token. (Neither form calls a provider revocation
endpoint — operators wanting that should revoke at the provider's admin
console.) `npm run oauth:list` shows both shared and per-user records.

## Failure modes worth knowing

- **No DCR support.** Some servers (older / enterprise) don't expose
  `registration_endpoint`. Connect once with the CLI using `--client-id` /
  `--client-secret`; the first DM authorization copies that shared client into
  `_clients/`.
- **Server isn't spec-compliant.** No 401 with `WWW-Authenticate`, or
  metadata missing required endpoints — the CLI errors out and points
  at the offending URL.
- **Inactivity timeouts** (Atlassian, MS, ~90 days). Without a keep-warm
  scheduler, the next spawn after a long idle period will hit a refresh
  failure and that one MCP gets dropped. Reconnect with the CLI to fix.
- **Missing `ARCHIE_PUBLIC_URL`.** Shared and DM connect flows fail fast — the
  daemon must be reachable at a stable HTTPS URL because the OAuth
  provider redirects browsers there.

## Out of scope (today)

- Background refresh / keep-warm schedulers.
- Provider revocation endpoint calls.
- Audit logs.
- Automatic offboarding purge of a departed user's tokens (the per-user
  revoke primitive exists; wiring it to an offboarding signal does not).
- Per-user OAuth in channel threads or multi-party conversations.
- Per-message / per-tool-call identity switching.
