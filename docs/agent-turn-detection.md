# Agent Turn Detection with Claude Agent SDK Hooks

## Overview

This document explains how to reliably detect when an agent completes its turn in a multi-turn conversation using the Claude Agent SDK's built-in hook system.

## Key Concept: Turn vs. Termination

### Turn Completion
- Agent finishes responding and **waits for next user input**
- Agent session is **still active** and running
- Agent will process more messages in the same session
- Example: Backend agent completes investigation and waits for PM's next message

### Agent Termination/Stopping
- Agent execution is **ending permanently**
- Session is cleaning up and shutting down
- No more turns will happen
- Example: Task is complete and agent is being disposed

## Available Hook Events

The Claude Agent SDK provides 12 built-in hook events:

```typescript
const HOOK_EVENTS = [
  "PreToolUse",           // Before a tool is executed
  "PostToolUse",          // After successful tool execution
  "PostToolUseFailure",   // After tool execution fails
  "Notification",         // System notifications (includes idle state)
  "UserPromptSubmit",     // When user submits a prompt
  "SessionStart",         // Session begins
  "SessionEnd",           // Session ends
  "Stop",                 // Agent stopped/terminated
  "SubagentStart",        // Subagent spawned
  "SubagentStop",         // Subagent stopped
  "PreCompact",           // Before context compaction
  "PermissionRequest"     // Permission requested
];
```

## The Right Hook for Turn Detection

### ✅ Use: `Stop` Hook

The **Stop hook** fires when the agent finishes its turn. Tested and confirmed in `feature/agent-recovery-idle-detection` branch.

**Type Definition:**
```typescript
type StopHookInput = BaseHookInput & {
  hook_event_name: 'Stop';
  stop_hook_active: boolean;
};
```

**Implementation Example:**
```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

const agentQuery = query({
  prompt: inputGenerator,
  options: {
    model: 'claude-sonnet-4-5-20250929',
    hooks: {
      Stop: [{
        hooks: [async () => {
          console.log('Agent turn completed - waiting for input');

          // Your turn completion logic here:
          // - Update agent active state
          // - Check if all agents are idle
          // - Trigger recovery if needed
          return { continue: true };  // Don't terminate, wait for next message
        }]
      }]
    }
  }
});
```

### ❌ Don't Use: `Notification` Hook with `idle_prompt` for Turn Detection

The Notification hook with `notification_type === 'idle_prompt'` is NOT the right mechanism for detecting turn completion in multi-agent streaming setups.

## Alternative Detection Methods

### Option 1: PostToolUse Hook
Track tool execution patterns to infer turn completion:

```typescript
let lastToolUseTime: Date | null = null;

hooks: {
  PostToolUse: [{
    hooks: [async (input) => {
      lastToolUseTime = new Date();

      // Check if this is a message-sending tool (indicates turn end)
      if (input.tool_name === 'send_message_to_pm_agent' ||
          input.tool_name === 'report_completion') {
        console.log('Agent completed turn (sent message)');
      }

      return { continue: true };
    }]
  }]
}
```

**Pros:**
- Fine-grained tracking of tool usage
- Can detect application-specific completion patterns

**Cons:**
- Requires knowledge of which tools indicate turn completion
- Less reliable than Notification hook

### Option 2: UserPromptSubmit Hook
Detect when the next turn begins:

```typescript
hooks: {
  UserPromptSubmit: [{
    hooks: [async (input) => {
      console.log('Previous turn ended, new prompt submitted');
      console.log(`Prompt: ${input.prompt}`);
      return { continue: true };
    }]
  }]
}
```

**Pros:**
- Definitive turn boundary
- Gives access to the new prompt

**Cons:**
- Fires at the start of the next turn, not at the end of the current turn
- Timing may not be ideal for some use cases

### Option 3: Event Stream Observation
Monitor assistant messages without tool uses:

```typescript
for await (const event of agentQuery) {
  if (event.type === 'assistant') {
    const content = event.message.content;

    // Check if message has no tool uses (agent is waiting)
    const hasToolUses = Array.isArray(content) &&
      content.some(block => block.type === 'tool_use');

    if (!hasToolUses) {
      console.log('Agent sent message without tools - turn likely ending');
    }
  }
}
```

**Pros:**
- No hooks required
- Works with existing event processing code

**Cons:**
- Not as reliable (agent might send text before tool uses)
- Requires manual pattern matching

## Hook Configuration Format

### Basic Hook Configuration

