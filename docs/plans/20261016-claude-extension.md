# Talk to Archie from Claude (Desktop extension and /mcp)

**Date:** 2026-10-16 · **Status: Planned (in progress).**

## Acceptance criteria

| id | criterion | method |
|---|---|---|
| AC1 | WHEN a person DMs Archie "connect claude" THEN the engine replies in that DM with a one-time code, creating no task and waking no PM; WHEN connect_archie(code) runs THEN the extension exchanges it at /mcp/connect for a credential bound to that Slack user and stores it in a local file, and no tool result ever contains the credential; a code works once and not after 10 minutes; "disconnect claude" revokes all of that person's credentials. | integration |
| AC2 | WHEN a /mcp call other than connect carries no valid credential THEN 401; WHEN it names a session the caller did not start THEN 404 and nothing is read, sent or resolved; /api is unchanged (its existing tests stay green). | integration |
| AC3 | WHEN ask_archie has no session id THEN it returns at once with a new session id; with an id THEN it sends the message to that task and returns the same id; WHEN check_archie(id) runs THEN it returns Archie's replies since the previous check, attached files as their text (UTF-8, size-capped) or a one-line note, the task state (working / done / paused), and every pending approval with its id and Archie's request text. | integration |
| AC4 | WHEN a session starts from Claude THEN its task is homed in the person's DM: memory destination = their DM, created_by = their Slack id (so trigger proposals bind to their DM with them as creator and their per-person cap), every inbound line names them, and nothing from that task is posted to Slack. | integration |
| AC5 | WHEN approve_archie runs in a client declaring MCP Apps THEN a card shows Archie's request text with Approve/Deny whose buttons call an app-only tool; a click resolves the approval with the person as approver; on load the card shows a recorded decision instead of buttons; the tool result states the current state. A client declaring elicitation but not MCP Apps gets an Approve/Deny form; neither → refused. A decided approval is never resolved twice. | manual |
| AC6 | npm run extension:pack builds a .mcpb whose manifest passes mcpb validate and takes the Archie URL as user config; docs describe Desktop and CLI install (a claude mcp add line) and say to expose only /mcp and the webhooks, never /api; docs/architecture describes the connector. | structural |

## Design

## Approach

A new engine connector, `src/connectors/claude/`, serves a credential-checked, owner-scoped `/mcp` namespace on the existing Express app. A local stdio MCP server in `extension/` (Node ≥ 20, packed as a `.mcpb` for Claude Desktop, also runnable by Claude Code CLI via `claude mcp add`) is the only client. `/api` stays as it is; the only change there is that the body of `POST /api/tasks/:id/approve` moves verbatim into an exported `resolveApproval()` in the same file so `/mcp` resolves approvals through the exact same branches. Without the new optional `via` argument it is byte-for-byte the old handler.

## Identity (engine-issued, never through the model)

- `src/connectors/claude/connections.ts` keeps `${SECRETS_DIR}/claude-connections.json` (0600 via `writeJsonAtomic`, read-modify-write under `withKeyMutex`, both from `src/system/secrets-vault.ts`): `{ codes: {sha256 → {user_id, channel_id, channel_name, created_at, expires_at}}, credentials: {sha256 → {user_id, channel_id, channel_name, created_at}} }`. Only hashes are stored, so no vault encryption. Codes are 8 chars from an unambiguous alphabet shown as `XXXX-XXXX`, single use, 10-minute TTL, persisted so a restart does not drop them. Credentials are 32 random bytes base64url. The file path is computed inside functions, never at module scope, because many existing tests mock `system/workdir.js` without `SECRETS_DIR`.
- `src/connectors/claude/dm-commands.ts` `handleClaudeCommand(event)` is called from `handleSlackEvent` (`src/connectors/slack/events.ts`) right after the external-author bail-out, before the :eyes: ack. It only acts on a DM message (`channel` starts with `D`; a thread reply counts, because the Slack assistant view threads DM messages, and the reply goes into the same thread) whose text is exactly `connect claude` / `disconnect claude` (case-insensitive, optional trailing `.`/`!`). Connect issues a code and posts it as a plain DM message; disconnect revokes every credential and code of that Slack user. It returns true so no task is created and no PM wakes. External/guest authors never reach it (they are bailed out first).
- `POST /mcp/connect {code}` redeems the code and returns `{credential, name}`. The extension writes the credential to `~/.archie/claude.json` (0600, keyed by Archie URL) and tells the model only "Connected as <name>".

## /mcp routes (`src/connectors/claude/routes.ts`, mounted in `src/index.ts` right after `mountApiRoutes`)

Every route except `/connect` requires `Authorization: Bearer <credential>` → `findConnection` → else 401. Session ids are resolved with `findTaskOnDisk` (request input never reaches a path) and the task's `metadata.created_by` must equal the connection's `user_id`, else 404 and nothing happens.

- `POST /mcp/sessions {message, session_id?}` — new: `Task.create()`, then set `created_by`, `home_channel = {connection.channel_id, connection.channel_name}`, `memory_authors = {user_id: name}`, `setMemoryDestination(channel_id)`, `linkCliChannel()`, `save(true)`, `appendCliMessage(id, message, {id, name})`, `sendMessage(inboundNewTask([line]))`, 201 `{session_id}`. Existing: owner check, `appendCliMessage` with author, `Task.get`, `linkCliChannel`, `sendMessage(inboundActivity([line]))`, 200 `{session_id}` — mirrors `/api`'s message route. Both return as soon as the message is queued (as `/api` does); the PM works in the background.
- `GET /mcp/sessions/:id?after=N` — reads the full `events.jsonl` (`readEvents`), returns `{status, replies, approvals, cursor}`: replies are `message` events with `data.to === 'user'` after index N, each `{text, files}`; a file is its UTF-8 text if ≤ 100 000 bytes, decodes strictly and has no NUL, else `{name, note}`; status maps `metadata.status` completed→done, stopped→paused, else working; approvals are the still-pending ones; cursor is `events.length`. The extension keeps the cursor per session in memory (after an extension restart the first check replays the session).
- Approval id = the index of the `approval:requested` event in the task's event list. A request is decided by the first later `approval:resolved` whose `data.approval_id` equals its id; a resolved event without `approval_id` (an operator `/api` resolution) decides the latest still-pending request of the same `approvalType`.
- `GET /mcp/sessions/:id/approvals/:aid` → `{approval_id, type, text, state: pending|approved|denied, decided_by?, decided_at?}`.
- `POST /mcp/sessions/:id/approvals/:aid {approve}` — serialized per task with `createKeyedLock` (`src/system/keyed-lock.ts`); waits for the task's queued event writes (`eventsFlushed`, new in persistence), re-reads, returns `already_decided: true` for a decided request without resolving again; otherwise calls `resolveApproval(taskId, {type, approve, github, pr_number, ref from the request event}, {approval_id, approver: {id, name, email} from getUserInfo(user_id)})`, passes a non-200 straight through, else returns the decided view.

