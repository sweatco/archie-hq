# OAuth + Encrypted Secrets Vault for Agent MCPs (MVP)

## Context

Today, every secret used by an MCP comes from `process.env` and is substituted into `plugins/.mcp.json` once at boot (`src/system/plugin-loader.ts:46`). That works for static API keys but cannot support OAuth: tokens expire, refresh tokens must be persisted somewhere safe, and re-auth must not happen mid-conversation in a user-facing channel.

We confirmed via the official Claude Agent SDK / MCP-connector docs that **the SDK does not perform the OAuth flow itself** — Anthropic's guidance is explicit: *"API consumers are expected to handle the OAuth flow and obtain the access token prior to making the API call, as well as refreshing the token as needed."* Token storage and refresh are unavoidably ours.

But — and this is the key design choice — OAuth for MCP **is fully standardized**. The MCP authorization spec ties together OAuth 2.1, RFC 8414 (authorization-server metadata discovery), RFC 9728 (protected-resource metadata), and RFC 7591 (Dynamic Client Registration). A correctly-implemented MCP server advertises everything a client needs to authenticate without per-server hard-coded knowledge. So our implementation must be **provider-agnostic**: no hard-coded list of "supported services," no per-service config files in the codebase. We don't know which MCPs will be used. Whatever we ship has to work for any spec-compliant server.

We want Archie to connect to OAuth-based SaaS MCPs (Notion, Monday, GitHub, Atlassian, etc.) using **its own service identity**, not any individual employee's. We need:

1. Encrypted-at-rest storage that survives deploys.
2. An out-of-band CLI-only flow for connecting/reconnecting any MCP server — no Slack-visible "Authorize Archie" link, eliminating the risk of an employee accidentally logging in with their personal account.
3. Token refresh at agent-spawn time, on demand. No background scheduler.
4. The existing `.mcp.json` remains the canonical and **fully-standard** place to declare MCP servers — no Archie-specific syntax, no embedded credentials, no template variables.

Per-user OAuth, Slack-web reconnect, background refresh schedulers, and any per-provider registry are explicitly out of scope.

## Scope

**In scope (MVP):**
- Encrypted file vault at `ARCHIE_SECRETS_DIR` with master key in `ARCHIE_SECRETS_KEY`.
- Per-MCP-server token records (keyed by the server name authors use in `.mcp.json`).
- Generic CLI command `oauth:connect <server-name>` that uses the MCP standard discovery flow against the URL declared in `.mcp.json`.
- Spawn-time injection of `Authorization: Bearer <token>` for any HTTP/SSE MCP server that has tokens in the vault.
- On-demand refresh just before injection.
- Slack alert (one-shot per spawn, rate-limited per server) when refresh fails.

**Out of scope (defer):**
- Per-provider hard-coded knowledge of any kind.
- OAuth for stdio MCPs (no standard exists; stdio keeps its existing `${MCP_*}` env-var path).
- Background keep-warm/refresh scheduler.
- Per-user, per-task, or per-agent OAuth scoping.
- Multi-account-per-server support.
- Slack-triggered or web UI reconnect flow.
- Token rotation policies, audit logs, role-based access.

## Architecture

The guiding principle: **`.mcp.json` is fully standard. Authentication is standard. The codebase contains zero per-service configuration.**

`.mcp.json` is written exactly as the MCP server's docs describe — server name + transport + URL. Nothing else:
```jsonc
{
  "mcpServers": {
    "notion": { "type": "http", "url": "https://mcp.notion.com/mcp" },
    "linear": { "type": "http", "url": "https://mcp.linear.app/mcp" }
  }
}
```

Authentication is decided per-server by **whether a token exists in the vault under that server name**. If yes → inject Bearer header at spawn. If no → pass through untouched.

### Storage location

