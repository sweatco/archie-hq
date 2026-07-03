## 1. Storage layout: per-user tokens + shared client

- [ ] 1.1 Add per-user path helpers to `src/system/oauth/storage.ts`: `userVaultPathFor(slackUserId, server)` → `oauth/users/<uid>/<server>.json` and `clientPathFor(server)` → `oauth/_clients/<server>.json`, with `slackUserId` validated by a safe-segment pattern (reuse the server-name guard style)
- [ ] 1.2 Add read/write/delete/has for per-user token records and shared client records (atomic, `0o600`), plus `listUserServers(slackUserId)` and `listServerUsers(server)`
- [ ] 1.3 Split the sealed shape: token record holds `access_token`/`refresh_token`/`token_type`; shared client record holds `client_id`/`client_secret`. Add the new record/meta types to `src/system/oauth/types.ts`
- [ ] 1.4 Extend `OAuthPendingMeta` with `slack_user_id` (carried from click → callback → user vault)
- [ ] 1.5 Ensure `validateMasterKey()` startup check also fires when any `oauth/users/**` or `oauth/_clients/**` record exists
- [ ] 1.6 Unit tests for the new storage helpers (round-trip seal/unseal, path safety, per-user isolation)

## 2. Daemon-side connect (discovery + DCR on demand)

- [ ] 2.1 Refactor `beginConnect` in `src/system/oauth/connect.ts` so its discovery→resource-metadata→auth-server-metadata→PKCE/state pipeline is callable in-process (not CLI-only)
- [ ] 2.2 On first authorization of a server, run DCR and persist the shared client to `oauth/_clients/<server>.json`; on subsequent authorizations reuse the cached client
- [ ] 2.3 Write the pending record with `slack_user_id` set; keep the existing TTL + reaper
- [ ] 2.4 Add a `serverRequiresAuth(server)` probe helper (reuse `probeResourceMetadataUrl`) with a short-lived in-memory cache for the needs-auth classification
- [ ] 2.5 Preserve the operator CLI connect path (shared record) unchanged

## 3. Callback: bind token to the Slack user

- [ ] 3.1 In `src/connectors/oauth/routes.ts`, read `slack_user_id` from the pending record and write the exchanged tokens to `oauth/users/<uid>/<server>.json`
- [ ] 3.2 Reject missing/expired/reused `state` (extend existing checks) and surface a clear result page
- [ ] 3.3 On success, invoke a hook that records the `(task, server)` binding and reactivates the parked task (see 5.x)
- [ ] 3.4 Keep the per-`state` `withKeyMutex` serialization

## 4. Injection: acting-user resolution + precedence

- [ ] 4.1 Rework `applyOAuthBindings` in `src/system/oauth/inject.ts` to accept the resolved acting-user binding and choose credentials by precedence: per-user token → shared operator token → unauthorized
- [ ] 4.2 Move `ensureFreshToken` to a per-user keyed record (mutex key `oauth:<uid>:<server>`); on refresh failure, mark that `(uid, server)` unusable instead of only dropping the server globally
- [ ] 4.3 Return, alongside `injected`/`dropped`, the set of `requestable` servers (referenced, require auth, no usable credential) for prompt injection
- [ ] 4.4 Update `src/agents/spawn.ts:532` call site to pass the task's acting-user bindings and consume the `requestable` set
- [ ] 4.5 Update `inject.test.ts` for precedence, per-user refresh isolation, and requestable computation

## 5. Acting-user binding + park/wake on the task

- [ ] 5.1 Add `mcpAuthBindings: Record<serverName, slackUserId>` to `TaskMetadata` (`src/types/task.ts`) with persistence
- [ ] 5.2 Add acting-user resolution: use an existing binding; else if the task has a single human who already holds a stored token, auto-bind and skip the wall (D6)
- [ ] 5.3 Add `Task` methods to park a pending auth request and to complete it (write binding, reactivate) — model on `handleEditModeApproval`/reactivation
- [ ] 5.4 Wire the callback-success hook (3.3) to the completion method, resolving the parked `(task, server)` request

## 6. Wall trigger tool + Slack interaction

- [ ] 6.1 Add the in-process `request_mcp_auth("<server>")` tool in `src/agents/tools.ts`, callable by any agent; it parks the agent's work and asks the `Task` to post the wall (agent needs no Slack tools)
- [ ] 6.2 Add `Task.postMcpAuthWall(server)` building an interactive Block Kit message with an "Authorize <server>" button (action id e.g. `authorize_mcp`), reusing `postInteractiveToUser`
- [ ] 6.3 Add the Bolt action handler in `src/connectors/slack/events.ts`: read `body.user.id`, resolve/auto-bind or (no token) run daemon-side connect for that user and reply with the authorize URL **ephemerally / via DM only**
- [ ] 6.4 Serialize concurrent clicks per `(task, server)` with `withKeyMutex`; apply the chosen tie-break (see Open Questions)
- [ ] 6.5 At spawn, inject a prompt line listing requestable servers (from 4.3) so agents know what they can request

## 7. Lifecycle: refresh, revoke, disconnect

- [ ] 7.1 Per-user revoke primitive (delete `oauth/users/<uid>/<server>.json`) leaving shared client + other users intact; expose via CLI (`oauth:revoke <server> --user <uid>`)
- [ ] 7.2 Expiry re-wall: a failed refresh for an acting user makes `(task, server)` requestable again without affecting others (verify via 4.2)
- [ ] 7.3 (Optional, per Open Questions) self-service disconnect surface and a post-connect confirmation DM

## 8. Docs + verification

- [ ] 8.1 Update `docs/architecture/secrets.md`: move "per-user OAuth" and "Slack-triggered re-auth" out of "Out of scope"; document storage layout, precedence, the wall flow, and security notes
- [ ] 8.2 `npm run typecheck` and the OAuth + task test suites pass
- [ ] 8.3 End-to-end check against a real OAuth MCP: wall appears on `request_mcp_auth`, button click yields an ephemeral URL, callback binds the token, agent resumes with per-user creds; returning user auto-binds with no wall
