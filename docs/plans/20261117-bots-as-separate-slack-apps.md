# Archie bots as separate Slack apps on one backend

**Status:** Proposed on 2026-11-17; nothing is implemented or verified. Slack provisioning behaviour marked "Stage 0" comes from documentation and third-party reports and has not been tested. No owner or dates are agreed.
**Milestones:** Stages 1 to 3: [Slack bots: first role bot on its own Slack app](https://github.com/sweatco/archie-hq/milestone/2). Stages 0 and 4: [Slack bots: Archie provisions bot apps](https://github.com/sweatco/archie-hq/milestone/3). The milestones own their issues.

## 1. Context and recommendation

**Why.** We want focused bots that are parts of Archie (`Archie QA`, `Archie Mobile`), each a real Slack identity people can @-mention and DM, like ChatGPT dots. Research on 2026-11-16 found that one Slack app has exactly one bot user, and that dots most likely rely on Slack's partner-only "Add to Slack" manager-app programme, which Archie cannot join. The open equivalent is what Runbear, Gumloop and self-hosted LangSmith do: **one Slack app per bot, created through the app-manifest API, installed by a person with one click, all served by one backend.**

**Decisions made by the maintainer.**

| Date | Decision |
|---|---|
| 2026-11-16 | Bots are per role, not per person |
| 2026-11-16 | A bot's prompt can extend or fully replace the core PM prompt |
| 2026-11-16 | A default bot per channel is a later extension |
| 2026-11-17 | One Slack app per bot (supersedes the user-group-handle approach planned earlier) |
| 2026-11-17 | Archie creates each app itself and sends an admin an install link |
| 2026-11-17 | Several bots may work the same thread |

**Relation to the existing draft.** A draft proposal on a main discussion and channel roles (not committed) defines a *bot* as "a named agent definition that replaces the PM for the conversations it owns" and asks whether Slack identity should be option A (one app) or B (one app per bot). This plan uses that vocabulary, delivers its sequence step 1 (bot abstraction) and answers its question 1 with **B**.

**Scope.**

| In this plan | Deferred |
|---|---|
| Bot definitions in the plugins repo; prompt `extend` / `replace` | Per-bot tools and MCP servers |
| Slack connector serves several apps; each task belongs to one bot | Memory tagging per bot |
| Rules for several Archie apps sharing a channel or thread | Per-bot model and effort |
| Archie provisions each bot's Slack app; admin clicks install | Homes / main discussion; master↔bot handoff |
| Master Archie unchanged | Channel-default bot; per-person bots |

**Size.** This is a multi-stage initiative. The connector refactor alone touches 35 Slack helper functions, about 70 call sites and up to 50 test files, though the compiler finds every site.

## 2. Current foundation and gaps

| Capability needed | What exists today | Change |
|---|---|---|
| Bot definition | Only the PM: `buildPmDef()` / `readPmOverlay()` in `src/agents/registry.ts` | Add a bot roster loader |
| Base prompt per bot | `generatePMPrompt()` in `src/agents/spawn.ts:177`, dynamic sections appended after | Choose the base by the task's bot |
| Task knows its bot | `TaskMetadata` set-once fields (`home_channel`, `triggered_by`); `Task.create()` takes no arguments | Add optional `bot` |
| Slack client per app | One `WebClient` and one bot identity as module globals in `src/connectors/slack/client.ts:104-135`; 34 internal uses | Explicit per-app handle |
| Events per app | One Bolt `App` in `events.ts:114-185`; 5 event and 15 action handlers; nothing reads `api_app_id` | One Bolt app per Slack app from a factory |
| Thread → task | `findTaskByThread(threadId)` keyed on thread only, first hit wins (`persistence.ts:642`) | Key on thread **and** bot |
| Self-message filter | Drops only this app's `bot_id` / user (`routeSlackEvent`, `events.ts:841`) | Drop posts from any Archie app |
| Secrets | Env file plus the encrypted vault under `/app/secrets` | Store bot-app credentials and the config token in the vault |
| Public URL | HTTP webhooks at `/webhooks/slack`; Socket Mode optional | Bot apps are HTTP-only; needs `ARCHIE_PUBLIC_URL` |

**What breaks today if a second Archie app joins a channel** (verified in code): every message is handled once per app, so tasks are woken twice and channel triggers fire twice; a bot's own reply reaches the other app's handler, is not recognised as "ours", and wakes its own task again.

**Invariants kept.** One process, one workspace, one plugins repo, one set of approval and sandbox rules. One agent per task; session key stays `pm-agent`. Approval gates and tool policy are code-enforced, so a replaced prompt cannot weaken them.

## 3. Proposed solution

### Overview

1. An admin adds `bots/qa.md` to the plugins repo.
2. Archie creates a Slack app "Archie QA" from that definition and DMs the admin an install link.
3. The admin clicks Allow. Archie stores the bot token and starts serving the app at its own webhook path.
4. Someone invites `@Archie QA` to `#release` and mentions it. Slack delivers the mention to that app only.
5. Archie creates a task with `metadata.bot = 'qa'`. Its prompt comes from the bot definition; every Slack call for that task uses the QA app's token.
6. Replies appear from Archie QA, which also has its own DM.

### Bot definition

One file per bot at `<plugins repo>/bots/<key>.md`, read fresh like `pm.md`.

```markdown
---
name: Archie QA            # Slack app and bot display name (required)
description: Release quality checks
icon: icons/qa.png         # optional, relative to the plugins repo
prompt: extend             # extend (default) | replace
---
You focus on release quality…
```

- `<key>` is the file name and the stable id stored on tasks, credentials and the webhook path.
- Frontmatter is validated with zod; an invalid file is skipped with a warning naming the file and field.
- Owner: new `src/agents/bots.ts`. Master Archie is the absence of a bot, not a file.

### Prompt: extend or replace

| Mode | Base prompt | Use |
|---|---|---|
| `extend` | `prompts/pm-agent.md`, then a `# Bot: <name>` section with the body | A focused variant of Archie |
| `replace` | The bot body only; `pm-agent.md` is not loaded | Rewriting core behaviour |

In both modes the engine-owned sections still follow in today's order (task context, people, pins, canvas, trigger data, memory, observation guidance, `pm.md` deployment context), so a replaced prompt still learns its task, channel and tools. `prompts/pm-agent.md` and core skills are not edited.

Risk accepted: a `replace` body that omits how to reply yields a silent bot. Mitigation is a documented template under `examples/plugins/bots/`.

### One handle per Slack app in the connector

A `SlackApp` value holds everything that is per app: `key`, `appId`, `client`, `botUserId`, `botId`, granted scopes. A small registry (`src/connectors/slack/apps.ts`) lists them, returns the master, and answers "is this user or bot id one of ours?".

- **Explicit, not ambient.** Every Slack helper that depends on the token takes the `SlackApp` as its first argument. Rejected alternative: an async-local "current app". It would avoid most edits, but a bot task silently using the master token is exactly the bug to prevent, and the compiler cannot catch it.
- **Where the app comes from.** Inbound handlers use the app that received the event. A `Task` exposes `task.slack`, resolved from `metadata.bot`. Task-less work (proactivity, canvas announcements, startup) uses the master.
- **Caches.** Workspace-level caches (user list, user trust) stay shared. Token-dependent ones (`channelCache`, the pins-scope latch, canvas and pin lookups) move onto the `SlackApp`.

### Events: one Bolt app per Slack app

`mountSlackApp` becomes a factory that builds a Bolt `App` and registers the same handlers for a given `SlackApp`.

- **HTTP.** Each app gets its own receiver and path: master stays at `/webhooks/slack`, bots at `/webhooks/slack/<key>`. Bolt supports several receivers on one Express server only with distinct paths. A bot's receiver is mounted when its app is installed; an unknown or removed key answers 404.
- **Socket Mode.** Supported for the master as today. Bot apps created by Archie are HTTP-only, because no public API issues the app-level token Socket Mode needs.

### Who handles an event

Every Archie app in a channel receives its own copy of each message. Exactly one must act. For an event received by app **R**:

| Event | Rule |
|---|---|
| Author is any Archie app | Never routed (it still shows in thread history). This prevents loops |
| `app_mention` | R handles it; Slack sends it only to the mentioned app |
| DM | R handles it; each app has its own DM |
| Button click | R handles it; Slack sends it only to the app that posted the message |
| Reply in a thread, no mention | R handles it only if R has a task on the thread **and** R is the bot engaged last there |
| Reply that mentions another Archie bot | R ignores it; that bot's `app_mention` handles it |
| Reply to a thread R itself started, no task yet | R starts a task, as today |
| Top-level channel message matching a trigger | Handled by the app that owns the trigger |
| Proactivity observation | Master's copy only |

"Engaged last" means the Archie bot that most recently posted in, or was mentioned in, the thread. It is derived from the thread itself, so the apps need no shared state and always agree.

To keep cost flat, R first checks locally whether it has a task on the thread; if not, and it was not addressed and did not start the thread, it drops the event without calling Slack.

### Tasks, threads and triggers

- `findTaskByThread(threadId, botKey)`: one task per thread **per bot**. A missing `metadata.bot` means master, so existing tasks need no migration.
- A second bot mentioned in a thread starts its own task there and reads the thread history, where other Archie bots appear as named participants.
- People resolution and memory-author recording skip all Archie bot users, not only the current one.
- `Trigger` gains an optional `bot` (absent means master), set from the creating task. A fired task belongs to that bot, and channel triggers are evaluated only on that bot's copy of the event.

### Provisioning: Archie creates the app, an admin installs it

State per bot, kept in the vault next to its secrets: `defined → created → awaiting install → installed`.

1. **Config token.** An admin generates a Slack app-configuration token once (api.slack.com/apps → "Your App Configuration Tokens") and gives Archie the refresh token. Archie stores it in the vault and rotates it with `tooling.tokens.rotate` before the 12-hour expiry. Each rotation returns a new access and refresh pair and voids the old one, so both are persisted atomically before use.
2. **Create.** When a bot file has no app, Archie builds a manifest from the definition: name, description, the master's scopes and events, event and interactivity URL `${ARCHIE_PUBLIC_URL}/webhooks/slack/<key>`, redirect URL `${ARCHIE_PUBLIC_URL}/slack/install/<key>/callback`. It validates with `apps.manifest.validate`, calls `apps.manifest.create`, and stores the returned app id, client secret and signing secret at once, because no later call returns them. It then sets the icon with `apps.icon.set` (512–2000 px), retrying on rate limit.
3. **Ask.** Archie DMs the install link, with a single-use `state` value, to the config-token owner and the users listed under a new `slackAdmins` key in `archie.json`. The link is also available from the API and CLI. The message includes the app's Event Subscriptions settings link in case Slack wants the URL verified by hand (check S1).
4. **Install.** The callback checks `state`, exchanges the code with `oauth.v2.access`, stores the bot token and bot user id, mounts the app's receiver and confirms to the admin. No restart.
5. **Change.** Edits to name or description are pushed with `apps.manifest.update` (the whole manifest each time); icon changes with `apps.icon.set`. Scope changes need a reinstall, so Archie re-sends the install link.
6. **Remove.** Deleting a bot file leaves its app installed but unserved, with a warning. Teardown is an explicit admin command, never automatic: `apps.uninstall`, then `apps.manifest.delete`, then purge the stored secrets.

**Agent surface.** Slack requires new apps to use `features.agent_view` (the master's `assistant_view` is deprecated in February 2027). Bot manifests therefore use `agent_view`, enable the Messages tab, and subscribe to `app_home_opened` and `agent_session_stopped` alongside the master's events. Moving the master itself to `agent_view` is separate work and cannot be reversed, so it is not part of this plan.

**Manual fallback.** A bot app can also be supplied by hand through `SLACK_BOT_TOKEN__<KEY>` and `SLACK_SIGNING_SECRET__<KEY>`. This is how Stage 3 proves routing before provisioning exists, and it stays as the path for deployments without a public URL or config token.

**Failure handling.** If rotation is missed and the refresh token is dead, provisioning stops with a warning asking an admin for a new token; installed bots keep working. If the workspace requires app approval, the admin sees Slack's approval request instead of Allow; Archie keeps the bot in `awaiting install`.

### API entry for tests

The API and CLI task-creation route and the debug MCP `create_task` accept an optional `bot`, so the E2E harness (which has no Slack) can exercise a bot's prompt.

## 4. Delivery stages

### Stage 0 — Slack sandbox checks (no product code)

Run against a development workspace. Each result can change the design.

| # | Question | If it goes the other way |
|---|---|---|
| S1 | Do events and button clicks reach a manifest-set URL without anyone clicking Verify? Slack's docs say manual verification is needed; one live report saw events flow anyway, another saw them pending | Keep the manual Verify step in the admin message |
| S2 | Can an admin who did not create the app install it from the link? With workspace app approval on, is each new app a separate request? | Installer must be the config-token owner; each bot needs an approval |
| S3 | Does `apps.icon.set` work right after create, and at what rate? (Documented, but reports show about one call a minute) | Icon is set by hand once per bot |
| S4 | With two apps in a channel: is `app_mention` sent only to the mentioned app, and plain messages to both? | Revisit the ownership table |
| S5 | Does the refresh token survive after the access token has expired, and for how long? | Shorter rotation interval; clearer recovery message |
| S6 | Does the created `agent_view` app accept DMs and show the agent badge? | Adjust manifest fields |
| S7 | Does `apps.uninstall` accept the bot token, and what happens to the apps if the token owner is deactivated? | Adjust teardown; document owner-account requirement |

Needs a maintainer go-ahead and a dev workspace, since it creates and installs Slack apps there. Exit: a results table on the Stage 0 issue, with any design change reflected here.

### Stage 1 — Bots in the engine (no Slack change)

- `src/agents/bots.ts` loader and schema; `TaskMetadata.bot`; `Task.create({ bot })`; spawn picks the base prompt; optional `bot` on the API, CLI and debug MCP.
- Example bot in `examples/plugins/bots/`.
- Tests: loader cases following `pm-overlay.test.ts`; prompt assembly for master, `extend`, `replace`.
- Docs: `docs/architecture/agents.md`, `overview.md`.

Exit: through the E2E harness, a task created with a `replace` bot answers per its body; a task with no bot behaves as today.

### Stage 2 — Multi-app connector with only the master (no behaviour change)

- `SlackApp` and registry; thread the handle through the token-dependent helpers and their callers; move token-dependent caches.
- Bolt factory; per-app receiver path; `findTaskByThread(threadId, botKey)`; "any Archie app" self-filter; the ownership rules.
- Tests: existing suites updated to the new signatures; new tests for the ownership table using the Bolt fake from `subtype-sweep.test.ts` with two fake apps.
- Docs: `slack-integration.md` (identity, event handling).

Depends on nothing. Exit: `npm run check` passes, the basic E2E scenario passes, and master Archie behaves the same in the dev workspace.

### Stage 3 — A second app by hand

- Load extra apps from `SLACK_BOT_TOKEN__<KEY>` / `SLACK_SIGNING_SECRET__<KEY>`; bind them to bot definitions; `Trigger.bot`.
- Docs: `local-development.md`, `deployment.md`, `.env.example`.

Depends on Stages 1, 2 and S4. Exit: the acceptance example below, with a hand-made QA app.

### Stage 4 — Provisioning

- Config-token storage and rotation; manifest generation; create, install callback, update; `slackAdmins`; admin DM; teardown command; status in the API/CLI.
- Tests: manifest generation, state transitions, `state` check on the callback, rotation failure path, all against a faked Slack API.
- Docs: `slack-integration.md` (provisioning), `deployment.md` (public URL, config token, vault).

Depends on Stage 3 and S1–S3, S5–S7. Exit: adding a bot file in the dev deployment produces an install DM, and after one click the bot answers a mention, with no restart.

## 5. Validation and rollout

- `npm run lint` and focused tests while iterating; `npm run check` before each handoff.
- The E2E harness covers Stage 1 and the Stage 2 regression only; it cannot inject Slack events. Stages 2–4 rely on unit tests plus manual runs in the dev workspace.
- **Acceptance example.** Archie and Archie QA are both in `#release`. A member posts `@Archie QA is build 412 safe to ship?`. Only Archie QA reacts and replies in the thread; the task shows `bot: qa`. The member replies without a mention and Archie QA answers. They then write `@Archie summarise this`; master Archie starts its own task on the same thread and answers once. A further un-mentioned reply goes to Archie only. No message is answered twice.
- **Rollout.** Each stage ships separately. Stages 1–2 are inert in production. Bots appear only when a bot file exists and its app is installed. Rollback of a bot: remove its file; its tasks stop receiving events. Stage 2 is the risky one for existing behaviour, so it ships alone and is watched before Stage 3.

## 6. Open questions and risks

- **Config token custody.** The token belongs to one Slack user, apps created with it are owned by that user, and that user is the safest installer. If the account is deactivated the token likely dies and the apps need a new collaborator. Which account should own Archie's bot apps (ideally a durable admin or service account) is a maintainer decision before Stage 4, tracked in the provisioning milestone.
- **App approval.** If the workspace requires app approval, every new bot app is a separate approval request.
- **Coordination with the shared-receiver plan.** The [incoming events plan](20261116-incoming-events-shared-receiver.md) also adds Bolt handlers, `ARCHIE_PUBLIC_URL` and trigger-store changes. Whichever lands second must register its handlers through the Stage 2 factory and respect `Trigger.bot`.
- **Channel membership.** Each bot must be invited to a channel separately, and reads what its own token can see.
- **Cost.** A thread with two engaged bots spends two agent sessions.
- **Not answered here:** memory privacy scopes, bot-specific tools and credentials, homes (proposal questions 2, 3, 5–7).

Stages 1 and 2 do not depend on the Stage 0 checks.