We reuse the existing `/app/secrets` volume (host `./secrets`, declared in `docker-compose.yml:65` and pre-created by `Dockerfile.prod:48`, `Dockerfile.dev:46`). OAuth records live at `${SECRETS_DIR}/oauth/<server-name>.json`, where `SECRETS_DIR` defaults to `/app/secrets` in the container (and `<repo>/secrets` for local dev), overridable via `ARCHIE_SECRETS_DIR`.

**Required deploy change:** the volume mount in `docker-compose.yml:65` is currently `./secrets:/app/secrets:ro`. OAuth tokens are written at runtime, so this must become `./secrets:/app/secrets` (read-write). Existing deploy-time secrets like `github-private-key.pem` continue to live in the same volume; they're just no longer protected by RO at the mount level. Acceptable tradeoff — the directory is `0o700` and the token writer is the same process that reads the existing secrets, so RO didn't add real protection against the threat model anyway.

### The OAuth flow — server-hosted callback, CLI-driven

Two processes coordinate: the **running Archie daemon** (which already runs Express on `PORT`) and the **CLI** (run via SSH on the same host). They share the filesystem under `SECRETS_DIR`, so coordination doesn't need an HTTP control plane — the CLI does the OAuth heavy-lifting itself, hands off only the callback step to the daemon.

Only **one** OAuth route is added to the Express app, and it's the public one because that's the only thing the daemon strictly has to host:

- `GET /oauth/callback` — **public**. Provider redirects here. Reads `state` from the query, looks up the matching pending-attempt file under `${SECRETS_DIR}/oauth/.pending/<state>.json`, exchanges the code for tokens at the token endpoint recorded in that file, writes the final encrypted vault record at `${SECRETS_DIR}/oauth/<server-name>.json`, deletes the pending file, renders a "you can close this tab" page.

The `ARCHIE_PUBLIC_URL` env var (new) tells everything what to use as `redirect_uri` (e.g. `https://archie.example.com/oauth/callback`). The CLI reads it to build the authorize URL; the daemon reads it to validate that received state was issued for this deployment.

End-to-end:

1. Operator SSHs to the host and runs `npm run oauth:connect notion`.
2. CLI reads `.mcp.json`, finds `notion`'s URL, probes for `WWW-Authenticate`, fetches RFC 9728 protected-resource metadata, fetches RFC 8414 authorization-server metadata, attempts RFC 7591 Dynamic Client Registration (or uses `--client-id`/`--client-secret` if provided).
3. CLI generates `state` + PKCE verifier/challenge, writes a pending-attempt file `${SECRETS_DIR}/oauth/.pending/<state>.json` (encrypted with the master key, `0o600`) containing `{ server_name, token_endpoint, scopes, client_id, client_secret, code_verifier, label, created_at }`.
4. CLI builds the authorize URL with `redirect_uri=${ARCHIE_PUBLIC_URL}/oauth/callback&state=<state>` and prints it.
5. **Operator copies the URL into their local browser.** No localhost on the server is involved — only an HTTPS URL to the public Archie server.
6. Operator authorizes. Provider redirects browser to `${ARCHIE_PUBLIC_URL}/oauth/callback?code=...&state=...`.
7. Daemon's callback handler reads + decrypts the matching pending file, exchanges the code at `token_endpoint`, writes the final vault record, deletes the pending file, renders success page.
8. CLI was polling for the existence of `${SECRETS_DIR}/oauth/<server-name>.json` (or for the pending file to disappear); on success it prints OK and exits. On timeout (e.g. 10 min) or if the pending file lingers with an error sentinel, it prints the error and exits non-zero.

A small reaper inside the daemon (or simply on next startup) deletes pending files older than 1 hour — they're stale auth attempts.

If the server doesn't expose DCR, the CLI fails before writing any pending file with a clear instruction to rerun with `--client-id` / `--client-secret`.

### Refresh

`ensureFreshToken(serverName)` reads the vault record (which already contains the token endpoint and client credentials from the original connect), refreshes if `expires_at - now < 60s`, atomically writes the rotated record back, returns the live token. Standard OAuth 2.1 refresh — no provider-specific logic.