`resolveApproval`'s `via`: the approver is the connection's person (the body's approver is ignored), a trigger approval passes the person's id to `handleTriggerApproval` instead of `'cli'`, and each `approval:resolved` it emits additionally carries `approval_id` and `approver_name`.

## Containment: the DM environment

A Claude task is set up exactly like a trigger-fired DM task (`fireTrigger`, `src/system/trigger-scheduler.ts:419-425`): `home_channel` and `memory_destination` are the person's DM, so `resolveTriggerOrigin` (`src/agents/tools.ts:2263`) resolves a DM origin (trigger proposals bind to that DM with `created_by` = the person and count against their cap; trigger visibility is DM, not operator), memory reads and extraction are private to that DM (`src/tasks/memory-scope.ts`), and `taskSlackChannelIds` covers the DM (`src/connectors/slack/channel-ids.ts:66`). Unlike a trigger-fired task its `default_channel` is the CLI channel from the first moment, so `postToUser` and `postInteractiveToUser` never reach Slack (`resolveSlackChannel` returns null for a CLI default), and the home-channel guards that only bite when `default_channel` is null (`src/agents/tools.ts:352,707,981,2084,2412`, `src/agents/spawn.ts:415`) never fire. `announceTriggerChange` already skips DM-bound triggers. The inbound log line names the person as `<@U…:Name> in claude`, the same marker the people section parses (`resolvePeopleFromTranscript`). `TaskMetadata.created_by` is new and set only here; the `home_channel` doc comment is widened to name this second writer.

## Files from Archie

`Task.logFilesUpload` adds `files: filePaths` to its `message` event so `/mcp` can return their text. The paths were already validated against the PM's sandbox by `post_files_to_user` (`assertReadable`); request input never names a file.

## Extension (`extension/`, plain ESM `.mjs` — the root `.gitignore` ignores `*.js`)

Own `package.json` + lockfile (deps as in the proven probe: `@modelcontextprotocol/sdk ^1.32.1`, `@modelcontextprotocol/ext-apps ^1.7.5`, `zod ^4.6.7`), `manifest.json` (manifest 0.3, node server `server.mjs`, `user_config.archie_url` → env `ARCHIE_URL`), `server.mjs`, `.mcpbignore`. Model-visible tools: `connect_archie`, `ask_archie`, `check_archie`, `approve_archie`. App-only (`_meta.ui.visibility: ["app"]`): `archie_approval_state`, `archie_decide`. `approve_archie` picks the UI from the client's declared capabilities: `getUiCapability(caps)` (ext-apps) → card; else `caps.elicitation` → `elicitInput` form; else refuse. Card HTML is the probe's (`applyDocumentTheme`, `applyHostStyleVariables`, inlined `app-with-deps` bundle) at `ui://archie/approval-v1.html`. Root script `extension:pack` = `npm ci --prefix extension --omit=dev && npx --yes @anthropic-ai/mcpb pack extension dist/archie.mcpb` (`dist/` is already gitignored).

## Error and recovery paths

Bad/expired/used code → 401 with a "say connect claude for a new one" message. Unknown or foreign session → 404. Archie restart: codes and credentials are on disk; the task's CLI channel and `created_by` persist in metadata; in-progress tasks resume as today. Extension restart: credential on disk, cursor resets (replay). A stale approval (e.g. trigger withdrawn) returns the engine's 409 message, which the card shows. A file that vanished → note "could not be read".

## Rejected alternatives

- Reusing `/api` over the network: it shows every chat; operator ruled it internal.
- Cloudflare Access identity: infrastructure dependency; operator ruled it out.
- In-memory codes: lost on restart and impossible to exercise live without Slack; persisted hashes cost nothing extra.
- A new approval-state store: the event log already holds requests and resolutions; tagging the resolution with `approval_id` is enough.
- Server-side cursor in metadata: an extra write per poll; replay after an extension restart is harmless.
- Ephemeral Slack message for the code: unverified delivery (`postEphemeral` swallows errors); the code is single-use and expires in 10 minutes.

## Not in this change

Slack pings of any kind from this flow, uploads from Claude, a task list tool, OAuth, claude.ai web, Slack-as-user, private-channel reads (#355), any `/api` behaviour change, any Cloudflare dependency, explicit memory preferences from Claude (`remember_preference` needs a Slack message ts and a Slack approval card).

## Small knock-ons

`secrets/claude-connections.json` is added to `.gitignore` (in local dev `SECRETS_DIR` is `<repo>/secrets`). `extension/node_modules/` is added to `.dockerignore` (the root `node_modules/` pattern does not reach it, and compose builds from the repo root). `resolveTriggerOrigin`'s doc comment says the home channel decides when the default is not Slack. Docs that say `fireTrigger` is the only writer of `home_channel` (`docs/architecture/triggers.md:117`, `docs/architecture/persistence.md:79-80`) are updated in the docs stage.

## Dependents checked

- The approve route's clients and tests (`src/cli/api.ts:87-113`, `src/cli/components/TaskDetail.tsx:358`, `tools/debug-mcp/archie-client.ts:128-153`, `tools/debug-mcp/server.ts:181-208`, `tools/e2e/tool-gate-check.ts:169-172`, `src/connectors/__tests__/merge-approval-surfaces.test.ts:120-129`, `src/connectors/__tests__/trigger-operator-surface.test.ts:111-120`) are unaffected: the route keeps its path, its router position (`use.mock.calls[0][1]`), its handler as `route.stack[0].handle`, and byte-identical responses and `approval:resolved` payloads when `via` is absent.
- `appendCliMessage`'s two existing callers (`src/connectors/api/routes.ts:163`, `src/connectors/api/routes.ts:184`) pass no author and keep the `[cli]` line; the `vi.fn()` mocks in the Slack tests (e.g. `src/connectors/slack/__tests__/trigger-dispatch.test.ts:92`) are unaffected.
- Tests that drive `handleSlackEvent` with DM or bot events (`src/connectors/slack/__tests__/trigger-dispatch.test.ts:387`, `src/connectors/slack/__tests__/subtype-sweep.test.ts:261`, `src/connectors/slack/__tests__/mpim-external-author.test.ts:111`, `src/connectors/slack/__tests__/single-render-path.test.ts:240`) never send the exact command text, so `handleClaudeCommand` returns false before touching any import their mocks omit; `connections.ts` reads `SECRETS_DIR` only inside functions for the same reason.
- `message` event consumers (`tools/debug-mcp/server.ts:171-175`, `tools/debug-mcp/wait-for-task.ts:202-203`, `src/cli/components/TaskDetail.tsx:142-146`) ignore unknown keys; `get_events` will also print the new `files` array, which is intended.
- `approval:resolved` consumers (`src/cli/components/TaskDetail.tsx:84-95`, `tools/debug-mcp/wait-for-task.ts:199-201`) read only `type`/`approve` or nothing; the extra keys appear only on `/mcp` resolutions.
- `home_channel` readers: `postToUser` (`src/tasks/task.ts:695`) opens a home thread only when `default_channel` is null, which never holds for a Claude task; `taskSlackChannelIds` (`src/connectors/slack/channel-ids.ts:66`) includes the DM, as for any DM task.
- The extension directory: `tools/e2e/boot.ts:459-462` counts untracked files for the `-dirty` sha, and `extension/node_modules` and `dist/` are gitignored, so a pack does not dirty the checkout; `.github/workflows/ci.yml:23-26` and `.github/dependabot.yml:10-11` cover only the root, so CI never installs the extension and its deps get no automated updates (found, not doing).

## Tasks

### T01 — Claude connection store (codes and credentials, hashes only)

Create `src/connectors/claude/connections.ts` exporting exactly:
- `interface ClaudeConnection { user_id: string; channel_id: string; channel_name: string; created_at: string }`
- `issueCode(c: { user_id: string; channel_id: string; channel_name: string }): Promise<string>`
- `redeemCode(code: string): Promise<{ credential: string; connection: ClaudeConnection } | null>`
- `findConnection(credential: string): Promise<ClaudeConnection | null>`
- `revokeUser(userId: string): Promise<number>`

Storage: one file, path `join(SECRETS_DIR, 'claude-connections.json')` with `SECRETS_DIR` from `src/system/workdir.ts`, computed INSIDE a function (never a module-scope constant: dozens of existing tests mock `system/workdir.js` without `SECRETS_DIR`, and a module-scope read would throw on import). Shape `{ codes: Record<string, ClaudeConnection & { expires_at: string }>, credentials: Record<string, ClaudeConnection> }`, keys are sha256 hex (`crypto.createHash('sha256')`). Read with `readJson` (null → `{ codes: {}, credentials: {} }`), write with `writeJsonAtomic` (default mode 0o600), and wrap every read-modify-write in `withKeyMutex(path, ...)` — all three from `src/system/secrets-vault.ts`. `findConnection` reads without the mutex.

Code: 8 characters, each `ALPHABET[crypto.randomInt(ALPHABET.length)]` with `ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'`; returned as `XXXX-XXXX`. Normalize for hashing (both issue and redeem): uppercase, remove every character outside `[A-Z0-9]`. `expires_at = new Date(Date.now() + 10 * 60_000).toISOString()`. `issueCode` also deletes expired code entries in the same write.

`redeemCode`: normalize + hash, inside the mutex delete the code entry if present; return null if it was absent or `expires_at <= now`; otherwise `credential = crypto.randomBytes(32).toString('base64url')`, store `credentials[sha256(credential)] = { user_id, channel_id, channel_name, created_at: now ISO }`, return `{ credential, connection }`.

`revokeUser`: delete every credential and every code whose `user_id === userId`; return how many credentials were removed.

No comments except one line above the store type: `// Only sha256 hashes of codes and credentials are kept, so nothing here needs the vault's encryption.` Use no logger here.

Tests (`src/connectors/claude/__tests__/connections.test.ts`): `vi.mock('../../../system/workdir.js', ...)` returning `SECRETS_DIR` = a `mkdtempSync` dir (see `src/tasks/__tests__/persistence.test.ts:11-16` for the hoisted tmpdir pattern). Cases: issue → format `/^[A-Z0-9]{4}-[A-Z0-9]{4}$/` → redeem returns a credential and `findConnection(credential)` returns the connection; redeeming the same code again → null; lowercase with spaces (`'abcd efgh'` form of the issued code) redeems; after `vi.setSystemTime(now + 10 min + 1 s)` (with `vi.useFakeTimers({ toFake: ['Date'] })`) redeem → null; `revokeUser` returns 1 and `findConnection` → null, and a code issued for that user can no longer be redeemed; the file's text contains neither the code nor the credential and `statSync(file).mode & 0o777 === 0o600`; `findConnection('nope')` → null.

Also add one line to the root `.gitignore`, directly after `secrets/*-credentials.json`: `secrets/claude-connections.json`.

**Files:** `src/connectors/claude/connections.ts`, `src/connectors/claude/__tests__/connections.test.ts`, `.gitignore`

**Tests:** npx vitest run src/connectors/claude/__tests__/connections.test.ts

**Must not touch:** src/system/secrets-vault.ts; src/system/oauth/; src/connectors/api/routes.ts; package.json

### T02 — Task and persistence tweaks: created_by, CLI author line, file paths on the event, eventsFlushed

1. `src/types/task.ts` `TaskMetadata`: add right after `home_channel` (line ~277):
```ts
  /** Slack user id of the person who started this task from Claude. Set only by the `/mcp` connector, and it owner-scopes every `/mcp` call. */
  created_by?: string;
```
   In the `home_channel` doc comment replace the sentence "Written only by `fireTrigger`, from the binding on an approved trigger — never from a model input." with "Written by `fireTrigger` from an approved trigger's binding, and by the `/mcp` connector from the person's Claude connection — never from a model input." Leave the rest of that comment as is.
2. `src/tasks/persistence.ts` `appendCliMessage(taskId, message)` → `appendCliMessage(taskId: string, message: string, author?: { id: string; name: string })`; `source: author ? `<@${author.id}:${author.name}> in claude` : 'cli'`. The emitted event stays exactly `{ from: 'cli', to: 'pm-agent', message }`. Update its doc comment by one clause only if needed; no new comment.
3. `src/tasks/persistence.ts`: directly after `appendEvent`, add
```ts
export function eventsFlushed(taskId: string): Promise<void> {
  return writeQueues.get(taskId) ?? Promise.resolve();
}
```
   with a one-line doc: `/** Resolves once every event already emitted for this task is on disk. */`.
4. `src/tasks/task.ts` `logFilesUpload` (line ~831): the emitted event data becomes `{ from: sender, to: 'user', destination: display, message: rendered, files: [...filePaths] }`. Nothing else in task.ts changes.

Tests (append to `src/tasks/__tests__/persistence.test.ts`, which already has a fixture `SESSIONS_ROOT` and mocks event-bus): (a) `appendCliMessage` with an author writes a knowledge.log line containing `[<@U1:Dana> in claude] hello` and without author still `[cli] hello` (create `<SESSIONS_ROOT>/<taskId>/shared/` first; `getKnowledgeLogPath` gives the path); (b) `appendEvent` two events then `await eventsFlushed(taskId)` then `readEvents(taskId)` returns both (create the shared dir first).
5. `src/agents/tools.ts` doc comment of `resolveTriggerOrigin` (lines ~2258-2262): replace "a CLI/absent default → operator (full visibility, matching the CLI surface)." with "otherwise the home channel decides the same way, and with neither → operator (full visibility, matching the CLI surface)." Nothing else in tools.ts changes.

**Files:** `src/types/task.ts`, `src/tasks/persistence.ts`, `src/tasks/task.ts`, `src/tasks/__tests__/persistence.test.ts`, `src/agents/tools.ts`

**Tests:** npx vitest run src/tasks/__tests__/persistence.test.ts

**Must not touch:** src/connectors/; prompts/; src/agents/spawn.ts

### T03 — Extract the /api approve body into resolveApproval with an optional via

In `src/connectors/api/routes.ts`, move the whole body of the `router.post('/tasks/:id/approve', ...)` handler (lines ~227-383: from `const taskId = ...` through the final `res.json({ ok: true })`, including its try/catch) into a new exported function in the same file, placed above `mountApiRoutes`:
```ts
export async function resolveApproval(
  taskId: string,
  body: unknown,
  via?: { approval_id: number; approver: { id: string; name: string; email?: string } },
): Promise<{ status: number; body: Record<string, unknown> }>
```
Mechanical rewrite: `req.body` → `body` (keep the same destructuring cast), `req.params.id` → `taskId`; every `res.status(X).json(Y); return;` → `return { status: X, body: Y };`; `res.json(Y)` → `return { status: 200, body: Y };`; the catch keeps `logger.error('api', 'Failed to process approval', error)` and returns `{ status: 500, body: { error: 'Failed to process approval' } }`. Keep every existing comment and the exact order of checks (type/approve 400, merge 400, approver normalization, `Task.get`, per-type branches, unknown type 400). The route handler becomes:
```ts
  router.post('/tasks/:id/approve', async (req: Request, res: Response) => {
    const result = await resolveApproval(req.params.id as string, req.body);
    res.status(result.status).json(result.body);
  });
```
Then the `via` behaviour (only when `via` is given; without it the function must behave and respond exactly as the old handler):
- `const cleanApprover = via ? via.approver : (<existing normalization expression>);`
- trigger approve: `task.handleTriggerApproval(via ? via.approver.id : 'cli', ref)`.
- each of the three `emitEvent('approval:resolved', taskId, { type, approve })` calls passes `{ type, approve, ...(via ? { approval_id: via.approval_id, approver_name: via.approver.name } : {}) }` — define it once as `const resolved = { type, approve, ...(via ? {...} : {}) };` after the validations and use it at all three sites.
Add no other comments.

Tests: existing `src/connectors/__tests__/merge-approval-surfaces.test.ts` and `src/connectors/__tests__/trigger-operator-surface.test.ts` must pass unchanged. Append to `trigger-operator-surface.test.ts` (it already mocks `Task.get`, `emitEvent`, trigger-store) a `describe('resolveApproval via')` with two cases calling the exported `resolveApproval` directly: (1) a trigger approve with `via = { approval_id: 7, approver: { id: 'U1', name: 'Dana' } }` calls `handleTriggerApproval('U1', ref)` and emits `approval:resolved` with `approval_id: 7, approver_name: 'Dana'`; (2) the same call without `via` calls `handleTriggerApproval('cli', ref)` and emits `{ type: 'trigger', approve: true }` exactly. Reuse the file's existing fake-task setup.

**Files:** `src/connectors/api/routes.ts`, `src/connectors/__tests__/trigger-operator-surface.test.ts`

**Tests:** npx vitest run src/connectors/__tests__/trigger-operator-surface.test.ts src/connectors/__tests__/merge-approval-surfaces.test.ts src/connectors/api

**Must not touch:** src/tasks/task.ts; src/cli/; tools/

### T04 — /mcp routes and mount

Create `src/connectors/claude/routes.ts` exporting `mountClaudeRoutes(app: Application): void`, same Express idiom as `src/connectors/api/routes.ts:9-12,34-36` (createRequire express, `express.Router()`, `router.use(express.json())`), ending `app.use('/mcp', router); logger.plain('Claude routes: /mcp');`. In `src/index.ts` import it and call `mountClaudeRoutes(app);` on the line after `mountApiRoutes(app);`.

Imports: `redeemCode, findConnection, type ClaudeConnection` from `./connections.js`; `resolveApproval` from `../api/routes.js`; `Task` from `../../tasks/task.js`; `appendCliMessage, readEvents, loadMetadata, findTaskOnDisk, eventsFlushed` from `../../tasks/persistence.js`; `AGENT_PROMPTS` from `../../agents/prompts.js`; `getUserInfo` from `../slack/client.js`; `createKeyedLock` from `../../system/keyed-lock.js`; `logger`.

Helpers (module scope, no exports):
- `const decisionLock = createKeyedLock();`
- `async function person(c: ClaudeConnection) { const info = await getUserInfo(c.user_id); return { id: c.user_id, name: info.realName || info.name, email: info.email }; }`
- `async function ownedTask(id: unknown, c: ClaudeConnection)`: `const taskId = typeof id === 'string' ? findTaskOnDisk(id) : undefined; const metadata = taskId ? await loadMetadata(taskId) : null; return taskId && metadata && metadata.created_by === c.user_id ? { taskId, metadata } : null;`
- `approvalViews(events)` → array of `{ approval_id: number; type: string; text: string; state: 'pending' | 'approved' | 'denied'; decided_by?: string; decided_at?: string; request: Record<string, unknown> }`: walk `events` with index i; `approval:requested` → push `{ approval_id: i, type: String(e.data.approvalType), text: String(e.data.text ?? ''), state: 'pending', request: e.data }`; `approval:resolved` → target = `typeof e.data.approval_id === 'number' ? views.find(v => v.approval_id === e.data.approval_id) : [...views].reverse().find(v => v.state === 'pending' && v.type === e.data.type)`; if target is pending set `state = e.data.approve ? 'approved' : 'denied'`, `decided_at = e.timestamp`, and `decided_by = e.data.approver_name` when it is a string. `const view = ({ request, ...rest }) => rest;` strips `request` from responses.
- `readAttachment(path: string)` → `{ name, text }` or `{ name, note }`: `name = basename(path)`; `readFile` throws → note `${name} could not be read.`; length > 100_000 → note `${name} (${buf.length} bytes) is too large to show here.`; `new TextDecoder('utf-8', { fatal: true }).decode(buf)` throws or the text contains `\u0000` → note `${name} is not a text file, so it is not shown here.`; else `{ name, text }`.

Routes (each body in try/catch → `logger.error('claude', '<what failed>', error)` and 500 `{ error: 'Archie could not handle that request' }`):
1. `POST /connect` (registered BEFORE the auth middleware): `code` must be a non-empty string else 400 `{ error: 'code is required' }`; `redeemCode(code)` null → 401 `{ error: 'That code is invalid, already used or expired. Say "connect claude" to Archie in Slack for a new one.' }`; else `const p = await person(result.connection)`; `logger.system(`Claude connected for ${result.connection.user_id}`)`; 200 `{ credential: result.credential, name: p.name }`.
2. Auth middleware `router.use(async (req, res, next) => ...)`: match `req.headers.authorization` against `/^Bearer (\S+)$/`; `findConnection(match[1])`; none → 401 `{ error: 'Not connected to Archie. Say "connect claude" to Archie in Slack, then pass the code to connect_archie.' }`; else `res.locals.connection = connection; next()`.
3. `POST /sessions`: `message` must be a non-empty string else 400 `{ error: 'message is required' }`. If `session_id !== undefined`: `ownedTask(session_id, c)` null → 404 `{ error: 'Session not found' }`; else `const line = await appendCliMessage(taskId, message, { id: p.id, name: p.name }); const task = await Task.get(taskId); task.linkCliChannel(); await task.sendMessage(AGENT_PROMPTS.inboundActivity([line])); res.json({ session_id: taskId });`. Else (new): `const task = await Task.create(); task.metadata.created_by = c.user_id; task.metadata.home_channel = { channel_id: c.channel_id, channel_name: c.channel_name }; task.metadata.memory_authors = { ...task.metadata.memory_authors, [p.id]: p.name }; task.setMemoryDestination(c.channel_id); task.linkCliChannel(); await task.save(true); const line = await appendCliMessage(task.taskId, message, { id: p.id, name: p.name }); await task.sendMessage(AGENT_PROMPTS.inboundNewTask([line])); res.status(201).json({ session_id: task.taskId });`
4. `GET /sessions/:id`: owned else 404; `const { events } = await readEvents(taskId)`; `const after = Math.max(0, Number.parseInt(String(req.query.after ?? '0'), 10) || 0)`; replies = for each `e` in `events.slice(after)` with `e.type === 'message' && e.data.to === 'user'`: `{ text: String(e.data.message ?? ''), files: await Promise.all((Array.isArray(e.data.files) ? e.data.files : []).filter((f): f is string => typeof f === 'string').map(readAttachment)) }`; `status = metadata.status === 'completed' ? 'done' : metadata.status === 'stopped' ? 'paused' : 'working'`; `approvals = approvalViews(events).filter(v => v.state === 'pending').map(view)`; 200 `{ status, replies, approvals, cursor: events.length }`.
5. `GET /sessions/:id/approvals/:aid`: owned else 404; `aid = Number(req.params.aid)` must be an integer else 404 `{ error: 'Approval not found' }`; find view else same 404; 200 `view(v)`.
6. `POST /sessions/:id/approvals/:aid`: `approve` must be boolean else 400 `{ error: 'approve must be true or false' }`; owned else 404; then inside `await decisionLock(taskId, async () => { ... })`: `await eventsFlushed(taskId)`; read events; find view by aid else 404; if `v.state !== 'pending'` → 200 `{ ...view(v), already_decided: true }`; `const p = await person(c)`; `const r = await resolveApproval(taskId, { type: v.type, approve, github: v.request.github, pr_number: v.request.pr_number, ref: v.request.ref }, { approval_id: v.approval_id, approver: p })`; `r.status !== 200` → `res.status(r.status).json(r.body)`; else `await eventsFlushed(taskId)` and 200 `{ ...view(v), state: approve ? 'approved' : 'denied', decided_by: p.name, decided_at: new Date().toISOString(), already_decided: false }`.

Comments: none, except one line above the auth middleware: `// Every route below acts as the connected person and only on tasks they started.`

Tests `src/connectors/claude/__tests__/routes.test.ts`: real Express app with `mountClaudeRoutes`, listening on port 0, requests via `fetch` — follow `src/connectors/api/__tests__/task-listing.test.ts` (fixture sessions dir via a mocked `system/workdir.js`, logger and event-bus mocked). Mock `../connections.js` (`findConnection` returns `{ user_id: 'U1', channel_id: 'D1', channel_name: 'DM with Dana', created_at }` for credential `good`, null otherwise; `redeemCode` returns `{ credential: 'good', connection }` for `'ABCD-EFGH'`, else null), `../../slack/client.js` (`getUserInfo` → `{ realName: 'Dana', name: 'dana', email: 'dana@example.com' }`, plus the exports persistence needs: `formatSlackChannelRef`, `formatSlackChannelDisplay`, `isExternalUser`), `../../api/routes.js` (`resolveApproval: vi.fn().mockResolvedValue({ status: 200, body: { ok: true } })`), `../../../tasks/task.js` (`Task.create` → a fake `{ taskId: 'task-20261016-1200-new', metadata: { memory_authors: {} }, setMemoryDestination: vi.fn(), linkCliChannel: vi.fn(), save: vi.fn(), sendMessage: vi.fn() }`, `Task.get` → a similar fake), and `../../../tasks/persistence.js` via `importActual` overriding only `appendCliMessage: vi.fn().mockResolvedValue('LINE')`. Write fixture tasks as `<sessions>/<id>/shared/metadata.json` and `<sessions>/<id>/shared/events.jsonl` (that is where `loadMetadata`/`readEvents` look; see `src/tasks/persistence.ts:156-158` and `task-listing.test.ts:62-76`) for an own task (`created_by: 'U1'`) and a foreign one (`created_by: 'U2'`). Cases:
- 401: no header, and `Bearer bad`, on `GET /mcp/sessions/<own>`.
- connect: `ABCD-EFGH` → 200 `{ credential: 'good', name: 'Dana' }`; wrong code → 401; missing → 400; connect needs no Authorization header.
- new session → 201 with the fake id; fake metadata has `created_by: 'U1'`, `home_channel: { channel_id: 'D1', channel_name: 'DM with Dana' }`, `memory_authors.U1 === 'Dana'`; `setMemoryDestination('D1')`, `linkCliChannel`, `save(true)` called; `appendCliMessage` called with `(id, 'hi', { id: 'U1', name: 'Dana' })`; `sendMessage` called once.
- existing own session → 200 same id, `Task.get` + `sendMessage` called; foreign session_id and unknown session_id → 404 and neither `appendCliMessage` nor `Task.get` called.
- check: events fixture = [message from cli to pm-agent, message to user 'first', approval:requested (trigger, text 'Set up this automation?', ref 'trg-1'), message to user with `files` [a small .md fixture file, a file with a NUL byte, a missing path], approval:requested (edit_mode) , approval:resolved { type: 'edit_mode', approve: true, approval_id: 4, approver_name: 'Dana' }] → `?after=0`: two replies (texts; the .md text, the binary note, the could-not-be-read note), approvals = only id 2, cursor 6; `?after=3`: one reply; metadata status `completed` → `done`, `stopped` → `paused`, `in_progress` → `working`.
- approval view: id 2 → pending with text; id 4 → approved, decided_by 'Dana'; id 1 (not a request) and 'x' → 404; foreign task → 404.
- decide: POST id 2 `{ approve: true }` → 200 state approved, decided_by 'Dana', already_decided false, and `resolveApproval` called with `(own, { type: 'trigger', approve: true, github: undefined, pr_number: undefined, ref: 'trg-1' }, { approval_id: 2, approver: { id: 'U1', name: 'Dana', email: 'dana@example.com' } })`; POST id 4 → 200 already_decided true and `resolveApproval` not called; `resolveApproval` returning `{ status: 409, body: { ok: false, stale: true, error: 'x' } }` → 409 passed through; `{ approve: 'yes' }` → 400; foreign task → 404 and `resolveApproval` not called.

**Files:** `src/connectors/claude/routes.ts`, `src/index.ts`, `src/connectors/claude/__tests__/routes.test.ts`

**Tests:** npx vitest run src/connectors/claude/__tests__/routes.test.ts

**Must not touch:** src/connectors/api/routes.ts; src/tasks/; src/types/; src/connectors/slack/

### T05 — connect/disconnect claude in the DM, handled by the engine

Create `src/connectors/claude/dm-commands.ts`:
```ts
export async function handleClaudeCommand(event: { channel: string; user: string; thread_ts?: string; raw: unknown }): Promise<boolean>
```
- `const text = typeof (event.raw as { text?: unknown } | null)?.text === 'string' ? (event.raw as { text: string }).text.trim() : '';`
- `const match = /^(dis)?connect claude[.!]?$/i.exec(text);` Return false unless `event.channel.startsWith('D') && event.user && match`. Thread replies count too: with the Slack assistant view a DM message can carry `thread_ts`. Every reply below is posted with `threadTs: event.thread_ts` so it lands where the person typed.
- connect (`!match[1]`): `const info = await getChannelInfo(event.channel); const code = await issueCode({ user_id: event.user, channel_id: event.channel, channel_name: info.name }); await postSlackMessage({ channel: event.channel, threadTs: event.thread_ts, text: `Your code for Claude: \`${code}\`\nPaste it into Claude within 10 minutes. It works once.\nSay \`disconnect claude\` here to disconnect Claude.` }); logger.system(`Issued a Claude connect code for ${event.user}`);`
- disconnect: `const removed = await revokeUser(event.user); await postSlackMessage({ channel: event.channel, threadTs: event.thread_ts, text: removed > 0 ? 'Claude is disconnected. Say `connect claude` here to connect again.' : 'No Claude was connected.' }); logger.system(`Revoked ${removed} Claude credential(s) for ${event.user}`);`
- return true.
Imports: `getChannelInfo, postSlackMessage` from `../slack/client.js`; `issueCode, revokeUser` from `./connections.js`; `logger`. No comments.

In `src/connectors/slack/events.ts` `handleSlackEvent`: import `handleClaudeCommand` from `../claude/dm-commands.js`, and add as the first statement after the external-author bail-out block (the `if (event.user) { try { ... isExternalUser ... } }` block, before the `// Instant acknowledgment` comment):
```ts
  if (await handleClaudeCommand(event)) return;
```
Nothing else in events.ts changes.

