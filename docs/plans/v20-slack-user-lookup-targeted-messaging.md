# Plan: Slack User Lookup & Targeted Messaging

## Context

The PM agent currently can only post messages to the originating Slack thread (or broadcasts to all linked threads). There's no way to:
1. Find a Slack user by name (only by ID)
2. Send a message to a specific user via DM or to a different channel
3. Link those new conversations back to the current task

This limits Archie's ability to coordinate across people — e.g., "ping John about this" requires knowing John's user ID and having a tool to DM him.

The goal is to give PM the ability to find users, message them (or any channel), and have those conversations automatically linked to the task so replies flow back.

## Changes

### 1. `src/connectors/slack/client.ts` — Slack API layer

**Add user listing with cache:**

```typescript
interface SlackUserInfo {
  id: string;
  name: string;          // @handle
  realName: string;      // Full name
  displayName: string;   // Display name (may differ from realName)
}

let userCache: SlackUserInfo[] = [];
let userCacheTimestamp = 0;
const USER_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

export async function listWorkspaceUsers(): Promise<SlackUserInfo[]> {
  if (userCache.length > 0 && Date.now() - userCacheTimestamp < USER_CACHE_TTL) {
    return userCache;
  }
  // Paginated users.list call, filter out bots and deactivated
  // Store in userCache, update timestamp
  return userCache;
}

export async function findUsersByName(query: string): Promise<SlackUserInfo[]> {
  const users = await listWorkspaceUsers();
  const q = query.toLowerCase();
  // Match against name, realName, displayName — case-insensitive substring
  return users.filter(u =>
    u.name.toLowerCase().includes(q) ||
    u.realName.toLowerCase().includes(q) ||
    u.displayName.toLowerCase().includes(q)
  );
}
```

**Add DM channel opening:**

```typescript
export async function openDMChannel(userId: string): Promise<string> {
  const client = getSlackClient();
  const result = await client.conversations.open({ users: userId });
  return result.channel!.id!;
}
```

**Add top-level message posting (creates a new thread):**

```typescript
export async function postNewMessage(channel: string, text: string): Promise<string | undefined> {
  // Same as postToThread but WITHOUT thread_ts — creates top-level message
  // Returns the message ts (which becomes the thread_id for replies)
  if (dryRun) { ... }
  const client = getSlackClient();
  const slackText = slackifyMarkdown(restoreMentions(text));
  const result = await client.chat.postMessage({ channel, text: slackText, mrkdwn: true });
  return result.ts;
}
```

### 2. `src/tasks/task.ts` — Task posting logic

**Update `postToUser` signature and behavior:**

```typescript
interface PostTarget {
  channel?: string;        // existing channel key (e.g., "slack:C123:456.789")
  new_dm?: string;         // user ID — open DM, post, link
  new_thread?: string;     // channel ID — post top-level, link
}

async postToUser(
  message: string,
  agentName?: string,
  target?: PostTarget
): Promise<string | null> {  // returns new channel key when creating, null otherwise
```

Logic:
- **`target.new_dm`**: Call `openDMChannel(userId)` to get the DM channel ID (e.g., `D1234` — always the same for a given user) → scan `metadata.channels` for an existing slack channel with matching `channel_id` → if found, post to that existing thread and return its channel key → if not found, `postNewMessage(dmChannelId, message)` → register new entry `slack:{dmChannelId}:{ts}` with name `DM with {realName}` → return new channel key. No metadata changes needed — the DM channel ID itself is the unique identifier for a user's DM.
- **`target.new_thread`**: Call `postNewMessage(channelId, message)` → get `ts` → register `slack:{channelId}:{ts}` → return channel key
- **`target.channel`**: Look up the channel in `metadata.channels` → post to that specific thread only → return null
- **No target**: Look up `default_channel` → post to that thread only → return null

The key behavioral change: **no more broadcasting to all threads**. Without a target, post to `default_channel` only.

**Update `postInteractiveToUser` to match:** Same logic — post to `default_channel` only instead of broadcasting to all threads. This applies to approval buttons (edit mode, research budget, subtask budget).

**Add helper to register a new channel:**

```typescript
private registerSlackChannel(channelId: string, threadTs: string, channelName: string): string {
  const key = `slack:${channelId}:${threadTs}`;
  this.metadata.channels[key] = {
    type: 'slack',
    thread_id: threadTs,
    channel_id: channelId,
    channel_name: channelName,
    last_processed_ts: threadTs,
    url: buildThreadUrl(channelId, threadTs) ?? undefined,
  };
  this.debouncedSave();
  return key;
}
```

**Find existing channel by channel_id** (used for DM reuse):

```typescript
private findChannelBySlackId(slackChannelId: string): { key: string; channel: SlackChannel } | null {
  for (const [key, ch] of Object.entries(this.metadata.channels)) {
    if (ch.type === 'slack' && ch.channel_id === slackChannelId) return { key, channel: ch };
  }
  return null;
}
```

**DM reuse** — `new_dm` calls `openDMChannel(userId)` to get the DM channel ID, then uses `findChannelBySlackId` to check if we already have a thread in that DM. If so, posts there. No type changes needed.

### 3. `src/agents/tools.ts` — Tool definitions

