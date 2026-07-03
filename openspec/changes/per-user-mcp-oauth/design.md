## Context

Archie has a complete OAuth-for-MCP subsystem (`src/system/oauth/`, `docs/architecture/secrets.md`): RFC-compliant discovery (RFC 9728/8414), Dynamic Client Registration (RFC 7591), OAuth 2.1 + PKCE via `oauth4webapi`, an AES-256-GCM vault (`secrets-vault.ts`), a public `GET /oauth/callback`, and spawn-time header injection (`inject.ts`, wired at `spawn.ts:532`). Today it is single-tenant: one operator runs `npm run oauth:connect <server>`, producing one vault record per server (`oauth/<server>.json`) that every agent and every Slack user shares.

Two constraints shape this design:

- **One identity per spawn.** `applyOAuthBindings` bakes a single `Authorization` header per server into the SDK subprocess before it starts. An agent cannot swap identities mid-turn, so the acting identity must be resolved *before* spawn — it is a task-level property, not a per-tool-call one.
- **An existing park/wake precedent.** Edit mode already does exactly the shape we need: an agent calls `request_edit_mode` → the Task posts interactive Slack buttons → a human clicks → `handleEditModeApproval(approver)` captures `body.user.id` (`events.ts:221`, `:258`) → the approver is recorded and the task reactivates. The OAuth wall is the same flow with a URL in place of an approve/deny verdict.

## Goals / Non-Goals

**Goals:**

- Let an agent act with the MCP permissions of the specific Slack user who authorized the server (permission fidelity / least privilege).
- Remove the operator from the loop for per-user servers: authorization is initiated lazily, in-Slack, by the user.
- Keep the mechanism provider-agnostic — any http/sse server that requires auth, no per-service code.
- Preserve the existing shared/operator model with no breaking changes.

**Non-Goals:**

- Per-message / per-tool-call identity switching (precluded by one-identity-per-spawn).
- Multi-user attribution policy within a single task beyond "whoever clicks the wall button binds that server."
- Automatic offboarding purge of a departed user's tokens (noted as future work; per-user revoke primitive is in scope).
- Provider-side token revocation calls (unchanged from today — local delete only).
- Background keep-warm / refresh schedulers.

## Decisions

### D1: Acting user is captured from the wall button click, not inferred

The wall message is an interactive Block Kit message with an "Authorize" button, modeled on the edit-mode approval buttons. The click gives us `body.user.id` — Slack has already authenticated that person. This is what makes "the acting user is whoever answers the wall" implementable: we never guess from task authorship or message order, and the binding is unambiguous.

*Alternative considered — post a shared URL to the channel:* rejected. The callback only sees `state`, not who clicked a link, so a channel-posted URL can't identify the authorizing user; and a shared URL is a leakable bearer capability. The button click both identifies the user and gates URL delivery.

### D2: Trigger is an explicit `request_mcp_auth` tool (lazy), not a real-401 interceptor

Agents get an in-process tool `request_mcp_auth("<server>")`, callable by any agent (like `request_edit_mode`); the Task posts the wall on the agent's behalf so specialists need no Slack tools. Unauthorized-but-requestable servers are surfaced to the agent via a spawn-time prompt line ("servers you can request access to: …") computed from frontmatter `mcpServers` minus already-usable ones.

*Alternative considered — keep the unauthorized server in the SDK map and let a real 401 tool-error surface:* rejected as the primary path. It leaks provider-specific error semantics into agent reasoning and relies on the LLM interpreting a 401 correctly. The tool has the same proven reliability profile as `request_edit_mode`. (Unauthorized servers are still *dropped* from the live SDK map as today; the agent learns about them from the prompt, not from broken tools.)

### D3: Storage splits client (shared) from token (per-user)

```
oauth/
  _clients/<server>.json          # DCR client_id/secret — registered once, shared
  users/<slackUserId>/<server>.json# per-user access + refresh token
  <server>.json                    # legacy shared operator record (unchanged)
  .pending/<state>.json            # in-flight; now carries auth_request_id + task_id + slack_user_id (D5a)
```

