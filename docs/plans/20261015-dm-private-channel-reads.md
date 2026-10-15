# Dm private channel reads

**Date:** 2026-10-15 · **Status: Implemented (this PR).**

## Acceptance criteria

| id | criterion | method |
|---|---|---|
| AC1 | In a DM with U, list_channels includes the private channels both Archie and U are in, and read_channel_history / read_thread read them. | unit |
| AC2 | A private channel where U is not a member stays refused in that DM (as do group DMs and other DMs), and every non-DM task behaves exactly as on main: same access, same refusal text, no extra Slack calls. | unit |
| AC3 | A DM trigger run bound to U (homed in the DM, no thread yet) gets the same access as AC1. | unit |
| AC4 | Membership is live: after U leaves C, the next read is refused (no cache). | unit |
| AC5 | Private content does not travel: the PR body carries the path-by-path analysis with citations; containment rests on existing gates; residuals R1 (persistence past membership) and R2 (U-directed egress) are accepted as parity with a task living in C and documented. | manual |
| AC6 | prompts/pm-agent.md:46 and docs/architecture/slack-integration.md each state the new rule in one sentence. | structural |

## Design

A task whose one fixed Slack conversation is a 1:1 DM with person U may also list and read a private channel C while U is a member of C, checked against Slack on every read.

Who U is. U is derived from `task.metadata.memory_destination.channel_id` (types/task.ts:279). That is the task's immutable Slack destination: `append` sets it from the first linked thread (task.ts:459, 580-600), and `fireTrigger` sets it to the binding's channel for a schedule fire (trigger-scheduler.ts:421). Every Slack delivery is refused unless it targets that destination (`prepareMemoryDelivery`, task.ts:602-607), so tying the read grant to the same field means anything read from C can only be said back into that DM. A new helper `dmPartnerOf(task)` in src/agents/tools.ts returns undefined unless the destination starts with `D`. Then it calls `getChannelInfo(destination)` (client.ts:1769), which returns `{ isIm, imUserId }` and swallows API errors as `isIm:false` (but throws when the Slack client is uninitialised, client.ts:1772, so the helper adds `.catch(() => null)`), and returns `imUserId` only when `isIm`. A lookup failure therefore reads as 'not a DM' and never widens access. Non-DM tasks never reach the Slack call. For a trigger run, the destination is the binding's `channel_id`. `prepareTriggerDelivery` (task.ts:609-616) verified at proposal and approval that this DM's partner equals `binding.user_id` (tools.ts:2369), and a 1:1 DM's partner never changes. So the binding's user and the derived U are the same value, through one code path. Rejected alternative: persisting `binding.user_id` on the fired task (a new field, two code paths).

The read gate. `assertAccessibleChannel` (client.ts:1526) gains an optional third parameter `dmUserId`. After the existing own-channel pass and before the existing refusal, a channel passes when `dmUserId` is set, `is_private === true`, it is not `is_im` or `is_mpim`, and `fetchConversationMemberIds(channelId)` (client.ts:1816, paginated `conversations.members`, not cached) includes `dmUserId`. Everything else falls through to the existing refusal unchanged. Archie's own membership needs no check of ours: a bot token cannot `conversations.info`, `conversations.members` or read history of a private channel the bot is not in. Slack's error then flows to `formatSlackReadError` as `channel_not_found` or `not_in_channel`. A members-lookup error propagates the same way and fails closed. `fetchChannelHistory` (client.ts:1566) and `fetchExploreThread` (client.ts:1589) each gain a trailing optional `dmUserId` that they pass through.

The listing. `listBotChannels` (client.ts:2729) gains an optional `sharedWithUserId`. When it is set, the `users.conversations` call uses `{ user: sharedWithUserId, types: 'private_channel' }` instead of `{ types: 'public_channel' }`. For a bot token this returns only private channels the bot shares with that user, and `private_channel` excludes group DMs. `list_channels` (tools.ts:460) calls `listBotChannels()` exactly as today. Only when `dmPartnerOf` returns U does it also call `listBotChannels(U)` and list those channels with a private-shared marker.

