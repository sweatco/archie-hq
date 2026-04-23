# Fire-and-Forget (Autonomous) Tasks

## Context

Today, every task in Archie HQ is initiated by a user-facing event:
- Slack `app_mention` / DM / thread reply → creates or appends to a task
- CLI `POST /tasks` → creates a task
- Reminders → only *reactivate* existing tasks, never create new ones

There is no way for Archie to *kickstart* a new task on its own initiative (e.g. from a future scheduled trigger, cron, or another agent). The user wants to add this "fire-and-forget" capability, with the twist that such tasks start with no predetermined destination — the PM agent itself must decide whether to ping a user via DM or post into a channel.

This uncovers a latent ambiguity in the current design: the "no default_channel" state is overloaded to mean *both* "CLI session" *and* "no destination at all". In `Task.postToUser` ([src/tasks/task.ts:303-314](src/tasks/task.ts#L303-L314)) the fallback when there is no default channel is to silently log to the knowledge log under the literal string `"cli"`. For a CLI session that's the correct behavior (the CLI tails the log via SSE). For an autonomous task it would mean the PM's reply goes into a void where nobody sees it.

**Intended outcome**: a clean separation where "channels" genuinely means "places this task can post to". CLI becomes a first-class channel type. Autonomous tasks start with zero channels and the PM is forced (via a tool-level guardrail, not just prompt text) to either open a destination or complete silently.

## Design

### 1. Promote CLI to a first-class channel type

Extend the channel type union in [src/types/task.ts:40-64](src/types/task.ts#L40-L64):

```ts
export type ChannelType = 'slack' | 'github' | 'cli';

export interface CliChannel extends ChannelBase {
  type: 'cli';
  id: 'cli:local';   // constant — one CLI channel per task at most
}

export type Channel = SlackChannel | GitHubChannel | CliChannel;
```

Channel key: `'cli:local'` (constant). Stored in `metadata.channels['cli:local']` exactly like any other channel.

### 2. Link CLI channel explicitly on every CLI inbound

This mirrors how Slack handles it: `Task.append(thread)` at [src/tasks/task.ts:209-245](src/tasks/task.ts#L209-L245) is called on *every* inbound Slack message, and registers the Slack thread as a channel if it isn't already (`default_channel ??= id`). Slack's precedent is "every entry point links its channel before processing the message" — not a side-effect of task creation.

The CLI should do the same. New method on `Task`:

```ts
linkCliChannel(): void {
  this.metadata.channels['cli:local'] = { type: 'cli', id: 'cli:local' };
  this.metadata.default_channel ??= 'cli:local';   // first-channel-wins rule (same as Slack)
  this.debouncedSave();
}
```

Called from both CLI entry points in [src/connectors/api/routes.ts:170-210](src/connectors/api/routes.ts#L170-L210):

- `POST /tasks` — after `Task.create()`, before `sendMessage(AGENT_PROMPTS.newTask)`
- `POST /tasks/:id/message` — after `Task.get(taskId)`, before `sendMessage(AGENT_PROMPTS.existingTask)`

Re-linking on an already-linked task is a plain overwrite of the same keys and a no-op for the channel state (the `??=` guarantees `default_channel` is only promoted the first time). This matches Slack's behavior exactly: every inbound call hits `append` whether the thread is new or not, and `append` idempotently ensures the channel is linked.

Not called from Slack handlers, reminder scheduler, or the task-launch helper.

**Naming note**: the method is called `linkCliChannel`, not `ensureCliChannel` — it mirrors "link a channel," not "ensure something." Both conceptually and namewise, it's the CLI counterpart of `Task.append` for Slack.

**First channel wins as default**: yes — the `??=` pattern is the existing rule, used in `Task.append` [src/tasks/task.ts:223](src/tasks/task.ts#L223) and in the legacy `slack_threads` migration [src/tasks/task.ts:101](src/tasks/task.ts#L101). `linkCliChannel` follows the same rule.

No migration for existing tasks on disk — per user, there are no orphaned CLI tasks to worry about. If an old task *does* get a CLI follow-up post-deployment, the `linkCliChannel` call on resume ensures it picks up a CLI channel at that point.

### 3. Route CLI posts through the new channel

Update `Task.postToUser` in [src/tasks/task.ts:258-316](src/tasks/task.ts#L258-L316). Current shape:

- `target.new_dm` / `target.new_thread` / `target.channel` handled as today
- default branch: `defaultCh.type === 'slack'` → post to Slack, else fall through to `logOutgoingMessage(sender, message, 'cli')`

New shape for the default branch:

```ts
const defaultCh = this.metadata.default_channel
  ? this.metadata.channels[this.metadata.default_channel]
  : null;

if (!defaultCh) {
  // No channels at all — autonomous task that hasn't picked a destination yet
  throw new ToolError(
    "No channel linked to this task. Use target.new_dm <userId> or target.new_thread <channelId> " +
    "to open a destination, or call report_completion without a message to finish silently."
  );
}

if (defaultCh.type === 'slack') {
  // unchanged — post to Slack thread
} else if (defaultCh.type === 'cli') {
  // Same behavior as today's CLI fallback
  this.logOutgoingMessage(sender, message, 'cli');
}
```

Also update the same-shape block in `postInteractiveToUser` at [src/tasks/task.ts:344-359](src/tasks/task.ts#L344-L359): CLI channel path logs `logger.slack("POST (interactive): ...")` (same as current no-channel behavior) — interactive approvals don't have a real CLI surface anyway, and we want to avoid cascading the guardrail into flows that already work.

**Tool error mechanism**: `post_to_user` in [src/agents/tools.ts:145-171](src/agents/tools.ts#L145-L171) already returns string responses; wrap the `task.postToUser` call in try/catch and return an error `ok()`-style message when channels is empty. Alternatively, do the check *in* the tool wrapper rather than `postToUser` — cleaner layering:

- Put the "empty channels + no target" check at the tool boundary (`createPostToUserTool`), return an error result to the agent.
- `Task.postToUser` stays pure/defensive: if called with no channels, logs a warning and no-ops.

This keeps `Task.postToUser` callable from internal code paths (like `mute_thread`'s notification, reminder-triggered posts, etc.) without those unexpectedly throwing.

### 4. `report_completion` guardrail

Update [src/agents/tools.ts:291-322](src/agents/tools.ts#L291-L322):

```ts
if (args.message) {
  if (Object.keys(task.metadata.channels).length === 0) {
    return ok(
      "Cannot post a completion message — no channel linked. " +
      "Either open a destination via post_to_user(target.new_dm/new_thread) first, " +
      "or call report_completion() without a message to finish silently."
    );
  }
  await task.postToUser(args.message, agentName);
}
```

`report_completion()` with no message stays always-allowed — the escape hatch.

### 5. `launch_task` PM tool

Exposed as a new PM tool `launch_task` (not a REST endpoint — CLI task creation already exists via `POST /tasks`, and the new flow is agent-initiated).

**Tool name**: `launch_task`. Alternatives considered: `spawn_task` (common verb in codebase but overloaded with agent-spawning), `start_task` (too generic), `fork_task` (implies a branch relationship that doesn't exist here — the new task is fully independent). `launch_task` reads cleanly in tool descriptions and avoids jargon.

**Internal helper** in a new module `src/tasks/launch.ts`:

```ts
export async function launchTask(
  originatingTask: Task,
  prompt: string,
  reason: string,
): Promise<{ newTaskId: string; notifiedInChannel: boolean }> {
  // Block fan-out from a task that has no channel of its own. A channel-less task
  // cannot report back to anyone, so letting it spawn more channel-less tasks would
  // create invisible fan-out.
  if (Object.keys(originatingTask.metadata.channels).length === 0) {
    throw new Error(
      'Cannot launch a new task — this task has no linked channel to report back through. ' +
      'Open a channel first via post_to_user(target.new_dm/new_thread), or handle the work inline.'
    );
  }

  const newTask = await Task.create();

  // Seed knowledge.log with the launch context so the new PM can read it
  await appendAgentFinding(
    newTask.taskId,
    'system',
    `Launched from task ${originatingTask.taskId}: ${reason}`,
    'decision',
  );
  await newTask.sendMessage(AGENT_PROMPTS.launchTask(prompt, reason));

  // Notify the originating task's default channel about the launch
  // (originatingTask has at least one channel by the guard above)
  const hasDefault = !!originatingTask.metadata.default_channel;
  if (hasDefault) {
    await originatingTask.postToUser(
      `Launched task \`${newTask.taskId}\` — ${reason}`,
      'system',
    );
  }

  return { newTaskId: newTask.taskId, notifiedInChannel: hasDefault };
}
```

The new task is created with zero channels — that's the whole point. No `autonomous` marker on metadata; the channel-less state is self-describing.

**Fan-out block**: gated on `originatingTask.metadata.channels` being empty, not on a separate flag. Rationale: a channel-less task is exactly the case where invisible fan-out would occur (nobody's watching), so that's the condition we want to block. A launched task that has since opened a DM has a human on the other end and can freely launch more — at that point it's indistinguishable from any other task.

**PM tool wrapper** in [src/agents/tools.ts](src/agents/tools.ts):

```ts
tool(
  'launch_task',
  'Launch a new independent task that runs in the background. Use for fire-and-forget ' +
  'work that should not block the current conversation. The launched task starts with no ' +
  'channel — its own PM will decide whether to ping someone (DM, new thread) or complete ' +
  'silently based on the task. Cannot be called from a task that has no channel of its own.',
  {
    prompt: z.string().describe('The task prompt for the launched PM agent'),
    reason: z.string().describe('Why this task is being launched (shown to the new PM and in the notification)'),
  },
  async (args) => {
    try {
      const { newTaskId, notifiedInChannel } = await launchTask(task, args.prompt, args.reason);
      return ok(
        notifiedInChannel
          ? `Task ${newTaskId} launched. User was already notified in the current channel — do not repost.`
          : `Task ${newTaskId} launched. No channel notified.`
      );
    } catch (err) {
      return ok(`Failed to launch task: ${(err as Error).message}`);
    }
  },
);
```

Return value is explicit about the notification side-effect so the calling PM doesn't duplicate the announcement.

### 6. New `launchTask` prompt

Add to [src/agents/prompts.ts](src/agents/prompts.ts):

```ts
launchTask: (prompt: string, reason: string) => `New task — launched in the background.

Reason: ${reason}

Task: ${prompt}

IMPORTANT: This task starts with no channel — there is no thread or DM waiting for your reply. Before posting anything, you must decide where to reach someone:
- Use find_slack_user / find_slack_channel to locate the right destination
- Use post_to_user with target.new_dm <userId> or target.new_thread <channelId> to open it
- If the task can be completed without pinging anyone, call report_completion() with no message

Calling post_to_user without a target, or report_completion(message) without first opening a channel, will fail.`,
```

### 7. Spawn context update — support channel lists

Update [src/agents/spawn.ts:176-188](src/agents/spawn.ts#L176-L188). A task can legitimately have multiple channels at once (e.g. originated in `#bot-test` thread, then PM opened a DM with `target.new_dm`). Both current rendering and the new rendering must handle lists.

Rendering rules:

- Zero channels → `Channel(s): none — to reply you must first open a destination via post_to_user(target.new_dm <userId>) or post_to_user(target.new_thread <channelId>)`
- One or more channels → join rendered names with `, `. Per channel:
  - `slack` → `#{channel_name}` (default) or `DM:{channel_name}` if the name is already `DM with ...`
  - `cli` → `CLI session`
  - `github` → `PR {repo}#{pr_number}`
- If `default_channel` is set, mark it in the rendering: e.g. `Default channel: #bot-test` on a separate line, so the PM knows where a target-less `post_to_user` will go.

The guardrail hint is only included when `channels` is empty — once the PM has any destination, omit the nag. This way the constraint is visible in every PM turn during the dangerous state (zero channels) but not noise afterward.

### 8. Listing endpoint tweak

[src/connectors/api/routes.ts:90-95](src/connectors/api/routes.ts#L90-L95) currently extracts `channel_name` only from Slack channels. Add a branch so CLI-default tasks show `channel_name: 'cli'` (or similar) in the list response, so the CLI UI can still render them meaningfully. Autonomous tasks will show `null` — correct.

## Files to modify

| File | Change |
|---|---|
| [src/types/task.ts](src/types/task.ts) | Add `'cli'` to `ChannelType`, add `CliChannel` interface, extend `Channel` union |
| [src/tasks/task.ts](src/tasks/task.ts) | Add `linkCliChannel()` method; update `postToUser` default branch to handle CLI channel type and no-channel no-op; update `postInteractiveToUser` similarly |
| [src/connectors/api/routes.ts](src/connectors/api/routes.ts) | Call `linkCliChannel` in both `POST /tasks` (after `Task.create()`) and `POST /tasks/:id/message` (after `Task.get()`); tweak list endpoint to surface CLI channel name |
| [src/agents/tools.ts](src/agents/tools.ts) | Add empty-channels + no-target guardrail to `post_to_user`; add empty-channels guardrail to `report_completion` when message is present; add new `launch_task` tool to `createPMAgentMcpServer` |
| [src/agents/prompts.ts](src/agents/prompts.ts) | Add `launchTask(prompt, reason)` prompt |
| [src/agents/spawn.ts](src/agents/spawn.ts) | Replace hardcoded `'CLI (no Slack channel)'` rendering with multi-channel list rendering; separate `Default channel:` line; empty-channels guardrail hint |
| New: `src/tasks/launch.ts` | `launchTask(originatingTask, prompt, reason)` helper; blocks on channel-less originating tasks; posts notice to originating task's default channel |

Existing functions/utilities reused:
- `Task.create()` — [src/tasks/task.ts:119](src/tasks/task.ts#L119)
- `Task.sendMessage()` — [src/tasks/task.ts:191](src/tasks/task.ts#L191)
- `default_channel ??= id` first-channel-wins pattern — [src/tasks/task.ts:223](src/tasks/task.ts#L223)
- `appendAgentFinding` — [src/tasks/persistence.ts](src/tasks/persistence.ts)
- `post_to_user` tool's `target.new_dm` / `target.new_thread` branches — already handle the "open a destination" flow, no changes needed there

## Verification

1. **Existing Slack flow** — `@archie do X` in a channel. Expect: task created, `default_channel` = slack key, PM replies in-thread as today. No regression.
2. **Existing CLI flow (create)** — `POST /tasks` with a message. Expect: task has `channels: { 'cli:local': { type: 'cli', id: 'cli:local' } }`, `default_channel: 'cli:local'`. PM's `post_to_user` with no target logs to knowledge.log under `cli` destination, same as today. CLI UI reads messages from log as today.
3. **Existing CLI flow (follow-up)** — `POST /tasks/:id/message` on an existing CLI task. Expect: `linkCliChannel` re-assigns the same channel, state unchanged, follow-up processed. Also on an old task that never had a CLI channel: now picks one up on first follow-up.
4. **Launched task, happy path** —
   - From a live Slack or CLI task, PM calls `launch_task({ prompt: "Ask Egor about deploy status", reason: "nightly check" })`
   - Expect: notification posted to originating task's default channel (e.g. Slack thread); tool returns `"Task task-xxx launched. User was already notified..."`
   - New task created with empty `channels`, `default_channel: null`
   - New PM sees `Channel(s): none — ...` in system prompt
   - New PM calls `find_slack_user("Egor")` → gets user ID
   - New PM calls `post_to_user({ message: "Hey, deploy status?", target: { new_dm: "U123" } })` → DM opened, channel linked as `default_channel`
   - New PM calls `report_completion()` without message → task stops
5. **Guardrail on post** — PM calls `post_to_user({ message: "..." })` without target on a task with empty channels. Expect: tool returns error string instructing to use target.new_dm/new_thread or complete silently. Agent retries correctly.
6. **Guardrail on completion** — PM calls `report_completion({ message: "done" })` without having opened a channel. Expect: tool returns error string. Agent either opens a channel first, or calls `report_completion()` with no message.
7. **Silent completion** — Launched-task PM decides no ping is needed, calls `report_completion()` with no message. Expect: task stops cleanly, nothing posted anywhere. Knowledge log shows launch finding + completion.
8. **Fan-out block** — From a launched task that has not yet opened any channel, PM calls `launch_task(...)`. Expect: tool returns error string explaining the block (channel-less task cannot launch more). After the PM opens a DM or thread, a subsequent `launch_task` call succeeds.
9. **Multi-channel rendering** — Task with both a Slack thread and an open DM. Expect spawn context to render both: e.g. `Channel(s): #bot-test, DM with Egor` + `Default channel: #bot-test` on a separate line.
10. **Type check + build** — `npm run typecheck && npm run build`.
11. **Unit tests** — existing `tool-contract.test.ts` should keep passing; add tests for the two new guardrail paths, the fan-out block, and multi-channel spawn rendering.
