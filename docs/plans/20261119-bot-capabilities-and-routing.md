# Bot capabilities and routing: own skills, tools, workdir, memory and handoff

Created: 2026-11-19

Status: proposed, 2026-11-19. Not implemented and not verified. No owner or dates are agreed; each stage needs its own go-ahead.

## Tracking

| Record | Link |
|---|---|
| Parent issue | [#411](https://github.com/sweatco/archie-hq/issues/411) |
| Milestone: each bot has its own skills, tools and workdir | [milestone 9](https://github.com/sweatco/archie-hq/milestone/9): [#412](https://github.com/sweatco/archie-hq/issues/412) (Stage A), [#413](https://github.com/sweatco/archie-hq/issues/413) (Stage B) |
| Milestone: master Archie routes to the right bot | [milestone 10](https://github.com/sweatco/archie-hq/milestone/10): [#415](https://github.com/sweatco/archie-hq/issues/415) (Stage D) |
| No milestone | [#414](https://github.com/sweatco/archie-hq/issues/414) (Stage C, waits on memory enablement) |
| Separate target | [#416](https://github.com/sweatco/archie-hq/issues/416) (main discussion) |

Live status belongs to those issues and the [Archie project](https://github.com/orgs/sweatco/projects/16); this document owns the design and the dated decisions.

## 1. Context

The [bots plan](https://github.com/sweatco/archie-hq/blob/docs/bots-as-separate-slack-apps/docs/plans/20261117-bots-as-separate-slack-apps.md) ([#382](https://github.com/sweatco/archie-hq/issues/382)) gives each bot a definition file, a prompt and its own Slack app. It explicitly defers per-bot tools, memory, handoff and the main discussion to the proposal [Main discussion, background work sessions and focused bots](../proposals/main-discussion-and-channel-roles.md). This plan covers the first four of those. The main discussion stays a separate target and has no stages here.

**Decisions made by the user** (full list and wording in the proposal):

| Date | Decision |
|---|---|
| 2026-11-16 | Two memory tiers: the bot's own memory is its first responder; the shared memory is the corporate knowledge bank, readable by every bot. Master reads every bot's memory and context |
| 2026-11-16 | Memory privacy scopes stay as they are, for bots and for master |
| 2026-11-16 | One credential vault for the deployment; bots may use it |
| 2026-11-17 | Everything a bot's task produces is extracted to the bank at completion, as today, as well as to the bot's memory |
| 2026-11-18 | One common MCP pool. A sub-bot reaches only its own subset and knows which bot to call for the rest |
| 2026-11-18 | Sub-bots list their skills and MCP servers explicitly and inherit neither. Master keeps the whole pool and all skills, with a way to disable particular skills |
| 2026-11-18 | Each sub-bot has its own workdir, possibly nested |
| 2026-11-18 | Master never starts work on its own. It acts when explicitly addressed and routes to a specific bot if needed |
| 2026-11-18 | Work stays where it was requested; the current posting rule applies to bots unchanged |
| 2026-11-19 | When master routes a request in a channel, the called bot answers in the thread itself |

**Scope.**

| In this plan | Not in this plan |
|---|---|
| Skill and MCP allow-lists per sub-bot; skill deny-list for master | Bot definitions, Slack apps, provisioning (bots plan) |
| A workdir per sub-bot | Main discussion: one continuous conversation per DM and channel (separate target) |
| Bot memory tier beside the corporate bank | Master picking up messages nobody addressed |
| Bot directory, calling another bot, master routing | Per-bot model and effort; per-bot credentials or approval tiers |

## 2. Current foundation and gaps

| Capability | What exists today | Change |
|---|---|---|
| Skills per session | Every plugin directory is passed to the SDK (`pluginConfigs()`, `src/agents/spawn.ts`); all skills are listed. The SDK's `skills` option accepts a list and hides the rest | Pass the bot's list |
| MCP servers per session | Spawn builds one `mcpServers` map: engine in-process servers plus every server in the root `.mcp.json` | Filter the root servers by the bot's list |
| Master configuration | `pm.md` frontmatter: model, effort, max mode (`readPmOverlay`, `src/agents/registry.ts`) | Add `disabledSkills` |
| Persistent directory | Only per trigger: `triggers-data/<id>/` | Add `bots/<key>/` |
| Memory layout | `memory/public`, `memory/private/<channel>`, one serialized writer, one injection block, flags default off ([memory](../architecture/memory.md)) | Add a bot tier under the same rules |
| One task calling another | None. `launch_task` and headless tasks were removed ([PM permissions rework](20260627-pm-permissions-task-creation.md)); nothing wakes a task when another completes | A bounded call between bots that keeps the trace in the caller |

## 3. Proposed solution

### Skills and MCP servers

A sub-bot's definition gains two lists. Master's overlay gains one.

```markdown
# bots/qa.md
---
name: Archie QA
skills: [core:thread-conduct, qa:release-check]
mcpServers: [teamcity, tramline]
---
```

```markdown
# pm.md
---
disabledSkills: [qa:release-check]
---
```

- **Sub-bot.** Spawn passes `skills` to the SDK as the bot's list and attaches only the listed root `.mcp.json` servers. An omitted list means none, not all.
- **Master.** Unchanged, except that names in `disabledSkills` are turned off through the session settings file spawn already writes.
- **Always attached.** The engine's own in-process servers (comms, orchestration, scheduling, repo, research, file bridge) are the engine, not the pool. Every bot keeps them, so every bot can still reply, request edit mode and report completion.
- **Approval tiers and credentials** are untouched: a server keeps its `allow` / `ask` / `deny` policy and its vault credentials whichever bot uses it.
- **Validation.** A name that matches no skill or server is skipped with a warning naming the bot file.
- **Limits.** The SDK describes its skill filter as a context filter, not a sandbox: an unlisted skill's files stay readable on disk. An unattached MCP server is a real boundary for that session. Workers a bot spawns inherit the bot's session, so they get the same set.

Risk: an `extend` bot keeps the core prompt, which names core skills such as `core:thread-conduct`. If its list omits them the bot is told to load a skill it cannot see. Mitigation: the example bot lists the core skills, and the loader warns when an `extend` bot omits a skill the core prompt names.

### Workdir per bot

`WORKDIR/bots/<key>/`, created on the bot's first task.

- `data/`: a persistent directory mounted read-write into every task of that bot, for files it wants to keep between tasks. Same pattern as the trigger directory.
- `memory/`: the bot's memory tier (below).
- Master's tasks get read access to every `bots/*` tree. A sub-bot's tasks get their own tree only.
- **Task sessions stay in the shared `sessions/` directory** in this version. Task lookup, recovery and the API all scan that one directory, and the bots plan already keys tasks by thread and bot there. Moving sessions under the bot's tree is possible later and changes none of the above.
- Removing a bot file leaves its tree in place.

### Memory: bot tier and corporate bank

- **Bank.** Today's `memory/` store, unchanged in layout and rules.
- **Bot tier.** `bots/<key>/memory/`, with the same public and private split by exact destination.
- **Write.** Completion extraction for a bot's task writes to the bank as today and to the bot's tier, through the existing serialized lifecycle queue. No second writer.
- **Inject.** The single injection block gains a first section from the bot's tier for the task's destination; the bank sections follow.
- **Read.** The memory tools search the bot's tier first, then the bank. Master's tools can also read any bot's tier.
- **Authorization** is the current live check on the task's fixed destination, applied to both tiers. A bot's private-channel memory is readable only from that channel, by that bot or by master.
- **Flags.** All of it sits behind the existing `ARCHIE_MEMORY*` flags.

This changes three documented memory invariants (strict storage split, one writer, one injection block's contents), so `docs/architecture/memory.md` and `src/memory/CLAUDE.md` change in the same work.

### Bot directory, calling a bot, and master routing

- **Directory.** Every bot's prompt gets a short roster: each other bot's name, description and MCP servers.
- **Call.** A new orchestration tool lets a bot ask another bot to do something that needs the other's skills or servers. The engine starts a task for the target bot with the brief, and wakes the caller with the report when it completes. The caller answers its user. The call is allowed only inside a task a human started, records the caller task on the called task, cannot be chained (a called task cannot call further) and cannot target the caller itself.
- **Route.** When someone addresses master with a request that belongs to a bot, master uses the same call. In a channel where the target bot is a member, the target also posts its answer in the thread under its own name; by the bots plan's "engaged last" rule, later unaddressed replies in that thread then go to that bot. In a DM with master the target cannot post, so master relays.
- **Why this is not the removed `launch_task`.** That tool started detached tasks in other places. Here the called task belongs to the caller's thread, the result returns to the caller, and nothing is posted outside the conversation the human started.

## 4. Delivery stages

| Stage | Delivers | Depends on | Exit |
|---|---|---|---|
| A | Skill and MCP lists per sub-bot; `disabledSkills` for master | Bots plan stage 1 ([#384](https://github.com/sweatco/archie-hq/issues/384)) | Through the E2E harness, a bot task lists and can use only its skills and servers; master no longer lists a disabled skill; a task with no bot is unchanged |
| B | `bots/<key>/` workdir with `data/` | #384 | A file a bot task writes to `data/` is readable by that bot's next task and by a master task, and not by another sub-bot's task |
| C | Bot memory tier | Stage B; a decision to run memory in production (Memory initiative, [#374](https://github.com/sweatco/archie-hq/issues/374) is its open review) | With memory flags on, a bot's second task is injected with what its first task learned, a master task can read it, and a private-channel summary is not readable from another destination |
| D | Bot directory, call tool, master routing | Stage A; a second Slack app ([#386](https://github.com/sweatco/archie-hq/issues/386)) | Master, addressed in a channel with a QA request, calls Archie QA; QA answers once in the thread; the next unaddressed reply goes to QA only. In a DM, master relays QA's report |

Stages A and B are independent of each other. Each ships separately and is inert until a bot file uses it.

## 5. Validation

- `npm run lint` and focused tests while iterating; `npm run check` before each handoff.
- Stages A and B are covered by the E2E harness using the optional `bot` on task creation from the bots plan. Stage C adds tests under `src/memory/__tests__/`. Stage D needs two Slack apps and is verified by hand in the development workspace.

## 6. Open questions and risks

- **Memory in production.** Injection and memory tools are off by default and the Memory initiative has not accepted production enablement. Stage C can be built and tested but changes nothing for users until that decision.
- **Cost.** A routed request spends two agent sessions.
- **Not a security boundary.** Bots share one process, sandbox and vault. Skill and workdir scoping narrow what a bot is shown, not what a compromised session could reach.
- **Coordination.** Stage D adds a task-completion wake; [#201](https://github.com/sweatco/archie-hq/issues/201) (single Task instance per task id) touches the same lifecycle code.