Tests `src/connectors/claude/__tests__/dm-commands.test.ts`: mock `../../slack/client.js` (`getChannelInfo` → `{ id: 'D1', name: 'DM with Dana', isPrivate: true, isIm: true, imUserId: 'U1' }`, `postSlackMessage` vi.fn), `../connections.js` (`issueCode` → `'ABCD-EFGH'`, `revokeUser` → 1), logger. Cases: `{ channel: 'D1', user: 'U1', raw: { text: 'connect claude' } }` → true, `issueCode` called with `{ user_id: 'U1', channel_id: 'D1', channel_name: 'DM with Dana' }`, posted text contains `ABCD-EFGH` and posted to channel D1 with `threadTs` undefined; `' Connect Claude! '` → true; same text with `thread_ts: '111.222'` → true and the reply carries `threadTs: '111.222'`; channel `C1` → false; `'connect claude please'` → false; raw undefined → false; for every false case nothing is posted and `issueCode`/`revokeUser` not called; `'disconnect claude'` → true, `revokeUser('U1')`, reply `Claude is disconnected…`; with `revokeUser` → 0 reply is `No Claude was connected.`.

**Files:** `src/connectors/claude/dm-commands.ts`, `src/connectors/slack/events.ts`, `src/connectors/claude/__tests__/dm-commands.test.ts`

