/**
 * Unified Repo Agent
 *
 * Generic repository agent that adapts its behavior based on context.
 * Specialization is provided via RepoAgentConfig.
 * Agent determines its role (Task Owner, Participant, PR Maintenance) from
 * knowledge.log and incoming messages, not from spawn parameters.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { exec } from "child_process";
import { promisify } from "util";
import type { TaskMetadata } from "../types/index.js";
import type { AgentHandle } from "../types/agent.js";
import type { RepoAgentConfig } from "../types/repo-agent.js";
import {
  getSharedPath,
  getReposPath,
  saveMetadata,
} from "../system/task-manager.js";
import {
  MessageQueue,
  createAgentInputGenerator,
} from "../system/message-queue.js";
import {
  createRepoAgentMcpServer,
  type RepoAgentToolCallbacks,
} from "../mcp/tools.js";
import { processAgentEventForLogging, logger } from "../system/logger.js";
import { getAllRepoConfigs } from "./repo-configs.js";
import { setupWorktree, worktreeExists } from "../system/worktree-manager.js";
import { loadPrompt } from "../utils/prompt-loader.js";

const execAsync = promisify(exec);

/**
 * Generate the system prompt for a repo agent
 * Includes all roles - agent determines which to use from context
 * Agent discovers its mode (readonly vs edit) from available tools
 */
async function generateRepoAgentPrompt(
  config: RepoAgentConfig
): Promise<string> {
  // Build peer list from all other repo agents
  const peerList = getAllRepoConfigs()
    .filter((c) => c.agentId !== config.agentId)
    .map((c) => `- ${c.agentId}: ${c.role} (${c.repoKey} repository)`)
    .join("\n");

  return loadPrompt("repo-agent", {
    AGENT_ID: config.agentId,
    AGENT_ROLE: config.role,
    REPO_KEY: config.repoKey,
    EXPERTISE: config.expertise,
    PEER_LIST: peerList,
    BASE_BRANCH: config.baseBranch || "main",
  });
}

/**
 * Spawn a repo agent with streaming input from a message queue
 * Returns an AgentHandle to track the running agent
 *
 * In edit mode:
 * - Creates/reuses worktree for isolated work
 * - Adds Write and Edit to allowed tools
 * - cwd is set to worktree path
 *
 * @param onMetadataUpdate - Optional callback when metadata changes (worktree created)
 */
export async function spawnRepoAgent(
  config: RepoAgentConfig,
  metadata: TaskMetadata,
  queue: MessageQueue,
  callbacks: RepoAgentToolCallbacks,
  onSessionId: (sessionId: string) => void,
  existingSessionId?: string,
  onMetadataUpdate?: (metadata: TaskMetadata) => Promise<void>
): Promise<AgentHandle> {
  const repoInfo = metadata.repositories[config.repoKey];
  const baseRepoPath = repoInfo?.path || config.defaultRepoPath;
  const sharedPath = getSharedPath(metadata.task_id);
  const editAllowed = metadata.edit_allowed === true;

  // Determine working directory based on mode
  let repoPath: string;
  let startFreshSession = false; // Track if we need a fresh session (cwd is changing to non-child path)

  if (editAllowed) {
    // Edit mode - use or create worktree
    if (
      repoInfo?.worktree_path &&
      (await worktreeExists(repoInfo.worktree_path))
    ) {
      // Worktree already exists - reuse it
      repoPath = repoInfo.worktree_path;
      logger.agent(config.agentId, `Reusing existing worktree at ${repoPath}`, {
        editMode: true,
      });

      // Fetch origin to ensure origin/main is up-to-date for conflict resolution
      try {
        logger.agent(config.agentId, "Fetching origin to update remote refs");
        await execAsync("git fetch origin", { cwd: repoPath });
      } catch (error) {
        logger.warn(
          config.agentId,
          "Failed to fetch origin (non-fatal)",
          error
        );
      }
    } else {
      // Create new worktree (includes fetch)
      // This means we're switching from readonly to edit mode - need to fork session
      startFreshSession = true; // cwd is changing to non-child path, need fresh session

      const reposPath = getReposPath(metadata.task_id);
      const { worktree_path, feature_branch } = await setupWorktree(
        metadata.task_id,
        config.repoKey,
        reposPath,
        baseRepoPath,
        config.baseBranch // Use config value, falls back to auto-detection if undefined
      );

      // Update metadata with worktree info
      metadata.repositories[config.repoKey] = {
        ...repoInfo,
        path: baseRepoPath,
        worktree_path,
        feature_branch,
        base_branch: config.baseBranch,
      };

      // Save metadata and notify caller
      await saveMetadata(metadata.task_id, metadata);
      if (onMetadataUpdate) {
        await onMetadataUpdate(metadata);
      }

      repoPath = worktree_path;
    }
  } else {
    // Readonly mode - use base repo
    repoPath = baseRepoPath;
  }

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

  const systemPrompt = await generateRepoAgentPrompt(config);

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
      // Don't resume if cwd is changing to non-child path (worktree) - Claude Code blocks this
      resume: startFreshSession ? undefined : existingSessionId,
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
        // Edit mode adds Write, Edit, and local git Bash commands
        ...(editAllowed
          ? [
              "Write",
              "Edit",
              // Local git operations only - no git push/fetch (PM handles remote)
              "Bash(git add:*)",
              "Bash(git commit:*)",
              "Bash(git status:*)",
              "Bash(git diff:*)",
              "Bash(git log:*)",
              "Bash(git merge:*)", // For conflict resolution with origin/main
              "Bash(git restore:*)", // For unstaging (git restore --staged <file>) or discarding changes
            ]
          : []),
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
        processAgentEventForLogging(
          event,
          config.agentId,
          [repoPath, sharedPath],
          editAllowed
        );
      }
    } catch (error) {
      if (!queue.isStopped()) {
        logger.error(config.agentId, "Error", error);
      }
    } finally {
      handle.isRunning = false;
    }
  })();

  return handle;
}
