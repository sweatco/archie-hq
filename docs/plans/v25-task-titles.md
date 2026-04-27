# Task Titles — Implementation Plan

## Context

Tasks today are identified by `task_id` (timestamp + random) and `channel_name` (e.g. `DM with Egor`). Neither communicates what the task is about. Goal: generate a Haiku-authored one-line title at task creation, surface it via API + CLI, and push it to Slack DM thread titles via `assistant.threads.setTitle` for DM-originated tasks.

Trigger: every `task.append(thread)` in `events.ts`, fire-and-forget, guarded by `if (!task.metadata.title)` so pre-feature tasks pick up a title on next interaction. Once set, never regenerated. No active backfill.

## Scope

- All tasks (DMs and channel mentions) get a title.
- Slack-side title sync only applies to DM tasks (Slack API does not support setting titles for non-assistant channel threads).
- Title generated for any task that doesn't already have one, guarded by `if (!task.metadata.title)`. Guard fires for new tasks AND resumed pre-feature tasks — old tasks pick up a title organically on next interaction. Once set, never regenerated.
- No active scan / backfill. Inactive pre-feature tasks stay title-less unless a Slack event re-touches them.

## Out of Scope

- Active backfill job.
- Title regeneration when conversation pivots topic.
- PM agent override / update via tool.
- User-facing title editing.
- Setting Slack thread titles for non-DM channels (API does not support it).

## Phases

Five phases, sequenced. Each compiles and typechecks independently.

---

### Phase 1 — Type + render-helper extraction

**Goal:** Add optional `title` to metadata; extract body-rendering from `appendSlackMessage` with byte-exact parity. Pure refactor — no behavior change.

**Files:**

- `src/types/task.ts` — add `title?: string` to `TaskMetadata` (between `default_channel` and `slack_threads`). Optional → backwards compatible, no migration.

- `src/tasks/persistence.ts` — extract `renderMessageForContext()`:

  ```ts
  export function renderMessageForContext(
    msg: { user: SlackAuthor; text: string; files?: SlackFile[]; attachments?: SlackAttachment[] },
    options: { redacted: boolean }
  ): string
  ```

  Move body lines 198–231 verbatim. `appendSlackMessage` keeps signature; replaces those lines with one call to the helper. Lines 233–253 (displayName masking, `LogEntry`, `appendFile`, `emitEvent`) stay in `appendSlackMessage`.

  **Parity guarantee:** identical conditional ordering, identical `\n` joins, identical `[Attachments: ...]` and `[forwarded from ...]` formatting. Verify via diff against an old log post-refactor.

---

### Phase 2 — Title generator + Slack title wrapper

**New file `src/tasks/title-generator.ts`:**

```ts
export async function generateTaskTitle(thread: SlackThread): Promise<string | null>
```

Pattern mirrors `src/mcp/research-tools.ts:53-102` (NOT `triage.ts` — skip `processAgentEventForLogging` to keep noise low):

1. Per message, compute `redacted = thread.shared && isExternalUser(msg.user)`. Render via `renderMessageForContext(msg, { redacted })`. Author label: `'external'` when redacted else `realName`.
2. Concatenate transcript lines `[<author>]: <body>`.
3. **Skip-LLM guard:** if all rendered bodies equal the redaction placeholder or are empty, return `null` — no LLM call.
4. Zod schema: `z.object({ title: z.string() })`. Convert via `toJSONSchema` (zod 4 native, matches `research-tools.ts`).
5. `query()` opts: `model: 'haiku'`, `cwd: SESSIONS_DIR`, `executable: 'node'`, env `{ NODE_ENV, ANTHROPIC_API_KEY, PATH }`, `allowedTools: []`, `outputFormat: { type: 'json_schema', schema }`. System prompt:

   ```
   You generate a concise title for a task based on the initial conversation that started it.

   Rules:
   - Maximum 60 characters
   - Free-form style (imperative, noun phrase, question — whatever fits)
   - No quotes, no trailing punctuation
   - Match the conversation's primary language
   - Capture the actual subject, not generic phrases
   ```

   Output structure enforced by `json_schema` outputFormat — no need to instruct shape in prompt.
