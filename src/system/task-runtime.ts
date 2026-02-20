/**
 * TaskRuntime
 *
 * In-memory state management for active tasks.
 * Manages message queues, agent coordination, and task lifecycle.
 * Each agent has its own queue and runs with a streaming generator.
 */

import { exec } from "child_process";
import { promisify } from "util";
import { mkdir, writeFile, symlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type { AgentName, AgentSessionState, FindingType, SlackThread, TaskMetadata } from "../types/index.js";
import type { AgentHandle } from "../types/agent.js";
import { MessageQueue } from "./message-queue.js";
import {
  loadMetadata,
  getMetadataPath,
  appendAgentFinding,
  ensureSessionsDir,
  generateTaskId,
  getSharedPath,
  getMemoryPath,
  getKnowledgeLogPath,
} from "./task-manager.js";
import { getPluginsWithPmSkills } from "./plugin-loader.js";
import { spawnPMAgent } from "../agents/pm.js";
import { AGENT_PROMPTS } from "../agents/prompts.js";
import { saveTask } from "./task-persistence.js";
import { getIsShuttingDown } from "./server.js";
import { scheduleIdleCheck } from "./task-recovery.js";
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
 * Read helper for legacy agent_sessions entries.
 * If the entry is a legacy string (old metadata on disk), convert it
 * to an AgentSessionState. Returns undefined if no entry exists.
 */
function getAgentSession(
  metadata: TaskMetadata,
  agentName: string
): AgentSessionState | undefined {
  const entry = metadata.agent_sessions[agentName];
  if (!entry) return undefined;
  if (typeof entry === 'string') {
    return { session_id: entry, active: false };
  }
  return entry;
}

/**
 * Update an agent's active state.
 * Updates in-memory session, persists (debounced), and schedules idle check on deactivation.
 *
 * During shutdown, deactivation is skipped so recovery sees the correct pre-shutdown state.
 */
function updateAgentState(
  runtime: TaskRuntimeState,
  agentName: AgentName | string,
  active: boolean,
  sessionId?: string
): void {
  if (!active && getIsShuttingDown()) return;

  const name = agentName as AgentName;

  const session = runtime.sessions.get(name);
  if (session) {
    if (sessionId) session.session_id = sessionId;
    session.active = active;
    session.last_activity = new Date().toISOString();
  } else if (sessionId) {
    runtime.sessions.set(name, {
      session_id: sessionId,
      active,
      last_activity: new Date().toISOString(),
    });
  }

  saveTask(runtime);

  if (!active) {
    scheduleIdleCheck(runtime);
  }
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

      // Safety check: If task went inactive, just log warning
      if (!runtime.isActive) {
        logger.warn(
          "task-runtime",
          `Task ${runtime.taskId} is inactive but ${agentName} is sending message`
        );
        return `Task is inactive, message logged to knowledge.log.`;
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

      // Update in-memory metadata directly
      runtime.metadata.task_owner = agent;
      if (!runtime.metadata.participants.includes(agent)) {
        runtime.metadata.participants.push(agent);
      }
      saveTask(runtime);

      // Log the assignment to shared knowledge
      await appendAgentFinding(
        runtime.taskId,
        agentName,
        `Assigned ${agent} as task owner`,
        "decision"
      );

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

      const repoInfo = runtime.metadata.repositories[repoKey];
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

      const repoInfo = runtime.metadata.repositories[repoKey];
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
        saveTask(runtime);
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

      // Persist count via debounced metadata write
      runtime.metadata.research_request_count = runtime.budgets.researchRequestCount;
      saveTask(runtime);
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

  const callbacks = createToolCallbacks(runtime, agentName);

  const onSessionId = (sessionId: string) => {
    updateAgentState(runtime, agentName, true, sessionId);
  };

  // Get existing session ID if available
  const existingSession = runtime.sessions.get(agentName);
  const existingSessionId = existingSession?.session_id;

  // Track participant in-memory
  if (!runtime.metadata.participants.includes(agentName)) {
    runtime.metadata.participants.push(agentName);
  }

  let handle: AgentHandle;

  // Check if it's a repo agent
  const repoConfig = getRepoConfig(agentName);

  if (repoConfig) {
    // It's a repo agent - use unified spawn
    const queue = runtime.queues.get(agentName);
    if (!queue) {
      throw new Error(`${agentName} queue not initialized`);
    }
    handle = await spawnRepoAgent(
      repoConfig,
      runtime.metadata,
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
      runtime.metadata,
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
      const queue = runtime.queues.get(agentName);
      if (!queue) {
        throw new Error(`${agentName} queue not initialized`);
      }
      handle = await spawnPluginAgent(
        pluginConfig,
        runtime.metadata,
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

  // Persist metadata (participant added, repo-agent may have mutated worktree info)
  saveTask(runtime);

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
 * Create a new task: set up disk structure, register runtime in memory.
 * Returns TaskRuntimeState directly — no round-trip through disk.
 */
export async function createTask(
  slackThread: SlackThread
): Promise<TaskRuntimeState> {
  await ensureSessionsDir();

  const taskId = generateTaskId();
  const sharedPath = getSharedPath(taskId);

  // Create task directory structure
  await mkdir(sharedPath, { recursive: true });
  await mkdir(getMemoryPath(taskId), { recursive: true });

  // Symlink PM skills from all loaded plugins into task shared folder
  const skillsTarget = join(sharedPath, '.claude', 'skills');
  await mkdir(join(sharedPath, '.claude'), { recursive: true });

  for (const plugin of getPluginsWithPmSkills()) {
    for (const skill of plugin.pmSkills) {
      const target = join(skillsTarget, skill.namespacedName);
      if (!existsSync(target)) {
        await mkdir(skillsTarget, { recursive: true });
        await symlink(skill.sourcePath, target);
      }
    }
  }

  // Build repositories map dynamically from loaded repo configs
  const repositories: Record<string, { path: string }> = {};
  for (const config of getAllRepoConfigs()) {
    repositories[config.repoKey] = { path: config.defaultRepoPath };
  }

  // Create initial metadata
  const metadata: TaskMetadata = {
    task_id: taskId,
    task_owner: null,
    participants: [],
    slack_threads: [slackThread],
    agent_sessions: {},
    repositories,
    status: 'in_progress',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  metadata.updated_at = new Date().toISOString();
  await writeFile(getMetadataPath(taskId), JSON.stringify(metadata, null, 2));

  // Create empty knowledge log
  await writeFile(getKnowledgeLogPath(taskId), '');

  logger.system(`Created task ${taskId}`);

  return buildRuntime(taskId, metadata);
}

/**
 * Load a task into memory. Idempotent — returns existing runtime instantly
 * if already loaded, otherwise reads from disk.
 */
export async function loadTask(taskId: string): Promise<TaskRuntimeState> {
  const existing = activeTasks.get(taskId);
  if (existing) return existing;

  const metadata = await loadMetadata(taskId);
  if (!metadata) {
    throw new Error(`Task ${taskId} not found`);
  }

  return buildRuntime(taskId, metadata);
}

/**
 * Send a message to an agent. Ensures the agent is spawned first (idempotent).
 */
export async function sendMessage(
  runtime: TaskRuntimeState,
  agentName: AgentName,
  message: string
): Promise<void> {
  await ensureAgentSpawned(runtime, agentName);
  const queue = runtime.queues.get(agentName);
  if (!queue) {
    throw new Error(`No queue for ${agentName}`);
  }
  queue.addMessage(message);
}

/**
 * Build a TaskRuntimeState from metadata. Shared by createTask and loadTask.
 * Registers in activeTasks and starts wall-clock timeout.
 */
function buildRuntime(taskId: string, metadata: TaskMetadata): TaskRuntimeState {
  metadata.status = 'in_progress';

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

  // Deactivate all agents in-memory
  for (const agentName of runtime.spawned) {
    updateAgentState(runtime, agentName, false);
  }

  // Stop all queues - this will cause agent generators to exit
  for (const queue of runtime.queues.values()) {
    queue.stop();
  }

  // Final write: set status + flush to disk
  runtime.metadata.status = 'stopped';
  await saveTask(runtime, true);

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

  // Deactivate all agents in-memory
  for (const agentName of runtime.spawned) {
    updateAgentState(runtime, agentName, false);
  }

  // Stop all queues
  for (const queue of runtime.queues.values()) {
    queue.stop();
  }

  // Final write: set status + flush to disk
  runtime.metadata.status = 'completed';
  await saveTask(runtime, true);

  // Remove from active tasks
  activeTasks.delete(taskId);

  logger.system(`Task ${taskId} completed`);
}

/**
 * Handle edit mode approval from Slack button
 */
export async function handleEditModeApproval(taskId: string): Promise<void> {
  const runtime = await loadTask(taskId);
  runtime.metadata.edit_allowed = true;
  saveTask(runtime);

  await appendAgentFinding(taskId, "system", "Edit mode approved by user", "decision");
  await sendMessage(runtime, 'pm-agent', AGENT_PROMPTS.existingTask);
}

/**
 * Handle edit mode denial from Slack button
 */
export async function handleEditModeDenial(taskId: string): Promise<void> {
  const runtime = await loadTask(taskId);
  await appendAgentFinding(taskId, "system", "Edit mode denied by user", "decision");
  await sendMessage(runtime, 'pm-agent', AGENT_PROMPTS.existingTask);
}

/**
 * Handle research budget approval from Slack button
 */
export async function handleResearchBudgetApproval(taskId: string): Promise<void> {
  const runtime = await loadTask(taskId);
  runtime.metadata.research_budget_extra = (runtime.metadata.research_budget_extra ?? 0) + 5;
  runtime.budgets.researchRequestLimit = 5 + (runtime.metadata.research_budget_extra ?? 0);
  saveTask(runtime);

  await appendAgentFinding(
    taskId,
    "system",
    `Research budget extended by user (+5 requests, total extra: ${runtime.metadata.research_budget_extra})`,
    "decision"
  );
  await sendMessage(runtime, 'pm-agent', AGENT_PROMPTS.existingTask);
}

/**
 * Handle research budget denial from Slack button
 */
export async function handleResearchBudgetDenial(taskId: string): Promise<void> {
  const runtime = await loadTask(taskId);
  await appendAgentFinding(taskId, "system", "Additional research denied by user", "decision");
  await sendMessage(runtime, 'pm-agent', AGENT_PROMPTS.existingTask);
}

