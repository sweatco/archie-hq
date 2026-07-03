## 1. Storage layout: per-user tokens + shared client

- [x] 1.1 Add per-user path helpers to `src/system/oauth/storage.ts`: `userVaultPathFor(slackUserId, server)` → `oauth/users/<uid>/<server>.json` and `clientPathFor(server)` → `oauth/_clients/<server>.json`, with `slackUserId` validated by a safe-segment pattern (reuse the server-name guard style)
- [x] 1.2 Add read/write/delete/has for per-user token records and shared client records (atomic, `0o600`), plus `listUserServers(slackUserId)` and `listServerUsers(server)`
- [x] 1.3 Split the sealed shape: token record holds `access_token`/`refresh_token`/`token_type`; shared client record holds `client_id`/`client_secret`. Add the new record/meta types to `src/system/oauth/types.ts`
- [x] 1.4 Extend `OAuthPendingMeta` with the durable correlation tuple — `auth_request_id`, `task_id`, `server_name`, `slack_user_id`, `agent_id`, `channel_key` — carried from click → callback → user vault (D5a)
- [x] 1.5 Ensure `validateMasterKey()` startup check also fires when any `oauth/users/**` or `oauth/_clients/**` record exists
- [x] 1.6 Unit tests for the new storage helpers (round-trip seal/unseal, path safety, per-user isolation)

## 2. Daemon-side connect (discovery + DCR on demand)

- [x] 2.1 Refactor `beginConnect` in `src/system/oauth/connect.ts` so its discovery→resource-metadata→auth-server-metadata→PKCE/state pipeline is callable in-process (not CLI-only)
- [x] 2.2 On first authorization of a server, run DCR and persist the shared client to `oauth/_clients/<server>.json`; on subsequent authorizations reuse the cached client
- [x] 2.3 Write the pending record with the full correlation tuple (1.4) and register the outstanding request in task metadata (5.1a); keep the existing TTL + reaper
- [x] 2.4 Add a `serverRequiresAuth(server)` probe helper (reuse `probeResourceMetadataUrl`) with a short-lived in-memory cache for the needs-auth classification
- [x] 2.5 Preserve the operator CLI connect path (shared record) unchanged

## 3. Callback: resolve the exact parked request and bind

- [x] 3.1 In `src/connectors/oauth/routes.ts`, read the correlation tuple from the pending record and write the exchanged tokens to `oauth/users/<uid>/<server>.json`
- [x] 3.2 Resolve the exact parked request by `auth_request_id`/`task_id` (not `slack_user_id` alone); load the task from persistence (`Task.get()`) so completion survives a daemon restart between click and callback
- [x] 3.3 Reject missing/expired/reused `state` (extend existing checks) and surface a clear result page
- [x] 3.4 On success, invoke a hook that records the `(task, server)` binding, clears the outstanding request, and reactivates the parked task (see 5.x); make completion **idempotent** — a replayed callback for a consumed request is a no-op
- [x] 3.5 Extend the per-`state` `withKeyMutex` to also serialize on `(task, server)` so concurrent/duplicate callbacks can't double-bind or double-wake

## 4. Injection: acting-user resolution + precedence

- [x] 4.1 Rework `applyOAuthBindings` in `src/system/oauth/inject.ts` to branch on whether `(task, server)` is bound: **bound** → per-user token only, else requestable (NO shared fallback); **unbound/cold** → shared operator token if present, else requestable
- [x] 4.2 Move `ensureFreshToken` to a per-user keyed record (mutex key `oauth:<uid>:<server>`); on refresh failure of a bound pair, mark that `(task, server)` requestable (re-wall) and do NOT fall back to the shared token
- [x] 4.3 Return, alongside `injected`/`dropped`, the set of `requestable` servers (referenced, require auth, no usable credential) for prompt injection
- [x] 4.4 Update `src/agents/spawn.ts:532` call site to pass the task's acting-user bindings and consume the `requestable` set
- [x] 4.5 Update `inject.test.ts` for precedence, per-user refresh isolation, and requestable computation

## 5. Acting-user binding + park/wake on the task

- [x] 5.1 Add `mcpAuthBindings: Record<serverName, slackUserId>` to `TaskMetadata` (`src/types/task.ts`) with persistence
- [x] 5.1a Add `mcpAuthRequests: Record<authRequestId, { server, agent_id, channel_key, state, created_at }>` to `TaskMetadata` to track outstanding parked requests; entries are removed on completion or expiry
- [x] 5.2 Add acting-user resolution: use an existing binding; else if the task has a single human who already holds a stored token, auto-bind and skip the wall (D6)
- [x] 5.3 Add `Task` methods to park a pending auth request (register in `mcpAuthRequests`) and to complete it (write binding, clear request, reactivate) — model on `handleEditModeApproval`/reactivation; completion is idempotent
- [x] 5.4 Wire the callback-success hook (3.4) to the completion method, resolving the parked `(task, server)` request by `auth_request_id`

## 6. Wall trigger tool + Slack interaction

- [x] 6.1 Add the in-process `request_mcp_auth("<server>")` tool in `src/agents/tools.ts`, callable by any agent; it parks the agent's work and asks the `Task` to post the wall (agent needs no Slack tools)
- [x] 6.2 Add `Task.postMcpAuthWall(server)` building an interactive Block Kit message with an "Authorize <server>" button (action id e.g. `authorize_mcp`), reusing `postInteractiveToUser`
- [x] 6.3 Add the Bolt action handler in `src/connectors/slack/events.ts`: read `body.user.id`, resolve/auto-bind or (no token) run daemon-side connect for that user and reply with the authorize URL **ephemerally / via DM only**
- [x] 6.4 Serialize concurrent clicks per `(task, server)` with `withKeyMutex`; apply the chosen tie-break (see Open Questions)
- [x] 6.5 At spawn, inject a prompt line listing requestable servers (from 4.3) so agents know what they can request
- [x] 6.6 Escalate-on-access-denied: instruct agents that a cold shared-token server returning 401/403/insufficient-scope should be escalated via `request_mcp_auth`; evaluate the open-question backstop (normalize the MCP auth error into an explicit "authorization required — call request_mcp_auth" hint) so escalation doesn't depend solely on the model reading a raw provider error

## 7. Lifecycle: refresh, revoke, disconnect

- [x] 7.1 Per-user revoke primitive (delete `oauth/users/<uid>/<server>.json`) leaving shared client + other users intact; expose via CLI (`oauth:revoke <server> --user <uid>`)
- [x] 7.2 Expiry re-wall: a failed refresh for a bound acting user makes `(task, server)` requestable again with no shared fallback and without affecting others (verify via 4.2)
- [ ] 7.3 (Optional, per Open Questions) self-service disconnect surface and a post-connect confirmation DM

## 8. Docs + verification

- [x] 8.1 Update `docs/architecture/secrets.md`: move "per-user OAuth" and "Slack-triggered re-auth" out of "Out of scope"; document storage layout, precedence, the wall flow, and security notes
- [x] 8.2 `npm run typecheck` and the OAuth + task test suites pass
- [ ] 8.3 End-to-end check against a real OAuth MCP: wall appears on `request_mcp_auth`, button click yields an ephemeral URL, callback binds the token, agent resumes with per-user creds; returning user auto-binds with no wall
- [x] 8.4 Correctness checks for the review findings: (a) two concurrent tasks authorizing the same user+server bind independently; (b) a callback delivered twice is a no-op; (c) a revoked/expired per-user token on a bound pair re-walls and does NOT silently use the shared token
