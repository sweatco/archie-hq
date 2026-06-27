# Plan — Per-Channel "Archie" Canvas as Project Context

## Context

Today Archie's context is per-thread: each Slack thread becomes a task, and the only standing instructions an agent sees come from the PM prompt plus plugin skills. There is no way to give a *channel* durable, project-level instructions (a spec, conventions, a pin code, links to reference files).

This feature lets a team drop a canvas titled `Archie…` into a Slack channel (as a canvas tab). Archie reads it bot-token-only, converts it to markdown, and injects it into the PM agent as channel project context for every task in that channel — effectively a per-channel `CLAUDE.md`. Files referenced inside the canvas are fetched on demand by the PM. Each channel becomes a project.

All read/convert/extract mechanics were validated end-to-end against the real `#bot-test` canvas with a bot token (per the user's feasibility findings). Proven facts that anchor this plan:

- A canvas reads as a **file**: `files.info` → `url_private_download` → bot Bearer GET → **HTML**.
- Only **`files:read`** is needed (already held). `canvases:read` / `bookmarks:read` are inert — do not add them.
- Canvas body is HTML → convert with the supplied `turndown`-based helper, which also extracts referenced file ids in one pass.
- Referenced files download in native format; **nested canvases** are `filetype: "quip"` → recurse.
- Creator is `files.info.user` → trust gate.

---

## Locked scope

| Decision | Resolution |
| --- | --- |
| Discovery | `conversations.info` → `channel.properties.tabs[]` where `type === "canvas"` → `data.file_id`; keep those whose title starts with `Archie` (case-insensitive). Load all matches, labelled by title. No bookmarks, no `meeting_notes`. |
| Surfaces | Public + private channels only. No DMs / group DMs. |
| Trust gate | Ignore a canvas whose creator (`files.info.user`) is external (`isExternalUser`). Editor identity is irrelevant. |
| Injection | Canvas markdown → PM system prompt only, wrapped in XML tags (one `<canvas title="…">` element per canvas) so it stays contained; trust level = user instruction, never a gate bypass. Specialists get relevant slices via normal PM delegation. |
| Referenced files | No pre-download. A PM-only MCP tool fetches a reference on demand into the PM's own workspace; the PM hands files to teammates via the existing `share_artifact`. The tool branches on `filetype` internally — the agent never picks "canvas vs file". |
| Refresh | Driven by the canvas file's `files.info.updated` timestamp, cached in a channel-level store. Re-read the body only when it advances. No hashing. |
| Announcements | One-time top-level channel post when a canvas is adopted or ignored (external creator), fired on `member_joined_channel` and as a first-interaction backstop. Updates are silent. |
| Scopes | None new (`files:read` held). Add only the `member_joined_channel` event subscription. |
| PM skill | New skill teaches the relay discipline (PM is sole reader; surface what matters; authoring convention for referencing files). |

---

## Architecture

```
inbound Slack msg / member_joined_channel
        │
        ▼
ensureChannelCanvas(channelId)                      ← new; events.ts calls it
  conversations.info → properties.tabs[canvas] → file_ids titled "Archie*"
  for each: getSlackFileInfo(fileId) → { updated, creator, title }
    creator external?  → store.ignored = true; announce-ignored (once)
    changed vs store?  → readCanvas(fileId) → { markdown, fileIds }; update store
  not yet announced + adopted? → announce-adopted (once)
        │ writes
        ▼
Channel store  $ARCHIE_WORKDIR/slack/channels/<channelId>.json   ← new, platform-namespaced
  { canvases: [{ file_id, title, creator, external, updatedTs, markdown, fileIds }], announced, checkedAt }
        │ read at spawn
        ▼
spawn.ts (PM branch) → inject "Channel Project Context" (all canvases' markdown)
        │
        ▼  PM follows a reference on demand
fetch_slack_reference(ref)  (PM-only, comms-tools)
  files.info(filetype): "quip" → readCanvas → write .md to PM workspace
                         else  → downloadSlackFile → PM workspace
  returns workspace path; PM may then share_artifact to a teammate
```

`readCanvas` and `downloadSlackFile` are internal functions; the only agent-facing surface is `fetch_slack_reference`.

---

## Hard gate (resolve before building)

**Confirm the SDK applies a *changed* system prompt on resume.** The whole "inject canvas into the PM system prompt and let refreshes propagate each wake" approach depends on it. Repo evidence says yes — `buildQueryOptions` re-sends `systemPrompt` on every query (`spawn.ts:493-546`; `resume` is just a session id), and org-memory injection (`enrichPromptWithMemory`, `spawn.ts:474`) already relies on per-spawn re-application. But the SDK source is not in `node_modules` to inspect, so verify empirically first (see Verification step 2). If it fails, switch injection to the `existingTask` wake-prompt path — same content, different delivery.

---

## Changes — archie-hq

### 1. Canvas HTML→markdown helper — new module

- **New file** `src/connectors/slack/canvas-markdown.ts`: port the user-supplied `canvas-html-to-md.mjs` to TS. Export `canvasHtmlToMarkdown(html): { markdown, fileIds }`.
- Keep the four custom rules verbatim (lnk / embedded-file card / control / img) and the U+200B strip — they encode the proven extraction matrix.
- **Deps**: add `turndown` + `turndown-plugin-gfm` to `package.json` (and `@types/turndown` dev).

### 2. Slack client helpers — `src/connectors/slack/client.ts`

- **`getChannelCanvasTabs(channelId)`** near `getChannelInfo` (~1029): call `conversations.info`, read `channel.properties.tabs[]` (cast the result — nothing reads `properties` today), return `[{ file_id, title? }]` for `type === "canvas"`. Wrap in a TTL cache mirroring `isChannelShared` (~950-994, 60s).
- **`getSlackFileInfo(fileId)`**: new `client.files.info({ file })` call (none exist today). Return `{ url_private_download, filetype, user (creator), title, updated }`. Refresh is keyed on `files.info.updated` (the edit timestamp), not `created`/`timestamp`.
- **`fetchSlackFileBody(url): Promise<string>`**: sibling of `downloadSlackFile` (~1102) that returns the body as a UTF-8 string instead of writing to disk. TRAP — do NOT reuse `downloadSlackFile`'s `text/html`→throw guard (~1130-1141): canvas bodies are legitimately `text/html`; that guard exists to catch Slack auth/login pages. Keep the Bearer auth and `response.ok` check, but return the HTML body rather than throwing on `text/html`.
- **`readCanvas(fileId): Promise<{ markdown, fileIds, title, creator, updatedTs }>`**: `getSlackFileInfo` → `fetchSlackFileBody(url_private_download)` → `canvasHtmlToMarkdown`. The canvas-read primitive used by ingest, recursion, and the fetch tool's canvas branch.

### 3. Channel-level store — new

- **New file** `src/system/channel-store.ts` (or extend persistence). Path `getChannelStorePath(channelId)` = `join(WORKDIR, 'slack', 'channels', '<channelId>.json')` — workdir-level (not per-task), namespaced under `slack/` so other messaging platforms can keep sibling stores later. Modeled on `PLUGINS_DATA_DIR` (`src/system/workdir.ts:39`) and the JSON read / atomic-write / `mkdir{recursive}` pattern in `persistence.ts`.
- Shape: `{ canvases: Array<{ file_id, title, creator, external, updatedTs, markdown, fileIds }>, announced: Record<file_id, true>, checkedAt }`.
- `loadChannelStore(channelId)` / `saveChannelStore(channelId, data)`.
- **Concurrency (required)**: `handleSlackEvent` is fire-and-forget (`events.ts:141,195`), so two events in the same channel (or a join racing a first-interaction) can call `ensureChannelCanvas` concurrently. Add an in-process per-channel async mutex / single-flight keyed by channelId around the whole read→update→write cycle. Atomic file write alone is not enough — it prevents torn files, not lost updates (which would drop the `announced` flag and double-announce).
- **Restart invariant**: the persisted `announced` map is authoritative. In-process TTL caches are empty after a restart but the store survives; `ensureChannelCanvas` must consult persisted `announced` so a restart never re-announces.

### 4. Canvas orchestration — new

- **New file** `src/connectors/slack/channel-canvas.ts` exporting **`ensureChannelCanvas(channelId): Promise<void>`**:
  - `checkedAt` TTL short-circuit (~60s) to bound API calls per inbound.
  - `getChannelCanvasTabs` → filter title `^Archie`i → for each `getSlackFileInfo`.
  - External creator (`getUserInfo` + `isExternalUser`, reused from client.ts) → mark store ignored; `announceCanvas(channelId, 'ignored', title)` if not already announced.
  - Changed `updated` (or new) and internal creator → `readCanvas` → update the store entry (markdown / fileIds / updatedTs); `announceCanvas(channelId, 'adopted', title)` if not already announced.
- **`announceCanvas`** posts a top-level message via `postSlackMessage({ channel, text })` (`client.ts:175`) — no task required — and records `announced[file_id] = true`.

### 5. Event wiring — `src/connectors/slack/events.ts`

- In `handleSlackEvent` (~417, after `fetchSlackThread`, before waking the PM): `await ensureChannelCanvas(event.channel)` for non-DM channels (first-interaction backstop + refresh). Skip channel ids starting with `D`.
- **New handler** `app.event('member_joined_channel', …)` after the `message` handler (~197): guard `getIsShuttingDown()` first (like every other handler, `events.ts:124,154,178`); then if `event.user === getBotUserId()` (bot self-join) call `await ensureChannelCanvas(event.channel)`; ignore other members' joins. Note: `routeSlackEvent` (own-bot filter) is not on the join path, so this explicit self-join check is load-bearing — there is no upstream dedup.

### 6. PM prompt injection — `src/agents/spawn.ts`

- In the PM branch, after the shared-channel NOTE (~307) and before `def.pmOverlayPrompt` (~310): for each linked slack channel in `metadata.channels` (extract `channelId` from the `slack:<channelId>:<ts>` key), `loadChannelStore(channelId)`; if it has non-external canvases, append an XML-wrapped block so the injected content is clearly contained and can't bleed into the surrounding prompt.
- Wrap the whole block in a single container element framed as standing user instructions (not system authority), and wrap **each canvas in its own `<canvas title="…">…</canvas>` element** (title as an attribute). The markdown body goes inside the element verbatim. Per-canvas tags mean colliding `Archie*` titles need no disambiguation — each is independently delimited.
- See the Hard Gate section for the resume dependency and the wake-prompt fallback.

### 7. PM-only fetch tool — `src/agents/tools.ts`

- **`createFetchSlackReferenceTool(agent, task)`** following the `tool()` + `ok()/err()` shape; input `reference: z.string()` (a Slack file URL or a bare `F…` id).
- Normalize → `fileId` (extract `F…` from a `/files/<U>/<F>/…` URL, or accept a bare id).
- Workspace path = `requireSandbox(agent).cwd` (the PM's RW workspace; `spawn.ts:197-198,234`). Read it from the sandbox — do not reconstruct it.
- `getSlackFileInfo(fileId)` → branch on `filetype`: `"quip"` → `readCanvas` → write `markdown` to `<cwd>/<title>.md` → return path (PM can recurse on links inside); else → `downloadSlackFile(url_private_download, <cwd>/<name>)` → return path.
- Returns the saved path plainly (e.g. `ok("Saved to <path>.")`) — no tool names, no next-step prescription in the agent-facing message; the PM decides what to do with it. The file lands in the PM's own workspace, not shared (`sharedPath` is read-only to the PM, `spawn.ts:300`); how the PM later hands it to a teammate is left to the PM's existing judgement.
- Register in `createCommsMcpServer` (~1721) — PM-only automatically, since only the PM gets `comms-tools` (`spawn.ts:314`); no allow-list change.
- Add a status fragment in `commsToolPhrase` (`src/agents/activity.ts` ~194), e.g. "pulling in a reference".
- **Converter→tool contract**: `canvasHtmlToMarkdown` must emit references the PM can pass to this tool — full `/files/<U>/<F>/…` URLs or bare `F…` ids (the converter's `fileIds` array is the natural bridge). The injected markdown is the PM's only source of references, so anything that lands as `[unreadable embed]` (a collapsed title chip) is genuinely unfetchable — surface it, don't fail.

### 8. Manifest — `slack-manifest.yaml`

- Add `member_joined_channel` to `event_subscriptions.bot_events`. No new scopes; verify on manifest re-import that `channels:read` / `groups:read` cover event delivery (public and private), and do not assume private-channel delivery without checking.

---

## Changes — archie-plugins

### 9. PM skill — new

- **New file** `pm/skills/channel-canvas/SKILL.md`. Teaches concepts only — no tool names, no prescribed sequence; the PM already knows how to delegate, share material, and reply, so the skill states intent and judgement and lets the PM execute.
- What it conveys: a channel's canvas is standing project intent for everything that happens in that channel; the PM is the only one who can see it and open what it points to, so the PM owns carrying the relevant understanding — and any referenced material a teammate actually needs — to that teammate with enough context to act, rather than assuming others can see it. Bring across only what's relevant, not the whole document.
- Authoring guidance the PM passes on to people: attach files so Archie can open them (a file referenced as a link or an expanded preview is readable; a file reduced to a bare title is not); if something referenced can't be opened, ask for it directly.
- Discovery is automatic (`spawn.ts:110-127` symlinks `pm/skills/*`). Nothing is added to the `pm/agents/pm.md` overlay — that surface holds business context only, not engine behaviour.

---

## Out of scope (noted, not built)

- Join-time proactive task (announce + scan history + suggest help). The `member_joined_channel` handler + channel store are the hooks it would later build on.
- Honoring canvases in shared/Connect channels, DMs, group DMs.
- Archie writing back to canvases (`canvases:write`).

---

## Verification

1. **Unit — converter**: add a vitest that feeds the captured `#bot-test` canvas HTML fixture and asserts `markdown` contains the prose + the two `[file](…)` links, and `fileIds === [F0BDH8SN79P, F0BE9MEESC8]`.
2. **Resume behavior — HARD GATE (do first)**: empirically confirm the SDK applies a changed system prompt on resume. Quickest check: start a PM session, change the injected canvas text, wake the PM, confirm it sees the new text (or add a temporary sentinel line and confirm it appears after resume). If it fails, switch to the wake-prompt fallback before building anything else.
3. **Live, bot token (local)** with the dev bot in `#bot-test`:
   - Mention Archie in the channel → assert the channel store file appears with the adopted canvas markdown + `fileIds`, and a single top-level "now using **Archie — bot-test**" announcement posts.
   - Start a task in the channel → confirm the PM's composed system prompt contains the "Channel Project Context" section.
   - Ask the PM in-thread to load a referenced file → confirm `fetch_slack_reference` saves it to the PM workspace and the PM reads it; confirm `share_artifact` hand-off to a specialist works.
   - Edit the canvas, send another message → confirm the body refreshes (timestamp) and no new announcement posts.
   - Point the trust gate at an external-created canvas (or stub `isExternalUser`) → confirm it is ignored + the "ignored, external creator" announcement.
   - Bot self-join: re-add the bot to a channel that already has an `Archie*` canvas → confirm the join announcement.
   - Restart dedup: after a canvas is announced, restart the process and send another message → confirm no re-announcement (persisted `announced` is authoritative).
4. **Regression**: `npm run typecheck` + `npm run build`; existing Slack/event tests pass; the message-attachment download path (shared `downloadSlackFile`) is unchanged.