6. Iterate events; on `event.type === 'result'`:
   - `subtype === 'success'`: `safeParse`, take `title`, `.trim()`, strip surrounding quotes + trailing punctuation `[.!?…]+$`, slice 60 chars. Empty → `null`.
   - other subtypes: `logger.warn('title-generator', ...)`, return `null`.
7. Outer try/catch → log + `null` on throw.

**Files attached to messages:** never sent to title generator (titles only need text).

**No retry.** Single attempt. Slack DMs fall back to first-message preview natively.

**Failure modes:**

| Failure | Behavior |
| --- | --- |
| Haiku call fails (network/API) | `logger.warn`, returns `null` |
| Haiku returns malformed JSON / fails schema | `logger.warn`, returns `null` |
| Empty/whitespace title after cleaning | returns `null` |
| All rendered messages are redaction placeholders | skip LLM call entirely, return `null` |
| `setAssistantThreadTitle` fails | warn logged, swallowed; metadata title still persisted |
| `assistant:write` scope missing | API error → warn logged, swallowed |

**New file `src/connectors/slack/title.ts`:**

```ts
export async function setAssistantThreadTitle(
  client: WebClient, channel_id: string, thread_ts: string, title: string
): Promise<void>
```

Try/catch around `client.assistant.threads.setTitle(...)`. Errors → `logger.warn('slack-title', ...)`, swallowed. Caller (events.ts) only invokes for DM channels.

---

### Phase 3 — Tests

Follow `pr-tools.test.ts` style (`vi.mock` at top).

**`src/tasks/__tests__/title-generator.test.ts`** — mock `query` from `@anthropic-ai/claude-agent-sdk` as async generator. Cases:
- success → trimmed title ≤60 chars
- title with quotes + trailing period → cleaned
- >60 chars → truncated
- empty/whitespace from model → `null`
- `subtype: 'error_during_execution'` → `null`, warn logged
- thrown query → `null`
- fully-redacted thread → `query` NOT called, returns `null`
- mixed thread → external bodies redacted in transcript, internal intact
- internal author + external attachment → `[forwarded from ...]` label in transcript

**`src/tasks/__tests__/persistence.test.ts`** — direct unit tests on `renderMessageForContext`:
- plain message → text only
- message + files → `\n  [Attachments: name (path)]` suffix
- redacted → exactly `'[redacted: external participant in shared channel]'`
- internal + external attachment → forwarded label + content
- multiple attachments, only first external → second folds inline (matches current behavior)
- empty message + attachments only → no leading newline

Skipping `setAssistantThreadTitle` test (5-line try/catch). Skipping events.ts integration tests — covered by manual verification.

---

### Phase 4 — Wiring

**`src/connectors/slack/events.ts`** — add `generateTitleAndSync` helper at top-level (co-located with sole caller, keeps `task.ts` slim):

```ts
async function generateTitleAndSync(task: Task, thread: SlackThread): Promise<void> {
  const title = await generateTaskTitle(thread);
  if (!title) return;
  task.metadata.title = title;
  task.debouncedSave();
  if (thread.channel.id.startsWith('D')) {
    await setAssistantThreadTitle(getSlackClient(), thread.channel.id, thread.threadId, title);
  }
}
```

Add imports: `generateTaskTitle`, `setAssistantThreadTitle`, `getSlackClient`, `SlackThread`.

**Trigger guard** — at both call sites in `handleSlackEvent`, immediately after `await task.append(thread)`:

```ts
if (!task.metadata.title) {
  generateTitleAndSync(task, thread).catch((err) =>
    logger.warn('title-generator', `pipeline failed: ${err}`)
  );
}
```

Both sites: existing-task path (~line 376) and new-task path (~line 384). Fire-and-forget — PM agent doesn't block on Haiku.

**Race note:** guard is non-atomic. Two events on same thread within Haiku roundtrip can both fire. Outcome: extra LLM call, second `debouncedSave()` writes same field. Acceptable — no corruption.

---

### Phase 5 — API + CLI surfaces

**`src/connectors/api/routes.ts`** — `GET /api/tasks` (lines 98-108): add `title: metadata.title ?? null` to summary object. `GET /api/tasks/:id` already returns full `metadata` — `title` flows automatically.

**`src/cli/components/TaskList.tsx`** — add `title?: string | null` to `TaskSummary` interface. In render block (lines 175-189): keep current layout (task_id + channel as today), append title trailing after channel when present. Example row:

