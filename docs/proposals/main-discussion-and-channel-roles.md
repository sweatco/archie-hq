# Proposal: Main discussion, background work sessions and focused bots

> **Status:** Draft — research captured 2026-11-16, decisions through 2026-11-18. Planned in two places: Slack identity and bot definitions in `docs/plans/20261117-bots-as-separate-slack-apps.md` (branch `docs/bots-as-separate-slack-apps`, [#382](https://github.com/sweatco/archie-hq/issues/382)); skills, tools, workdir, memory and routing in [bot capabilities and routing](../plans/20261119-bot-capabilities-and-routing.md). The main discussion is a separate target with no plan yet.

## The idea (user's)

Give Archie the shape ChatGPT Dots and Grok Bot have:

1. A **main discussion** where everything can be discussed. It follows the user's thoughts, memory items and context, and organizes work. Separate **background sessions** do the actual job.
2. Each channel can have a **role** selected for Archie: pre-built (for example mobile engineer) or custom to that channel.
3. The main discussion's persona **follows the context** of the channel and its discussions.

**Clarification (user, 2026-11-16).** The main idea is completely separate **bots**, each with its own focus, as parts of Archie. A bot is detached from the default PM role and owns its own home and context. A "master" Archie instance keeps running alongside them. Point 2 is therefore a roster of bots, not a prompt overlay on one PM.

**Decisions (user, 2026-11-16).**

- **Memory has two tiers.** Each bot has its own memory context, which is its **first responder**: what it consults and is given first. The shared Archie memory becomes the **corporate knowledge bank**, readable by every bot. Master Archie also reads every bot's memory and context. Grok Bot has only the first tier.
- **Tools are additive per bot.** *(Superseded 2026-11-18, see below.)*
- **Memory privacy scopes stay as they are.** "Full memory" does not cross the current rules: private-channel and DM memory stay confined to their destination, for bots and for master.
- **Credentials are Archie's.** There is one vault for the deployment, and bots may use it. A bot's own MCP servers add reach, not a separate secret boundary.
- **Each bot has its own Slack handle and DM.**

**Decisions (user, 2026-11-17).**

- **Promotion to the corporate bank is automatic.** Everything a bot's task produces is extracted to the bank at task completion, as extraction works today, as well as to the bot's own memory.
- **Bots are created on deploy, automatically.** A bot definition in the plugins repo is the request; Archie provisions its Slack app. Nobody creates a bot from chat. Mechanism and the admin install step are owned by the bots plan.
- **Several bots may share a channel.** An unaddressed reply goes to the bot attached to the thread; otherwise master Archie acts as the main router.

**Decision (user, 2026-11-18).**

- **Master routes only what is addressed to it, to start with.** Unaddressed messages in threads no Archie bot is engaged in stay ignored, as today. Master picking up unaddressed messages on its own is a possible later extension, not part of the first version.
- **One common MCP pool, scoped per bot.** All MCP servers are defined once for the deployment. A sub-bot reaches only its own subset by default, and knows which bot to call for the others. This replaces the earlier "global set plus the bot's own" model.
- **Sub-bots opt in, master opts out.** A sub-bot's definition explicitly lists the skills and the MCP servers it gets; it inherits neither by default. Master keeps the whole MCP pool and all skills, with a configuration option to disable particular skills for master.
- **Each sub-bot has its own workdir,** possibly nested inside Archie's.
- **The main discussion is a separate target.** A bot's DM, and likewise a channel, should become one continuous conversation instead of a new task per message. It is wanted, but tracked as its own goal apart from the bots work, not bundled into it.
- **Work stays where it was requested.** The current posting rule applies to bots unchanged: a task replies in its own threads, `post_to_channel` is limited to the task's own channel with a quoted human request, and a DM request is answered in the DM.
- **Master does not start work on its own.** It acts only when someone explicitly addresses it, and then routes to a specific bot if needed.

**Decision (user, 2026-11-19).**

- **A routed bot answers for itself.** When master routes a request in a channel, the called bot posts its answer in the thread under its own name. In a DM with master the called bot cannot post, so master relays.

## Findings: the reference products

Neither vendor documents internals. The points below are product behavior from official pages unless marked third-party.

| | ChatGPT Dots | Grok Bot |
|---|---|---|
| Main vs work | Delegated work appears as separate conversations; you "keep talking to your dot while these tasks run"; the dot "can check results and send follow-up instructions to tasks it created" | Routines, events and other Bots start work; results are written back to the Bot's transcript |
| Context handed to work | Only what the dot passes along (third-party reading) | Group chats share "only the context needed"; role memory stays with the Bot |
| Continuity | Conversation, ChatGPT memory and the dot's own **saved notes**, which are "not a transcript" | "Memory and Routines belong to the Bot"; Tools and Skills are account-level |
| Interrupts | Pause stops the main task only; delegated tasks are stopped separately; nothing is undone | A direct message "takes priority over background work"; "Stop now" does not undo |
| Role | A "responsibility" plus instructions and Custom Rules, per dot | Name, avatar, role per Bot; pre-built Team Bots (Customer, EPD Teammate, Marketing, Data) and custom ones |
| Shared spaces | Responds to its owner by default; joining a channel "doesn't start monitoring" | A Team Bot in Slack acts "for the teammate who mentioned it" and keeps separate memory per user |

Three things follow for Archie:

- **A role is a bot.** Neither product scopes a role per channel; a different role means a different bot with its own memory and routines, while tools and skills are shared. Grok users add a coordinator ("chief of staff") bot by convention, which matches the master Archie in the clarified idea.
- **Continuity comes from notes and memory, not from one endless transcript.** That matters for the session design below.
- **Known weak spot:** OpenAI's system card reports scope violations rising from 8.6% to 19.7% as chains of delegated tasks get longer (third-party citation). Approval gates expressed only as prompt rules are criticized in both ecosystems.

Sources: [Meet dots](https://learn.chatgpt.com/docs/dots.md), [Composio guide](https://composio.dev/content/a-guide-to-chatgpt-dots-how-openai-s-always-on-agents-work), [TechTiff](https://techtiff.substack.com/p/openai-dots-chatgpt-agent), [Flavio Copes](https://flaviocopes.com/openai-dots/), [Designing Grok Bot](https://x.ai/news/designing-grok-bot), [Grok Bot chat and collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration), [Team Bots](https://x.ai/news/team-bots).

## Findings: Archie today

- **A task is a Slack thread.** Routing keys on `thread_ts || ts` (`handleSlackEvent`, `src/connectors/slack/events.ts`; `findTaskByThread`, `src/tasks/persistence.ts`). Every top-level DM message starts a new, unrelated task. Top-level channel messages without a mention are dropped unless a trigger watches the channel.
- **Tasks cannot see, launch or message each other.** `launch_task`, task-linked threads and headless tasks were removed on purpose because they "fragment conversations and sever the trace back to the original request" ([PM permissions rework](../plans/20260627-pm-permissions-task-creation.md)). Nothing wakes one task when another completes.
- **Per-channel state already exists.** `src/system/channel-store.ts` holds canvas and pin indexes per channel and tolerates new fields. The "Archie" canvas tab is already described as a per-channel `CLAUDE.md` and is injected at spawn ([canvas plan](../plans/20260627-channel-canvas-project-context.md)).
- **There is no role or persona concept.** Identity is line 1 of `prompts/pm-agent.md`. The `pm.md` overlay is deployment-global. Tracks and `role` frontmatter were removed in the [flat PM rework](../plans/20260910-flat-pm-rework.md). Plugin `agents/*.md` define workers, not the PM's own persona. The overview's "presents as a single assistant" principle would need restating.
- **One Slack identity is assumed throughout.** One bot token and one bot user id held as module state (`src/index.ts`, `src/connectors/slack/client.ts`), used for mention detection, self-message filtering and "thread Archie started" checks. The manifest has no `chat:write.customize` scope.
- **One agent definition is assumed.** `getPmDef()` returns the single PM; sessions persist under the fixed key `pm-agent`; memory, triggers and the plugins checkout are deployment-wide.
- **Memory is not channel-aware at injection.** Summaries are stored per channel, but only user preferences, global recent activity and the entity index are injected, and injection and memory tools are off by default ([memory](../architecture/memory.md)). Private-channel summaries are never injected.
- **Proactivity is the only organizer above tasks.** It keeps cross-thread state (`Matter`s), observes public channels and starts tasks through `Task.prepare` → `startPrepared`, but it is batch extraction with no conversation ([proactivity](../architecture/proactivity.md)).
- **Sessions are built to be short.** 60-minute wall-clock cap per activation, system prompt frozen per spawn, no compaction handling beyond the SDK's, a session-reset path that points at one thread, and research, edit-mode and max-mode grants scoped to the task lifetime.

## Direction (assistant's assessment, not a decision)

### 1. Main discussion as a "home", work as today's tasks

Slack already has the two layers: the top-level stream of a DM or channel, and threads. Map the main discussion to the stream and work sessions to threads.

- A **home** is one long-lived conversation per DM or channel, keyed by channel id rather than thread. Top-level DM messages, and top-level mentions in a channel, route to it.
- The home answers directly when that is enough. For real work it **starts a work task**, which is an ordinary `Task` in its own thread under the message that requested it. The thread is the visible trace, which answers the objection that removed `launch_task`.
- A work task's completion **wakes the home** with its report (hook point: the `task:completed` event). The home can list its open work and send follow-ups to it.
- Edit mode, max mode, research budget and the wall-clock cap stay on work tasks. The home gets no write access to repositories.
- The home's continuity is **durable notes plus channel memory, rebuilt into the prompt on each activation**, as in Dots. Its SDK session can then rotate freely, which avoids the weeks-long-session problems above.

### 2. Bots as first-class definitions

A **bot** is a named agent definition that replaces the PM for the conversations it owns: its own base prompt and focus, model and effort, home notes, and its own tools in addition to the global ones. The master Archie is the default bot and stays what it is today.

- **Definition and engine:** owned by the bots plan: `bots/<key>.md` in the plugins repo, a prompt that extends or replaces the PM prompt, and a bot key on every task. Master Archie is the absence of a bot.
- **Memory:** two tiers.
  - *Bot memory* (first responder): the bot's own namespace, holding its home notes, the summaries of its tasks and what it learned in its focus. It is injected into the bot's prompt at spawn and searched first.
  - *Corporate knowledge bank*: today's shared store (users, entities, task summaries). Every bot reaches it through the memory tools, with only a small index injected.
  - Master's own first responder is the bank, and it can read any bot's namespace.
  - Implementation fits the current layout as a new `memory/bots/<bot-id>/` tree beside `public/` and `private/`, with extraction writing to the owning bot's tree and to the bank.
- **Tools and skills:** the pool stays where it is today, the root `.mcp.json` with its approval tiers, plus the plugins' skills. A sub-bot definition carries two allow-lists, `mcpServers` and `skills`; anything not listed is not attached. Master gets everything minus a deny-list of skills, which fits the existing `pm.md` overlay. Each bot's prompt gets a short directory of which bot holds which servers, and reaches them by handing the request to that bot (item 5 of the sequence). To verify: whether the SDK can filter skills per session when whole plugin directories are passed, or whether the engine must assemble a per-bot plugin view.
- **Workdir:** a nested tree per sub-bot, for example `WORKDIR/bots/<key>/`, holding that bot's memory tier and notes, and possibly its task sessions and trigger data. This replaces the `memory/bots/<bot-id>/` layout suggested above. Master's workdir is today's, and master can read every bot's tree. To verify against `src/memory/CLAUDE.md` invariants and the bots plan's `findTaskByThread(threadId, botKey)` before choosing what moves under the bot's tree.
- **Master as router:** when a message reaches master that belongs to a bot's focus, master hands it to that bot and is woken with the result, using the same start-work and completion-wake mechanism as section 1. Bot-to-bot handoff can wait.

**Slack identity.** One Slack app per bot, served by one backend; routing, de-duplication between apps and provisioning are designed in the bots plan and not repeated here. A bot's DM is its natural home.

**Agreement with the bots plan.** The plan's ownership rules stand unchanged: an unaddressed thread reply goes to the bot engaged last on that thread, and a reply in a thread no Archie app is engaged in is ignored. Master's router role is limited to requests addressed to master.

### 3. Persona follows the channel

A bot's home prompt is assembled from the bot's definition, the canvas brief, pins, the channel's own rolling summary, its notes and its open work. It needs channel-scoped memory injection restricted to the task's exact destination, so the current privacy rules hold.

### Possible sequence

The bots plan delivers bot definitions, the multi-app connector, the first bot on its own Slack app and provisioning (its stages 0 to 4). It defers the rest to this proposal:

1. Per-bot skill and MCP allow-lists from the common pool; skill deny-list for master.
2. Per-bot workdir.
3. Bot memory tier beside the corporate bank.
4. Main discussion (separate target): a bot's DM, and a channel, as one continuous conversation that starts work tasks and is woken by them.
5. Master as router, and master ↔ bot handoff.
6. Ambient following of unmentioned messages, if wanted.

Items 1 to 3 depend only on the plan's stage 1. Item 4 depends on its stage 3. Scoping in item 1 is only complete once item 5 exists, because a bot reaches servers outside its own subset by calling another bot.

## Assumptions

- Bots share one deployment, one plugins repo, one credential vault and one set of approvals and sandboxing rules.
- Work tasks stay as they are, each owned by the bot that started it.
- A home is addressed explicitly (DM or mention) until ambient following is chosen.

## Hard constraints

- Task state and queues are in-process; a home must survive restarts from disk alone ([distributed queues](distributed-queues.md) is related).
- Memory fixes one destination per task and never injects private content.
- Per-bot model and effort touch cost; `resolveAgentModel` is currently bot-blind.
- Subagents and bots would share one process, sandbox and credentials; a bot is a focus boundary, not a security boundary, unless that is designed in. Whatever is promoted to the corporate bank is readable by every bot, so the promotion rule is the only boundary between bots.
- Memory injection and memory tools are off by default (`ARCHIE_MEMORY_INJECT`, `ARCHIE_MEMORY_TOOLS`); the shared-memory behavior depends on them being on.
- Following unmentioned messages changes the Bolt gate and needs spend limits.

## Open questions (user's to decide)

1. In channels, does a bot see unmentioned messages or only mentions? (Deferred with the router extension.)

## Next step

Filed 2026-11-19: capabilities and routing under [#411](https://github.com/sweatco/archie-hq/issues/411), the main discussion as [#416](https://github.com/sweatco/archie-hq/issues/416). The main discussion needs a plan before tasks are filed. The bots plan lists memory scopes, bot tools and credentials as unanswered; they are answered in the decisions above, and its cross-references to this proposal's question numbers are stale.