Refusal wording. `formatSlackReadError` (format-errors.ts:75) gains an optional `inDm = false`. When true, the PrivateChannelError text names the DM rule, and the `not_in_channel`/`channel_not_found` text tells the person to invite Archie into the private channel. When false, both strings stay byte-identical to main. The read tools pass `dmUser !== undefined`.

Model-facing text. The descriptions of `list_channels`, `read_channel_history` and `read_thread`, plus prompts/pm-agent.md:46, state the DM rule.

Non-DM tasks: `dmPartnerOf` returns before any Slack call, the gate receives `dmUserId` undefined and behaves exactly as on main, `listBotChannels` is called once with no arguments, and refusal text is unchanged.

Out of scope and untouched: group DMs, other people's DMs, user tokens, search, `fetch_slack_reference` file and canvas allowlists, canvas and pin prompt injection (`taskSlackChannelIds` and `taskSlackChannelLabels` in channel-ids.ts stay as they are), `post_to_channel`, memory code, and the trigger scheduler. Docs (docs/architecture/slack-integration.md) are updated at ship, not here.

Failure paths: the `getChannelInfo` failure gives no extra access. A `conversations.members` failure is the read error, and the task gets the invite or 'couldn't read' text. A user who leaves C is refused on the next read because nothing is cached. Restart has no effect because there is no new persisted state.

## Tasks

### T01 — Read gate and listing in the Slack client (tests first)

FIRST write the new tests in src/connectors/slack/__tests__/client.test.ts and run them against the unchanged client. Save the failing output to the scratchpad file named in the brief. THEN implement.

In src/connectors/slack/client.ts:

(1) `assertAccessibleChannel(channelId, allowedIds = new Set(), dmUserId?: string)`. Between the `allowedIds.has` return and the existing `if (ch.is_private !== false || ch.is_im || ch.is_mpim) throw` line, insert: `if (dmUserId && ch.is_private === true && !ch.is_im && !ch.is_mpim && (await fetchConversationMemberIds(channelId)).includes(dmUserId)) return { id: ch.id ?? channelId, name: ch.name ?? channelId };`. Extend the JSDoc above it with one sentence: in a task that lives in a 1:1 DM, `dmUserId` is that person, and a private channel (never a DM or group DM) also passes while they are a member, checked on every call; Slack itself refuses a private channel the bot is not in.

(2) `fetchChannelHistory(channelId, limit = 30, allowedIds?, dmUserId?: string)` and `fetchExploreThread(channelId, threadTs, allowedIds?, dmUserId?: string)` pass `dmUserId` as the third argument to `assertAccessibleChannel`. In their JSDoc, add 'or, in a DM task, a private channel that person is in' where they describe the accessible set.

(3) `listBotChannels(sharedWithUserId?: string)`: replace `types: 'public_channel'` in the `users.conversations` call with `...(sharedWithUserId ? { user: sharedWithUserId, types: 'private_channel' } : { types: 'public_channel' })`. Rewrite its JSDoc's 'PUBLIC channels only' paragraph: without an argument it lists public channels only; with `sharedWithUserId` it lists the private channels the bot shares with that user (for a bot token `users.conversations` with `user` returns only conversations both are in); it never lists other private channels.

