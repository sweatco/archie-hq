## Why

Archie's OAuth-for-MCP subsystem authenticates every agent with a single operator-provisioned token per server, shared across all Slack users. This forces an operator to run `npm run oauth:connect` for each service, and — more importantly — it means agents act with one shared identity and see everything that service account can see, regardless of who asked. Tying MCP credentials to the specific Slack user who authorized them lets an agent act with that person's own permissions (least privilege / permission fidelity) and removes the operator from the loop. `docs/architecture/secrets.md` already lists "per-user OAuth" and "Slack-triggered re-auth flows" as explicitly out of scope today; this change promotes both into a real capability.

## What Changes

- **Lazy, tool-triggered authorization wall.** Agents gain an in-process `request_mcp_auth("<server>")` tool (modeled on `request_edit_mode`). When an agent needs an http/sse MCP server that requires auth and no usable token exists, it calls the tool; the Task parks the work and posts an interactive "Authorize" wall message to the thread. Nothing is provisioned ahead of time.
- **Acting user = whoever clicks the wall button.** The Slack button click identifies the authorizing user via `body.user.id` (the same mechanism the edit-mode approver uses). That user becomes the acting identity, bound per `(task, server)` in task metadata. Archie never guesses whose token to use.
- **Per-user token storage.** Access/refresh tokens are stored encrypted per user at `oauth/users/<slackUserId>/<server>.json`; the DCR client registration becomes shared-per-server at `oauth/_clients/<server>.json` (registered once, reused by all users).
- **Daemon-side discovery + DCR.** Discovery/DCR/PKCE, currently run in the CLI, is triggered in the daemon by the button click. The URL is delivered ephemerally to the clicking user only, never posted in-channel.
- **Coexists with the shared model, with the binding as the policy boundary.** A cold, unbound server uses a shared operator token if one exists (no upfront wall); if that shared token hits a runtime access-denied (401/403/insufficient scope), the agent escalates via `request_mcp_auth`. Once `(task, server)` is bound to an acting user it is user-scoped: a missing/revoked/refresh-failed per-user token **re-walls** and never silently falls back to shared. Existing shared connections keep working unchanged for cold, sufficient cases.
- **Auto-bind on reuse.** If the acting user already has a stored token for the server, Archie binds it and skips the wall entirely. The wall is a first-time / expiry / revocation event, not a per-task tax.
- **General, provider-agnostic.** Applies to any http/sse MCP that requires auth, detected via the existing 401 / `WWW-Authenticate` protected-resource probe. No per-service configuration.
- **Per-user lifecycle.** Per-user revoke / self-service disconnect and expiry-driven re-wall (offboarding purge is noted as future work).

## Capabilities

### New Capabilities

- `per-user-mcp-oauth`: Slack-initiated, per-user OAuth authorization for MCP servers — the authorization wall and its trigger tool, acting-user binding and resolution, per-user token storage and injection precedence, daemon-side connect, and the per-user token lifecycle.

### Modified Capabilities

<!-- No existing spec captures the OAuth subsystem (only memory-layer exists), so there are no spec-level requirement changes to an existing capability. -->

## Impact

- **New code:** `request_mcp_auth` in-process tool (plus escalate-on-access-denied from a shared-token server); the "Authorize" Slack button action handler; daemon-side `beginConnect` trigger; per-user token storage layout and injection resolution; acting-user binding and outstanding-request tracking in `TaskMetadata`; durable callback↔task correlation; needs-auth classification/cache per server.
- **Modified code:** `src/system/oauth/storage.ts` (per-user + shared-client layout), `src/system/oauth/inject.ts` (acting-user resolution + binding-boundary precedence), `src/system/oauth/connect.ts` (invocable in-daemon), `src/connectors/oauth/routes.ts` (correlation tuple in the pending → callback → vault chain; idempotent, restart-survivable completion), `src/agents/spawn.ts` (inject acting user's token; prompt-inject requestable servers), `src/connectors/slack/events.ts` (wall button handler), `src/agents/tools.ts` (new tool), `src/tasks/task.ts` (park/wake + binding + request tracking), `src/types/task.ts` (binding + requests fields), `src/types/*` for OAuth records.
- **Docs:** `docs/architecture/secrets.md` (move the two items out of "Out of scope"; document the per-user flow).
- **Reused unchanged:** vault sealing (`secrets-vault.ts`), discovery/DCR/PKCE (`discovery.ts`/`dcr.ts`/`flow.ts`), `/oauth/callback` route, refresh logic, edit-mode park/wake + interactive-button infrastructure.
- **Backward compatibility:** operator CLI connect and existing shared per-server records continue to work; no breaking changes.
- **Security surface:** the authorize URL is a bearer capability bound to a Slack identity — delivered ephemerally to the clicking user only, single-use `state`, short TTL.