### Spawn-time injection

After the existing merge of plugin-loaded MCPs and built-in MCPs in `src/agents/spawn.ts` (around line 541), call `applyOAuthBindings(mcpServers)`:

- For each entry whose `type` is `http` or `sse`, check if `${SECRETS_DIR}/oauth/<server-name>.json` exists.
- If yes: `ensureFreshToken(name)`, then write `headers.Authorization = "Bearer <token>"` (preserving any other existing headers).
- If refresh fails: delete that one entry from the map, `logger.error(...)`, post one rate-limited Slack ops alert.
- If no record: leave the entry as-is.

stdio entries are skipped — they keep their existing `${MCP_*}` env-var path.

### New modules

- `src/system/secrets-vault.ts` — generic encrypted KV. AES-256-GCM via Node `crypto`. API: `readSecret(key)`, `writeSecret(key, record)`, `listSecrets(prefix?)`, `deleteSecret(key)`. Atomic write (tmpfile + rename). In-process per-key mutex map.
- `src/system/oauth/discovery.ts` — RFC 9728 / RFC 8414 metadata fetchers. Pure standard, no per-server knowledge.
- `src/system/oauth/dcr.ts` — RFC 7591 dynamic client registration.
- `src/system/oauth/flow.ts` — PKCE authorize URL building, code-for-token exchange, refresh. All generic OAuth 2.1.
- `src/system/oauth/inject.ts` — `applyOAuthBindings(mcpServers)` for use in spawn.
- `src/system/oauth/cli.ts` — CLI subcommands. Subcommands: `connect <server-name>`, `list`, `revoke <server-name>`, `refresh <server-name>` (manual force-refresh for debugging). All talk to the running daemon over loopback HTTP.
- `src/connectors/oauth/routes.ts` — Express router for the single public `GET /oauth/callback`. Mounted in `src/index.ts` next to the API routes.

### Modified modules

- `src/system/workdir.ts` — add `SECRETS_DIR = process.env.ARCHIE_SECRETS_DIR || '/app/secrets'` (with a dev fallback to `<repo>/secrets` when the default path doesn't exist). `bootstrapWorkdir()` (line 52) ensures `${SECRETS_DIR}/oauth` exists at `0o700`. Validate `ARCHIE_SECRETS_KEY` (32-byte base64) at startup; fail fast if missing.
- `src/system/plugin-loader.ts:41-64` — **no change**. The vault path is keyed off server name, not on substitution markers in `.mcp.json`. The CLI's start handler reuses `loadMcpJson` to look up the URL for a given server name.
- `src/agents/spawn.ts` — call `applyOAuthBindings(mcpServers)` once just before line 541.
- `src/index.ts` — mount `/oauth` router next to API routes, after Slack/GitHub webhook setup.
- `docker-compose.yml:65` — change `./secrets:/app/secrets:ro` → `./secrets:/app/secrets`.
- `package.json:13` — scripts: `oauth:connect`, `oauth:list`, `oauth:revoke`, `oauth:refresh`.
- `.env.example` — `ARCHIE_SECRETS_KEY` (required, 32-byte base64), `ARCHIE_SECRETS_DIR` (optional), `ARCHIE_PUBLIC_URL` (required when using OAuth — used to build redirect URI), `SLACK_OPS_CHANNEL` (optional, for refresh-failure alerts).

### Vault record shape

Path: `${SECRETS_DIR}/oauth/<server-name>.json` (mode 0o600). One file per MCP server.

```jsonc
{
  "server_name": "notion",
  "label": "production",          // optional, free-form, set via --label on `oauth:connect`
  "expires_at": 1730000000,
  "created_at": 1729000000,
  "updated_at": 1730000000,
  "token_endpoint": "https://api.notion.com/v1/oauth/token",
  "scopes": ["..."],
  "ciphertext": "<base64>",
  "iv": "<base64>",
  "tag": "<base64>"
}
```

Plaintext fields stay unencrypted so `oauth:list` and refresh logic work without surprises. The earlier `account_label` field is dropped — there's no generic, provider-agnostic way to populate it (some providers expose user identity in the token response, most don't). If an operator wants a human-readable annotation, `--label "..."` on `oauth:connect` lets them attach a free-form string. Plain optional, default empty.

