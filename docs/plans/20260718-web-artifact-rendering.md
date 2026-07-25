# Web artifact rendering (Markdown + stable pointer + hot reload)

Status: Implemented (this PR)

Tracks issue #148 (narrowed to Stage 1a). HTML rendering is the sibling PR #224.

## Brief

Task artifacts (plans, reports) are only visible in Slack/CLI today, rendered thinly, and because artifacts are immutable content-hashed snapshots there is no way to update one in place. This iteration lets the PM publish a Markdown artifact to a stable, updatable web URL, rendered richly, with live reload.

Goals:

- Two explicit PM-ONLY tools — publish (create) and update — that turn a renderable file (typically one a specialist shared into the shared folder via `share_artifact`) into a web artifact and RETURN its `/a/<externalId>` URL; the PM decides whether to share the URL with the user.
- A stable, globally-unique, unguessable web-artifact identity (`/a/<externalId>`) layered over the existing immutable snapshots: snapshots stay the storage substrate (`copyArtifactToShared` in `src/agents/artifacts.ts`); a pointer maps external id → current snapshot. Update advances the pointer, keeping the URL.
- Record each task's web artifacts in a new `TaskMetadata.web_artifacts` field (`src/types/task.ts`), backward-compatible optional, defaulted on first publish and tolerated by `loadMetadata` for old on-disk tasks.
- Render Markdown server-side, SANITIZED, in first-party viewer chrome, with a download link for the original source file.
- Live hot reload of an open viewer via a SEPARATE PUBLIC SSE surface that emits ONLY the update signal for the one external id — never the task event vocabulary. Internally still one in-process event bus (`src/system/event-bus.ts`); the public endpoint is a narrow projection that strips `taskId` and all other events.
- Artifact lifecycle events land in the producing task's `events.jsonl` (via the existing `initEventPersistence` mirror in `src/tasks/persistence.ts`).
- Pure-file sharing (`share_artifact` for all agents, `post_files_to_user` for the PM) is preserved and does NOT create web artifacts.

