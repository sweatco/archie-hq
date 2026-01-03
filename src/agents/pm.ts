/**
 * PM Agent
 *
 * Task manager and user interface agent. One instance per task.
 * Responsible for assigning task owners and communicating with users via Slack.
 * Uses streaming generator for continuous message processing.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { TaskMetadata } from "../types/index.js";
import type { AgentHandle } from "../types/agent.js";
import { getSharedPath } from "../system/task-manager.js";
import {
  MessageQueue,
  createAgentInputGenerator,
} from "../system/message-queue.js";
import { createPMAgentMcpServer, type ToolCallbacks } from "../mcp/tools.js";
import { processAgentEventForLogging } from "../system/agent-logging.js";
import { getAllRepoConfigs } from "./repo-configs.js";
import { loadPrompt } from "../utils/prompt-loader.js";

/**
 * Generate PM system prompt with dynamically loaded engineering team
 */
async function generatePMSystemPrompt(): Promise<string> {
  const repoConfigs = getAllRepoConfigs();
  const teamList = repoConfigs
    .map((c) => `- ${c.agentId}: ${c.role}`)
    .join("\n");

  const assignmentGuidelines = repoConfigs
    .map((c) => `- ${c.agentId}: ${c.expertise}`)
    .join("\n");

  return loadPrompt("pm-agent", {
    TEAM_LIST: teamList,
    TEAM_EXPERTISE: assignmentGuidelines,
  });
}

/**
 * Spawn a PM agent with streaming input from a message queue
 * Returns an AgentHandle to track the running agent
 */
export async function spawnPMAgent(
  metadata: TaskMetadata,
  queue: MessageQueue,
  callbacks: ToolCallbacks,
  onSessionId: (sessionId: string) => void,
  existingSessionId?: string,
  agentName: string = "pm-agent"
): Promise<AgentHandle> {
  const PM_SYSTEM_PROMPT = await generatePMSystemPrompt();
  // Get task shared folder path (PM's working directory)
  const sharedPath = getSharedPath(metadata.task_id);

  // Create MCP server with PM tools
  const mcpServer = createPMAgentMcpServer(callbacks);

  // Build initial context
  const channelInfo = metadata.slack_threads
    .map((t) => `#${t.channel_id}`)
    .join(", ");

  const context = `
Task: ${metadata.task_id}
Status: ${metadata.status}
Slack Channel(s): ${channelInfo}
Task Owner: ${metadata.task_owner || "Not assigned"}
Participants: ${metadata.participants.join(", ") || "None yet"}

Your working directory: ${sharedPath}

Files available to read (in your working directory):
- knowledge.log (conversation history and agent findings)
- metadata.json (task metadata)
`;

  // Create streaming input generator from queue
  const inputGenerator = createAgentInputGenerator(queue);

  // Run the agent with streaming input - this runs until queue is stopped
  const agentQuery = query({
    prompt: inputGenerator as any,
    options: {
      model: (process.env.SONNET_MODEL || "claude-sonnet-4-5-20250929") as any,
      betas: ["context-1m-2025-08-07"],
      systemPrompt: `${PM_SYSTEM_PROMPT}\n\nCurrent Task Context:\n${context}`,
      cwd: sharedPath,
      executable: "node",
      pathToClaudeCodeExecutable: process.env.CLAUDE_PATH || "claude",
      env: {
        NODE_ENV: process.env.NODE_ENV || "development",
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        PATH: process.env.PATH,
      },
      resume: existingSessionId,
      maxTurns: 100,
      permissionMode: "dontAsk",
      mcpServers: {
        "pm-agent-tools": mcpServer,
      },
      allowedTools: [
        "mcp__pm-agent-tools__send_message_to_agent",
        "mcp__pm-agent-tools__post_to_slack",
        "mcp__pm-agent-tools__assign_task_owner",
        "mcp__pm-agent-tools__report_completion",
        "mcp__pm-agent-tools__request_edit_mode",
        "Read",
        "Glob",
        "Grep",
      ],
    },
  });

  // Create handle to track agent state
  const handle: AgentHandle = {
    running: Promise.resolve(),
    isRunning: true,
  };

  // Process agent output in background
  handle.running = (async () => {
    try {
      for await (const event of agentQuery) {
        // Capture session ID
        if (event.type === "system" && event.subtype === "init") {
          onSessionId(event.session_id);
        }

        // Log file operation tool calls
        processAgentEventForLogging(event, agentName, [sharedPath]);
      }
    } catch (error) {
      if (!queue.isStopped()) {
        console.error(`[${agentName}] Error:`, error);
      }
    } finally {
      handle.isRunning = false;
    }
  })();

  return handle;
}

/**
 * PM system prompt additions for specific scenarios
 */
export const PM_PROMPTS = {
  newTask: "New task created, assign owner",
  newUserInput:
    "New user input in the Slack thread. Check knowledge.log for the update.",
  taskCompleted:
    "Task owner completed investigation. Read knowledge.log and post a summary to Slack.",
  statusRequest:
    "User asked for status. Read knowledge.log and post a brief update to Slack.",
};