**Tests:** npx vitest run src/connectors/claude/__tests__/dm-commands.test.ts src/connectors/slack

**Must not touch:** src/connectors/slack/client.ts; slack-manifest.yaml; src/connectors/slack/task-routing.ts; prompts/

### T06 — Desktop/CLI extension and its pack script

Reference implementation to copy from: `/Users/khmelev/Projects/swc/archie-orchestrator/probes/elicitation/server.js` (read it whole; the card HTML, the app-with-deps bundle inlining, `registerAppTool`/`registerAppResource`, `applyDocumentTheme`/`applyHostStyleVariables`/`applyHostFonts`, `onhostcontextchanged` are proven in Claude Desktop). Do not copy its `approve` elicitation tool, its logging, its decisions file, or the stdio `onmessage` wrapper.

`extension/package.json`: `{ "name": "archie-claude-extension", "version": "0.1.0", "private": true, "type": "module", "main": "server.mjs", "dependencies": { "@modelcontextprotocol/ext-apps": "^1.7.5", "@modelcontextprotocol/sdk": "^1.32.1", "zod": "^4.6.7" } }`; generate `extension/package-lock.json` with `npm install --prefix extension` (commit the lockfile, never `extension/node_modules`, which the root `.gitignore` already ignores).

`extension/.mcpbignore`: one line `*.mcpb`.

