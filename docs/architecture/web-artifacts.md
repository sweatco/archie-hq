# Web Artifacts

Web artifacts let Archie turn a Markdown file a task produced into a web page the user can open in a browser at a stable, unguessable URL. The PM publishes the file, hands the user a `/a/<externalId>` link, and can later revise the same link in place — open viewers hot-reload without the user doing anything. This iteration renders only Archie's own sanitized Markdown; `.html` is explicitly rejected and deferred to a follow-up (issue [#224](https://github.com/sweatco/archie-hq/issues/224)).

## The pointer-over-snapshot model

Web artifacts layer a stable public identity over the existing immutable artifact substrate rather than introducing a new content store. Two things are kept deliberately separate:

- **The snapshot substrate** — `copyArtifactToShared` (`src/agents/artifacts.ts`) copies a source file into the producing task's `<task>/shared/artifacts/<basename>.<8hex>.<ext>` folder, deduped by content hash. This is unchanged by web artifacts: it already gives us immutable, content-addressed, versioned copies for free.
- **The pointer layer** — a small JSON record that carries a stable `externalId` and points at the current snapshot. Publishing mints a new `externalId`; updating advances the pointer's `snapshotPath` to a fresh snapshot while keeping the same `externalId`. The link the user holds therefore never changes, even as the underlying content is re-snapshotted.

The pointer is the unit of public identity; the snapshot is the unit of immutable content. Keeping them separate is what makes "update in place, same link" and "immutable version history" both true at once.

### The pointer store

Pointers live in a global, file-per-id store under `WEB_ARTIFACTS_DIR` (`workdir/web-artifacts/<externalId>.json`, added to `src/system/workdir.ts` with a lazy `mkdir`; it is intentionally not part of the startup bootstrap mkdir set). The store is global — not nested under a task — because the viewer resolves an artifact from the `externalId` alone and never sees a `taskId`. Resolution is O(1): read one file by id. This mirrors the crypto-id / file-per-record patterns already used for triggers.

A `WebArtifactPointer` (`src/agents/web-artifacts.ts`) carries `externalId`, `taskId`, `snapshotPath` (absolute), `sourceFilename`, `format`, `createdAt`, and `updatedAt`. The `externalId` is a `crypto.randomUUID()` — unguessable, so possession of the link is the only thing needed to view the artifact (there is no other access control this iteration; see the auth-ready seam below). Note that the URL and the store record are the public face, but the `taskId` is stored only to gate updates — it is never exposed in the URL, the viewer, or the SSE projection.

The core module (`src/agents/web-artifacts.ts`) is pure over already-validated absolute paths. Path resolution, sandbox checks, and format-gating all happen in the tool layer that calls in; the module only mints ids, snapshots content, reads/writes pointer files, and renders sanitized Markdown. Its surface: `publishWebArtifact`, `updateWebArtifact`, `resolveWebArtifact`, `renderMarkdownArtifact`, plus `parseExternalId` and `webArtifactFormatError` helpers.

`updateWebArtifact` asserts `pointer.taskId === taskId` before advancing anything: an artifact can only be advanced from within its producing task, otherwise it throws a clear error. Cross-task update is out of scope.

### Task-metadata projection

Alongside the global pointer, each published artifact is also recorded on the producing task as a `WebArtifactRecord` (`src/types/task.ts`): `external_id`, `source_filename`, `format`, `created_at`, `updated_at`. This is `TaskMetadata.web_artifacts?: WebArtifactRecord[]` — an optional field that stays `undefined` at task creation and is defaulted (`metadata.web_artifacts ??= []`) by the publish tool on first push. Being optional, it is backward-compatible with on-disk tasks written before the field existed. This is a second write site, kept consistent with the pointer store under the same `task.save(true)` in the tool handler. The pointer store is the source of truth for the viewer; the task projection is what lets a task see (and re-address) the artifacts it produced.

## PM-only publish/update tools

Two MCP tools are registered in `createCommsMcpServer` (`src/agents/tools.ts`), alongside `post_files_to_user`. That server is wired only into the PM branch of `spawn.ts`, so both tools are **PM-only by construction** — specialist agents never get them.

- **`publish_web_artifact({ path, title? })`** — `assertReadable(path, ...)` (so the PM can only publish files it could already read, including the shared folder), then format-gates via `webArtifactFormatError`. `.html`/`.htm` is rejected with the #224 deferral message; any other non-Markdown extension is rejected with a generic message. On rejection nothing is created — no snapshot, no pointer, no metadata. Otherwise it calls `publishWebArtifact`, pushes a `WebArtifactRecord` into `task.metadata.web_artifacts` (`??= []`), `task.save(true)`, emits `artifact:published`, and returns the `/a/<externalId>` URL.
- **`update_web_artifact({ external_id_or_url, path })`** — parses the id out of a raw id or a `/a/<id>` URL (`parseExternalId`), `assertReadable`s the new path, calls `updateWebArtifact` (which enforces producing-task ownership), bumps the matching record's `updated_at`, `task.save(true)`, emits `artifact:updated`, and returns the same `/a/<externalId>` URL. Unknown or foreign ids surface as tool errors.

