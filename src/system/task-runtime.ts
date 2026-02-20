/**
 * TaskRuntime
 *
 * In-memory state management for active tasks.
 * Manages message queues, agent coordination, and task lifecycle.
 * Each agent has its own queue and runs with a streaming generator.
 */

import { exec } from "child_process";
import { promisify } from "util";
import type { AgentName, AgentSessionState, FindingType } from "../types/index.js";
import type { AgentHandle } from "../types/agent.js";
import { MessageQueue } from "./message-queue.js";
import {
  loadMetadata,
  saveMetadata,
  appendAgentFinding,
  setTaskOwner,
  addParticipant,
  updateTaskStatus,
} from "./task-manager.js";
import { spawnPMAgent } from "../agents/pm.js";
import { AGENT_PROMPTS } from "../agents/prompts.js";
import { updateAgentState, getAgentSession, flushPendingPersist } from "./agent-state.js";
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
 * Spawn reason type
 */
export type SpawnReason = 'new_task' | 'existing_task' | 'recovery';

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

      // Inter-agent message budget tracking (Defense 4)
      runtime.budgets.interAgentMessageCount++;
      if (runtime.budgets.interAgentMessageCount > runtime.budgets.interAgentMessageLimit) {
        logger.warn(
          "budget",
          `Inter-agent message limit exceeded for task ${runtime.taskId} (${runtime.budgets.interAgentMessageCount}/${runtime.budgets.interAgentMessageLimit})`
        );
        // Advisory: post to Slack but don't block
        if (slackPostCallback) {
          slackPostCallback(
            runtime.taskId,
            `⚠️ Inter-agent message limit exceeded (${runtime.budgets.interAgentMessageCount}/${runtime.budgets.interAgentMessageLimit}). Task continues but may be consuming excessive resources.`
          ).catch(err => logger.error("budget", "Failed to post message limit warning", err));
        }
      }

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

    // ========================================================================
    // Research Budget Callbacks (Defense 4)
    // ========================================================================

    checkResearchBudget: () => ({
      allowed: runtime.budgets.researchRequestCount < runtime.budgets.researchRequestLimit,
      used: runtime.budgets.researchRequestCount,
      limit: runtime.budgets.researchRequestLimit,
    }),

    incrementResearchCount: () => {
      runtime.budgets.researchRequestCount++;
      logger.debug(
        "budget",
        `Research request ${runtime.budgets.researchRequestCount}/${runtime.budgets.researchRequestLimit} for task ${runtime.taskId}`
      );

      // Persist count to metadata (fire-and-forget — don't block research pipeline)
      loadMetadata(runtime.taskId).then(async (meta) => {
        if (meta) {
          meta.research_request_count = runtime.budgets.researchRequestCount;
          await saveMetadata(runtime.taskId, meta);
        }
      }).catch(err => logger.error("budget", "Failed to persist research count", err));
    },

    onResearchBudgetExceeded: async () => {
      logger.warn(
        "budget",
        `Research budget exceeded for task ${runtime.taskId} (${runtime.budgets.researchRequestCount}/${runtime.budgets.researchRequestLimit})`
      );

      // Post to Slack with interactive buttons for approval
      if (slackPostInteractiveCallback) {
        const blocks = [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Research budget reached* (${runtime.budgets.researchRequestCount}/${runtime.budgets.researchRequestLimit} requests). Approve additional research?`,
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Approve (+5)" },
                action_id: "approve_research_budget",
                value: runtime.taskId,
                style: "primary",
              },
              {
                type: "button",
                text: { type: "plain_text", text: "Deny" },
                action_id: "deny_research_budget",
                value: runtime.taskId,
                style: "danger",
              },
            ],
          },
        ];

        await slackPostInteractiveCallback(
          runtime.taskId,
          `Research budget reached (${runtime.budgets.researchRequestCount}/${runtime.budgets.researchRequestLimit} requests)`,
          blocks
        ).catch(err => logger.error("budget", "Failed to post budget approval request", err));
      } else if (slackPostCallback) {
        await slackPostCallback(
          runtime.taskId,
          `Research budget reached (${runtime.budgets.researchRequestCount}/${runtime.budgets.researchRequestLimit} requests). Stopping task — check knowledge.log for details.`
        ).catch(err => logger.error("budget", "Failed to post budget message", err));
      }

      // Stop the task — will be reactivated on approval/denial
      await stopTask(runtime.taskId);
    },

    // ========================================================================
    // Agent Lifecycle Callbacks
    // ========================================================================

    onIdle: async () => {
      updateAgentState(runtime, agentName, false);
    },

    // ========================================================================
    // Agent Status (PM only)
    // ========================================================================

    onGetAgentsStatus: () => {
      const statuses: { agent: string; active: boolean; last_activity?: string }[] = [];
      for (const spawned of runtime.spawned) {
        const session = runtime.sessions.get(spawned);
        statuses.push({
          agent: spawned,
          active: session?.active ?? false,
          last_activity: session?.last_activity,
        });
      }
      return statuses;
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
    updateAgentState(runtime, agentName, true, sessionId);
  };

  // Get existing session ID if available
  const existingSession = runtime.sessions.get(agentName);
  const existingSessionId = existingSession?.session_id;

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

  // Crash detection: when agent's background function exits, mark inactive
  // Shutdown guard inside updateAgentState will skip if shutting down
  handle.running.then(() => {
    updateAgentState(runtime, agentName, false);
  });

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

  // Load existing session state from metadata (handles legacy string values)
  const sessions = new Map<AgentName, AgentSessionState>();
  for (const [agentId] of Object.entries(metadata.agent_sessions)) {
    const session = getAgentSession(metadata, agentId);
    if (session) {
      sessions.set(agentId as AgentName, session);
    }
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
    budgets: {
      researchRequestCount: metadata.research_request_count ?? 0,
      researchRequestLimit: 5 + (metadata.research_budget_extra ?? 0),
      interAgentMessageCount: 0,
      interAgentMessageLimit: 100,
      taskStartTime: new Date(),
      taskTimeoutMs: 1_800_000, // 30 minutes
    },
    recoveryAttempts: 0,
  };

  // Wall-clock timeout (Defense 4) — check every 60s
  runtime.timeoutInterval = setInterval(async () => {
    const elapsed = Date.now() - runtime.budgets.taskStartTime.getTime();
    if (elapsed >= runtime.budgets.taskTimeoutMs) {
      logger.warn(
        "budget",
        `Task ${taskId} exceeded wall-clock timeout (${Math.round(elapsed / 60_000)}min / ${Math.round(runtime.budgets.taskTimeoutMs / 60_000)}min)`
      );

      // Post timeout message to Slack
      if (slackPostCallback) {
        await slackPostCallback(
          taskId,
          `⏱️ Task timed out after ${Math.round(elapsed / 60_000)} minutes. Stopping task.`
        ).catch(err => logger.error("budget", "Failed to post timeout message", err));
      }

      await stopTask(taskId);
    }
  }, 60_000);

  activeTasks.set(taskId, runtime);

  return runtime;
}

/**
 * Start a task by spawning agents and sending initial messages
 *
 * @param taskId - The task ID
 * @param reason - Why we're starting: 'new_task', 'existing_task', or 'recovery'
 */
export async function startTask(
  taskId: string,
  reason: SpawnReason = "new_task"
): Promise<void> {
  const runtime = activeTasks.get(taskId);
  if (!runtime) {
    throw new Error(`TaskRuntime for ${taskId} not initialized`);
  }

  if (reason === 'recovery') {
    // Re-spawn only agents that were active when interrupted
    let spawned = 0;
    for (const [agentName, session] of runtime.sessions) {
      if (!session.active) continue;

      const queue = runtime.queues.get(agentName);
      if (!queue) throw new Error(`${agentName} queue not initialized`);
      queue.addMessage(AGENT_PROMPTS.recovery);
      await ensureAgentSpawned(runtime, agentName as AgentName);
      spawned++;
    }

    // Fallback: if no agents were active (stale metadata), spawn PM below
    if (spawned > 0) return;
  }

  // Spawn PM: new_task, existing_task, or recovery fallback
  const pmQueue = runtime.queues.get("pm-agent");
  if (!pmQueue) {
    throw new Error("PM queue not initialized");
  }

  const prompt = reason === "new_task"
    ? AGENT_PROMPTS.newTask
    : reason === "recovery"
      ? AGENT_PROMPTS.recovery
      : AGENT_PROMPTS.existingTask;
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
    pmQueue.addMessage(AGENT_PROMPTS.existingTask);
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

  // Clear wall-clock timeout interval
  if (runtime.timeoutInterval) {
    clearInterval(runtime.timeoutInterval);
    runtime.timeoutInterval = undefined;
  }

  // Deactivate all spawned agents
  for (const agentName of runtime.spawned) {
    updateAgentState(runtime, agentName, false);
  }

  // Flush debounced session writes before removing from memory
  await flushPendingPersist(taskId);

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

  // Clear wall-clock timeout interval
  if (runtime.timeoutInterval) {
    clearInterval(runtime.timeoutInterval);
    runtime.timeoutInterval = undefined;
  }

  // Deactivate all spawned agents
  for (const agentName of runtime.spawned) {
    updateAgentState(runtime, agentName, false);
  }

  // Flush debounced session writes before removing from memory
  await flushPendingPersist(taskId);

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

/**
 * Handle research budget approval from Slack button
 * Persists extra budget to metadata BEFORE reactivation (avoids race condition)
 */
export async function handleResearchBudgetApproval(taskId: string): Promise<void> {
  const metadata = await loadMetadata(taskId);
  if (!metadata) {
    logger.error("System", `Task ${taskId} not found for research budget approval`);
    return;
  }

  // Persist increased budget BEFORE reactivation so initializeTaskRuntime picks it up
  metadata.research_budget_extra = (metadata.research_budget_extra ?? 0) + 5;
  await saveMetadata(taskId, metadata);

  await appendAgentFinding(
    taskId,
    "system",
    `Research budget extended by user (+5 requests, total extra: ${metadata.research_budget_extra})`,
    "decision"
  );

  await reactivateTask(taskId);
}

/**
 * Handle research budget denial from Slack button
 */
export async function handleResearchBudgetDenial(taskId: string): Promise<void> {
  await appendAgentFinding(
    taskId,
    "system",
    "Additional research denied by user",
    "decision"
  );

  await reactivateTask(taskId);
}