Tests to add in client.test.ts (reuse the `slackApi` fake, `BOT_USER` and the `rawMsg` helper):
(a) `fetchChannelHistory('C_shared', 30, new Set(), 'U_DM')` with info `{id:'C_shared', name:'shared', is_private:true, is_im:false, is_mpim:false}` and members `[BOT_USER, 'U_DM']` returns the history.
(b) The same call but with members `[BOT_USER]` rejects with PrivateChannelError and never calls `conversations.history`.
(c) Two consecutive calls, members first `[BOT_USER,'U_DM']` then `[BOT_USER]`: the first resolves, the second rejects with PrivateChannelError, and `conversations.members` was called twice.
(d) With dmUserId, an `is_mpim:true, is_private:true` channel and an `is_im:true` channel are both refused, and `conversations.members` is not called.
(e) Without dmUserId, a private channel is refused and `conversations.members` is not called.
(f) `fetchExploreThread('C_shared','1.0', new Set(), 'U_DM')` with U_DM a member returns the replies.
(g) `conversations.info` rejecting with a Slack-shaped `channel_not_found` error makes `fetchChannelHistory(..., 'U_DM')` reject with that error, not PrivateChannelError. Mirror how other tests shape Slack errors in this file, or use `Object.assign(new Error('An API error occurred: channel_not_found'), { data: { error: 'channel_not_found' } })`.
(h) `listBotChannels('U_DM')` calls `users.conversations` with `expect.objectContaining({ user: 'U_DM', types: 'private_channel', exclude_archived: true })`.
Keep the existing 'listBotChannels — public memberships only' test as is. Update the file's header comment bullet about the gate and listBotChannels to mention the DM case in one clause each.

**Files:** `src/connectors/slack/client.ts`, `src/connectors/slack/__tests__/client.test.ts`

**Tests:** ./node_modules/.bin/vitest run src/connectors/slack/__tests__/client.test.ts

**Must not touch:** src/connectors/slack/channel-ids.ts; getChannelInfo; fetchConversationMemberIds body; classifySlackMemoryScope; fetchSlackThread; assertPostableChannel; listWorkspaceChannels; findSlackChannels

### T02 — DM-aware read refusal wording

In src/connectors/slack/format-errors.ts, change the signature to `formatSlackReadError(err: unknown, channel: string, inDm = false): string`. In the PrivateChannelError branch, return `inDm ? <DM text> : <existing text, unchanged>`. The DM text is: `Couldn't read ${channel}: it's a DM, a group DM, or a private channel the person in this DM isn't a member of. From a DM, reading reaches public channels Archie's in, this DM, and private channels both Archie and that person belong to.` In the `not_in_channel || channel_not_found` branch, return `inDm ? <DM text> : <existing text, unchanged>`. The DM text is: `Couldn't read ${channel}: Archie isn't a member of that channel (or it doesn't exist). If it's a private channel the person in this DM belongs to, they can invite Archie there (\`/invite @Archie\`) and ask again.` Update the function's one-line JSDoc to mention the DM variant.

In src/connectors/slack/__tests__/format-errors.test.ts, add (a) exact-equality assertions that, without `inDm`, both existing strings equal main's text verbatim (copy them from the current file before editing); (b) with `inDm` true, the PrivateChannelError text mentions 'person in this DM' and the not_in_channel and channel_not_found texts contain '/invite @Archie' and 'private channel'.

**Files:** `src/connectors/slack/format-errors.ts`, `src/connectors/slack/__tests__/format-errors.test.ts`

**Tests:** ./node_modules/.bin/vitest run src/connectors/slack/__tests__/format-errors.test.ts

**Must not touch:** formatSlackPostError; formatSlackSendError; formatMutedTargetRefusal; formatCrossTaskMuteRefusal

### T03 — Wire the DM partner into list_channels and the read tools; model-facing text

In src/agents/tools.ts:

(1) Below `taskChannelIds`, add `async function dmPartnerOf(task: Task): Promise<string | undefined>` with this body: `const destination = task.metadata.memory_destination?.channel_id; if (!destination?.startsWith('D')) return undefined; const info = await getChannelInfo(destination).catch(() => null); return info?.isIm ? info.imUserId : undefined;`. Give it a JSDoc of at most two sentences. It is the person this task's 1:1 DM is with. It is read from the task's fixed Slack destination, the one conversation every delivery is confined to, so what a DM task reads from a private channel can only be said back into that DM. A failed lookup reads as 'not a DM'.

(2) `read_channel_history` and `read_thread` handlers: after the existing `rejectDmTarget` block and before `try`, add `const dmUser = await dmPartnerOf(task);`. Pass `dmUser` as the new last argument to `fetchChannelHistory(args.channel, args.limit ?? 30, allowed, dmUser)` and `fetchExploreThread(args.channel, args.thread_ts, allowed, dmUser)`. Change the catch to `formatSlackReadError(e, args.channel, dmUser !== undefined)`.