The returned link is the path form `/a/<externalId>` by default, prefixed with `ARCHIE_PUBLIC_BASE_URL` (trailing slash trimmed) when that env var is set so a deployment can hand the user an absolute URL. The PM-only tool contract is asserted in `src/agents/__tests__/tool-contract.test.ts`.

## Viewer routes and the narrow public SSE projection

`mountViewerRoutes(app)` (`src/connectors/viewer/routes.ts`) mounts the viewer on the shared Express app top-level, **outside `/api`** (called from `src/index.ts` right after `mountApiRoutes`). It is the only public projection of the pointer layer. All four routes resolve a pointer by `externalId` alone and 404 when the pointer file is absent (deleted snapshot / stale link).

- **`GET /a/:externalId`** — resolves the pointer, reads the snapshot `.md`, renders it, and wraps the sanitized HTML in first-party viewer chrome: a title, a "Download source" link, and an inline script that opens `EventSource('/a/:externalId/events')` and, on each signal, re-fetches `/a/:externalId/body` and swaps it into the content container (falling back to leaving current content in place if the fetch fails).
- **`GET /a/:externalId/body`** — the sanitized rendered HTML fragment only, used by the hot-reload swap so re-render goes through one shared render path.
- **`GET /a/:externalId/source`** — the original snapshot bytes as a download: `Content-Disposition: attachment; filename="<sourceFilename>"`, `Content-Type: text/markdown; charset=utf-8` (the filename is sanitized against header injection).
- **`GET /a/:externalId/events`** — the narrow public SSE projection. It subscribes to the single in-process event bus via `onEvent`, forwards only `artifact:published` / `artifact:updated` events whose `data.externalId` matches this exact `externalId`, and emits only a minimal `data: {"type":"update"}` signal — never the `taskId`, never any other event or artifact. It deliberately does **not** reuse `/api/events/stream`. Keepalive and `req.on('close')` cleanup (clear the interval, `offEvent` the listener) mirror the existing stream.

### Event vocabulary and persistence

The bus `EventType` union (`src/system/event-bus.ts`) gains `'artifact:published'` and `'artifact:updated'`, both emitted with the producing task's `taskId` and `data: { externalId }`. Because event persistence already mirrors every bus event to `<task>/shared/events.jsonl` keyed by `taskId`, these events are persisted and retrievable via `GET /api/tasks/:id/events` for free — no new persistence code. The SSE projection consumes the same bus but exposes a far narrower, id-scoped, taskId-free slice of it.

## Security posture

- **Sanitization.** `renderMarkdownArtifact` renders with `markdown-it({ html: false, linkify: true })`, then sanitizes the output with DOMPurify bound to a jsdom window. `html: false` escapes raw `<script>` / `<img onerror>` in the source and markdown-it already refuses `javascript:` / `vbscript:` hrefs; DOMPurify is defense-in-depth over the rendered HTML. A module-level DOMPurify singleton (one jsdom window) avoids per-request jsdom construction.
- **`nosniff`.** Every route that returns artifact content or the source download sets `X-Content-Type-Options: nosniff`.
- **Read-scope inheritance.** Publishing/updating goes through `assertReadable`, so the PM can only publish files it could already read — an artifact can never expose a file outside the PM's sandbox.
- **Id validation.** The `externalId` is validated against the UUID shape before it is ever used to build a store path (`getPointerPath` requires both the UUID shape and that the resolved path sits directly inside `WEB_ARTIFACTS_DIR`), which breaks any path-traversal taint flow. `parseExternalId` returns a validated id or `null`.

## Auth-ready seam

No authentication ships this iteration: possession of the unguessable link is the only gate. The viewer and its SSE are isolated in their own routes file and use path-based ids, so a future access token can live in the path or query without disturbing anything else. The SSE route is GET-only and header-less on purpose (an `EventSource` cannot set request headers) — that constraint is exactly why the auth seam is designed around the path/query rather than a header.

## Non-goals

Deliberately out of scope for this iteration:

- **HTML rendering** — `.html`/`.htm` is rejected with a message pointing at the deferral; HTML support is issue [#224](https://github.com/sweatco/archie-hq/issues/224).
- **A separate origin** — the viewer is served from the shared Express app, not an isolated host.
- **History / search UI** — no browsing of past artifacts, no cross-task search. (Version history exists implicitly in the snapshot substrate, but there is no UI over it.)
- **Authentication / authorization** — no login, no per-user access; the unguessable link is the boundary.
- **Cross-task update** — an artifact is advanced only from within its producing task.

## Related Documents

- [Persistence](./persistence.md) — task directories, shared artifacts, event mirroring
- [Security](./security.md) — sandboxing, read-scope rules, human gates
- [System Orchestration](./orchestration.md) — the in-process event bus and runtime state
