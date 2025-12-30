/**
 * Unified Repo Agent
 *
 * Generic repository agent that adapts its behavior based on context.
 * Specialization is provided via RepoAgentConfig.
 * Agent determines its role (Task Owner, Participant, PR Maintenance) from
 * knowledge.log and incoming messages, not from spawn parameters.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { TaskMetadata } from "../types/index.js";
import type { AgentHandle } from "../types/agent.js";
import type { RepoAgentConfig } from "../types/repo-agent.js";
import { getSharedPath } from "../system/task-manager.js";
import {
  MessageQueue,
  createAgentInputGenerator,
} from "../system/message-queue.js";
import { createRepoAgentMcpServer, type ToolCallbacks } from "../mcp/tools.js";
import { processAgentEventForLogging } from "../system/agent-logging.js";
import { getAllRepoConfigs } from "./repo-configs.js";

/**
 * Generate the system prompt for a repo agent
 * Includes all roles - agent determines which to use from context
 */
function generateRepoAgentPrompt(config: RepoAgentConfig): string {
  // Build peer list from all other repo agents
  const peerList = getAllRepoConfigs()
    .filter((c) => c.agentId !== config.agentId)
    .map((c) => `- ${c.agentId}: ${c.role} (${c.repoKey} repository)`)
    .join("\n");

  return `You are the ${config.agentId}, a ${config.role}.

You are responsible for the ${config.repoKey} repository.

Your expertise: ${config.expertise}.

Available peer agents:
${peerList}
- pm-agent: Task manager, handles user communication via Slack

## Your Roles

You will act as either Task Owner or Participant. **Default to Participant role** unless explicitly told otherwise.

**How roles are assigned:**
- Only pm-agent can assign you as Task Owner (via assign_task_owner tool)
- When assigned as owner, PM will explicitly tell you: "You are the task owner for this request" or "You are now the task owner"
- If another agent requests your help, you are a Participant

**Task Owner (only when PM explicitly assigns you):**
- Coordinate overall completion across repos if needed
- Pull in other agents when their expertise is needed (use send_message_to_agent)
- Report to pm-agent with findings and conclusions when task is complete

**Participant (default role):**
- Another agent requested your help
- Log your findings using log_finding
- Report back to the requesting agent (not PM) when done

Check knowledge.log and your incoming messages to confirm your role. PM can reassign task ownership during execution - adapt accordingly.

## Communication Tools

- send_message_to_agent: Send a message to another agent and wait for their response. Use for coordination and questions.
- log_finding: Write to the shared knowledge log (visible to all agents and PM). Use for discoveries, decisions, completions, blockers.

## Investigation Guidelines

1. When you receive a new message, read knowledge.log ONCE to get context
2. Explore the codebase systematically using Read, Grep, and Glob
3. Log important discoveries as you find them
4. If the issue involves another repository, coordinate with that repo's agent
5. When you find the root cause, log it as a "decision" type
6. Don't keep re-reading knowledge.log in loops - read it once per message, then investigate

## Completion Behavior

- As Task Owner: After sending final findings to pm-agent, STOP. Wait for further instructions.
- As Participant: After sending findings to the requesting agent, STOP. Wait for further instructions.`;
}

/**
 * Spawn a repo agent with streaming input from a message queue
 * Returns an AgentHandle to track the running agent
 */
export async function spawnRepoAgent(
  config: RepoAgentConfig,
  metadata: TaskMetadata,
  queue: MessageQueue,
  callbacks: ToolCallbacks,
  onSessionId: (sessionId: string) => void,
  existingSessionId?: string
): Promise<AgentHandle> {
  const repoPath =
    metadata.repositories[config.repoKey]?.path || config.defaultRepoPath;
  const sharedPath = getSharedPath(metadata.task_id);

  // Create MCP server with repo agent tools
  const mcpServer = createRepoAgentMcpServer(callbacks);

  // Build initial context
  const context = `
Task: ${metadata.task_id}
Repository: ${repoPath}
Shared folder: ${sharedPath}

Live task files (these update as work progresses):
- ${sharedPath}/knowledge.log (conversation history and agent findings)
- ${sharedPath}/metadata.json (task metadata - PM agent only)

IMPORTANT: The knowledge.log file is continuously updated by other agents and user messages.
Read it ONCE when you receive a new message, then proceed with your work. Don't poll it repeatedly.
`;

  const systemPrompt = generateRepoAgentPrompt(config);

  // Create streaming input generator from queue
  const inputGenerator = createAgentInputGenerator(queue);

  // Run the agent with streaming input - this runs until queue is stopped
  const agentQuery = query({
    prompt: inputGenerator as any,
    options: {
      model: (process.env.SONNET_MODEL || "claude-sonnet-4-5-20250929") as any,
      betas: ["context-1m-2025-08-07"],
      systemPrompt: `${systemPrompt}\n\nCurrent Context:\n${context}`,
      cwd: repoPath,
      additionalDirectories: [repoPath, sharedPath] as any,
      executable: "node",
      pathToClaudeCodeExecutable: process.env.CLAUDE_PATH || "claude",
      env: {
        NODE_ENV: process.env.NODE_ENV || "development",
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        PATH: process.env.PATH,
      },
      settingSources: ["project"],
      resume: existingSessionId,
      maxTurns: 100,
      permissionMode: "dontAsk",
      mcpServers: {
        "repo-agent-tools": mcpServer,
      },
      allowedTools: [
        "mcp__repo-agent-tools__send_message_to_agent",
        "mcp__repo-agent-tools__log_finding",
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
        processAgentEventForLogging(event, config.agentId, [repoPath, sharedPath]);
      }
    } catch (error) {
      if (!queue.isStopped()) {
        console.error(`[${config.agentId}] Error:`, error);
      }
    } finally {
      handle.isRunning = false;
    }
  })();

  return handle;
}
