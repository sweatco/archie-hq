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
  createRecoverableInputGenerator,
} from "../system/message-queue.js";
import { createPMAgentMcpServer, type PMToolCallbacks } from "../mcp/tools.js";
import { processAgentEventForLogging, logger } from "../system/logger.js";
import { getAllRepoConfigs } from "./repo-configs.js";
import { getAllPluginAgentConfigs } from "./plugin-configs.js";
import { loadPrompt } from "../utils/prompt-loader.js";

/**
 * Generate PM system prompt with dynamically loaded team (repo + plugin agents)
 */
async function generatePMSystemPrompt(): Promise<string> {
  const repoConfigs = getAllRepoConfigs();
  const pluginAgents = getAllPluginAgentConfigs();

  const teamList = [
    ...repoConfigs.map((c) => `- ${c.agentId}: ${c.role}`),
    ...pluginAgents.map((a) => `- ${a.agentId}: ${a.role}`),
  ].join("\n");

  const assignmentGuidelines = [
    ...repoConfigs.map((c) => `- ${c.agentId}: ${c.expertise}`),
    ...pluginAgents.map((a) => `- ${a.agentId}: ${a.expertise}`),
  ].join("\n");

  return loadPrompt("pm-agent", {
    TEAM_LIST: teamList,
    TEAM_EXPERTISE: assignmentGuidelines,
  });
}

/**
 * Spawn a PM agent with streaming input from a message queue
 * Returns an AgentHandle to track the running agent
 *
 * Includes automatic session recovery: if resuming a session fails,
 * it will retry once with a fresh session (consumed messages are replayed).
 */
export async function spawnPMAgent(
  metadata: TaskMetadata,
  queue: MessageQueue,
  callbacks: PMToolCallbacks,
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

  // Build query options (session ID may change on retry)
  const buildQueryOptions = (sessionId?: string) => ({
    model: (process.env.SONNET_MODEL || "claude-sonnet-4-5-20250929") as any,
    betas: ["context-1m-2025-08-07"] as any,
    systemPrompt: `${PM_SYSTEM_PROMPT}\n\nCurrent Task Context:\n${context}`,
    cwd: sharedPath,
    executable: "node" as const,
    pathToClaudeCodeExecutable: process.env.CLAUDE_PATH || "claude",
    settingSources: ["project"] as any,
    env: {
      NODE_ENV: process.env.NODE_ENV || "development",
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      PATH: process.env.PATH,
    },
    resume: sessionId,
    maxTurns: 100,
    permissionMode: "dontAsk" as const,
    mcpServers: {
      "pm-agent-tools": mcpServer,
    },
    allowedTools: [
      "Skill",
      "mcp__pm-agent-tools__send_message_to_agent",
      "mcp__pm-agent-tools__post_to_slack",
      "mcp__pm-agent-tools__assign_task_owner",
      "mcp__pm-agent-tools__report_completion",
      "mcp__pm-agent-tools__request_edit_mode",
      // GitHub tools - only available when edit mode is approved
      ...(metadata.edit_allowed
        ? [
            "mcp__pm-agent-tools__push_branch",
            "mcp__pm-agent-tools__create_pull_request",
            "mcp__pm-agent-tools__get_pr_status",
            "mcp__pm-agent-tools__get_pr_reviews",
            "mcp__pm-agent-tools__update_pr_description",
            "mcp__pm-agent-tools__add_pr_comment",
            "mcp__pm-agent-tools__add_review_comment",
            "mcp__pm-agent-tools__resolve_review_thread",
            "mcp__pm-agent-tools__request_re_review",
            "mcp__pm-agent-tools__trigger_merge_check",
          ]
        : []),
      "Read",
      "Glob",
      "Grep",
    ],
  });

  // Create handle to track agent state
  const handle: AgentHandle = {
    running: Promise.resolve(),
    isRunning: true,
  };

  // Create recoverable input generator (tracks consumed messages for retry)
  const recoverable = createRecoverableInputGenerator(queue);

  // Process agent output in background with session recovery
  handle.running = (async () => {
    let sessionId = existingSessionId;
    let hasRetried = false;

    try {
      while (true) {
        try {
          const agentQuery = query({
            prompt: recoverable.generator() as any,
            options: buildQueryOptions(sessionId),
          });

          for await (const event of agentQuery) {
            // Capture session ID
            if (event.type === "system" && event.subtype === "init") {
              onSessionId(event.session_id);
            }

            // Log file operation tool calls
            processAgentEventForLogging(event, agentName, [sharedPath]);
          }

          // Clean exit - loop completed normally
          return;
        } catch (error) {
          // If we had a session ID, retry once without it
          if (sessionId && !hasRetried) {
            logger.warn(
              agentName,
              `Agent failed with session ${sessionId}, retrying fresh`
            );
            recoverable.reset(); // Put consumed messages back in queue
            sessionId = undefined;
            hasRetried = true;
            continue;
          }

          // Already retried or no session - give up
          if (!queue.isStopped()) {
            logger.error(agentName, "Error", error);
          }
          return;
        }
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
  newTask: 'New task created, assign owner',
  existingTask: 'New input received. Check knowledge.log for the update.',
};