**New tool: `createFindSlackUserTool`**

```typescript
function createFindSlackUserTool(agent: Agent, task: Task) {
  return tool(
    'find_slack_user',
    'Search for a Slack user by name. Returns matching users with their IDs. Use this to find user IDs before sending DMs.',
    {
      query: z.string().describe('Name or part of name to search for'),
    },
    async (args) => {
      const matches = await findUsersByName(args.query);
      if (matches.length === 0) return ok('No users found matching that query.');
      const list = matches.slice(0, 10).map(u =>
        `- ${u.realName} (@${u.name}) — ID: ${u.id}`
      ).join('\n');
      return ok(`Found ${matches.length} user(s):\n${list}`);
    },
  );
}
```

**Update `createPostToUserTool`**

Add optional target parameter with a zod union/object:

```typescript
function createPostToUserTool(agent: Agent, task: Task) {
  return tool(
    'post_to_user',
    'Send a message to the user. Without target, posts to the default channel. ' +
    'Use target.channel to post to a specific linked thread. ' +
    'Use target.new_dm with a user ID to start a DM conversation (links it to this task). ' +
    'Use target.new_thread with a channel ID to start a new thread in a channel (links it to this task). ' +
    'When creating new threads, returns the channel key for future use.',
    {
      message: z.string().describe('The message to send'),
      target: z.object({
        channel: z.string().optional().describe('Channel key of an existing linked thread (e.g., "slack:C123:456.789")'),
        new_dm: z.string().optional().describe('User ID to start a new DM conversation with'),
        new_thread: z.string().optional().describe('Channel ID to start a new thread in'),
      }).optional().describe('Where to post. Omit to post to the default channel.'),
    },
    async (args) => {
      const agentName = agent.def.id as AgentName;
      logger.agentToSlack(agentName, args.message);
      task.touch();
      const newChannelKey = await task.postToUser(args.message, agentName, args.target);
      if (newChannelKey) {
        return ok(`Message posted. New channel linked: ${newChannelKey} (saved in task metadata for future use)`);
      }
      return ok(`Message posted.`);
    },
  );
}
```

**Register in `createPMAgentMcpServer` (line 884):**

Add `createFindSlackUserTool(agent, task)` to the tools array.

### 4. `prompts/pm-agent.md` — PM prompt update

In the "Action Tools" section, update `post_to_user` description and add `find_slack_user`:

```markdown
- `post_to_user`: Send a message to the user. By default posts to the originating channel. Optionally target a specific channel:
  - `target.channel`: Post to a specific linked thread (use the channel key)
  - `target.new_dm`: Start a new DM with a user (pass their user ID). Links the DM thread to this task so replies flow back. Returns the channel key.
  - `target.new_thread`: Start a new thread in a channel (pass channel ID). Links it to this task. Returns the channel key.
- `find_slack_user`: Search for a Slack user by name. Returns matching users with IDs. Use before sending DMs.
```

Add a section on cross-channel communication:
```markdown
### Cross-Channel Communication

You can reach people beyond the originating thread:
1. Use `find_slack_user` to look up a user's ID by name
2. Use `post_to_user` with `target.new_dm` to start a DM — this links the conversation to the current task
3. Use the returned channel key with `target.channel` for follow-up messages to the same thread

Replies from the DM will automatically route back to this task.
```

### 5. Slack manifest — No changes

All required scopes already present: `users:read`, `im:write`, `chat:write`.

### 6. Event handling — No changes

`findTaskByThread()` already scans all channels for matching `thread_id`. New linked threads will be found automatically.

## Edge Cases

1. **DM reuse**: Handled inside `postToUser` — `openDMChannel` returns the same channel ID for a given user, so we match on `channel_id` to find existing DM threads.
2. **Bot not in channel**: `chat.postMessage` to a channel the bot isn't a member of will fail. Let the error propagate to the agent via `err()`.
3. **Dry-run mode**: `postNewMessage` and `openDMChannel` should respect the existing `dryRun` flag.
4. **Default channel is null**: CLI-originated tasks have `default_channel: null`. Posting without target falls back to event emission only (existing behavior).
5. **User cache staleness**: 10-minute TTL is reasonable. New hires won't appear for up to 10 minutes.

### 7. `src/agents/__tests__/tool-contract.test.ts` — Update test

The test hardcodes expected PM tool names in `SPAWN_PM_TOOLS` array (line 97). Add:
```typescript
'mcp__pm-agent-tools__find_slack_user',
```

The `makeTask()` mock (line 64) has `postToUser: vi.fn()` — no signature change needed since extra args are optional.

## Verification

1. **Type check**: `npm run typecheck` passes
2. **Unit tests**: `npm run test` passes (tool-contract test updated)
3. **Manual test flow**:
   - Start a task via Slack
   - PM calls `find_slack_user("somename")` — verify results
   - PM calls `post_to_user("hello", { new_dm: "U..." })` — verify DM arrives, channel key returned
   - Reply to the DM — verify it routes to the same task
   - PM calls `post_to_user("follow-up", { channel: "slack:D..." })` — verify it goes to the same DM thread
   - PM calls `post_to_user("update")` without target — verify it goes to default channel only (not DM)