Encrypted blob:
```jsonc
{
  "access_token": "...",
  "refresh_token": "...",
  "client_id": "...",
  "client_secret": "...",     // present when DCR returned a confidential client
  "token_type": "Bearer"
}
```

Client credentials live in the encrypted blob because they're per-server secrets created by DCR — they don't belong in env vars or in the codebase.

## Implementation Steps

1. **Vault module + tests** — `src/system/secrets-vault.ts`. Pure encrypted KV. Atomic writes. Per-key mutex. Unit tests: round-trip, missing-key error, tamper detection, write atomicity.
2. **Workdir wiring** — extend `src/system/workdir.ts` with `SECRETS_DIR` (default `/app/secrets`, dev fallback to `<repo>/secrets`). Ensure `${SECRETS_DIR}/oauth` exists at `0o700` in `bootstrapWorkdir()`. Validate `ARCHIE_SECRETS_KEY` decodes to 32 bytes; fail fast if missing.
3. **Discovery + DCR + flow primitives** — `src/system/oauth/discovery.ts`, `dcr.ts`, `flow.ts`. All standard RFCs, all generic. Unit tests with mocked HTTP for happy path and common failure modes (no DCR support, metadata 404, token endpoint 401, refresh 400).
4. **Callback route** — `src/connectors/oauth/routes.ts` exposing `GET /oauth/callback`. Reads pending file by `state`, exchanges code, writes vault record, renders success/error page. Mount in `src/index.ts` near existing API routes. Validate `ARCHIE_PUBLIC_URL` at startup if vault records exist.
5. **CLI** — `src/system/oauth/cli.ts`. `connect <server-name> [--label X] [--client-id X --client-secret X]` runs discovery + DCR, writes the pending file, prints the authorize URL, polls the filesystem for completion, reports success/error. `list`, `revoke`, `refresh` subcommands. Wire scripts in `package.json`.
6. **Spawn-time injection** — `src/system/oauth/inject.ts` exporting `applyOAuthBindings`. Call from `src/agents/spawn.ts` just before line 541. Drop unresolvable MCPs, log error, post rate-limited Slack alert via `postSlackMessage`.
7. **Deploy change** — flip `docker-compose.yml:65` mount from `:ro` to RW. Confirm `./secrets/oauth` is git-ignored (the runtime files must not be committed).
8. **Documentation** — `docs/architecture/secrets.md` covers vault format, key management caveats, the `/oauth/*` route contract, public-URL requirement, and the manual-DCR-fallback. `docs/guides/local-development.md` gets a section on generating an `ARCHIE_SECRETS_KEY` and running OAuth flows against dev (e.g. via ngrok pointing at the dev `PORT`).

## Critical files

- `src/system/secrets-vault.ts` *(new)*
- `src/system/oauth/discovery.ts` *(new)*
- `src/system/oauth/dcr.ts` *(new)*
- `src/system/oauth/flow.ts` *(new)*
- `src/system/oauth/inject.ts` *(new)*
- `src/system/oauth/cli.ts` *(new)*
- `src/connectors/oauth/routes.ts` *(new — single `GET /oauth/callback` route)*
- `src/system/workdir.ts:27-56` *(extend with `SECRETS_DIR`)*
- `src/system/plugin-loader.ts:41-64` *(unchanged)*
- `src/agents/spawn.ts:498-546` *(call `applyOAuthBindings` before line 541)*
- `src/index.ts` *(mount `/oauth` router near existing API/webhook routes)*
- `docker-compose.yml:65` *(flip `:ro` → RW)*
- `package.json:13` *(scripts)*
- `.env.example` *(new vars)*
- `.gitignore` *(ensure `secrets/oauth/` is ignored)*