(3) `list_channels` handler: at the top of the try, `const dmUser = await dmPartnerOf(task);`, then `const [publicChannels, sharedPrivate] = await Promise.all([listBotChannels(), dmUser ? listBotChannels(dmUser) : Promise.resolve([])]);`. Replace the existing single `listBotChannels()` call; leave the `seen`/`own` logic untouched. The empty check becomes `publicChannels.length === 0 && sharedPrivate.length === 0 && own.length === 0`. The lines array becomes public lines, then `...sharedPrivate.map((ch) => \`- #${ch.name} — ID: ${ch.id} (private — Archie and the person in this DM are both members)\`)`, then the own lines. The header suffix uses if/else, not a nested ternary: when `sharedPrivate.length > 0`, " (public channels Archie's in, private channels Archie shares with the person in this DM, plus this task's own channel)"; else when `own.length > 0`, the existing " (public channels Archie's in, plus this task's own channel)"; else ''.

(4) Descriptions. In `list_channels`, after the first sentence, insert "In a 1:1 DM it also lists the private channels both Archie and that person are members of. ". Then change 'It never lists other private channels or DMs.' to 'It never lists any other private channel or DM.'. In `read_channel_history` and `read_thread`, replace "plus this task's own channel if it is private or a DM — other private channels and DMs are off-limits." with "plus this task's own channel if it is private or a DM, plus — in a 1:1 DM — any private channel both Archie and that person are in right now. Other private channels and DMs are off-limits."

(5) prompts/pm-agent.md line 46. Insert after its first sentence: "In a 1:1 DM they also reach private channels that both Archie and that person are in right now; if Archie is not in one, ask the person to invite it." Leave the rest of the line unchanged.

Tests in src/agents/__tests__/explore-tools.test.ts:
- Add `getChannelInfo` to the hoisted mocks and to the `vi.mock('../../connectors/slack/client.js', ...)` return. Today the real `getChannelInfo` runs in this file and rejects (no Slack client, client.ts:1772), and `post_to_channel`'s preflight absorbs that with `.catch` (tools.ts:1036). A bare `vi.fn()` would return undefined and break the existing post_to_channel tests. So add ONE file-level `beforeEach` near the top, after the imports, that does `getChannelInfo.mockReset(); getChannelInfo.mockRejectedValue(new Error('Slack client not initialized'));`. This reproduces today's behaviour for every existing test. Do not change any existing `beforeEach`. In the new describe's own `beforeEach`, `getChannelInfo.mockReset()` and mock `{ id: 'D_DM', name: 'DM with Dana', isPrivate: true, isIm: true, imUserId: 'U_DANA' }`.
- Build DM tasks with `makeTask('D_DM')`, then set `(task.metadata as any).memory_destination = { channel_id: 'D_DM' }`.
- Build a fired DM task with `makeTask()`, then set `home_channel = { channel_id: 'D_DM', channel_name: 'DM with Dana' }` and `memory_destination = { channel_id: 'D_DM' }`.
- Cases:
  (a) DM task: list_channels output contains a private shared channel returned by `listBotChannels` when called with 'U_DANA' (use `mockImplementation(async (u) => u ? [{id:'C_SHARED', name:'shared-priv', isPrivate:true, topic:''}] : [{id:'C1', name:'general', isPrivate:false, topic:''}])`). Expect '#shared-priv', 'C_SHARED', 'both members', and `listBotChannels` called with 'U_DANA'.
  (b) DM task: read_channel_history('C_SHARED') calls `fetchChannelHistory` with ('C_SHARED', 30, expect.any(Set), 'U_DANA').
  (c) DM task: read_thread passes 'U_DANA' as the 4th argument of `fetchExploreThread`.
  (d) Fired DM task (no thread yet): same as (a) and (b), proving trigger runs get the same access.
  (e) Non-DM task `makeTask('C_priv')` with `memory_destination = { channel_id: 'C_priv' }`: `getChannelInfo` is not called by list_channels or read_channel_history; `listBotChannels` is called exactly once, with no arguments; `fetchChannelHistory` gets `undefined` as the 4th argument.
  (f) DM task where `getChannelInfo` returns `{ isIm: false, isPrivate: false, id: 'D_DM', name: 'D_DM' }` (lookup failure shape): `listBotChannels` is called only with no arguments.
  (g) DM task: when `fetchChannelHistory` rejects with `new PrivateChannelError('C_X')` (import the real class), the output contains 'person in this DM'.