`extension/manifest.json`: `manifest_version` "0.3", `name` "archie", `display_name` "Archie", `version` "0.1.0", `description` "Talk to Archie, your team's AI teammate, from Claude.", `author` `{ "name": "Archie contributors" }`, `server` `{ "type": "node", "entry_point": "server.mjs", "mcp_config": { "command": "node", "args": ["${__dirname}/server.mjs"], "env": { "ARCHIE_URL": "${user_config.archie_url}" } } }`, `user_config` `{ "archie_url": { "type": "string", "title": "Archie URL", "description": "Base URL of your Archie server, e.g. https://archie.example.com", "required": true } }`, `tools`: the four model-visible tools with their descriptions below, `compatibility` `{ "platforms": ["darwin", "win32", "linux"], "runtimes": { "node": ">=20.0.0" } }`, `license` "AGPL-3.0-or-later".

`extension/server.mjs` (ESM, no build step):
- `const ARCHIE_URL = (process.env.ARCHIE_URL ?? '').replace(/\/+$/, '');` `const STORE = join(homedir(), '.archie', 'claude.json');` `const cursors = new Map();`
- `readCredential()`: parse STORE (missing/invalid → `{}`) and return `[ARCHIE_URL]`. `saveCredential(credential)`: read the same object, set `[ARCHIE_URL] = credential`, `mkdirSync(dirname(STORE), { recursive: true, mode: 0o700 })`, `writeFileSync(STORE, JSON.stringify(all, null, 2), { mode: 0o600 })`, then `chmodSync(STORE, 0o600)`.
- `async function archie(method, path, body)`: if `!ARCHIE_URL` throw `new Error('Set the Archie URL in the extension settings (ARCHIE_URL).')`; `fetch(ARCHIE_URL + '/mcp' + path, { method, headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })`; `const data = await res.json().catch(() => ({}))`; `!res.ok` → throw `new Error(data.error ?? `Archie answered ${res.status}.`)`; return data. A network failure surfaces as `Could not reach Archie at ${ARCHIE_URL}: ${err.message}`.
- `const result = (text, structuredContent) => ({ content: [{ type: 'text', text }], ...(structuredContent ? { structuredContent } : {}) });` and every tool handler wraps its body in try/catch returning `{ content: [{ type: 'text', text: err.message }], isError: true }`.
- `const approvalPath = (s, a) => `/sessions/${encodeURIComponent(s)}/approvals/${encodeURIComponent(String(a))}``.
- `describeDecision(v)`: pending → `Approval ${v.approval_id} is waiting for the person: "${v.text}"`; else `Approval ${v.approval_id} ("${v.text}") was ${v.state}${v.decided_by ? ` by ${v.decided_by}` : ''}${v.decided_at ? ` at ${v.decided_at}` : ''}.`

