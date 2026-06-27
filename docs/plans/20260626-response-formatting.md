# Archie response formatting: message footer + PR cards

## Context

Archie's Slack replies today are a single CommonMark `markdown` block with no metadata — there's no way for a user to see which task/session a message belongs to or which model the PM is running, and when a repo agent opens a PR the user only learns about it if the PM happens to paste the URL. We want every Archie reply to carry a small footer (task id + PM model), and we want pull requests to surface as compact, self-updating "cards" — like the Code section in the Claude desktop app — so it's obvious a PR opened, how big the change is (`+/−`, files), its state, and CI result, with a link.

This is entirely an **archie-hq** core-engine change. No `archie-plugins` changes are required.

Agreed behaviour (from discussion):
- **Footer** on **every** Archie message, on **both surfaces** (Slack + CLI): `task-id` as plain text (no share link yet) + the **resolved** PM model name (e.g. `claude-opus-4-8`), preserving the `[1m]` marker when the 1M window is on.
- **PR cards** render on **both surfaces** (Slack + CLI). They are coalesced: nothing is posted while the PM is mid-turn. When the PM **yields its turn back to the user** (its completion/turn-ending tools), if a PR changed since its last card, the card is **(re)posted at the bottom** so it lands right under the PM's final message (on Slack the old card is deleted and reposted; on CLI it re-anchors to the bottom).
- **CI status changes** and **state changes** (merged/closed) arrive via their own GitHub webhooks and **update the existing card in place** (no resurface — there's no accompanying PM message).
- Merged/closed cards show the final state and then stop changing.
- Each PR in a task has its own independently-tracked card.

---

## Part 1 — Message footer (task id + PM model), Slack + CLI

**Goal:** a small grey footer under every narrative message Archie posts — a Slack `context` block on Slack, and a dimmed line in the CLI.

### Changes

1. **`src/tasks/task.ts` — footer builder**
   - Add a private `buildUserFooter(): string` returning `${taskId} · ${pmModelLabel}` as **plain text** (no backticks — the footer is plain grey on Slack and the CLI doesn't render markdown; matches the reference screenshot). One place; leave the bare `taskId` easy to wrap in a `<url|taskId>` link later — no link work now.

2. **`src/connectors/slack/client.ts`**
   - Add an optional `footer?: string` param to `postSlackMessage(args)`. When present, render blocks as `[markdownBlock(text), { type: 'context', elements: [{ type: 'mrkdwn', text: footer }] }]`. Footer text is short/mention-restored, so no length assertion needed on it. Single render chokepoint for narrative messages; `context` blocks are new here but standard Slack shape.

3. **`src/tasks/task.ts` — `postToUser()` (lines ~340-403)**
   - Pass `buildUserFooter()` into all four `postSlackMessage(...)` branches (default channel, specific channel, new DM, new thread).
   - For **CLI parity**, include the footer in the emitted `message` event so the CLI can render it (Part 2, step 11): have `logOutgoingMessage` add `footer: buildUserFooter()` to the `emitEvent('message', …)` data. Slack ignores this field (it uses the context block); the CLI renders it dimmed under the message.

4. **PM model resolution + label**
   - The PM's model is `def.model || 'opus'` (resolved in `src/agents/spawn.ts:213` — same `isPmAgent(def) ? 'opus' : 'sonnet[1m]'` expression). Read it from the task's PM agent: `this.agentProcesses.get('pm-agent')?.def.model ?? 'opus'` (use the existing PM lookup / `isPm` rather than hardcoding the key if one exists).
   - Add a small `modelDisplayLabel(model: string): string` helper that resolves the short name to the **full model name** and **preserves the `[1m]` suffix**: split off a trailing `[1m]`, map the base (`opus → claude-opus-4-8`, `sonnet → claude-sonnet-4-6`, `haiku → claude-haiku-4-5`; pass through any already-full id), then re-append `[1m]` if present. So `sonnet[1m] → claude-sonnet-4-6[1m]`, `opus → claude-opus-4-8`. Co-locate with the model-resolution logic in `spawn.ts` (or a tiny `src/agents/model-label.ts`).
   - Note: the PM default `opus` carries no `[1m]` (Opus is 1M natively), so the default PM footer reads `claude-opus-4-8`; a `pm` overlay pinning `opus[1m]`/`sonnet[1m]` would surface the marker. The stale `AgentModel` union at `src/types/agent.ts:53` is unrelated.

---

## Part 2 — PR cards: one event, two renderers

**Goal:** compact, self-updating PR cards on both surfaces — a Slack message in the task thread and a rendered block in the CLI — coalesced to PM turn-ends, updated in place on async webhook updates.

**Architecture.** The card is driven by a new channel-agnostic **`pr_card` event** on the existing event bus. Core computes a card snapshot and emits the event; the surfaces are renderers:
- The event carries `{ cardId, action, repo, prNumber, url, title, state, additions, deletions, changed_files, ci }`, where `cardId = "${repo}#${prNumber}"` and `action` is `'post'` (create/resurface → re-anchor to bottom) or `'update'` (edit in place → don't move).
- It streams to **all** SSE consumers automatically (CLI today, any future web UI) — no per-consumer wiring.
- For tasks with a **Slack** channel, core *additionally* posts/deletes/updates a Slack message.

### Card design (compact, 2 lines) — same content on both surfaces

```
🔀 sweatco/archie-hq #482 — Add response footer + PR cards
+214 −38 · 7 files · ✅ checks passed
```
- Slack: a `section` (`mrkdwn`) title line + a `context` stats line; repo `#number` links to the PR (`<url|repo #number>`).
- CLI: the same two lines as Ink `<Text>` (state icon + colored stats); URL printed plain (terminals linkify it).
- State icon leads: `🔀` open · `🟣` merged · `🚫` closed. CI trails stats: `⏳ checks running` · `✅ checks passed` · `❌ checks failed`; omitted when the PR has no checks.

### Event type

4. **`src/system/event-bus.ts`** — add `'pr_card'` to the `EventType` union. The SSE endpoint (`/api/events/stream` in `routes.ts`) relays every bus event verbatim, so no endpoint change is needed.

### Data model

5. **`src/types/task.ts` — `BranchState` (lines ~132-137)**
   - Add `pr_card?: PrCardState` where `PrCardState = { fingerprint: string; slack?: { ts: string; channel_id: string; thread_id: string } }`.
   - `fingerprint` = stable string of `state | additions | deletions | changed_files | head_sha | ci` — the channel-agnostic "changed since last card?" gate for **both** surfaces. `slack` holds the message ref only when a Slack card was posted. The CLI keeps **no** server-side state (it folds the event stream client-side).

### GitHub client

6. **`src/connectors/github/client.ts`**
   - Add `getPRCardData(github, prNumber): Promise<PrCardData>` — a lean `GET /repos/{owner}/{repo}/pulls/{pull_number}` (`title`, `html_url`, `state`, `merged`, `additions`, `deletions`, `changed_files`, `head.sha`) plus a CI roll-up from existing `listPRChecks()`. Returns `{ state: 'open'|'merged'|'closed', title, url, additions, deletions, changed_files, head_sha, ci: 'none'|'pending'|'passed'|'failed' }`. Avoid `getPRDetails()` (it fetches the full diff).
   - CI roll-up helper over `listPRChecks()` entries: any failure-class → `failed`; else any pending/running → `pending`; else ≥1 success and all conclusive → `passed`; else `none`.

### Slack client

7. **`src/connectors/slack/client.ts`**
   - Add `deleteMessage(channel, ts)` wrapping `client.chat.delete` (respect dry-run) — does not exist yet.
   - Reuse existing `postInteractiveToThread(...)` (returns the new `ts`) to post cards and `updateMessage(...)` for in-place edits.
   - Add `buildPrCardBlocks(card: PrCardData): unknown[]` for the section+context blocks above.

### Task methods + hooks

8. **`src/tasks/task.ts`** — both methods compute the snapshot via `getPRCardData`, **always emit the `pr_card` event**, and additionally drive Slack when a Slack channel exists. Wrap in try/catch so card work never breaks completion.
   - `private async resurfacePrCards()` — iterate every attached repo / `branch_states` entry with a `pr_number`; `getPRCardData` → fingerprint. If no `pr_card` **or** fingerprint differs:
     - emit `pr_card` `{ action: 'post', cardId, …snapshot }` (drives CLI + any SSE client);
     - if the task has a Slack channel: `deleteMessage` the old card (if `pr_card.slack`), then `postInteractiveToThread` a fresh card into the default thread, store the new `slack` ref;
     - store `fingerprint`.
     If unchanged → skip.
   - `async refreshPrCardInPlace(github, prNumber)` — locate the `branch_states` entry for this PR; only act if a card already exists (`pr_card` set) — else no-op (the first card waits for turn-end). `getPRCardData` →
     - emit `pr_card` `{ action: 'update', cardId, …snapshot }`;
     - if `pr_card.slack`: `updateMessage` in place;
     - update `fingerprint`. For merged/closed this writes the final state.
   - **Hook `resurfacePrCards()` into `complete()` and `stop()`** (lines ~731 and ~697) — the "PM is awaiting user" chokepoints all turn-ending tools defer to (`report_completion → complete()`, `request_edit_mode` / research-budget → `stop()`), which run *after* the PM's final message is posted. Call `await this.resurfacePrCards()` early (before `emitEvent`), guarded. Needs only GitHub + Slack/event bus, not clones.

9. **`src/connectors/github/webhooks.ts` (+ `events.ts`)** — async in-place updates:
   - In the existing `handleChecksReadyDirect` debounce timer (CI; ~20s, already loads the `Task` and wakes the PM), also `await task.refreshPrCardInPlace(githubRepo, prNumber)`.
   - For `pull_request` `closed` (merged/closed) routing, resolve the task and call `task.refreshPrCardInPlace(...)` so the card flips to `🟣`/`🚫`.
   - Reuses `extractTaskIdFromBranch` / `findTaskByPRNumber` already used by the router.

### CLI renderer

10. **`src/cli/components/TaskDetail.tsx`** — extend the event→`logLines` derivation:
    - Fold `pr_card` events by `cardId`: the render **anchor** is the most recent `action:'post'` event; merge that post's snapshot with any later events for the same `cardId` to get the latest card state; **suppress** all non-anchor `pr_card` events from producing their own line.
    - Render one compact card block at the anchor via a small `renderPrCard(state)` helper (Ink `<Text>` lines, colored by state/CI), slotted into the existing event-render switch (which already handles `approval:requested`, etc.).
    - Net effect mirrors Slack: an `action:'post'` (resurface) re-anchors the card to the bottom; an `action:'update'` (CI/state webhook) refreshes the numbers in place without moving it.

11. **`src/cli/components/TaskDetail.tsx`** — message footer: when rendering a `message` event, if `event.data.footer` is present, append it as a `<Text dimColor>` line under the message (Part 1, step 3).

### Why this satisfies the agreement
- No card while the PM works → cards only (re)post from `complete()`/`stop()`.
- Resurface only on PM turn-end with a real change; Slack deletes+reposts, CLI re-anchors to bottom.
- CI/state changes ride their own webhooks → quiet in-place update on both surfaces.
- Per-PR `cardId` / `pr_card` → independent cards.
- One event feeds every surface (Slack, CLI, future web UI) — Slack and CLI never diverge.

---

## Files touched (summary)

| Area | File |
|---|---|
| Footer render param + `deleteMessage` + `buildPrCardBlocks` | `src/connectors/slack/client.ts` |
| `buildUserFooter`, footer population, footer in `message` event, `resurfacePrCards` / `refreshPrCardInPlace`, hooks in `complete()`/`stop()` | `src/tasks/task.ts` |
| Model label helper (+ reuse model resolution) | `src/agents/spawn.ts` (or new `src/agents/model-label.ts`) |
| `'pr_card'` event type | `src/system/event-bus.ts` |
| `PrCardState` on `BranchState` + `PrCardData` type | `src/types/task.ts` |
| `getPRCardData` + CI roll-up | `src/connectors/github/client.ts` |
| Async in-place card refresh on CI / PR-closed | `src/connectors/github/events.ts` (routing-independent hook in the webhook dispatcher; `webhooks.ts` only exports a helper) |
| CLI: render `pr_card` events (fold by cardId) + footer dim line | `src/cli/components/TaskDetail.tsx` |
| Docs | `docs/architecture/slack-integration.md`, `docs/architecture/github-integration.md` |

(SSE endpoint `src/connectors/api/routes.ts` needs no change — it relays every bus event.)

---

## Verification

- **Static:** `npm run typecheck` and `npm run build` clean.
- **Unit (vitest):** add focused tests for the pure pieces —
  - `modelDisplayLabel()` mapping (opus/sonnet/haiku + pass-through).
  - CI roll-up over sample `listPRChecks` entries (failed/pending/passed/none).
  - fingerprint equality / change detection.
  - `buildPrCardBlocks()` output for open / merged-failed-CI / no-checks cases.
- **Slack (dry-run `setSlackDryRun` or a test workspace + test repo):**
  1. Send any request → every PM reply carries the footer `task-… · claude-opus-4-8` (plain grey text).
  2. Approve edit mode, open a PR → **no** card mid-turn; on PM turn-end a card appears under the PM's message with correct `+/−`, files, link, `🔀`.
  3. Push a commit, prompt again → on the next turn-end the old card is deleted and reposted at the bottom with updated stats.
  4. CI finishes → card updates **in place** to `✅`/`❌` (does not move).
  5. Merge → card updates in place to `🟣` and stops changing.
  6. Open a second PR → two independent cards.
- **CLI (run the Ink CLI against the same task):**
  1. PM replies show the dimmed footer line under the message.
  2. Same PR lifecycle: card block appears at turn-end, re-anchors to the bottom on resurface, refreshes in place on CI/merge — matching Slack.
  3. CLI-only task (no Slack channel): the card still renders, driven purely by the `pr_card` event.

## Out of scope (deferred)
- Share-link plumbing (`ARCHIE_PUBLIC_BASE_URL`, `/s/{taskId}` route, session view) — task id stays plain text; one render site is left ready to wrap it in a link later.
- Footers on interactive approval cards (those are transient system prompts, not narrative replies).