- Leave the existing test at the current line ~365 ('never enumerates other private channels', `toHaveBeenCalledWith()`) passing unchanged.

**Files:** `src/agents/tools.ts`, `src/agents/__tests__/explore-tools.test.ts`, `prompts/pm-agent.md`

**Tests:** ./node_modules/.bin/vitest run src/agents/__tests__/explore-tools.test.ts src/agents/__tests__/tool-contract.test.ts src/agents/__tests__/trigger-dm-binding.test.ts

**Must not touch:** post_to_channel handler; fetch_slack_reference; rejectDmTarget; taskChannelIds; src/connectors/slack/channel-ids.ts; resolveTriggerOrigin; find_slack_channel; any other line of prompts/pm-agent.md

## Verification plan

| ac | method | scenario | evidence | command |
|---|---|---|---|---|
| AC1 | unit | client.test.ts (a),(f),(h) plus explore-tools.test.ts (a),(b),(c). Live: the brain drives DM D0ATJBRGJL9 against Archie Test (bot U0AT3BYG99C) and asks Archie to list channels and read P-both. | vitest output saved in the scratchpad; the live task's session JSONL tool_use/tool_result pairs for list_channels and read_channel_history on P-both | `./node_modules/.bin/vitest run src/connectors/slack/__tests__/client.test.ts src/agents/__tests__/explore-tools.test.ts` |
| AC2 | unit | client.test.ts (b),(d),(e),(g); explore-tools.test.ts (e),(f); format-errors.test.ts exact non-DM strings; the existing gate tests stay unchanged and green. Live: the operator leaves P-other, then the brain asks Archie to read it. | vitest output saved before (red on main) and after; the live refusal text in the session JSONL | `./node_modules/.bin/vitest run src/connectors/slack/__tests__/client.test.ts src/connectors/slack/__tests__/format-errors.test.ts src/agents/__tests__/explore-tools.test.ts` |
| AC3 | unit | explore-tools.test.ts (d): a fired DM task with home_channel and memory_destination set to the DM and no thread. Live: a one-shot DM trigger whose prompt reads P-both. | vitest output; the fired task's session JSONL | `./node_modules/.bin/vitest run src/agents/__tests__/explore-tools.test.ts` |
| AC4 | unit | client.test.ts (c): two consecutive reads with membership changing in between; conversations.members called twice. Live: read P-other, the operator leaves it, read it again. | vitest output; the two live tool results in the session JSONL | `./node_modules/.bin/vitest run src/connectors/slack/__tests__/client.test.ts -t "members"` |
| AC5 | manual | The PR body lists every place a DM task's output lands, with a file:line citation each, marking contained paths and residuals R1/R2 as accepted parity. A blind reviewer opens each citation and confirms it says what the PR claims. | PR body section 'Where DM output lands'; the reviewer's citation ruling | — |
| AC6 | structural | grep for the new sentence in the prompt and in the architecture doc | grep exit code 0 for both | `grep -n 'In a 1:1 DM they also reach private channels' prompts/pm-agent.md && grep -n -i 'private channel' docs/architecture/slack-integration.md \| grep -i 'DM'` |

## Facts this design stands on

Each was checked against the code by an agent instructed to refute it.

