/**
 * Unified Repo Agent
 *
 * Generic repository agent that adapts its behavior based on context.
 * Specialization is provided via RepoAgentConfig.
 * Agent determines its role (Task Owner, Participant, PR Maintenance) from
 * knowledge.log and incoming messages, not from spawn parameters.
 */

import { join } from "path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { TaskMetadata } from "../types/index.js";
import type { AgentHandle } from "../types/agent.js";
import type { RepoAgentConfig } from "../types/repo-agent.js";
import {
  getSharedPath,
  getTaskPath,
  getReposPath,
} from "../system/task-manager.js";
import {
  MessageQueue,
  createRecoverableInputGenerator,
} from "../system/message-queue.js";
import {
  createRepoAgentMcpServer,
  type RepoAgentToolCallbacks,
} from "../mcp/tools.js";
import { createResearchMcpServer, createResearchPostToolHook, createResearchDefenseTagHook } from "../mcp/research-tools.js";
import { processAgentEventForLogging, logger } from "../system/logger.js";
import { buildPeerList } from "./peer-list.js";
import { setupWorktree, worktreeExists, fetchOrigin } from "../system/worktree-manager.js";
import { loadPrompt } from "../utils/prompt-loader.js";

/**
 * Generate the system prompt for a repo agent
 * Includes all roles - agent determines which to use from context
 * Agent discovers its mode (readonly vs edit) from available tools
 */
async function generateRepoAgentPrompt(
  config: RepoAgentConfig
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

  // Layer 2: Repo-agent track extension
  const repoPrompt = await loadPrompt("repo-agent", {
    REPO_KEY: config.repoKey,
    BASE_BRANCH: config.baseBranch || "main",
  });

  // Layer 3: Plugin agent override (domain-specific instructions from agents/<key>.md)
  const layers = [corePrompt, repoPrompt];
  if (config.agentPrompt) {
    layers.push(config.agentPrompt);
  }

  return layers.join("\n\n");
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
 * Includes automatic session recovery: if resuming a session fails,
 * it will retry once with a fresh session.
 *
 */
export async function spawnRepoAgent(
  config: RepoAgentConfig,
  metadata: TaskMetadata,
  queue: MessageQueue,
  callbacks: RepoAgentToolCallbacks,
  onSessionId: (sessionId: string) => void,
  existingSessionId?: string,
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
      const baseBranch = repoInfo.base_branch || config.baseBranch || "main";
      await fetchOrigin(repoPath, baseBranch);
    } else {
      // Create new worktree (includes fetch)
      // This means we're switching from readonly to edit mode - need to fork session
      startFreshSession = true; // cwd is changing to non-child path, need fresh session

      const reposPath = getReposPath(metadata.task_id);
      const { worktree_path, feature_branch, base_branch } = await setupWorktree(
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
        base_branch,
      };

      // Metadata object is mutated in-place (caller owns persistence)
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

  // Build query options (session ID may change on retry)
  const buildQueryOptions = (sessionId?: string) => ({
    model: 'sonnet',
    betas: ["context-1m-2025-08-07"] as any,
    systemPrompt: `${systemPrompt}\n\nCurrent Context:\n${context}`,
    cwd: repoPath,
    additionalDirectories: [repoPath, sharedPath] as any,
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
    hooks: {
      PostToolUse: [
        createResearchPostToolHook({
          getSharedDir: () => getSharedPath(metadata.task_id),
          getTaskId: () => metadata.task_id,
          getAgentId: () => config.agentId,
        }),
        createResearchDefenseTagHook(),
      ],
      Stop: [{
        hooks: [async () => {
          await callbacks.onIdle();
          return { continue: true };
        }],
      }],
    },
    mcpServers: {
      "repo-agent-tools": mcpServer,
      "research-tools": createResearchMcpServer({
        getTaskId: () => metadata.task_id,
        getResearchesDir: () => join(getTaskPath(metadata.task_id), 'researches'),
        getCallerAgentId: () => config.agentId,
        checkResearchBudget: callbacks.checkResearchBudget,
        incrementResearchCount: callbacks.incrementResearchCount,
        onResearchBudgetExceeded: callbacks.onResearchBudgetExceeded,
      }),
    },
    allowedTools: [
      "mcp__repo-agent-tools__send_message_to_agent",
      "mcp__repo-agent-tools__log_finding",
      "mcp__research-tools__web_research",
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
  });

  // Create handle to track agent state
  const handle: AgentHandle = {
    running: Promise.resolve(),
    isRunning: true,
  };

  // Determine initial session ID (don't resume if cwd changed to worktree)
  const initialSessionId = startFreshSession ? undefined : existingSessionId;

  // Create recoverable input generator (tracks consumed messages for retry)
  const recoverable = createRecoverableInputGenerator(queue);

  // Process agent output in background with session recovery
  handle.running = (async () => {
    let sessionId = initialSessionId;
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
              [repoPath, sharedPath],
              editAllowed
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
