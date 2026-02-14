/**
 * TaskRuntime
 *
 * In-memory state management for active tasks.
 * Manages message queues, agent coordination, and task lifecycle.
 * Each agent has its own queue and runs with a streaming generator.
 */

import { exec } from "child_process";
import { promisify } from "util";
import type { AgentName, FindingType } from "../types/index.js";
import type { AgentHandle } from "../types/agent.js";
import { MessageQueue } from "./message-queue.js";
import {
  loadMetadata,
  saveMetadata,
  appendAgentFinding,
  setTaskOwner,
  addParticipant,
  storeAgentSession,
  updateTaskStatus,
} from "./task-manager.js";
import { spawnPMAgent, PM_PROMPTS } from "../agents/pm.js";
import { spawnRepoAgent } from "../agents/repo-agent.js";
import { getRepoConfig, getAllRepoConfigs } from "../agents/repo-configs.js";
import { getPluginAgentConfig, getAllPluginAgentConfigs } from "../agents/plugin-configs.js";
import { spawnPluginAgent } from "../agents/plugin-agent.js";
import type { PMToolCallbacks, PRStatus, PRReview } from "../mcp/tools.js";
import { GitHubClient, createGitHubClient } from "../github/client.js";
import { triggerMergeCheck } from "../github/merge-orchestrator.js";
import { logger } from "./logger.js";
import {
  activeTasks,
  isTaskActive,
  type TaskRuntimeState,
} from "./active-tasks.js";
import { reactivateTask } from "./event-handler.js";

// Re-export from active-tasks for backwards compatibility
export {
  isTaskActive,
  getActiveTaskIds,
  getTaskRuntime,
  isAgentRunning,
  getAgentStatus,
  findTaskIdByThread,
} from "./active-tasks.js";
export type { TaskRuntimeState } from "./active-tasks.js";

/**
 * Spawn reason type (relocated from queues.ts)
 */
export type SpawnReason = 'new_task' | 'existing_task';

const execAsync = promisify(exec);

// Lazy-loaded GitHub client
let githubClient: GitHubClient | null | undefined = undefined;

/**
 * Callback for Slack posting (injected by server)
 */
let slackPostCallback:
  | ((taskId: string, message: string) => Promise<void>)
  | null = null;

/**
 * Callback for Slack interactive messages (injected by server)
 */
let slackPostInteractiveCallback:
  | ((taskId: string, text: string, blocks: unknown[]) => Promise<void>)
  | null = null;

/**
 * Set the Slack callback functions
 */
export function setSlackCallbacks(
  postFn: (taskId: string, message: string) => Promise<void>,
  postInteractiveFn?: (
    taskId: string,
    text: string,
    blocks: unknown[]
  ) => Promise<void>
): void {
  slackPostCallback = postFn;
  if (postInteractiveFn) {
    slackPostInteractiveCallback = postInteractiveFn;
  }
}

/**
 * Get or create the GitHub client (lazy initialization)
 */
function getGitHubClient(): GitHubClient | null {
  if (githubClient === undefined) {
    githubClient = createGitHubClient();
  }
  return githubClient;
}

/**
 * Create tool callbacks for an agent
 */