One DCR client per server, N per-user authorization-code flows against it — the textbook multi-tenant OAuth shape. Per-user subtree gives a clean per-user revoke (`rm oauth/users/U/<server>.json`) and a future offboarding purge (`rm -rf oauth/users/U`). The legacy flat `oauth/<server>.json` record is untouched and read as the shared fallback.

*Alternative considered — keep client+token bundled per user:* rejected; it re-runs DCR per user for no benefit and couples client lifecycle to token lifecycle.

### D4: Injection precedence — binding locks out fallback; shared is a cold-start default that escalates on access-denied

At spawn, for each http/sse server the agent references:

```
resolve acting user for (task, server):
  bound on task?           -> use binding
  else task has one human
       with a stored token? -> auto-bind (D6), use it
  else                      -> unbound

pick credential:
  IF (task, server) is BOUND to an acting user:          # user-scoped — no shared fallback
    per-user token fresh/refreshable  -> inject
    else                              -> re-wall (drop server, mark requestable)
  ELSE (unbound, cold):
    shared operator token exists      -> inject shared    # cold-start default (coexistence)
    else                              -> drop server, mark requestable
```

Two rules make this both backward-compatible and non-regressive:

1. **The binding is the policy boundary.** Once `(task, server)` is bound to an acting user, that pair is *user-scoped*: a missing, revoked, or refresh-failed per-user token **re-walls** and never silently falls back to the shared operator token. This closes the least-privilege downgrade and removes the earlier contradiction between "fall back to shared" and "failed refresh re-walls."
2. **Escalate-on-access-denied.** A cold server with a shared token is used optimistically (no upfront wall). If a shared-token call returns an authorization/permission failure (401/403/insufficient scope) at runtime, the agent escalates by calling `request_mcp_auth` (D2) — posting the wall and binding the acting user's own credentials. So shared is the convenient default *until it is insufficient*, at which point the flow upgrades to permission fidelity.

Existing shared connections keep working unchanged for cold, sufficient cases; per-user takes over whenever shared is absent, bound, or denied.

*Alternative considered — always fall back to shared when no per-user token is usable:* rejected. It lets a revoked/expired per-user token silently regain broad shared access and hides the credential failure (flagged by adversarial review). The binding boundary preserves coexistence without that regression.

### D5: Discovery + DCR move daemon-side, triggered by the click

`beginConnect`'s logic (probe → resource metadata → auth-server metadata → DCR → PKCE/state → write pending) runs in the daemon on button click instead of in the CLI. The shared client is cached at `oauth/_clients/<server>.json`, so DCR runs only on the first-ever authorization of a server. The CLI connect path stays for operator/shared connections.

### D5a: Durable callback↔task correlation (the pending record links back to the exact parked request)

The public `/oauth/callback` is a cold HTTP request that arrives with only `state`. The token binding is per-`(task, server)`, so the callback must resolve *which* parked request it completes — `slack_user_id` alone is insufficient (two tasks can authorize the same user+server concurrently, and a daemon restart between click and callback loses any in-memory park state). Flagged by adversarial review.

The pending record therefore carries a durable correlation tuple, written at button-click time and mirrored into task metadata:

```jsonc
// oauth/.pending/<state>.json  (plaintext meta, extended)
{
  "state": "...",
  "auth_request_id": "...",   // unique per wall request
  "task_id": "...",           // the parked task
  "server_name": "...",
  "slack_user_id": "...",     // the clicking user (D1)
  "agent_id": "...",          // who requested (for wake targeting)
  "channel_key": "...",       // where the wall was posted
  // ...existing issuer/token_endpoint/scopes/resource/redirect_uri/created_at
}
```

On successful exchange the callback: (1) takes the per-`(task, server)` lock (extend the existing `withKeyMutex(pending:${state})` pattern to also key on the task/server), (2) verifies the pending request still matches an outstanding parked request in the task's metadata, (3) writes the token to `oauth/users/<slackUserId>/<server>.json`, (4) records the binding, (5) reactivates the task by loading it from persistence (`Task.get()`), so a daemon restart is survivable. Completion is **idempotent** — a duplicate/replayed callback (provider retry, tab reload) that finds the request already consumed is a no-op, not a second bind/wake.

### D6: Auto-bind on reuse — the wall is a first-time/expiry event