Model-visible tools (`mcp.registerTool` unless noted; input schemas with zod):
1. `connect_archie({ code: z.string() })` — description: "Connect Claude to Archie. The person gets a one-time code by saying \"connect claude\" to Archie in a Slack DM; pass that code here. Needed once per computer." Handler: `const { credential, name } = await archie('POST', '/connect', { code }); saveCredential(credential); return result(`Connected to Archie as ${name}.`);` — the credential is never in any result.
2. `ask_archie({ message: z.string(), session_id: z.string().optional() })` — description: "Ask Archie, an AI teammate with access to your company's tools, to do or answer something. Returns at once with a session_id while Archie works in the background, like a subagent. Without session_id it starts a new session; with one it continues that session. Read Archie's replies with check_archie." Handler: `const { session_id: id } = await archie('POST', '/sessions', { message, session_id }); return result(`Archie has it. Session ${id}. Call check_archie with this session_id for replies; pass it to ask_archie to continue the session.`, { session_id: id });`
3. `check_archie({ session_id: z.string() })` — description: "See what is new in an Archie session since the last check: Archie's replies, whether it is still working or done, and approvals waiting for the person." Handler: GET `/sessions/${encodeURIComponent(session_id)}?after=${cursors.get(session_id) ?? 0}`, `cursors.set(session_id, r.cursor)`, return text built as: first line `Session ${session_id}: ` + (working → 'Archie is still working. Check again in a little while.'; done → 'Archie has finished. Use ask_archie with this session_id to follow up.'; paused → 'Archie is paused, waiting for an approval or for you.'); then each reply as `\n\nArchie: ${text}` followed by each file as `\n\n--- ${f.name} ---\n${f.text}` or `\n\n(${f.note})`; if no replies `\n\nNo new replies.`; then each pending approval as `\n\nWaiting for approval ${a.approval_id}: ${a.text}\nCall approve_archie with this session_id and approval_id ${a.approval_id} to show it to the person. Only the person can decide.`
4. `approve_archie({ session_id: z.string(), approval_id: z.number().int() })` — registered with `registerAppTool(mcp, 'approve_archie', { description: "Put an Archie approval in front of the person so they can approve or deny it. Only the person decides; you cannot.", inputSchema, _meta: { ui: { resourceUri: UI_URI } } }, handler)`. Handler: `const caps = mcp.server.getClientCapabilities(); const v = await archie('GET', approvalPath(session_id, approval_id));` If `getUiCapability(caps)` (from `@modelcontextprotocol/ext-apps/server`) → return `result(v.state === 'pending' ? `The approval card is in front of the person: "${v.text}". They decide with its buttons; you cannot. Use check_archie afterwards.` : describeDecision(v), { session_id, approval_id })`. Else if `v.state !== 'pending'` → `result(describeDecision(v))`. Else if `caps?.elicitation` → `const answer = await mcp.server.elicitInput({ mode: 'form', message: `Archie asks for approval: ${v.text}`, requestedSchema: { type: 'object', properties: { decision: { type: 'string', title: 'Decision', enum: ['approve', 'deny'] } }, required: ['decision'] } });` if `answer.action !== 'accept'` → `result(`The person did not decide. Approval ${approval_id} is still waiting.`)`; else `const d = await archie('POST', approvalPath(session_id, approval_id), { approve: answer.content.decision === 'approve' }); return result(describeDecision(d));`. Else → `result('This client cannot show approvals: it supports neither MCP Apps cards nor elicitation forms. Use Claude Desktop or Claude Code.')`.

