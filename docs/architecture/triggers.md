# Triggers

Triggers let a user say, in plain language, "do Y when X happens" and have Archie set up a persistent rule that spawns a fresh task when the condition fires. They are the one sanctioned form of self-initiated work — everything else is reactive (Slack messages, GitHub webhooks).

Two condition types ship in v1:

- **Schedule** — fires on a recurring cadence (hourly / daily / weekdays / weekly at a time) or once at a future time.
- **Channel-message** — fires on a new **top-level** message in a watched channel matching an optional filter (substring and/or author).

A trigger is **bound** to a delivery target. In v1 that is a **channel** (results posted there). A `user` (DM) binding exists in the type but is **not offered at creation yet** — the fired PM has no DM-capable delivery tool under the current channel model, so `propose_trigger` accepts channel bindings only. User-DM delivery is a planned follow-up.

> Design bias: reuse, no new scheduling engine. The firing loop is the reminder scheduler's index-and-tick pattern; creation reuses the edit-mode Approve/Deny flow; fired tasks are ordinary read-only tasks. The only added dependency is [`croner`](https://www.npmjs.com/package/croner) (a tiny, DST-correct cron parser) used solely to compute next-run times.

## Triggers vs. reminders

These are separate features that share only a pattern:

| | Reminder (`set_reminder`) | Trigger |
| --- | --- | --- |
| Effect | Re-wakes the **current** task later | Spawns a **new** task on a saved rule |
| Lifetime | One-shot, lives on the task | Persistent, lives in the trigger store |
| Floor | none ("remind me in 5 min" works) | ≥1h, **recurring schedules only** |

The two schedulers (`reminder-scheduler.ts`, `trigger-scheduler.ts`) run side by side and never interfere.

## Data model

`src/types/trigger.ts`:

```ts
interface Trigger {
  id: string;                                  // "trg-YYYYMMDD-HHMM-random6"
  status: 'pending' | 'enabled' | 'paused';   // pending = proposed, awaiting approval
  created_by: string;                          // Slack user ID who requested it
  created_at: string;
  approved_by?: string;                        // who clicked Approve / typed y
  binding: TriggerBinding;                     // channel thread or user DM
  conditions: TriggerCondition[];              // any match fires
  action: { prompt: string };                  // seeded to the PM when fired
  last_fired_at?: string;
}
```

- A **recurring** schedule condition carries a `cron` expression plus a precomputed `next_run_at`; after each fire `next_run_at` is recomputed with `croner`.
- A **one-off** schedule condition has only `next_run_at` (no `cron`); it auto-pauses after firing once.
- **Channel privacy is deliberately not stored** on the binding — it's resolved live at list time (see Visibility), so a public↔private conversion can't leak a now-private channel's triggers.