## Reused utilities

- `logger` from `src/system/logger.ts` — match `logger.system(...)` / `logger.error(prefix, msg, err)` style seen in `src/system/reminder-scheduler.ts:38,44`.
- `postSlackMessage` from `src/connectors/slack/client.ts` for ops alerts.
- `WORKDIR` constant pattern in `src/system/workdir.ts:27-39` (extend with `SECRETS_DIR`).
- Node built-in `crypto` (AES-256-GCM) and `fetch` — no new runtime deps.
- The `.mcp.json` parsing already in `src/system/plugin-loader.ts` — the CLI reuses it to look up server URLs.

## Tradeoffs / open issues to flag during implementation

- **Servers without DCR support.** Some providers (often older / enterprise) don't expose the registration endpoint. The CLI handles this with `--client-id` / `--client-secret` flags so the operator can paste in manually-registered creds. No per-server code changes needed.
- **Servers without proper metadata advertising.** If the server doesn't return a 401 with `WWW-Authenticate`, the CLI fails with a clear error explaining the server isn't spec-compliant. We don't paper over this.
- **Inactivity timeouts** (Atlassian/MS, ~90 days) without a keep-warm scheduler will cause the next spawn after a long quiet period to fail and post an alert. Acceptable for MVP; revisit if it bites.

## Verification

1. **Vault round-trip (unit):** `npm test` — write/read a record, tamper a byte → expect decryption failure.
2. **Startup safety:** `npm run dev` with `ARCHIE_SECRETS_KEY` unset → clear error. With a valid 32-byte key → normal startup, `${SECRETS_DIR}/oauth` at `0o700`.
3. **Callback rejects unknown state:** Hit `/oauth/callback?state=garbage&code=anything` → renders an error page; no vault record written.
4. **OAuth connect flow against a real server (Notion test workspace):** SSH to host, run `npm run oauth:connect notion`. Verify (a) CLI prints an `authorize_url` pointing at the provider, (b) a pending file exists at `secrets/oauth/.pending/<state>.json` with `0o600` and is encrypted, (c) opening the URL in a local browser and approving redirects to `${ARCHIE_PUBLIC_URL}/oauth/callback`, (d) the callback handler renders the "you can close this tab" page, (e) the pending file is gone and `secrets/oauth/notion.json` exists at `0o600`, (f) CLI prints success and exits, (g) `npm run oauth:list` shows the entry.
5. **Manual-DCR fallback:** Repeat against a server that doesn't expose DCR; CLI fails with a clear message; rerun with `--client-id`/`--client-secret` succeeds.
6. **Spawn-time injection:** With Notion connected and `.mcp.json` containing `{ "notion": { type: "http", url: "..." } }` (URL only, no headers), spawn an agent. Unit test asserts `applyOAuthBindings` wrote a Bearer header. End-to-end: agent successfully calls a Notion tool.
7. **Refresh on near-expiry:** Manually edit `expires_at` to `now + 30s`. Spawn an agent. Assert refresh fired and the new `expires_at` advanced.
8. **Refresh failure degrades cleanly:** Corrupt the encrypted refresh token. Spawn an agent → that one MCP is missing from the SDK options, error logged, Slack alert posted (or dry-run path exercised).
9. **Concurrent refresh:** Two parallel `ensureFreshToken('notion')` calls on an expired token → exactly one HTTP refresh, both callers get the same fresh token (mutex test).
10. **Persistence across restart:** Restart container, `oauth:list` still shows the entry, agent spawn still authenticates. Confirms volume RW change took effect.
11. **Server with no vault record passes through:** `.mcp.json` lists `"some-other-mcp"` with no vault entry → `applyOAuthBindings` doesn't touch it, SDK gets the entry verbatim.
12. **Type + lint:** `npm run typecheck` and `npm run lint` pass.
