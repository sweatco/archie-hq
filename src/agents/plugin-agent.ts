/**
 * Plugin Agent Spawner
 *
 * Generic agent spawner for lightweight, read-only plugin agents.
 * These agents don't need git/worktree/GitHub infrastructure.
 *
 * Prompt composition: agent-core.md (Layer 1) + plugin-agent.md (Layer 2) + agent body (Layer 3)
 * Tools: Read, Glob, Grep, Skill + send_message_to_agent + log_finding (via MCP)
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, symlink, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type { TaskMetadata } from "../types/index.js";
import type { AgentHandle } from "../types/agent.js";
import type { PluginAgentConfig } from "../types/plugin-agent.js";
import { getTaskPath, getSharedPath } from "../system/task-manager.js";
import {
  MessageQueue,
  createRecoverableInputGenerator,
} from "../system/message-queue.js";
import {
  createRepoAgentMcpServer,
  type BaseToolCallbacks,
} from "../mcp/tools.js";
import { processAgentEventForLogging, logger } from "../system/logger.js";
import { buildPeerList } from "./peer-list.js";
import { loadPrompt } from "../utils/prompt-loader.js";

/**
 * Generate the system prompt for a plugin agent
 * Layers: agent-core.md (Layer 1) + plugin-agent.md (Layer 2) + agent body (Layer 3)
 */
async function generatePluginAgentPrompt(
  config: PluginAgentConfig
): Promise<string> {
  // Build peer list from all agents (repo + plugin)
  const peerList = buildPeerList(config.agentId);

  // Layer 1: Universal multi-agent protocol
  const corePrompt = await loadPrompt("agent-core", {
    AGENT_ID: config.agentId,
    AGENT_ROLE: config.role,
    EXPERTISE: config.expertise,
    PEER_LIST: peerList,
  });

  // Layer 2: Plugin-agent track extension
  const pluginPrompt = await loadPrompt("plugin-agent", {});

  // Layer 3: Domain-specific instructions from agent markdown body
  const layers = [corePrompt, pluginPrompt];
  if (config.prompt) {
    layers.push(config.prompt);
  }

  return layers.join("\n\n");
}

/**
 * Set up agent workspace directory and symlink skills
 */
async function setupAgentWorkspace(
  taskId: string,
  config: PluginAgentConfig
): Promise<string> {
  const agentWorkspace = join(getTaskPath(taskId), "agents", config.key);
  await mkdir(agentWorkspace, { recursive: true });

  // Symlink plugin's skills/ into agent's .claude/skills/
  if (config.skillsPath && existsSync(config.skillsPath)) {
    const agentSkillsDir = join(agentWorkspace, ".claude", "skills");
    await mkdir(join(agentWorkspace, ".claude"), { recursive: true });

    for (const skillEntry of await readdir(config.skillsPath, { withFileTypes: true })) {
      if (!skillEntry.isDirectory()) continue;
      const target = join(agentSkillsDir, skillEntry.name);
      if (!existsSync(target)) {
        await mkdir(agentSkillsDir, { recursive: true });
        await symlink(join(config.skillsPath, skillEntry.name), target);
      }
    }
  }

  return agentWorkspace;
}

/**
 * Spawn a plugin agent with streaming input from a message queue
 * Returns an AgentHandle to track the running agent
 *
 * Includes automatic session recovery: if resuming a session fails,
 * it will retry once with a fresh session.
 */
export async function spawnPluginAgent(
  config: PluginAgentConfig,
  metadata: TaskMetadata,
  queue: MessageQueue,
  callbacks: BaseToolCallbacks,
  onSessionId: (sessionId: string) => void,
  existingSessionId?: string
): Promise<AgentHandle> {
  const sharedPath = getSharedPath(metadata.task_id);

  // Set up agent workspace (created at spawn time, not at task creation)
  const agentWorkspace = await setupAgentWorkspace(metadata.task_id, config);

  // Create MCP server with base tools (send_message + log_finding)
  const mcpServer = createRepoAgentMcpServer(callbacks);

  // Build initial context
  const context = `
Task: ${metadata.task_id}
Plugin: ${config.pluginName}
Shared folder: ${sharedPath}

Live task files (these update as work progresses):
- ${sharedPath}/knowledge.log (conversation history and agent findings)
- ${sharedPath}/metadata.json (task metadata - PM agent only)

IMPORTANT: The knowledge.log file is continuously updated by other agents and user messages.
Read it ONCE when you receive a new message, then proceed with your work. Don't poll it repeatedly.
`;

  const systemPrompt = await generatePluginAgentPrompt(config);

  // Build query options (session ID may change on retry)
  const buildQueryOptions = (sessionId?: string) => ({
    model: (config.model || process.env.SONNET_MODEL || "claude-sonnet-4-5-20250929") as any,
    betas: ["context-1m-2025-08-07"] as any,
    systemPrompt: `${systemPrompt}\n\nCurrent Context:\n${context}`,
    cwd: agentWorkspace,
    additionalDirectories: [agentWorkspace, sharedPath] as any,
    executable: "node" as const,
    pathToClaudeCodeExecutable: process.env.CLAUDE_PATH || "claude",
    env: {
      NODE_ENV: process.env.NODE_ENV || "development",
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      PATH: process.env.PATH,
    },
    settingSources: ["project"] as any,
    resume: sessionId,
    maxTurns: 100,
    permissionMode: "dontAsk" as const,
    mcpServers: {
      "repo-agent-tools": mcpServer,
    },
    allowedTools: [
      "mcp__repo-agent-tools__send_message_to_agent",
      "mcp__repo-agent-tools__log_finding",
      "Read",
      "Glob",
      "Grep",
      "Skill",
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
            processAgentEventForLogging(
              event,
              config.agentId,
              [agentWorkspace, sharedPath],
              false // read-only mode
            );
          }

          // Clean exit - loop completed normally
          return;
        } catch (error) {
          // If we had a session ID, retry once without it
          if (sessionId && !hasRetried) {
            logger.warn(
              config.agentId,
              `Agent failed with session ${sessionId}, retrying fresh`
            );
            recoverable.reset(); // Put consumed messages back in queue
            sessionId = undefined;
            hasRetried = true;
            continue;
          }

          // Already retried or no session - give up
          if (!queue.isStopped()) {
            logger.error(config.agentId, "Error", error);
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