| claim | citation | ruling |
|---|---|---|
| fetchChannelHistory and fetchExploreThread both gate through assertAccessibleChannel before any read | `src/connectors/slack/client.ts:1576` | declared |
| assertAccessibleChannel returns early for allowedIds and otherwise throws PrivateChannelError unless is_private === false and not im/mpim | `src/connectors/slack/client.ts:1535-1540` | declared |
| fetchConversationMemberIds(channelId) paginates conversations.members and returns string[] of member ids; it is module-private in client.ts | `src/connectors/slack/client.ts:1816-1827` | declared |
| getChannelInfo returns { isIm, imUserId } for a 1:1 DM and on any error returns isIm:false instead of throwing | `src/connectors/slack/client.ts:1769-1799` | declared |
| listBotChannels calls users.conversations with types 'public_channel' and its only caller is list_channels | `src/connectors/slack/client.ts:2739` | declared |
| TaskMetadata.memory_destination is { channel_id: string } and optional | `src/types/task.ts:279` | declared |
| Task.append sets memory_destination from the linked thread's channel and setMemoryDestination refuses any different channel afterwards | `src/tasks/task.ts:580-600` | declared |
| fireTrigger sets memory_destination to binding.channel_id and home_channel for a schedule fire | `src/system/trigger-scheduler.ts:421` | declared |
| prepareTriggerDelivery refuses unless the destination DM's imUserId equals binding.user_id | `src/tasks/task.ts:609-616` | declared |
| Every Slack delivery from a task passes prepareMemoryDelivery, which throws unless the target is memory_destination | `src/tasks/task.ts:602-607` | declared |
| read_channel_history and read_thread call fetchChannelHistory/fetchExploreThread with taskChannelIds(task) and map errors with formatSlackReadError(e, args.channel) | `src/agents/tools.ts:902-915` | declared |
| formatSlackReadError has a PrivateChannelError branch and a not_in_channel/channel_not_found branch, and is only called from the two read tools | `src/connectors/slack/format-errors.ts:75-85` | declared |
| explore-tools.test.ts partially mocks the Slack client and keeps the actual getChannelInfo unless overridden | `src/agents/__tests__/explore-tools.test.ts:46-49` | declared |
| explore-tools.test.ts makeTask builds metadata with only channels and default_channel, so existing tests have no memory_destination | `src/agents/__tests__/explore-tools.test.ts:75-100` | declared |
| client.test.ts fakes conversations.members (default [BOT_USER,'UINTERNAL']) and users.conversations on a shared slackApi object reset per test | `src/connectors/slack/__tests__/client.test.ts:17-71` | declared |
| prompts/pm-agent.md:46 is the only prompt sentence stating the explore read rule | `prompts/pm-agent.md:46` | declared |
| users.conversations with a bot token and `user` returns only conversations the bot shares with that user; private_channel excludes group DMs | `https://docs.slack.dev/reference/methods/users.conversations` | declared |
| Without a mock, getChannelInfo in explore-tools.test.ts rejects (getSlackClient throws outside its try), and post_to_channel's preflight absorbs it with .catch | `src/connectors/slack/client.ts:1772` | declared |
| post_to_channel preflight calls getChannelInfo(args.channel).then(c => c.name).catch(() => undefined) on the first post to a channel | `src/agents/tools.ts:1036` | declared |
| single-render-path.test.ts calls fetchChannelHistory with two arguments, unaffected by a trailing optional parameter | `src/connectors/slack/__tests__/single-render-path.test.ts:184` | declared |

## Open at plan time

What the checks could not close. These travelled to implementation as watch-outs and to the pull request as unresolved items.

- CORRECTED FACT — the plan first assumed adding a getChannelInfo mock leaves existing beforeEach blocks unaffected, but a bare vi.fn() breaks post_to_channel's preflight (tools.ts:1036); a file-level default rejection reproduces today's behaviour.
- CORRECTED FACT — the DM-partner check for a trigger binding runs at proposal/approval (tools.ts:2369), not in fireTrigger; equivalence holds because a 1:1 DM's partner never changes.
- UNVERIFIED ASSUMPTION — users.conversations(user=U) with a bot token returns only channels the bot shares with U, and Slack refuses a private channel the bot is not in; settled live only.