function createToolCallbacks(
  runtime: TaskRuntimeState,
  agentName: AgentName
): PMToolCallbacks {
  return {
    /**
     * Send a message to another agent
     * Adds message to target's queue - they'll process it when ready
     */
    onSendMessage: async (
      target: AgentName,
      message: string
    ): Promise<string> => {
      logger.agentMessage(agentName, target, message, { truncate: 100 });

      runtime.lastActivity = new Date();

      // Log agent-to-agent communication to shared knowledge
      await appendAgentFinding(
        runtime.taskId,
        agentName,
        `→ ${target}: ${message}`,
        "decision"
      );

      // Safety check: If task is inactive, reactivate to wake PM
      if (!isTaskActive(runtime.taskId)) {
        logger.warn(
          "task-runtime",
          `Task ${runtime.taskId} is inactive but ${agentName} is sending message - reactivating`
        );
        await reactivateTask(runtime.taskId);
        return `Message logged to knowledge.log. PM will be notified.`;
      }

      // Get the target queue (triage-agent doesn't have a queue)
      const targetQueue = runtime.queues.get(target);
      if (!targetQueue) {
        throw new Error(`No queue found for agent ${target}`);
      }

      // Spawn target agent if not already running
      const wasAlreadyRunning = runtime.spawned.has(target);
      await ensureAgentSpawned(runtime, target);

      // Add message to target's queue
      targetQueue.addMessage(message, agentName);

      // Log delivery method for debugging
      if (wasAlreadyRunning) {
        logger.system(`Message from ${agentName} queued to running ${target}: "${message}"`);
      }

      // Return acknowledgment
      return `Message sent to ${target}. They will process it and log findings.`;
    },

    /**
     * Log a finding to the shared knowledge log
     */
    onLogFinding: async (entry: string, type: FindingType): Promise<void> => {
      // Log full message for decisions, truncate for discoveries
      if (type === "decision") {
        logger.agentFinding(agentName, type, entry);
      } else {
        logger.agentFinding(agentName, type, entry, { truncate: 100 });
      }

      runtime.lastActivity = new Date();

      await appendAgentFinding(runtime.taskId, agentName, entry, type);
    },

    /**
     * Post a message to Slack
     */
    onPostToSlack: async (message: string): Promise<void> => {
      logger.agentToSlack(agentName, message);

      runtime.lastActivity = new Date();

      // Post to Slack
      if (slackPostCallback) {
        await slackPostCallback(runtime.taskId, message);
      } else {
        logger.slack(`POST: ${message}`);
      }

      // Log with arrow prefix to show this is sent to user via Slack
      await appendAgentFinding(
        runtime.taskId,
        agentName,
        `→ Slack: ${message}`,
        "decision"
      );
    },

    /**
     * Report task completion (PM only)
     * Marks the task as complete without additional logging
     * (message already logged by post_to_slack if using report_completion tool)
     */
    onReportCompletion: async (): Promise<void> => {
      logger.agentAction(agentName, "Reporting completion", "");

      runtime.lastActivity = new Date();

      // Log a brief completion marker (not the full message since it was already posted to Slack)
      await appendAgentFinding(
        runtime.taskId,
        agentName,
        "Task completed",
        "completion"
      );

      // Complete the task immediately
      await completeTask(runtime.taskId);
    },

    /**
     * Assign a task owner (PM only)
     */
    onAssignTaskOwner: async (agent: AgentName): Promise<void> => {
      logger.agentAction(agentName, "Assigning task owner", agent);

      runtime.lastActivity = new Date();

      await setTaskOwner(runtime.taskId, agent);
      await addParticipant(runtime.taskId, agent);

      // Log the assignment to shared knowledge
      await appendAgentFinding(
        runtime.taskId,
        agentName,
        `Assigned ${agent} as task owner`,
        "decision"
      );

      // Reload metadata to reflect the change
      const metadata = await loadMetadata(runtime.taskId);
      if (metadata) {
        runtime.metadata = metadata;
      }

      logger.system(`Task ${runtime.taskId} owner set to ${agent}`);
    },

    /**
     * Request edit mode (PM only)
     * Logs the request, posts to Slack with buttons, and pauses the task
     */
    onRequestEditMode: async (reason: string): Promise<void> => {
      logger.agentAction(agentName, "Requesting edit mode", reason);

      runtime.lastActivity = new Date();

      // Log the request to shared knowledge
      await appendAgentFinding(
        runtime.taskId,
        "system",
        `Edit mode requested: ${reason}`,
        "decision"
      );

      // Post to Slack with interactive buttons
      if (slackPostInteractiveCallback) {
        const blocks = [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Edit mode request:* ${reason}`,
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Approve" },
                action_id: "approve_edit_mode",
                value: runtime.taskId,
                style: "primary",
              },
              {
                type: "button",
                text: { type: "plain_text", text: "Deny" },
                action_id: "deny_edit_mode",
                value: runtime.taskId,
                style: "danger",
              },
            ],
          },
        ];

        await slackPostInteractiveCallback(
          runtime.taskId,
          `Edit mode request: ${reason}`,
          blocks
        );
      } else if (slackPostCallback) {
        // Fallback to regular message if interactive not available
        await slackPostCallback(
          runtime.taskId,
          `Edit mode request: ${reason}\n\n(Interactive buttons not available - please respond with "approve" or "deny")`
        );
      }

      // Stop the task - it will be reactivated on approval/denial
      await stopTask(runtime.taskId);
    },

    // ========================================================================
    // GitHub Callbacks
    // ========================================================================

    /**
     * Trigger merge check for all linked PRs
     * Returns status of each PR and merges any that are ready
     */
    onTriggerMergeCheck: async (): Promise<{
      merged: string[];
      pending: string[];
      conflicts: string[];
    }> => {
      logger.agentAction(agentName, "Triggering merge check", runtime.taskId);
      return triggerMergeCheck(runtime.taskId);
    },

    /**
     * Push a branch to origin
     * Authentication is handled by GIT_ASKPASS environment variable
     */
    onPushBranch: async (
      repoKey: string
    ): Promise<{ success: boolean; message: string }> => {
      logger.agentAction(agentName, "Pushing branch", repoKey);

      // Always load fresh metadata from disk
      const metadata = await loadMetadata(runtime.taskId);
      if (!metadata) {
        return { success: false, message: `Task ${runtime.taskId} not found` };
      }

      const repoInfo = metadata.repositories[repoKey];
      if (!repoInfo?.worktree_path) {
        return { success: false, message: `No worktree found for ${repoKey}` };
      }
      if (!repoInfo.feature_branch) {
        return { success: false, message: `No feature branch found for ${repoKey}` };
      }

      try {
        const branch = repoInfo.feature_branch;

        // Push with upstream tracking - GIT_ASKPASS handles authentication
        await execAsync(`git push -u origin HEAD:${branch}`, {
          cwd: repoInfo.worktree_path,
        });

        const message = `Pushed ${branch} to origin`;
        logger.system(`GitHub: ${message}`);
        return { success: true, message };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        logger.error("task-runtime", `Failed to push ${repoKey}: ${message}`);
        return { success: false, message };
      }
    },

    /**
     * Create a pull request
     */
    onCreatePullRequest: async (
      repoKey: string,
      title: string,
      body: string
    ): Promise<{ pr_number: number; pr_url: string }> => {
      logger.agentAction(agentName, "Creating PR", `${repoKey}: ${title}`);

      const client = getGitHubClient();
      if (!client) {
        throw new Error("GitHub client not configured");
      }

      const config = getRepoConfig(`${repoKey}-agent`);
      if (!config) {
        throw new Error(`No config found for repo key: ${repoKey}`);
      }

      // Always load fresh metadata from disk
      const metadata = await loadMetadata(runtime.taskId);
      if (!metadata) {
        throw new Error(`Task ${runtime.taskId} not found`);
      }

      const repoInfo = metadata.repositories[repoKey];
      const head = repoInfo?.feature_branch || `feature/task-${runtime.taskId}`;
      const base = repoInfo?.base_branch || "main";

      const result = await client.createPullRequest(
        config.githubRepo,
        head,
        base,
        title,
        body
      );

      // Store PR number in metadata
      if (repoInfo) {
        repoInfo.pr_number = result.pr_number;
        await saveMetadata(runtime.taskId, runtime.metadata);
      }

      await appendAgentFinding(
        runtime.taskId,
        agentName,
        `Created PR #${result.pr_number}: ${result.pr_url}`,
        "decision"
      );

      return result;
    },

    /**
     * Get PR status
     */
    onGetPRStatus: async (
      repoKey: string,
      prNumber: number
    ): Promise<PRStatus> => {
      const client = getGitHubClient();
      if (!client) {
        throw new Error("GitHub client not configured");
      }

      const config = getRepoConfig(`${repoKey}-agent`);
      if (!config) {
        throw new Error(`No config found for repo key: ${repoKey}`);
      }

      return client.getPRStatus(config.githubRepo, prNumber);
    },

    /**
     * Get PR reviews
     */
    onGetPRReviews: async (
      repoKey: string,
      prNumber: number
    ): Promise<PRReview[]> => {
      const client = getGitHubClient();
      if (!client) {
        throw new Error("GitHub client not configured");
      }

      const config = getRepoConfig(`${repoKey}-agent`);
      if (!config) {
        throw new Error(`No config found for repo key: ${repoKey}`);
      }

      return client.getPRReviews(config.githubRepo, prNumber);
    },

    /**
     * Update PR description
     */
    onUpdatePRDescription: async (
      repoKey: string,
      prNumber: number,
      body: string
    ): Promise<void> => {
      const client = getGitHubClient();
      if (!client) {
        throw new Error("GitHub client not configured");
      }

      const config = getRepoConfig(`${repoKey}-agent`);
      if (!config) {
        throw new Error(`No config found for repo key: ${repoKey}`);
      }

      await client.updatePRDescription(config.githubRepo, prNumber, body);
    },

    /**
     * Add a PR comment
     */
    onAddPRComment: async (
      repoKey: string,
      prNumber: number,
      comment: string
    ): Promise<void> => {
      const client = getGitHubClient();
      if (!client) {
        throw new Error("GitHub client not configured");
      }

      const config = getRepoConfig(`${repoKey}-agent`);
      if (!config) {
        throw new Error(`No config found for repo key: ${repoKey}`);
      }

      await client.addPRComment(config.githubRepo, prNumber, comment);
    },

    /**
     * Add a review comment on a specific line
     */
    onAddReviewComment: async (
      repoKey: string,
      prNumber: number,
      path: string,
      line: number,
      comment: string
    ): Promise<void> => {
      const client = getGitHubClient();
      if (!client) {
        throw new Error("GitHub client not configured");
      }

      const config = getRepoConfig(`${repoKey}-agent`);
      if (!config) {
        throw new Error(`No config found for repo key: ${repoKey}`);
      }

      await client.addReviewComment(
        config.githubRepo,
        prNumber,
        path,
        line,
        comment
      );
    },

    /**
     * Resolve a review thread
     */
    onResolveReviewThread: async (
      repoKey: string,
      prNumber: number,
      threadId: string
    ): Promise<void> => {
      const client = getGitHubClient();
      if (!client) {
        throw new Error("GitHub client not configured");
      }

      const config = getRepoConfig(`${repoKey}-agent`);
      if (!config) {
        throw new Error(`No config found for repo key: ${repoKey}`);
      }

      await client.resolveReviewThread(config.githubRepo, prNumber, threadId);
    },

    /**
     * Request re-review
     */
    onRequestReReview: async (
      repoKey: string,
      prNumber: number
    ): Promise<void> => {
      const client = getGitHubClient();
      if (!client) {
        throw new Error("GitHub client not configured");
      }

      const config = getRepoConfig(`${repoKey}-agent`);
      if (!config) {
        throw new Error(`No config found for repo key: ${repoKey}`);
      }

      await client.requestReReview(config.githubRepo, prNumber);
    },
  };
}

/**
 * Ensure an agent is spawned and running
 */
async function ensureAgentSpawned(
  runtime: TaskRuntimeState,
  agentName: AgentName
): Promise<void> {
  // Already spawned
  if (runtime.spawned.has(agentName)) {
    return;
  }

  const metadata = await loadMetadata(runtime.taskId);
  if (!metadata) {
    throw new Error(`Task ${runtime.taskId} not found`);
  }

  const callbacks = createToolCallbacks(runtime, agentName);

  const onSessionId = (sessionId: string) => {
    runtime.sessions.set(agentName, sessionId);
    storeAgentSession(runtime.taskId, agentName, sessionId).catch((err) =>
      logger.error("task-runtime", "Failed to store agent session", err)
    );
  };

  // Get existing session ID if available
  const existingSessionId = runtime.sessions.get(agentName);

  let handle: AgentHandle;

  // Check if it's a repo agent
  const repoConfig = getRepoConfig(agentName);

  if (repoConfig) {
    // It's a repo agent - use unified spawn
    await addParticipant(runtime.taskId, agentName);
    const queue = runtime.queues.get(agentName);
    if (!queue) {
      throw new Error(`${agentName} queue not initialized`);
    }
    handle = await spawnRepoAgent(
      repoConfig,
      metadata,
      queue,
      callbacks,
      onSessionId,
      existingSessionId
    );
    runtime.handles.set(agentName, handle);
  } else if (agentName === "pm-agent") {
    // PM agent
    const pmQueue = runtime.queues.get("pm-agent");
    if (!pmQueue) {
      throw new Error("PM queue not initialized");
    }
    handle = await spawnPMAgent(
      metadata,
      pmQueue,
      callbacks,
      onSessionId,
      existingSessionId
    );
    runtime.handles.set("pm-agent", handle);
  } else {
    // Check if it's a plugin agent
    const pluginConfig = getPluginAgentConfig(agentName);
    if (pluginConfig) {
      await addParticipant(runtime.taskId, agentName);
      const queue = runtime.queues.get(agentName);
      if (!queue) {
        throw new Error(`${agentName} queue not initialized`);
      }
      handle = await spawnPluginAgent(
        pluginConfig,
        metadata,
        queue,
        callbacks,
        onSessionId,
        existingSessionId
      );
      runtime.handles.set(agentName, handle);
    } else {
      throw new Error(`Unknown agent: ${agentName}`);
    }
  }

  runtime.spawned.add(agentName);

  // Log spawning (single consolidated message)
  if (existingSessionId) {
    logger.system(
      `Resumed ${agentName} for task ${runtime.taskId} (session: ${existingSessionId})`
    );
  } else {
    logger.system(`Spawned ${agentName} for task ${runtime.taskId}`);
  }
}

/**
 * Initialize a new TaskRuntime for a task
 */
export async function initializeTaskRuntime(
  taskId: string
): Promise<TaskRuntimeState> {
  const metadata = await loadMetadata(taskId);
  if (!metadata) {
    throw new Error(`Task ${taskId} not found`);
  }

  // Initialize queues for PM, all repo agents, and all plugin agents
  const queues = new Map<AgentName, MessageQueue>();
  queues.set("pm-agent", new MessageQueue());
  for (const config of getAllRepoConfigs()) {
    queues.set(config.agentId as AgentName, new MessageQueue());
  }
  for (const config of getAllPluginAgentConfigs()) {
    queues.set(config.agentId as AgentName, new MessageQueue());
  }

  // Load existing session IDs from metadata
  const sessions = new Map<AgentName, string>();
  for (const [agentId, sessionId] of Object.entries(metadata.agent_sessions)) {
    sessions.set(agentId as AgentName, sessionId);
  }

  const runtime: TaskRuntimeState = {
    taskId,
    metadata,
    queues,
    handles: new Map<AgentName, AgentHandle>(),
    sessions,
    spawned: new Set<AgentName>(),
    lastActivity: new Date(),
    isActive: true,
  };

  activeTasks.set(taskId, runtime);

  return runtime;
}

/**
 * Start a task by spawning the PM agent and sending initial message
 *
 * @param taskId - The task ID
 * @param reason - Why we're starting: 'new_task' or 'existing_task' (continuation)
 */
export async function startTask(
  taskId: string,
  reason: SpawnReason = "new_task"
): Promise<void> {
  const runtime = activeTasks.get(taskId);
  if (!runtime) {
    throw new Error(`TaskRuntime for ${taskId} not initialized`);
  }

  // Add initial message to PM queue based on reason
  const pmQueue = runtime.queues.get("pm-agent");
  if (!pmQueue) {
    throw new Error("PM queue not initialized");
  }

  const prompt =
    reason === "new_task" ? PM_PROMPTS.newTask : PM_PROMPTS.existingTask;
  pmQueue.addMessage(prompt);

  // Spawn PM agent - it will process the message from its queue
  await ensureAgentSpawned(runtime, "pm-agent");
}

/**
 * Notify PM of new input (user message or GitHub event)
 */
export async function notifyNewInput(taskId: string): Promise<void> {
  const runtime = activeTasks.get(taskId);
  if (!runtime) {
    logger.warn(
      "task-runtime",
      `TaskRuntime for ${taskId} not found, cannot notify`
    );
    return;
  }

  runtime.lastActivity = new Date();
  const pmQueue = runtime.queues.get("pm-agent");
  if (pmQueue) {
    pmQueue.addMessage(PM_PROMPTS.existingTask);
  }
}

/**
 * Stop a task and clean up
 */
export async function stopTask(taskId: string): Promise<void> {
  const runtime = activeTasks.get(taskId);
  if (!runtime) {
    return;
  }

  // Prevent multiple concurrent stops
  if (!runtime.isActive) {
    logger.system(`Task ${taskId} already stopped`);
    return;
  }

  runtime.isActive = false;

  // Stop all queues - this will cause agent generators to exit
  for (const queue of runtime.queues.values()) {
    queue.stop();
  }

  // Update status
  await updateTaskStatus(taskId, "stopped");

  // Remove from active tasks
  activeTasks.delete(taskId);

  logger.system(`Task ${taskId} stopped`);
}

/**
 * Complete a task
 */
export async function completeTask(taskId: string): Promise<void> {
  const runtime = activeTasks.get(taskId);
  if (!runtime) {
    return;
  }

  // Prevent multiple concurrent completions
  if (!runtime.isActive) {
    logger.system(`Task ${taskId} already completed/stopped`);
    return;
  }

  runtime.isActive = false;

  // Stop all queues
  for (const queue of runtime.queues.values()) {
    queue.stop();
  }

  // Update status
  await updateTaskStatus(taskId, "completed");

  // Remove from active tasks
  activeTasks.delete(taskId);

  logger.system(`Task ${taskId} completed`);
}

/**
 * Handle edit mode approval from Slack button
 * Sets edit_allowed, logs approval, routes through spawn queue
 */
export async function handleEditModeApproval(taskId: string): Promise<void> {
  // Load metadata and set edit_allowed
  const metadata = await loadMetadata(taskId);
  if (!metadata) {
    logger.error("System", `Task ${taskId} not found for edit approval`);
    return;
  }

  // Update metadata with edit_allowed
  metadata.edit_allowed = true;
  await saveMetadata(taskId, metadata);

  // Log approval to shared knowledge (PM will read this)
  await appendAgentFinding(
    taskId,
    "system",
    "Edit mode approved by user",
    "decision"
  );

  // Reactivate task (PM was stopped, needs to restart)
  await reactivateTask(taskId);
}

/**
 * Handle edit mode denial from Slack button
 * Logs denial, routes through spawn queue
 */
export async function handleEditModeDenial(taskId: string): Promise<void> {
  // Log denial to shared knowledge (PM will read this)
  await appendAgentFinding(
    taskId,
    "system",
    "Edit mode denied by user",
    "decision"
  );

  // Reactivate task (PM was stopped, needs to restart)
  await reactivateTask(taskId);
}