App-only tools (`registerAppTool` with `_meta: { ui: { resourceUri: UI_URI, visibility: ['app'] } }`):
5. `archie_approval_state({ session_id, approval_id })` — description "Read an Archie approval's state. App-only." → `result(JSON.stringify(v), v)` with v from GET.
6. `archie_decide({ session_id, approval_id, decision: z.enum(['approve', 'deny']) })` — description "Record the person's decision from the approval card. App-only." → POST `{ approve: decision === 'approve' }` → `result(JSON.stringify(d), d)`.

Card: `const UI_URI = 'ui://archie/approval-v1.html';` resource registered with `registerAppResource(mcp, 'Archie approval', UI_URI, { description: 'Archie approval card' }, ...)` returning the HTML with `mimeType: RESOURCE_MIME_TYPE`. Copy the probe's HTML/CSS and bundle-inlining code; changes: `<p id="msg">` starts as `Loading…` and is set to the approval's `text`; `App` name `archie-approval`; on `ontoolinput`/`ontoolresult` take `session_id` and `approval_id` (from `p.arguments` / `r.structuredContent`) and, once both are known and not yet loaded, call `archie_approval_state`; show buttons only when `state === 'pending'`, else `Approved by X at <local time>` / `Denied by X at <local time>` (`decided_at` through `new Date(...).toLocaleString()`); buttons call `archie_decide` with `{ session_id, approval_id, decision }`; when the response has `already_decided` prefix `Already decided: `; on an error result show `Error: <text>` and keep the buttons. Keep `applyCtx` with theme, variables and fonts and `app.onhostcontextchanged = applyCtx` exactly as the probe.

`const mcp = new McpServer({ name: 'archie', version: '0.1.0' });` connect with `StdioServerTransport`. No `console.log` (stdout is the protocol). Comments: only one line above `UI_URI`: `// Bump the version whenever the card changes: Claude Desktop caches cards by URI.`

Root `package.json` scripts: add `"extension:pack": "npm ci --prefix extension --omit=dev && npx --yes @anthropic-ai/mcpb pack extension dist/archie.mcpb"` after `e2e:prepare`.

`.dockerignore`: add `extension/node_modules/` on the line after `node_modules/` (the existing pattern only matches the context root, and the compose build context is the repo root).

**Files:** `extension/package.json`, `extension/package-lock.json`, `extension/manifest.json`, `extension/server.mjs`, `extension/.mcpbignore`, `package.json`, `.dockerignore`

**Tests:** node --check extension/server.mjs && npx --no-install @anthropic-ai/mcpb validate extension/manifest.json && npm run extension:pack

**Must not touch:** src/; tools/; .gitignore; package-lock.json

## Verification plan