Storage: one JSON file per trigger under `$ARCHIE_WORKDIR/triggers/` (`src/system/trigger-store.ts`), plus — for a trigger that has actually fired — one directory per trigger under `$ARCHIE_WORKDIR/triggers-data/` (see [Persistent per-trigger directory](#persistent-per-trigger-directory) below).

## Scheduling: cron, kept internal

Schedule triggers store an absolute `next_run_at` ISO timestamp — exactly like a reminder — so the 60s tick is unchanged. Cron is **never user-facing**: the PM translates natural language → a cron expression at creation, the system validates the ≥1h floor (two successive runs must be ≥1h apart), and `list_triggers` renders the rule back to prose. One-off schedules bypass cron entirely (a single `next_run_at`, parsed via `parse_datetime`/`chrono-node`).

Offloading DST-correct recurrence math to a tested library is the dumb-simple choice; a hand-rolled helper would take on the same DST problem in custom code.

## Lifecycle

```
User asks in plain language
   → PM agent gathers cadence/channel + what to do + where to deliver
   → propose_trigger  →  status:'pending'  →  Approve/Deny prompt
        Approve → status:'enabled', indexed in the scheduler, announced
        Deny    → pending file deleted
   → (enabled) condition fires → fireTrigger spawns a fresh read-only task
   → that task does the work and posts the result to the bound channel
```

A one-off schedule auto-pauses after it fires (its condition is consumed). **Rescheduling a paused trigger auto-resumes it:** `update_trigger` treats new conditions on a paused trigger as intent to make it live again — it re-enables (re-checking caps) and reports the resume back to the PM so the user is told. Editing only the prompt/summary of a paused trigger does *not* resume it (a deliberate pause is respected). An explicit `status: 'paused'` in the same call always wins.

### Firing

`fireTrigger(trigger, context)` (`src/system/trigger-scheduler.ts`) is shared by the scheduler (schedule context) and the Slack dispatch hook (message context):

1. Create a fresh task; set `metadata.triggered_by = trigger.id`.
2. Wire delivery, differently per mode (below).
3. Seed the PM with `AGENT_PROMPTS.triggered(...)` and let it do the work.

**Firing posts no preamble.** The spawned PM does the work and posts the result itself, so the first thing the channel sees is the actual output — not an "I was triggered" line. Nothing else posts on the fire path either, which is why the standing-context refresh below is told not to announce.

#### A message fire ingests its thread

A `channel_message` fire calls `task.append(thread)` with the thread the dispatch hook already fetched. That is the same ingestion path every other Slack task uses, and it does five things at once: it writes the triggering message to `knowledge.log` through the single renderer with its author line and `msg:<ts>` id, applies the redaction policy via `shouldRedact`, downloads its files (or skips them for a redacted message) so the `[Attachments: …]` suffix carries usable local paths, links `slack:<channel>:<threadId>` as a channel, and promotes it to `default_channel`. The task therefore replies under the message that fired it, and **every agent on the task can read that message**, not just the PM — before this, the fire told the PM only that "a new message matched your filter" and the message itself reached nothing, so a delegated repo or plugin agent, which sees only the log, had to guess.

There is one **ingestion floor** behind that, and it is deliberately narrow. `fetchSlackThread` drops a raw message with neither a `user` nor a `botId`, so the very message that fired the trigger can be missing from the thread it was fetched from — and then `append` writes no entry for it. In that case `fireTrigger` writes the already-rendered body itself, attributed to `unknown` — which is not a fallback but the condition: the branch runs precisely because no user id and no bot id came with the payload. It fires **only** for that reason: `append` still links the channel and advances the watermark on an empty message list, so nothing else needs repairing, and the fetch's other drop reason is a bot post from another workspace, whose content must not bypass the redaction policy on its way into the log. An empty body is refused for the same reason in miniature. The entry's `msg:<ts>` id is read off the thread's own root, because dispatch fires only on top-level messages — the thread root *is* the message that fired, so the check asks precisely whether the fetched thread contained its own root.

Matching is unaffected by any of this and lives in the dispatch hook: a `contains` filter is tested against the same rendered body, so a report whose content sits only in Slack attachment cards matches like any other message.

#### A schedule fire homes its task in the bound channel

A schedule fire has no thread to reply in. Rather than hand the agent a detached "post it over there" tool, the task is **homed** in the channel the trigger is bound to: `fireTrigger` sets `metadata.home_channel`, and the task's first user-facing message from an agent is posted as a **new top-level message** there and adopted as the task's thread (`Task.postToUser` → `openHomeThread`). The thread root is the result itself, so the no-preamble rule holds, and a human reply lands in a thread `findTaskByThread` resolves to that same task — the run continues instead of restarting. Before this, the PM could only reach the channel through `post_to_channel`, which deliberately does not link, so a reply to it opened a stranger task with no trigger directory and no history.

Four properties of that open are load-bearing:

- **Only an agent's message opens a thread.** `postToUser` takes the open branch only when `sender !== 'system'`. The internal callers that post without an agent name — the inter-agent budget warning, the wall-clock pause notice — would otherwise make an operational notice the thread root, which is the preamble this feature exists to avoid.
- **One thread per channel.** The open first looks for a thread this task already has in the home channel and posts into it instead of rooting a second one. The whole open is serialized per task by a keyed lock, because an agent can emit two `post_to_user` calls in one turn and both would otherwise root a top-level message.
- **The linking write is flushed, not debounced.** That record is what routes every future reply, and the message is already live in Slack, so a crash in a debounce window would leave a thread nobody owns.
- **The destination never comes from the model.** Opening a task-linked thread was removed from the PM deliberately (commit `89f81b7`). It returns here in the narrowest form: no tool takes a destination, and the only writer of `home_channel` is `fireTrigger` reading the binding of a human-approved trigger. `propose_trigger` refuses a binding id that is a DM or a user, because that id also decides what the fired task may later read.

#### The home channel is the task's own channel

Everything a task gets for a channel it is linked to, a fired task gets for its home channel from its first turn — one derivation, `taskSlackChannelIds` / `taskSlackChannelLabels` in `src/connectors/slack/channel-ids.ts`, feeds all of it: the channel canvas brief and the pinned-message index in the system prompt, the `fetch_slack_reference` file allowlists those blocks name, the explore reads (`read_channel_history`, `read_thread`), and `list_channels`. Deriving the prompt and the capabilities separately is a mistake this made once: the pin index told the agent to open a file id with a tool that then refused it, for exactly one turn.

Because those stores are otherwise refreshed only by inbound Slack events, a schedule fire refreshes them for the home channel before it wakes the task. That is worth knowing about in a channel with no message-watching trigger, where ambient posts are dropped at the routing gate and never scan anything: there, a fire is often the first scan to see a canvas change, and it may therefore be the scan that announces the adoption. That announcement is wanted rather than tolerated — it reports a real change to what Archie reads in the channel, it explains why the fire's output reads the way it does, and it carries no task footer, so it cannot be mistaken for the automation's own result. Suppressing it was tried and reverted: **firing posts no preamble** is about the fire not announcing *itself*, not about silencing every other actor that has something true to say.

`post_to_channel` waits for all of this: while a task has a `home_channel` and no `default_channel`, it refuses and says to post the result to the user first. Once a channel is open it is untouched in every respect — same mandate gate, same mute checks, same standing-brief preflight, same detached semantics — for every target including the task's own channel. That symmetry is deliberate: before a thread exists, a detached post would be the task's only utterance; after one exists, posting elsewhere is an ordinary, answerable act.

**Four rough edges of a task that has not opened its thread yet**, all reachable and none of them fixed here:

- **An approval card reaches nobody.** `postInteractiveToUser` resolves its destination from linked channels only — it has no `home_channel` branch, unlike `postToUser` — so a fired task that follows the seed's advice to request edit mode *before* its first post gets an SSE event and a log line and no buttons in Slack. Post first, then request.
- **A failed first post leaves the task mute, not merely un-threaded.** If the home-channel post throws (the bot is not in the channel, the channel was archived), `default_channel` stays null, so `post_to_channel` keeps refusing and `post_to_user` keeps throwing. A retry can still open the thread, but until one succeeds the task cannot reach anyone. Note `isChannelReachable` passes a public channel the bot is not a member of, so the pre-flight does not catch that case.
- **`report_completion(message)` can be the message that opens the thread.** It routes through `postToUser` with the agent as sender, so a fired task that says everything in one final message opens its thread with it. That is intended, not an accident.
- **`post_files_to_user` cannot open a thread**, because Slack's upload carries no text to serve as a root. The PM is told this by its channel context line at spawn, which names the home channel and says the first `post_to_user` is what opens the thread.

**DM (`user`) bindings are still not delivered.** `propose_trigger` accepts channel bindings only, so no DM-bound trigger can exist to deliver to, and the `user` branch of the delivery seed is unchanged and unreachable in practice.

## Persistent per-trigger directory

Each fire is a brand-new task with its own agent workspace, and no fire can reach another's. So a trigger whose job needs continuity — "summarise what changed since last time", "chase the thing you raised yesterday" — used to have no way to carry anything forward, and silently degraded into redoing the work and re-reporting it in full. Every trigger that actually fires now gets one directory that outlives a single fire, at `$ARCHIE_WORKDIR/triggers-data/<trigger-id>/`. A trigger that is never approved or never fires gets none, because creation happens at agent spawn.

**Created at agent spawn, not at fire.** The scheduler is untouched. `ensureTriggerDataDir` (`src/system/trigger-store.ts`) runs from the one block in `spawnAgent` that sits after all three per-track branches, so every agent on a trigger-fired task gets it — PM, repo agent and plugin agent alike. `mkdir` is recursive, which is what makes it idempotent: spawn re-runs once per agent, again on every wake of the task, and again after a restart.

**It refuses to create once the record is gone.** A task outlives the fire that created it — a user can keep replying in its thread, the PM can delegate, a restart re-spawns it — while `metadata.triggered_by` keeps naming a trigger that may since have been deleted. So creation checks that the trigger's record file still exists first, and returns null when it does not. Without that check the next spawn would recreate the directory straight after `deleteTrigger` removed it, resurrecting deleted content and orphaning it for good, because nothing scans `triggers-data/` for entries whose record has gone. The check is deliberately `existsSync` on the record path rather than `loadTrigger`, because `loadTrigger` also returns null for a `JSON.parse` failure and `saveTrigger` truncates before it writes — a spawn reading the record mid-write would otherwise conclude a live trigger had been deleted.

**Granted read-write, in both sandbox lists.** The directory goes into `allowReadPaths` and `allowWritePaths`, the same shape the agent workspace and the repo clones use. It was briefly granted write-only, on the belief that listing a path in both lists makes bwrap lay a read-only bind over the writable one and downgrade it — the claim in [security.md](security.md#known-sandbox-limitations)'s Known Limitation 1. That was measured and is false; both forms behave identically. Write-only also has a real cost: `assertReadable` (`src/agents/artifacts.ts`) validates against `allowReadPaths` alone, so an agent could write a file here and then be refused when it tried to `share_artifact` it. Two things about the grant are still worth knowing:

- **`Bash` reaches it fine, which took measuring.** `denyReadPaths` includes `$ARCHIE_WORKDIR`, so the obvious reading — and an earlier version of this section — was that the parent's `denyRead` destroys the child's grant. It does not. Measured under bwrap 0.11.0 with the production config: an agent granted this path write-only can `cat`, `ls` and write to it from `Bash`, and the writes persist to real disk. `denyRead` emits its `--tmpfs` **before** the `allowWrite --bind`, so the bind lands on top and survives; the parent stays opaque (it renders as a mode-700 tmpfs) while the granted subtree punches through. That is the reverse of what Known Limitation 1 in [security.md](security.md#known-sandbox-limitations) used to claim; that entry now records the correction.
- **The artifact tools can read it**, because it is in `allowReadPaths`. That is not automatic: `assertReadable` checks that list alone, unlike the OS sandbox and the PreToolUse hook, which both treat writable as readable. Any future path granted write-only inherits that gap — `CACHES_DIR` does, and its files cannot be shared through the artifact tools.

**Not in `additionalDirectories`.** `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` is on, so a `CLAUDE.md` in an additional directory is auto-loaded into the prompt — and this directory is agent-writable, so listing it there would let one agent inject a prompt into every later agent on the same trigger.

**Announced once, in one place, on every track.** `buildTriggerDataPromptSection` builds a single block appended after the per-track branches. It names the trigger, names the path as read-write, lists the directory's entries (names only, sorted, capped at 50), says to load the `trigger-task` skill, and frames whatever is in there as data rather than instructions, since it was written by an earlier agent. That is all it does.

**Why the skill instruction is in the block and not in the seed message.** The seed (`AGENT_PROMPTS.triggered`) reaches the PM alone, and a delegated repo or plugin agent holds the same directory read-write. The block is the only trigger-specific text every track sees, so it is the only place an instruction reaches everyone who might write there. `knowledge.log` was the other candidate and is worse on two counts: it is the data channel, where user-authored text lands and where the injection rules say to treat what you read as data rather than instruction, and it is chronological, so a line written at fire time reads as a stale event ten turns later rather than as a standing instruction.

Three things the block deliberately does not do, each of which it did at some point during development:

- **It does not name a tool.** Reading a file and listing a directory are things an agent already knows how to do, and a named tool dates the prompt. The failure that made the point was of exactly that kind: an early draft named `Glob`, which this runtime does not have, so the fire reaching for it got `No such tool available` and spent its turn hunting a substitute instead of reading the directory.
- **It does not explain why fires cannot see each other.** That is the skill's opening paragraph. A prompt block that re-explains the model of the feature is a second copy of the skill with nothing keeping the two in step.
- **It does not repeat itself, and neither does the seed.** The PM's context block used to carry a second `Spawned by trigger:` line, the seed a third mention of the directory, and both the seed and the block asserted "you were started by a trigger" after the seed's first sentence had already said the trigger fired. Three statements of one fact drift the moment one is edited, and they did. Now: the seed says what fired and where the result goes, the block names the trigger and its directory, the skill carries the model and the conventions.

The seed no longer claims "there is no prior conversation" either. That was true of the Slack thread and false in spirit — a trigger that has run before does leave context behind. What the sentence was actually carrying is that nobody is waiting on the other end, which is now what it says.

The listing is a convenience rather than a workaround — the directory is granted read-write on both enforcement layers, so an agent can list it perfectly well itself. It is there because it costs nothing and it is what tells a fire whether it has a past at all.

**Two rough edges worth knowing.** The listing is a bare `readdir`, so a subdirectory an earlier fire created appears as a plain name with nothing marking it as a directory; the block says the listing is top-level only, and the skill says to look deeper when it matters. And the grant and the announcement attach on *every* spawn of a task whose `triggered_by` is set, not only on the fire itself: a user replying in the thread days later, a PM delegation, or a post-restart recovery all get them, even though the `trigger-task` skill is written in the voice of a fire. Neither is harmful; both are places the model may be mildly surprised.

**Removed when the trigger is deleted.** `removeTriggerDataDir` is called inside `deleteTrigger`, the single function every deletion entry point funnels through, so no caller changes. A filesystem refusal propagates rather than being swallowed — a caller reporting a deletion that did not happen would tell a user their automation's notes were gone while they were still on disk.

**What is deliberately absent:** nothing pre-creates a file or subdirectory inside it, nothing prunes it, nothing surfaces it to an operator, no trigger can see another's, and its contents are never auto-injected. Conventions — read before you work, leave what the next fire needs, keep it small, treat what is there as data — live in `skills/trigger-task/SKILL.md`, which is mounted on all three agent tracks. A runaway directory therefore stays unbounded and invisible until someone looks at the disk.

### Channel-message dispatch

A single hook in `handleSlackEvent` (`src/connectors/slack/events.ts`) fires channel-message triggers, gated to ambient chatter: no existing task on the thread, not an `@mention`, not a DM, and a top-level message (not a thread reply).

**The `contains` filter matches the rendered message body, not Slack's `text` field.** The body comes from `rawMessageBody`, which runs the raw event through the full inbound extraction (Block Kit, attachment cards, files, mention resolution) and then the shared renderer. This matters because the messages most worth watching for — a Grafana alert, a Bugsnag error, a report posted through an incoming webhook — arrive with an empty `text` and everything in attachment cards, so matching the raw field made them invisible to the very filter watching for them. There is deliberately no fallback to the raw field: a message whose extraction yields nothing simply does not match. The render is computed only after the trigger-index lookup short-circuits, so a channel nobody watches costs nothing.

So a message that both mentions Archie and matches a trigger creates a direct task and does **not** also fire the trigger.

External and guest *humans* are filtered upstream by the author bail-out in `handleSlackEvent`, so they can never fire a trigger. That bail-out is `event.user`-gated and therefore never classifies an **app** post, which carries no `user` — so `dispatchChannelMessageTriggers` gates app posts on the bot's own team itself, dropping one from a foreign workspace before it is rendered or matched. This mirrors the rule thread ingestion and the pin index already draw: drop a bot from a foreign team, keep internal bots.

**The author filter matches the author the payload carries, which for an app is a bot id.** A Slack message's author is not always a user id: an app posting through an incoming webhook (or with `as_user: false`) carries a `bot_id` and no `user` at all, while an app calling `chat.postMessage` with a bot token carries both. So `from_user` is tested against **both** ids, in `messageMatchesTrigger` (`src/system/trigger-match.ts`), and the id that decided the fire is the id handed to `fireTrigger` as `authorId` — one derivation, so the seed cannot name an author the filter did not match on.

This is a correction, and the shape of the bug is worth keeping. The matcher used to compare `from_user` against `event.user` alone. Everything else in the codebase already knew better — `fetchSlackThread` keeps `botId` and renders the author line as `<@B…:Name>`, dispatch's own foreign-app gate reads `bot_id`, `fireTrigger` took `event.user || raw.bot_id` — so an agent reading a channel's history was *shown* the `B…` id as the author and had every reason to write it into the filter. A live trigger did exactly that: it watched #sweatcoin-mobile for an "Expired Feature Flags Report" from `B0A9ZRW2TS9`, was approved, announced and listed as active, and fired zero times across six weeks of reports. Nothing was broken enough to log: the message was routed, rendered and matched against the keyword; only the author comparison silently failed. **A filter that cannot match is indistinguishable from a channel where nothing was posted**, which is why the fix is paired with a validator rather than left to the matcher alone.

`propose_trigger` and `update_trigger` therefore refuse a `from_user` that is not shaped like an author id (`U…`, `W…`, `B…`) — a name, an @handle, or a channel id pasted into the wrong field is rejected at creation with a message saying where to find the right id, instead of producing a trigger that is announced and inert. The validator is deliberately a shape check and not a lookup: resolving the id against Slack would fail closed on an app the bot cannot see, and a trigger refused because of a transient API error is worse than one refused for being unmatchable.

Rendering follows the same principle. `describeCondition` used to say "from a specific person", which told neither the human reading the change notice nor the agent managing the trigger anything they could act on. It now names the author — a `U…` as a mention (a config change is exactly when the watched person should hear about it), a `B…` as its id, since an app cannot be mentioned — and names the watched channel when it differs from the delivery binding, the one case a listing could not otherwise express.

## Reading a trigger

`list_triggers` renders one summary line per trigger — `<when> → <what>`, deliberately short, because the common ask is "what's set up here". `get_trigger(id)` returns the stored record: every condition as stored (watched channel id, keyword, author id and what kind of id it is), the full internal `action.prompt`, the binding, and who created and approved it.

The split exists because an agent that can only read the summary cannot manage what it is already allowed to delete. It cannot say which sender is filtered, cannot quote the instruction that runs — and, since `update_trigger` **replaces the condition list wholesale**, cannot edit one condition without silently dropping the filters it never saw. Visibility (below) is the gate on *which* triggers an agent may touch; withholding fields from a trigger that has already passed that gate protects nobody, because the same agent may rewrite or delete it outright. `get_trigger` is gated by exactly the same `triggerVisibleFrom` check as the rest of the surface, and refuses a `pending` proposal like `list_triggers` and `update_trigger` do, so the read tool cannot become the one way to see one.

The action prompt is returned in full rather than clipped. Clipping it is what made the summary insufficient in the first place, and a prompt long enough to be a problem here is already seeded into a PM turn on every fire, so it is bounded by construction.

## Confirmation gate (channel-agnostic)

Trigger creation reuses the edit-mode approval mechanism, which is already channel-agnostic:

- `propose_trigger` stashes the proposed id on `task.metadata.pending_trigger_id` and calls `postInteractiveToUser(..., 'trigger')`, which always emits an `approval:requested` event.
- **Slack** renders Approve/Deny buttons; **the CLI** renders the same request as `[y] approve / [n] deny`.
- Both converge on the task-level handlers `handleTriggerApproval` / `handleTriggerDenial`. The Slack buttons carry the trigger id; the CLI `POST /tasks/:id/approve` body is just `{ type:'trigger', approve }`, so the handler falls back to `pending_trigger_id`.

There is **no operator bypass** — approving from the CLI is exactly equivalent to clicking Approve in Slack.

## Visibility & privacy

Scoped by the **tier of the space the request comes from** (`src/system/trigger-visibility.ts`):

- **From a public channel:** all public-channel triggers. Never DM or private-channel triggers.
- **From a private channel:** this private channel's triggers + all public-channel triggers.
- **From a DM:** your own DM triggers + all public-channel triggers.
- **Hard invariant:** a private space's triggers are never visible from outside that exact space.

Privacy is resolved from the **workspace channel map** (`listWorkspaceChannels()` → `conversations.list`, `id → isPrivate`, a process-wide ~10-min cache shared with the `find_slack_channel` tool), so a listing is O(1) lookups with no per-channel Slack calls. A channel not in the cached map (brand-new, just-converted, or archived) falls through to a live `conversations.info` lookup. Both paths **fail closed** — an unresolved channel is treated as private — so a private trigger is never leaked into a public/DM listing. The trade is a bounded ≤10-min staleness window after a public→private conversion of an already-cached channel.

The **operator CLI** (`/api/triggers`, the `t` view) operates at operator trust and sees all triggers, consistent with the existing CLI task list.

## Announcements (no silent changes)

Every **configuration change** — created/enabled, edited, paused/resumed, deleted — posts a one-line notice to the channel the trigger is bound to, even when the change was made from a DM. Firing is **not** a config change and is never announced.

## Protections & limits

- **Propose-then-confirm** — no agent enables a trigger from a model decision alone.
- **Human approval is the loop guard** — a trigger-spawned task *may* call `propose_trigger`, but that only ever creates a `pending` trigger; nothing enables (or fires) without a human clicking Approve, and a task has no way to self-approve (approval comes only from the Slack button or the CLI `/approve` endpoint). So there is no autonomous amplification loop to gate against — the approval step already breaks it. (Runaway pending-proposal spam is bounded by the daily fire cap.)
- **Read-only by default** — a fired task is an ordinary task; any write/push still needs in-the-moment edit-mode approval.
- **Limits** — recurring schedules ≥1h apart; per-user and per-channel active-trigger caps; a per-account daily fired-run cap (in-memory, reset daily).
- **Kill switch** — `ARCHIE_TRIGGERS_ENABLED=false` disables all firing and creation globally.

## CLI & API surface

- `GET /api/triggers`, `GET /api/triggers/:id`, `PATCH /api/triggers/:id` (pause/resume/edit prompt), `DELETE /api/triggers/:id` — operator endpoints, mirroring `/api/tasks`.
- `POST /api/tasks/:id/approve` accepts `type:'trigger'` for the CLI approval gate.
- CLI: press `t` from the task list to open the trigger list (status, bound channel, `[p]` pause/resume, `[d]` delete).

## Key files

| File | Responsibility |
| --- | --- |
| `src/types/trigger.ts` | `Trigger`, `TriggerBinding`, `TriggerCondition` |
| `src/system/trigger-store.ts` | One-JSON-file-per-trigger persistence, plus the per-trigger data directory's lifecycle (`getTriggerDataPath`, `ensureTriggerDataDir`, `removeTriggerDataDir`) |
| `src/agents/trigger-data.ts` | The two pure pieces of the persistent directory: the sandbox grant, and the prompt block that announces the path and lists its contents |
| `src/system/trigger-scheduler.ts` | In-memory index, 60s tick, cron math, `fireTrigger`, announcements |
| `src/system/trigger-visibility.ts` | Pure visibility decision (privacy injected) |
| `src/system/trigger-match.ts` | Pure channel-message match decision — author-id shape, the `contains`/`from_user` predicate |
| `src/agents/tools.ts` | PM tools: `propose_trigger`, `list_triggers`, `get_trigger`, `update_trigger`, `delete_trigger` |
| `src/tasks/task.ts` | `handleTriggerApproval` / `handleTriggerDenial`; `openHomeThread` (opens and adopts the task's own thread in its home channel) and `linkSlackThread` |
| `src/connectors/slack/channel-ids.ts` | `taskSlackChannelLabels` / `taskSlackChannelIds` — the one derivation of which channels a task's standing context and capabilities cover, home channel included |
| `src/connectors/slack/events.ts` | Approve/Deny buttons + channel-message dispatch hook |
| `src/connectors/api/routes.ts` | `/triggers` endpoints + the `trigger` approval branch |
| `skills/triggers/SKILL.md` | Engine-owned PM skill (the orchestration playbook), loaded via the `Skill` tool |
| `skills/trigger-task/SKILL.md` | Conventions for the per-trigger directory. Mounted on **all three** agent tracks, so it is written track-neutrally rather than in the PM's voice |
| `prompts/pm-agent.md` | Short always-present blurb so the PM knows triggers exist before loading the skill |