Non-goals (binding on reviewers): HTML rendering / sandboxed iframe (that is PR #224, iteration 2). Separate-origin hosting (follow-up after #224). Cross-task search. History-browsing UI. Auth/login (the viewer + its SSE are structured as their own auth-ready seam — EventSource is GET-only and cannot set headers, so future auth will use a token in the path/query — but NO auth ships here). Rebuilding the Ink CLI. Plan-specific rendering (#147). Non-PM agents publishing web artifacts.

Constraints: Serve from the existing shared Express app (`src/index.ts`, which already has a precedent top-level route `GET /health` and mounts connectors in sequence); viewer routes are mounted OUTSIDE the `/api` prefix (a new `mountViewerRoutes(app)`). Do NOT reuse `GET /api/events/stream` for the viewer — it is CLI/debug-facing and heading toward access control (see issues #221, #203). Markdown: `markdown-it` with `html:false` (safe by default; it already blocks `javascript:`/`vbscript:` links) PLUS sanitize the RENDERED HTML output with DOMPurify + jsdom (keep jsdom current — a stale jsdom is itself an XSS vector); these are new dependencies not currently in `package.json`. Set `X-Content-Type-Options: nosniff` on all served artifact content and on the source download (`Content-Disposition: attachment`). The new tools are PM-ONLY, registered on the PM comms MCP server (`createCommsMcpServer`, wired in the PM branch of `src/agents/spawn.ts`) alongside `post_files_to_user`; update the tool-contract test (`src/agents/__tests__/tool-contract.test.ts`, `PM_COMMS_TOOLS`). Publish resolves its input path through the PM's read sandbox via `assertReadable` (`src/agents/artifacts.ts`) so it can only publish files the PM could read (including the shared folder). Mint external ids with the existing crypto pattern (`crypto.randomUUID()` as already used in `artifacts.ts`). Use the unified logger, never `console.*`. Never touch `CHANGELOG.md`.

Risk class: Medium — new public HTTP + SSE surface and a new persistence field, but this iteration serves only our own sanitized Markdown (no untrusted-HTML execution; that risk is quarantined to PR #224).

## Acceptance criteria

| AC | Criterion | Method |
| --- | --- | --- |
| AC1 | The PM-only `publish_web_artifact` tool turns a Markdown file into a web artifact, returns its `/a/<externalId>` URL, records a `web_artifacts` metadata entry, and the URL serves rendered HTML with a source-download link. | integration |
| AC2 | `update_web_artifact` advances the pointer to new content while keeping the same `/a/<externalId>` URL; the viewer then serves the new content. | integration |
| AC3 | External ids are globally unique and do not encode the producing `taskId` (no `taskId` appears in the id or the URL). | unit |
| AC4 | Rendered Markdown is sanitized: `<script>`, `img onerror`, and `javascript:` links are neutralized while headings, lists, and safe links are preserved. | integration |
| AC5 | `GET /a/<id>/source` returns the original bytes as an attachment with the original filename, `Content-Type: text/markdown`, and `X-Content-Type-Options: nosniff`. | integration |
| AC6 | Publish and update emit `artifact:published` / `artifact:updated` events that are persisted to the producing task's `events.jsonl`, each carrying the correct `taskId` and `data.externalId`. | integration |
| AC7 | The public SSE endpoint `/a/<id>/events` is a narrow projection: it delivers only the target id's `{type:'update'}` signal and never leaks `taskId`, other artifact ids, or other event types. | integration |
| AC8 | An open viewer hot-reloads to new content after an update with no manual refresh. | live-e2e (degradable to AC7 SSE signal + manual browser check) |
| AC9 | Pure-file sharing (`share_artifact`, `post_files_to_user`) creates no pointer file and no `web_artifacts` entry. | integration |
| AC10 | Publishing a `.html`/`.htm` file is rejected with the #224-deferral message and creates no pointer or metadata entry. | integration |

## Design

### Approach

Layer a stable, unguessable web-artifact identity over the existing immutable snapshot substrate, expose it through two PM-only MCP tools and a first-party viewer served from the shared Express app, and hot-reload open viewers via a narrow public SSE projection of the existing in-process event bus. This iteration renders only our own sanitized Markdown; `.html` is explicitly rejected (deferred to PR #224).

### New building blocks

1. **`src/agents/web-artifacts.ts` — core module (the pointer layer).**
   - Types: `WebArtifactFormat = 'markdown'`; `WebArtifactPointer = { externalId, taskId, snapshotPath (abs), sourceFilename, format, createdAt, updatedAt }`.
   - **Pointer store** (global, resolvable from `externalId` alone — the viewer has no taskId): file-per-id under `join(WORKDIR, 'web-artifacts')/<externalId>.json` (add `WEB_ARTIFACTS_DIR` to `src/system/workdir.ts`, lazy `mkdir`). O(1) resolve, matches the crypto-id / file-per-record patterns already in the repo.
   - `publishWebArtifact({ taskId, resolvedSourcePath, sourceFilename })`: calls `copyArtifactToShared(taskId, resolvedSourcePath)` (immutable snapshot substrate, unchanged), mints `externalId = crypto.randomUUID()`, writes the pointer file, returns `{ externalId, snapshotPath }`. Path resolution/format-gating happens in the tool layer (below) so the module stays pure over already-validated paths.
   - `updateWebArtifact({ externalId, taskId, resolvedSourcePath })`: loads pointer, asserts `pointer.taskId === taskId` (an artifact is advanced only from within its producing task; otherwise a clear error), snapshots the new content, advances `snapshotPath` + `updatedAt`, keeps `externalId`. Returns the pointer.
   - `resolveWebArtifact(externalId)`: reads the pointer file (null if absent).
   - `renderMarkdownArtifact(markdownSource): string`: `markdown-it({ html: false, linkify: true })` render → sanitize the rendered HTML with DOMPurify bound to a jsdom window (`createDOMPurify(new JSDOM('').window)`). `html:false` escapes raw `<script>`/`<img onerror>` and markdown-it already blocks `javascript:`/`vbscript:` hrefs; DOMPurify is defense-in-depth on the output. A module-level singleton DOMPurify instance avoids per-request jsdom construction.
   - `WEB_ARTIFACT_FORMAT_ERROR` helper strings: `.html`/`.htm` → the #224-deferral message; other non-`.md`/`.markdown` → generic "only Markdown web artifacts are supported this iteration".

2. **`TaskMetadata.web_artifacts` (`src/types/task.ts`).** New optional field: `web_artifacts?: WebArtifactRecord[]` where `WebArtifactRecord = { external_id, source_filename, format, created_at, updated_at }`. Backward-compatible (optional → tolerated by `loadMetadata`'s plain `JSON.parse`). Not added to the `Task.create` metadata literal is acceptable since it is optional, but per the brief we default it: leave it undefined at create and have the publish tool initialize the array on first push (`metadata.web_artifacts ??= []`) — this keeps `Task.create` untouched-in-shape while the field is defaulted on first use and tolerated when absent. (Chosen over eagerly writing `[]` in `Task.create` to keep old on-disk tasks and the create literal identical; the AC only requires it be defaulted/tolerated, which `??=` + optional typing satisfies.)

3. **Event vocabulary (`src/system/event-bus.ts`).** Extend the `EventType` union with `'artifact:published' | 'artifact:updated'`. Both are emitted with the producing task's `taskId` and `data: { externalId }`. Because `initEventPersistence()` already mirrors every bus event to `<task>/shared/events.jsonl` keyed by `taskId`, persistence (AC6) and retrieval via `GET /api/tasks/:id/events` come for free.

4. **Two PM-only tools in `createCommsMcpServer` (`src/agents/tools.ts`).** Registered alongside `post_files_to_user`, so they are PM-only by construction (the server is wired only in the PM branch of `spawn.ts`).
   - `publish_web_artifact({ path, [title] })`: `assertReadable(path, requireSandbox(agent))` (so the PM can only publish files it could read, including the shared folder); reject `.html`/`.htm` with the #224 message and other non-Markdown with the generic message (no snapshot, no pointer, no metadata written on rejection); else `publishWebArtifact`, push a `WebArtifactRecord` into `task.metadata.web_artifacts` (`??= []`), `task.save(true)`, `emitEvent('artifact:published', task.taskId, { externalId })`, and return the `/a/<externalId>` URL (path form; prefixed with `ARCHIE_PUBLIC_BASE_URL` when set).
   - `update_web_artifact({ external_id_or_url, path })`: parse the external id out of a raw id or a `/a/<id>` URL; `assertReadable` the new path; `updateWebArtifact` (asserts producing-task ownership); update the matching `web_artifacts` record's `updated_at`; `task.save(true)`; `emitEvent('artifact:updated', task.taskId, { externalId })`; return the same `/a/<externalId>` URL. Errors surfaced via `err(...)` for unknown/foreign external ids.
   - Update `PM_COMMS_TOOLS` in `src/agents/__tests__/tool-contract.test.ts`.

5. **`src/connectors/viewer/routes.ts` — `mountViewerRoutes(app)`, mounted top-level in `src/index.ts` (after `mountApiRoutes`, OUTSIDE `/api`).** All artifact content and the source download set `X-Content-Type-Options: nosniff`.
   - `GET /a/:externalId` — resolve pointer (404 if absent), read snapshot `.md`, `renderMarkdownArtifact`, wrap in first-party viewer chrome (title, a **download source** link to `/a/:externalId/source`, and an inline script that opens `EventSource('/a/:externalId/events')` and on a signal re-fetches `/a/:externalId/body` and swaps it into the content container). `Content-Type: text/html; charset=utf-8`.
   - `GET /a/:externalId/body` — the sanitized rendered HTML fragment only (used by hot reload to re-render in place). `nosniff`.
   - `GET /a/:externalId/source` — the original snapshot bytes as a download: `Content-Disposition: attachment; filename="<sourceFilename>"`, `Content-Type: text/markdown; charset=utf-8`, `nosniff`.
   - `GET /a/:externalId/events` — **narrow public SSE projection.** Subscribes to the one in-process bus via `onEvent`, forwards ONLY `artifact:updated` (and `artifact:published`) events whose `data.externalId === req.params.externalId`, and emits ONLY a minimal `data: {"type":"update"}` signal — never `taskId`, never any other event or artifact. GET-only, header-less (EventSource cannot set headers) — the auth-ready seam noted in the brief; no auth ships. Keepalive + `req.on('close')` cleanup mirror the existing `/api/events/stream`.

### Auth-ready seam / non-goals

No auth, no separate origin, no HTML rendering, no history UI, no cross-task search. The viewer + its SSE are isolated in their own routes file and use path-based ids so a future token can live in the path/query.

### Error & recovery paths

- Unknown/foreign `externalId` → tool `err(...)`; viewer routes → `404`.
- `.html`/`.htm` publish → `err(...)` with the #224 message, nothing created (AC10).
- Non-Markdown, non-HTML publish → generic rejection, nothing created.
- Unreadable/out-of-sandbox path → `assertReadable` throws → `err(...)`.
- Pointer file missing on viewer hit → `404` (snapshot deleted / stale link).
- SSE client disconnect → listener removed in `req.on('close')`.

### Trade-offs

- Global file-per-id pointer store (vs scanning task metadata like `findTaskByThread`): O(1) viewer resolution and a clean auth seam, at the cost of a second write site kept consistent with `web_artifacts` (both written in the tool handler under the same `task.save`).
- Hot reload re-fetches a `/body` fragment rather than full `location.reload()` — cleaner render and one shared render path; falls back to reload semantics if the fetch fails.
- `update` restricted to the producing task keeps ownership/safety simple; cross-task update is out of scope for the ACs.

## Tasks

| Task | Title | Detail | Tests |
| --- | --- | --- | --- |
| T1 | Add web_artifacts type + artifact event vocabulary | In `src/types/task.ts` add `WebArtifactFormat = 'markdown'` and `WebArtifactRecord { external_id; source_filename; format; created_at; updated_at }`, and add optional `web_artifacts?: WebArtifactRecord[]` to `TaskMetadata` (doc comment noting it is backward-compatible/optional and tolerated by `loadMetadata` for old tasks). Do NOT change the `Task.create` metadata literal (field stays undefined at create; defaulted via `??= []` at first publish). In `src/system/event-bus.ts` extend the `EventType` union with `'artifact:published' \| 'artifact:updated'`. | `npm run typecheck` stays green; existing `src/tasks/__tests__/persistence.test.ts` metadata round-trip still passes (proves optional field tolerated). |
| T2 | Add rendering/sanitizer dependencies | Add to `package.json` dependencies: `markdown-it` and `@types/markdown-it`, `dompurify` + `jsdom` (or `isomorphic-dompurify`), and `@types/jsdom`. Pin jsdom to a current version (stale jsdom is an XSS vector). Run `npm install` and commit the lockfile. No source changes here. | `npm run build` / `npm run typecheck` resolve the new modules; `npm ci` clean install succeeds. |
| T3 | Create web-artifacts core module | Create `src/agents/web-artifacts.ts`. Add `WEB_ARTIFACTS_DIR = join(WORKDIR,'web-artifacts')` to `src/system/workdir.ts`. Implement `WebArtifactPointer` type; pointer store (file-per-id, lazy mkdir); `publishWebArtifact` (calls `copyArtifactToShared`, mints `crypto.randomUUID()` externalId, writes pointer); `updateWebArtifact` (loads pointer, asserts producing-task ownership, snapshots new content, advances snapshotPath+updatedAt keeping externalId); `resolveWebArtifact`; `renderMarkdownArtifact` (markdown-it `html:false,linkify:true` then singleton DOMPurify/jsdom sanitize); `parseExternalId` (raw id or `/a/<id>` URL); format-gate helpers/messages. Unified logger only. | New `src/agents/__tests__/web-artifacts.test.ts`: render strips/neutralizes `<script>`, `img onerror`, `javascript:` links while keeping headings/lists/links (AC4); publish across two synthetic taskIds yields distinct externalIds, no taskId in pointer/URL (AC3); update keeps externalId and advances snapshotPath (AC2 core); `parseExternalId` handles id and `/a/<id>`. |
| T4 | Create viewer routes and wire into the app | Create `src/connectors/viewer/routes.ts` exporting `mountViewerRoutes(app)`. Top-level routes OUTSIDE `/api`: `GET /a/:externalId` (resolve → 404 if missing; render + first-party chrome with source-download link and inline `EventSource` re-fetch script); `GET /a/:externalId/body` (sanitized fragment); `GET /a/:externalId/source` (original bytes, `Content-Disposition: attachment`, `text/markdown`, nosniff); `GET /a/:externalId/events` (narrow SSE forwarding ONLY `artifact:published/updated` for the param id, emitting only `data:{"type":"update"}`; keepalive + close cleanup). `nosniff` on all served content. In `src/index.ts` call `mountViewerRoutes(app)` after `mountApiRoutes(app)`. Do NOT reuse `/api/events/stream`. | Covered by T6 integration tests; typecheck green. |
| T5 | Add PM-only publish/update tools | In `src/agents/tools.ts` add `createPublishWebArtifactTool` and `createUpdateWebArtifactTool`, register in `createCommsMcpServer`. `publish_web_artifact({path,title?})`: `assertReadable`; reject `.html`/`.htm` (#224) and other non-Markdown (generic), creating nothing; else `publishWebArtifact`, `task.metadata.web_artifacts ??= []` + push record, `task.save(true)`, `emitEvent('artifact:published', …)`, return `/a/<id>` URL (path form, `ARCHIE_PUBLIC_BASE_URL` prefix when set). `update_web_artifact({external_id_or_url,path})`: `parseExternalId`, `assertReadable`, `updateWebArtifact` (surface unknown/foreign-id via `err`), bump record `updated_at`, `task.save(true)`, `emitEvent('artifact:updated', …)`, return same URL. Do not modify `share_artifact` or `post_files_to_user`. | Update `PM_COMMS_TOOLS` in `src/agents/__tests__/tool-contract.test.ts` to include `mcp__comms-tools__publish_web_artifact` and `…__update_web_artifact`; the "comms-tools registers exactly its tools" test passes. Behavior covered by T6. |
| T6 | Integration tests: tools + viewer + events + private-sharing | Add `src/connectors/viewer/__tests__/viewer.test.ts`: drive the tool handlers over a temp WORKDIR/SESSIONS with a real task metadata file. Assert publish returns `/a/<id>`, writes a `web_artifacts` entry, GET serves rendered+sanitized HTML with a download link (AC1, AC4); update advances the pointer, keeps the URL, serves new content (AC2); two publishes across two taskIds → unique ids, no taskId in URLs (AC3); `/source` returns attachment with original filename + nosniff (AC5); `.html` publish returns #224 rejection and creates nothing (AC10); `events.jsonl` (via `readEvents` / `GET /api/tasks/:id/events`) contains `artifact:published/updated` with correct taskId (AC6); `share_artifact`/`post_files_to_user` create no pointer/entry (AC9). Read `/a/:id/events` SSE via raw http streaming (dependency-free): emit an unrelated event + a second artifact's update and assert only the target id's `{type:'update'}` is delivered (AC7). | This task IS the AC1–AC7, AC9, AC10 machine verification. `npm test` green. |
| T7 | Live-e2e: hot reload in a real browser (AC8) | Using the archie-e2e harness, boot the branch, have the PM publish a Markdown web artifact, open `/a/<id>` in a headless browser, update the artifact, assert the page re-renders with no manual refresh. If the QA boot cannot drive a browser, degrade per AC8: rely on the T6 narrow-SSE test as the machine-verified half and record a manual browser check as evidence. Capture per-scenario evidence files. | AC8 evidence: browser DOM shows updated content after update (or manual screenshot + the AC7 SSE integration test as the machine-verified half). |
| T8 | Add architecture doc | Add `docs/architecture/web-artifacts.md` describing the pointer-over-snapshot model, the PM-only publish/update tools, the viewer routes and narrow public SSE projection, the nosniff/sanitization posture, the auth-ready seam, and the explicit non-goals (HTML #224, separate origin, history/search, auth). Soft-wrap prose. Do not touch `CHANGELOG.md`. | Doc-only; sanity: links/paths referenced exist. |

## Verification plan

| AC | Method | Scenario | Evidence |
| --- | --- | --- | --- |
| AC1 | integration | Invoke `publish_web_artifact` with a Markdown file in the PM read sandbox; then GET `/a/<externalId>` on an ephemeral viewer instance. | Tool result contains a `/a/<uuid>` URL; task `metadata.json` has a `web_artifacts` entry with that external_id; GET returns 200 HTML. Assertions in `src/connectors/viewer/__tests__/viewer.test.ts`. |
| AC2 | integration | Publish, capture the URL, then call `update_web_artifact` with new Markdown for the same external id; GET before and after. | Update returns the identical `/a/<id>` URL; pointer snapshotPath changed; GET body reflects new content. |
| AC3 | unit | `publishWebArtifact` called for two distinct synthetic taskIds; inspect both external ids and URLs. | `web-artifacts.test.ts` asserts the two externalIds differ and neither the id nor the URL contains either taskId. |
| AC4 | integration | Publish Markdown containing headings/lists/links plus `<script>`, `<img onerror=...>`, and a `[x](javascript:...)` link; GET `/a/<id>`. | Rendered HTML shows headings/lists/links; no executable `<script>`, no `onerror` attribute, no `javascript:` href. Asserted in `viewer.test.ts` and the unit render test. |
| AC5 | integration | GET `/a/<id>/source` for a published Markdown artifact. | `Content-Disposition: attachment; filename="<original>.md"`, `Content-Type text/markdown`, `X-Content-Type-Options: nosniff`, body equals the original bytes. |
| AC6 | integration | Publish then update; read the task's `events.jsonl` via `readEvents` and via `GET /api/tasks/:id/events`. | `events.jsonl` contains `artifact:published` and `artifact:updated` entries carrying the correct taskId and `data.externalId`. |
| AC7 | integration | Open `/a/<X>/events` SSE (raw http read); emit an unrelated task event, an `artifact:updated` for a different id Y, and finally one for X. | Stream delivers exactly one `{type:'update'}` (for X); no taskId, no other event type, nothing from Y. |
| AC8 | live-e2e | Boot the branch via archie-e2e, PM publishes a Markdown artifact, open `/a/<id>` in a headless browser, then update. | Browser DOM shows the new content with no manual refresh. If no browser in the QA boot: the AC7 SSE integration test is the machine-verified half plus a manual browser screenshot. |
| AC9 | integration | Call `share_artifact` and `post_files_to_user` against a task, then inspect `WORKDIR/web-artifacts` and the task metadata. | No pointer file created and `metadata.web_artifacts` remains absent/empty. |
| AC10 | integration | Call `publish_web_artifact` with a `.html` file path. | Tool returns an error stating HTML web artifacts arrive in a later iteration (#224); no pointer file and no `web_artifacts` entry created. |