```typescript
const agentQuery = query({
  prompt: inputGenerator,
  options: {
    model: 'claude-sonnet-4-5-20250929',
    hooks: {
      Notification: [{
        hooks: [async (input) => {
          // Hook logic here
          return { continue: true };
        }]
      }]
    }
  }
});
```

### Advanced Hook Configuration with Matcher

```typescript
hooks: {
  PostToolUse: [{
    // Optional matcher for specific tools (glob pattern)
    matcher: 'send_message_to_*',
    hooks: [async (input) => {
      console.log(`Tool completed: ${input.tool_name}`);
      return { continue: true };
    }],
    timeout: 30  // seconds
  }]
}
```

### Multiple Hooks

```typescript
hooks: {
  Notification: [{
    hooks: [
      async (input) => {
        // First hook
        console.log('Hook 1');
        return { continue: true };
      },
      async (input) => {
        // Second hook
        console.log('Hook 2');
        return { continue: true };
      }
    ]
  }]
}
```

## Hook Return Values

Hooks return a `HookJSONOutput` object with these options:

```typescript
type SyncHookJSONOutput = {
  continue?: boolean;           // Continue or stop execution (default: true)
  suppressOutput?: boolean;     // Hide output from user
  stopReason?: string;          // Why execution stopped
  decision?: 'approve' | 'block';  // For permission hooks
  systemMessage?: string;       // Add system message to conversation
  hookSpecificOutput?: {        // Hook-specific data
    hookEventName: 'Notification';
    additionalContext?: string;  // Inject additional context
  };
};
```

## Complete Implementation Example

Here's a complete example for the backend agent with turn detection:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createAgentInputGenerator } from './input-generator';

export async function startBackendAgent(
  queue: MessageQueue,
  sessionId: string,
  onTurnComplete?: () => void
) {
  const inputGenerator = createAgentInputGenerator(queue, sessionId);

  const agentQuery = query({
    prompt: inputGenerator,
    options: {
      model: 'claude-sonnet-4-5-20250929',
      systemPrompt: BACKEND_SYSTEM_PROMPT,
      maxTurns: 100,

      hooks: {
        // Detect turn completion
        Stop: [{
          hooks: [async () => {
            console.log('[Backend Agent] Turn completed - waiting for input');

            // Call custom callback
            if (onTurnComplete) {
              onTurnComplete();
            }

            return { continue: true };
          }]
        }],

        // Track tool usage for debugging
        PostToolUse: [{
          hooks: [async (input) => {
            console.log(`[Backend Agent] Tool: ${input.tool_name}`);
            return { continue: true };
          }]
        }]
      }
    }
  });

  // Process agent events
  for await (const event of agentQuery) {
    // Handle events as normal
  }
}
```

## Comparison Table

| Hook | Fires On | Use For | Timing |
|------|----------|---------|--------|
| `Stop` | Agent finishes turn | ✅ **Turn completion detection** | End of turn |
| `SessionEnd` | Session ends | Includes exit reason | End of session |
| `PostToolUse` | After each tool execution | Tool-level monitoring, custom patterns | After each tool |
| `UserPromptSubmit` | New user message arrives | Next turn detection | Start of next turn |

## Best Practices

1. **Use the Right Hook**: For turn detection, use the `Stop` hook with `return { continue: true }` to keep the agent alive for the next message.

2. **Keep Hooks Fast**: Hooks run synchronously in the agent execution path. Keep them lightweight.

3. **Handle Errors**: Wrap hook logic in try-catch to prevent breaking agent execution:
```typescript
hooks: [async (input) => {
  try {
    // Your logic here
  } catch (error) {
    console.error('Hook error:', error);
  }
  return { continue: true };
}]
```

4. **Return Properly**: Always return a valid `HookJSONOutput`. If unsure, return `{ continue: true }`.

5. **Use Matchers**: For tool-specific hooks, use the `matcher` pattern to filter:
```typescript
PostToolUse: [{
  matcher: 'send_message_*',  // Only MCP messaging tools
  hooks: [/* ... */]
}]
```

## References

- [Claude Agent SDK Documentation](https://docs.anthropic.com/en/api/beta-headers)
- [Hook Events Type Definition](../node_modules/@anthropic-ai/claude-agent-sdk/entrypoints/agentSdkTypes.d.ts)
- [Agent Implementation Examples](../src/agents/)

## Related Documentation

- [System Orchestration](./system-orchestration.md) - How agents coordinate
- [Task Runtime](./task-runtime.md) - Task lifecycle management
- [Message Queue](../src/system/message-queue.ts) - Inter-agent communication