```
> [+] task-20260425-2136-abcd  #bot-test  Fix iOS login crash on cold start  3 active
```

Title text should not be dim (primary content); channel stays as it is. Truncate-end already applies via `wrap="truncate-end"`.

**`src/cli/components/TaskDetail.tsx`** — `detail.metadata` already fetched (line 168). Add `setTitle` state alongside `setStatus`/`setReminder`. Header (lines 343-357): render `metadata.title` prominently when present; fall back to `channel_name`.

---

## Data Flow

```
Slack DM or channel mention received
  → events.ts: resolve task (Task.create() OR fetch existing)
  → task.append(thread)            // messages persisted (with redaction)
  → if (!task.metadata.title) {
       fire-and-forget: generateTitleAndSync(task, thread)
         ├─ generateTaskTitle(thread)          [renders via shared helper, Haiku via query()]
         ├─ on success: metadata.title = result, debouncedSave()
         └─ if originating channel is DM:
              setAssistantThreadTitle(channel_id, thread_ts, title)
    }
  → task.sendMessage(...)   // PM / agent not blocked
```

## Slack API Notes

- `setAssistantThreadTitle` wraps `client.assistant.threads.setTitle({ channel_id, thread_ts, title })`.
- Required Slack scope: `assistant:write`. Agents & AI Apps feature toggle must be enabled for the bot.
- Caller responsibility: only invoke for DM channels (channel_id starts with `D`). Channel-mention tasks skip Slack-side title sync.

## Critical Files

- [src/types/task.ts](src/types/task.ts) — TaskMetadata field
- [src/tasks/persistence.ts](src/tasks/persistence.ts) — extract renderMessageForContext
- [src/tasks/title-generator.ts](src/tasks/title-generator.ts) — new
- [src/connectors/slack/title.ts](src/connectors/slack/title.ts) — new
- [src/connectors/slack/events.ts](src/connectors/slack/events.ts) — wiring
- [src/connectors/api/routes.ts](src/connectors/api/routes.ts) — list response
- [src/cli/components/TaskList.tsx](src/cli/components/TaskList.tsx) — list rendering
- [src/cli/components/TaskDetail.tsx](src/cli/components/TaskDetail.tsx) — header rendering

## Reused Utilities

- `renderMessageForContext` (extracted from `appendSlackMessage`) — single source of truth for redaction + forwarded-attachment rendering
- `isExternalUser` from `src/connectors/slack/client.ts:792`
- `getSlackClient` from `src/connectors/slack/client.ts:105`
- `query` pattern from `src/mcp/research-tools.ts:53-102`
- `toJSONSchema` from `zod` (matches research-tools.ts)
- `task.debouncedSave()` and `task.metadata` mutation pattern (already used by `sendSharedChannelWarnings`)

## Verification

End-to-end manual checks after Phase 5:

1. **DM new task** — DM bot with substantive content. Within ~10s: CLI list shows title; Slack DM thread title updates; `metadata.json` has `.title`; knowledge.log byte-identical to pre-refactor (diff old log).
2. **Channel mention** — `@archie ...` in public channel. Title in metadata + CLI; Slack thread title NOT updated (channel_id starts with `C`).
3. **Pre-feature task resume** — old task without `title`, send follow-up. Title generated; subsequent messages do NOT re-trigger (no extra warns in logs).
4. **API key missing** — unset `ANTHROPIC_API_KEY` for events scope. Task creates; PM runs; `title-generator` warn logged; CLI falls back to channel_name.
5. **Fully-redacted thread** — Slack-Connect channel, only external posters. Title generator returns `null` without `query()` call (verify via log absence). CLI falls back.
6. `npm run typecheck` passes after each phase.
7. `npm test` passes (vitest) — new tests + existing 2 test files green.

## Decisions Confirmed

- **TaskList layout:** channel first, title trailing (keeps current layout intact, appends title after channel).
- **Race lock:** none. Non-atomic guard is acceptable; rare duplicate Haiku call lands on same field, no corruption.
- **`setAssistantThreadTitle` test:** skipped (wrapper is 5 lines).

## Outstanding Risk

- `assistant:write` scope must be on deployed bot token. If missing, `setTitle` returns API error → swallowed warn, metadata title still persists. Worth one-time scope audit before rollout.