| ac | method | scenario | evidence | command |
|---|---|---|---|---|
| AC1 | integration | connections.test.ts (issue/redeem once/expiry/normalize/revoke/hash-only 0600), dm-commands.test.ts (connect/disconnect handled pre-PM, only top-level DM exact phrase), routes.test.ts (connect 200/401/400). Live: brain drives the operator's DM with Archie Test via Hookdeck pointed at the booted port — 'connect claude' → code in DM, no new task folder; operator passes the code to connect_archie in Desktop; then 'disconnect claude' → next check_archie gets the not-connected error. | vitest output in scratchpad; instance logs 'Issued a Claude connect code' / 'Claude connected for' / 'Revoked'; secrets/claude-connections.json holds only hashes; ~/.archie/claude.json mode 600; tool results contain no credential | `npx vitest run src/connectors/claude` |
| AC2 | integration | routes.test.ts: 401 without/with bad bearer; foreign and unknown session ids → 404 on ask, check, approval view and decide, with Task.get/appendCliMessage/resolveApproval never called. Existing /api suites unchanged and green. | vitest output; full suite count ≥ baseline 2004 | `npx vitest run src/connectors` |
| AC3 | integration | routes.test.ts: new session 201 with id, continue 200 same id; check folds replies after cursor, file text vs note, status mapping, pending approvals. Live (manual, operator in Desktop): new session; follow-up on the same id; a slow request checked several times until done. | vitest output; Desktop transcript screenshots from the operator; task events.jsonl showing message events to user | `npx vitest run src/connectors/claude/__tests__/routes.test.ts` |
| AC4 | integration | routes.test.ts new-session case asserts created_by, home_channel, memory_authors, setMemoryDestination(DM), CLI channel; persistence.test.ts asserts the `<@U:Name> in claude` line. Live: the session's metadata.json has created_by, home_channel and memory_destination = the DM, default_channel cli:local; a proposed trigger's created_by = the person and binding = their DM; instance logs show no Slack post for that task. | vitest output; metadata.json and trigger json excerpts; grep of instance logs for the task id | `npx vitest run src/connectors/claude src/tasks/__tests__/persistence.test.ts` |
| AC5 | manual | Integration: routes.test.ts decide resolves through resolveApproval with the person as approver and approval_id, a second decide returns already_decided without resolving; trigger-operator-surface.test.ts pins via (approver id, approval_id on the event). Manual: operator provokes a trigger proposal in Desktop, approve_archie shows the card, Approve click, reopening the chat shows the decision; Claude Code CLI initialize capabilities recorded by pointing `claude` at the probe; the elicitation form is exercised only if the operator runs it in a terminal. | vitest output; operator screenshots; trigger json approved_by = person's Slack id (then paused, residue); probe log line of the CLI initialize | `npx vitest run src/connectors/claude/__tests__/routes.test.ts src/connectors/__tests__/trigger-operator-surface.test.ts` |
| AC6 | structural | Pack the extension, validate its manifest, confirm the user_config key and the docs lines. | command exit 0 and grep hits | `npm run extension:pack && npx --no-install @anthropic-ai/mcpb validate extension/manifest.json && grep -q '"archie_url"' extension/manifest.json && grep -rq 'claude mcp add' docs && grep -rq '/mcp' docs/architecture` |

## Facts this design stands on

Each was checked against the code by an agent instructed to refute it.

| claim | citation | ruling |
|---|---|---|
| POST /api/tasks creates a task with Task.create(), calls linkCliChannel(), appendCliMessage, then sendMessage(AGENT_PROMPTS.inboundNewTask([line])) and answers 201 without waiting for the PM turn | `src/connectors/api/routes.ts:151-171` | declared |
| POST /api/tasks/:id/message appends the CLI message, Task.get, linkCliChannel, sendMessage(AGENT_PROMPTS.inboundActivity([line])) | `src/connectors/api/routes.ts:175-195` | declared |
| The approve route handles edit_mode, research_budget, merge, trigger, tool_call, max_mode and emits approval:resolved {type, approve} on success and on the two trigger stale paths | `src/connectors/api/routes.ts:226-384` | declared |
| The trigger branch of the approve route passes the literal 'cli' as approverId to handleTriggerApproval | `src/connectors/api/routes.ts:312` | declared |
| postInteractiveToUser emits approval:requested with {text, approvalType, github?, pr_number?, ref?} for every approval kind | `src/tasks/task.ts:860-865` | declared |
| postToUser with a CLI default channel only logs the message and emits a message event {from, to:'user', destination:'cli', message}; nothing reaches Slack | `src/tasks/task.ts:704-706` | declared |
| resolveSlackChannel returns null when the default channel is the CLI channel, so interactive approval cards are not posted to Slack | `src/tasks/task.ts:921-926` | declared |
| logFilesUpload emits a message event whose data has no file paths today | `src/tasks/task.ts:827-834` | declared |
| linkCliChannel sets channels['cli:local'] and default_channel ??= 'cli:local' | `src/tasks/task.ts:646-650` | declared |
| setMemoryDestination accepts a channel equal to the derived destination from home_channel when no memory_destination is set and there is no Slack history | `src/tasks/task.ts:580-597` | declared |
| resolveTriggerOrigin falls back to home_channel when the default channel is not Slack and returns a dm origin with the partner's user id for an IM | `src/agents/tools.ts:2263-2279` | declared |
| propose_trigger sets created_by to the DM origin's userId and enforces MAX_TRIGGERS_PER_USER by created_by | `src/agents/tools.ts:2441-2466` | declared |
| announceTriggerChange returns early for a DM-bound (type user) trigger | `src/system/trigger-scheduler.ts:476-478` | declared |
| fireTrigger homes a schedule-fired task by setMemoryDestination(binding.channel_id) and home_channel = binding channel | `src/system/trigger-scheduler.ts:419-425` | declared |
| Task.metadata is a public mutable field and task.save(true) is callable from routes | `src/connectors/api/routes.ts:209-215` | declared |
| appendCliMessage writes a knowledge.log line with source 'cli' and emits {from:'cli', to:'pm-agent', message} | `src/tasks/persistence.ts:517-531` | declared |
| appendEvent sets writeQueues for the task synchronously before its first await, and the event bus dispatches synchronously, so after emitEvent returns the queue includes that event | `src/tasks/persistence.ts:823-835` | declared |
| readEvents returns the parsed events of events.jsonl in file order and total = number of non-blank lines | `src/tasks/persistence.ts:917-934` | declared |
| findTaskOnDisk returns the session folder name only for an exact, well-formed task id that exists, so request input never reaches a path | `src/tasks/persistence.ts:167-176` | declared |
| TaskMetadata has no created_by field today | `src/types/task.ts:268-386` | declared |
| resolvePeopleFromTranscript collects people from <@ID:Name> markers in the knowledge log | `src/connectors/slack/client.ts:2645-2653` | declared |
| getChannelInfo returns name 'DM with <realName>' and isIm/imUserId for a DM | `src/connectors/slack/client.ts:1769-1787` | declared |
| getUserInfo returns realName, name and email for a Slack user id | `src/connectors/slack/client.ts:1604-1614` | declared |
| handleSlackEvent bails out on external/guest authors before acknowledging or creating a task, and a top-level DM otherwise creates a new task | `src/connectors/slack/events.ts:785-866` | declared |
| writeJsonAtomic creates the parent dir 0700 and writes with mode 0600; readJson returns null on ENOENT; withKeyMutex serializes per key | `src/system/secrets-vault.ts:100-160` | declared |
| SECRETS_DIR is ARCHIE_SECRETS_DIR, else /app/secrets, else <cwd>/secrets | `src/system/workdir.ts:64-71` | declared |
| createKeyedLock returns run(key, fn) serializing calls per key | `src/system/keyed-lock.ts:15-27` | declared |
| The root .gitignore ignores *.js and dist/ but not *.mjs | `.gitignore:7-12` | declared |
| tsconfig covers only src/** and vitest includes src/**/*.test.ts and tools/**/*.test.ts | `vitest.config.ts:6` | declared |
| @modelcontextprotocol/ext-apps/server exports getUiCapability, registerAppTool, registerAppResource and RESOURCE_MIME_TYPE | `/Users/khmelev/Projects/swc/archie-orchestrator/probes/elicitation/node_modules/@modelcontextprotocol/ext-apps/dist/src/server/index.d.ts:359` | declared |
| The app is mounted with mountApiRoutes(app) in src/index.ts, on the same Express app as the Slack webhook | `src/index.ts:161-162` | declared |