Tokens persist per user across tasks. When an agent needs a server and an acting user can be resolved who already holds a usable token, the system binds it and skips the wall. In practice: a DM-rooted task (one human) with a returning user never sees a wall; a channel task with no prior binding gets one wall per new server, then remembers.

### D7: Acting-user binding and pending requests live in `TaskMetadata`

A `mcpAuthBindings: Record<serverName, slackUserId>` map on the task holds completed bindings — written on callback completion, read at spawn — mirroring how `approvedBy` (edit-mode approver) is a task-level human-identity fact that drives later behavior. Alongside it, an `mcpAuthRequests: Record<authRequestId, { server, agent_id, channel_key, state, created_at }>` map tracks *outstanding* parked requests so the callback (D5a) can verify and resolve the exact request, and so an un-completed request is recoverable after a restart. A completed or expired request is removed from `mcpAuthRequests`.

## Risks / Trade-offs

- **Leaked authorize URL binds an attacker's provider account to a Slack user's slot** → Deliver the URL ephemerally to the clicking user only (never in-channel); single-use `state`; short TTL (reuse existing 1h pending TTL, consider tightening); optionally post a "you just connected X — revoke if this wasn't you" confirmation DM.
- **Agent fails to call `request_mcp_auth` when it should** (LLM reliability) → Same risk class as `request_edit_mode`, which works in production; mitigated by the explicit spawn-time prompt line listing requestable servers.
- **Group-thread ambiguity — the "wrong" person clicks** → Accepted by design: whoever clicks binds. The binding is per `(task, server)` and revocable; the acting identity is always a real, authenticated human, never a guess.
- **Parked work stalls if nobody authorizes** → Task simply remains parked (mirrors an un-approved edit-mode request); the agent can re-request. No credentials are ever fabricated.
- **Token refresh failure for a bound user** → Isolated *and* non-downgrading: that `(task, server)` re-walls (D4 rule 1) rather than falling back to the shared token; other servers, other users, and the rest of the task are unaffected (contrast with today's "drop the server" for everyone).
- **Silent downgrade to shared access on revocation** (adversarial-review finding) → Closed by the D4 binding boundary: once a pair is user-scoped, shared fallback is disabled for it.
- **Callback bound to the wrong / a stranded task** (adversarial-review finding) → Closed by D5a: durable `auth_request_id` + `task_id` in the pending record, verified under lock, idempotent, restart-survivable via `Task.get()`.
- **Two participants click near-simultaneously** → Serialize per `(task, server)` with the existing `withKeyMutex` pattern; first binding wins, later clicks no-op or rebind explicitly. Decide the exact tie-break in implementation.
- **`.mcp.json` must stay vanilla** (the subsystem's stated ethos) → The per-user-vs-shared distinction is inferred at runtime (token presence + probe + runtime access-denied), not declared in `.mcp.json`; no Archie-specific keys added there.

## Migration Plan

- **Backward compatible, additive.** Existing `oauth/<server>.json` shared records keep working via the D4 fallback; the operator CLI is untouched. No data migration required.
- **Rollout:** ship storage + injection-precedence changes first (inert until per-user tokens exist), then the `request_mcp_auth` tool + wall handler + daemon-side connect. Gate the wall behind a flag if a staged rollout is wanted.
- **Rollback:** with no per-user tokens written and the tool disabled, behavior is identical to today (shared-only). Deleting `oauth/users/` and `oauth/_clients/` reverts to the pre-change state.

## Open Questions

- Exact TTL for the per-user authorize pending — keep 1h or tighten given ephemeral delivery?
- Tie-break when two participants click the same wall near-simultaneously (first-wins vs. last-wins vs. reject-second).
- Should a confirmation DM ("connected X") be in scope now or deferred?
- Self-service disconnect surface: a PM tool, a slash-style DM command, or CLI-only for v1?
- **Access-denied detection for escalate-on-access-denied (D4 rule 2):** the agent recognizing a 401/403/insufficient-scope tool error and choosing to call `request_mcp_auth` is the tool-based (LLM-driven) path, consistent with the trigger decision. Do we also need a deterministic backstop (e.g. surfacing a normalized "authorization required — call request_mcp_auth" hint when a shared-token MCP call returns an auth error) so escalation doesn't depend solely on the model interpreting a raw provider error?
