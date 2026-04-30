# Secrets vault and OAuth-based MCP authentication

This document describes how Archie stores credentials for OAuth-based MCP
servers (Notion, Linear, Atlassian, etc.) and how those credentials reach
agents at spawn time. Static API keys (`MCP_*` env vars substituted into
`plugins/.mcp.json`) are unchanged and are documented in
[`plugin-system.md`](./plugin-system.md).

## Goals

The vault and connect flow are deliberately **provider-agnostic**:

- `.mcp.json` stays exactly as the MCP server's docs describe — server
  name + transport + URL, no Archie-specific syntax.
- The codebase contains zero per-service configuration. Connecting a new
  OAuth server is `npm run oauth:connect <name>` and nothing else.
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
    ├── notion.json             # vault record (one per MCP server)
    ├── linear.json
    └── .pending/               # short-lived in-flight authorize attempts
        └── <state>.json
```

The `secrets/oauth/` subtree is git-ignored.

### Encryption

All sensitive fields are sealed with AES-256-GCM. The master key comes
from `ARCHIE_SECRETS_KEY` (32 random bytes, base64-encoded). Append one
straight to `.env` so the value never lands on stdout or in shell
history (prefix the line with a space when `HIST_IGNORE_SPACE` is on):

```sh
 echo "ARCHIE_SECRETS_KEY=$(openssl rand -base64 32 | tr -d '\n')" >> .env
```

The startup check fails fast if any vault record is on disk and the key is
missing or the wrong length.

### Vault record (`oauth/<server-name>.json`)

```jsonc
{
  "server_name": "notion",
  "label": "production",        // optional, set via --label on connect
  "expires_at": 1730000000,     // unix seconds; refresh leeway = 60s
  "created_at": 1729000000,
  "updated_at": 1730000000,
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
  "refresh_token": "...",
  "client_id": "...",
  "client_secret": "...",       // present when DCR returned a confidential client
  "token_type": "Bearer"
}
```

Client credentials live in the encrypted blob — they're per-server secrets
created by DCR, not deploy-time config.

## Connect flow

```
operator               daemon (running)              OAuth provider
   │                         │                              │
   │ npm run oauth:connect   │                              │
   │ ────────────────────►   │ (CLI runs in same process)   │
   │                         │  discovery + DCR             │
   │                         │  write pending file          │
   │ ◄── authorize URL ───   │                              │
   │                         │                              │
   │ open URL in browser ─────────────────────────────────► │
   │                         │                              │
   │                         │ ◄── GET /oauth/callback ──── │
   │                         │  exchange code, write vault, │
   │                         │  delete pending              │
   │                         │                              │
   │ poll FS for completion  │                              │
   │ ◄── success ────────────│                              │
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
   (encrypted with the master key, mode `0o600`).
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

A periodic reaper inside the same process deletes pending files older
than the TTL.

### Required env vars

| Variable             | Required                  | Purpose                                                            |
|----------------------|---------------------------|--------------------------------------------------------------------|
| `ARCHIE_SECRETS_KEY` | Yes (when OAuth is used)  | 32-byte base64 master key for the vault.                           |
| `ARCHIE_PUBLIC_URL`  | Yes (for `oauth:connect`) | Public HTTPS URL of the daemon — used as the `redirect_uri` base.  |
| `ARCHIE_SECRETS_DIR` | No                        | Override storage location. Defaults to `/app/secrets`.             |

## Spawn-time injection

`src/system/oauth/inject.ts` is called once per agent spawn, just before
the SDK options are built (`src/agents/spawn.ts`).

For each `mcpServers` entry whose transport is `http` or `sse`:

- If a vault record exists for the server name, run `ensureFreshToken()`
  (refreshes when within 60s of expiry, atomic write-back, per-key mutex
  so concurrent spawns share one round-trip), then set
  `headers.Authorization = "Bearer <token>"`.
- If the operator already supplied an `Authorization` header in
  `.mcp.json`, leave it alone — explicit operator intent wins.
- If the refresh fails, drop that one entry from the SDK options and
  log an error. Other MCP servers spawn normally.
- stdio MCP entries are untouched — they keep their existing
  `${MCP_*}` env-var substitution path.

## Reconnect / revoke

Reconnect: just run `npm run oauth:connect <name>` again. The new vault
record overwrites the old one atomically.

Revoke: `npm run oauth:revoke <name>` deletes the local record. (It does
not call any provider revocation endpoint — operators wanting that should
revoke at the provider's admin console.)

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

- Per-user OAuth (every Slack participant authenticates separately).
- Slack-triggered re-auth flows.
- Background refresh / keep-warm schedulers.
- Provider revocation endpoint calls.
- Audit logs.
