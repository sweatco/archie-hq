/**
 * TaskRuntime
 *
 * In-memory state management for active tasks.
 * Manages message queues, agent coordination, and task lifecycle.
 * Each agent has its own queue and runs with a streaming generator.
 */

import type { TaskMetadata, AgentName, FindingType } from '../types/index.js';
import type { AgentHandle } from '../types/agent.js';
import { MessageQueue } from './message-queue.js';
import {
  loadMetadata,
  appendAgentFinding,
  setTaskOwner,
  addParticipant,
  storeAgentSession,
  updateTaskStatus,
} from './task-manager.js';
import { spawnPMAgent, PM_PROMPTS } from '../agents/pm.js';
import { spawnRepoAgent } from '../agents/repo-agent.js';
import { getRepoConfig, getAllRepoConfigs } from '../agents/repo-configs.js';
import type { ToolCallbacks } from '../mcp/tools.js';

/**
 * Runtime state for a single task
 */
export interface TaskRuntimeState {
  taskId: string;
  metadata: TaskMetadata;

  // Message queues for each agent (dynamic, keyed by agent name)
  queues: Map<AgentName, MessageQueue>;

  // Agent handles for tracking running agents (dynamic, keyed by agent name)
  handles: Map<AgentName, AgentHandle>;

  // Session IDs for resume capability (dynamic, keyed by agent name)
  sessions: Map<AgentName, string>;

  // Track which agents have been spawned (dynamic, keyed by agent name)
  spawned: Set<AgentName>;

  // Activity tracking
  lastActivity: Date;
  completionDetected: boolean;
  isActive: boolean;
}

/**
 * Global map of active tasks
 */
const activeTasks = new Map<string, TaskRuntimeState>();

/**
 * Callback for Slack posting (injected by server)
 */
let slackPostCallback: ((taskId: string, message: string) => Promise<void>) | null = null;

/**
 * Set the Slack callback function
 */
export function setSlackCallbacks(
  postFn: (taskId: string, message: string) => Promise<void>
): void {
  slackPostCallback = postFn;
}

/**
 * Find task ID by thread ID by iterating over active tasks
 */
export function findTaskIdByThread(threadId: string): string | null {
  for (const [taskId, runtime] of activeTasks.entries()) {
    const hasThread = runtime.metadata.slack_threads.some((t) => t.thread_id === threadId);
    if (hasThread) {
      return taskId;
    }
  }
  return null;
}

/**
 * Create tool callbacks for an agent
 */
function createToolCallbacks(
  runtime: TaskRuntimeState,
  agentName: AgentName
): ToolCallbacks {
  return {
    /**
     * Send a message to another agent
     * Adds message to target's queue - they'll process it when ready
     */
    onSendMessage: async (target: AgentName, message: string): Promise<string> => {
      console.log(`[${agentName}] → [${target}]: ${message.substring(0, 100)}...`);

      runtime.lastActivity = new Date();

      // Log agent-to-agent communication to shared knowledge
      await appendAgentFinding(runtime.taskId, agentName, `→ ${target}: ${message}`, 'decision');

      // Safety check: If sending to PM and task is inactive, reactivate it
      if (target === 'pm-agent' && !isTaskActive(runtime.taskId)) {
        console.log(`[System] Task was completed but ${agentName} is reporting - reactivating`);
        await reactivateTask(runtime.taskId);
        // Get the fresh runtime after reactivation
        const freshRuntime = activeTasks.get(runtime.taskId);
        if (!freshRuntime) {
          throw new Error(`Failed to reactivate task ${runtime.taskId}`);
        }
        // Update the closure's runtime reference
        Object.assign(runtime, freshRuntime);
      }

      // Get the target queue (triage-agent doesn't have a queue)
      const targetQueue = runtime.queues.get(target as 'pm-agent' | 'backend-agent' | 'mobile-agent');
      if (!targetQueue) {
        throw new Error(`No queue found for agent ${target}`);
      }

      // Spawn target agent if not already running
      await ensureAgentSpawned(runtime, target);

      // Add message to target's queue
      targetQueue.addMessage(message, agentName);

      // Return acknowledgment
      return `Message sent to ${target}. They will process it and log findings.`;
    },

    /**
     * Log a finding to the shared knowledge log
     */
    onLogFinding: async (entry: string, type: FindingType): Promise<void> => {
      // Log full message for decisions, truncate for discoveries
      if (type === 'decision') {
        console.log(`[${agentName}] [${type}]: ${entry}`);
      } else {
        console.log(`[${agentName}] [${type}]: ${entry.substring(0, 100)}...`);
      }

      runtime.lastActivity = new Date();

      await appendAgentFinding(runtime.taskId, agentName, entry, type);

      // Check for completion
      if (type === 'completion') {
        runtime.completionDetected = true;
        // Notify PM about completion
        const pmQueue = runtime.queues.get('pm-agent');
        if (pmQueue) {
          pmQueue.addMessage(PM_PROMPTS.taskCompleted);
        }
      }
    },

    /**
     * Post a message to Slack
     */
    onPostToSlack: async (message: string): Promise<void> => {
      console.log(`[${agentName}] → Slack: ${message}`);

      runtime.lastActivity = new Date();

      // Post to Slack
      if (slackPostCallback) {
        await slackPostCallback(runtime.taskId, message);
      } else {
        console.log(`[SLACK POST] ${message}`);
      }

      // Log with arrow prefix to show this is sent to user via Slack
      await appendAgentFinding(runtime.taskId, agentName, `→ Slack: ${message}`, 'decision');
    },

    /**
     * Report task completion (PM only)
     * Marks the task as complete without additional logging
     * (message already logged by post_to_slack if using report_completion tool)
     */
    onReportCompletion: async (): Promise<void> => {
      console.log(`[${agentName}] Reporting completion`);

      runtime.lastActivity = new Date();
      runtime.completionDetected = true;

      // Log a brief completion marker (not the full message since it was already posted to Slack)
      await appendAgentFinding(runtime.taskId, agentName, 'Task completed', 'completion');

      // Complete the task immediately
      await completeTask(runtime.taskId);
    },

    /**
     * Assign a task owner (PM only)
     */
    onAssignTaskOwner: async (agent: AgentName): Promise<void> => {
      console.log(`[${agentName}] Assigning task owner: ${agent}`);

      runtime.lastActivity = new Date();

      await setTaskOwner(runtime.taskId, agent);
      await addParticipant(runtime.taskId, agent);

      // Log the assignment to shared knowledge
      await appendAgentFinding(
        runtime.taskId,
        agentName,
        `Assigned ${agent} as task owner`,
        'decision'
      );

      // Reload metadata to reflect the change
      const metadata = await loadMetadata(runtime.taskId);
      if (metadata) {
        runtime.metadata = metadata;
      }

      console.log(`[System] Task ${runtime.taskId} owner set to ${agent}`);
    },
  };
}

/**
 * Ensure an agent is spawned and running
 */
async function ensureAgentSpawned(runtime: TaskRuntimeState, agentName: AgentName): Promise<void> {
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
    storeAgentSession(runtime.taskId, agentName, sessionId).catch(console.error);
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
    handle = await spawnRepoAgent(repoConfig, metadata, queue, callbacks, onSessionId, existingSessionId);
    runtime.handles.set(agentName, handle);
  } else if (agentName === 'pm-agent') {
    // PM agent
    const pmQueue = runtime.queues.get('pm-agent');
    if (!pmQueue) {
      throw new Error('PM queue not initialized');
    }
    handle = await spawnPMAgent(metadata, pmQueue, callbacks, onSessionId, existingSessionId);
    runtime.handles.set('pm-agent', handle);
  } else {
    throw new Error(`Unknown agent: ${agentName}`);
  }

  // Log whether we're resuming or starting fresh
  if (existingSessionId) {
    console.log(`[System] Resuming ${agentName} for task ${runtime.taskId} (session: ${existingSessionId})`);
  } else {
    console.log(`[System] Starting new ${agentName} session for task ${runtime.taskId}`);
  }

  runtime.spawned.add(agentName);
  console.log(`[System] Spawned ${agentName} for task ${runtime.taskId}`);
}

/**
 * Reactivate a completed/stopped task
 * Used both for Slack-triggered reactivation and internal safety checks
 */
export async function reactivateTask(taskId: string): Promise<void> {
  console.log(`[System] Reactivating completed task ${taskId}`);

  // Check if task is actually inactive
  if (isTaskActive(taskId)) {
    console.log(`[System] Task ${taskId} is already active, skipping reactivation`);
    return;
  }

  // Ensure Slack callbacks are set
  if (!slackPostCallback) {
    console.error(`[System] Cannot reactivate task ${taskId} - Slack callbacks not set`);
    return;
  }

  // Remove old runtime if it exists
  activeTasks.delete(taskId);

  // Reinitialize with fresh queues and state
  await initializeTaskRuntime(taskId);

  // Restart the PM agent
  await startTask(taskId);
}

/**
 * Initialize a new TaskRuntime for a task
 */
export async function initializeTaskRuntime(taskId: string): Promise<TaskRuntimeState> {
  const metadata = await loadMetadata(taskId);
  if (!metadata) {
    throw new Error(`Task ${taskId} not found`);
  }

  // Initialize queues for PM and all repo agents
  const queues = new Map<AgentName, MessageQueue>();
  queues.set('pm-agent', new MessageQueue());
  for (const config of getAllRepoConfigs()) {
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
    completionDetected: false,
    isActive: true,
  };

  activeTasks.set(taskId, runtime);

  return runtime;
}

/**
 * Start a new task by spawning the PM agent and sending initial message
 */
export async function startTask(taskId: string): Promise<void> {
  const runtime = activeTasks.get(taskId);
  if (!runtime) {
    throw new Error(`TaskRuntime for ${taskId} not initialized`);
  }

  // Add initial message to PM queue
  const pmQueue = runtime.queues.get('pm-agent');
  if (!pmQueue) {
    throw new Error('PM queue not initialized');
  }
  pmQueue.addMessage(PM_PROMPTS.newTask);

  // Spawn PM agent - it will process the message from its queue
  await ensureAgentSpawned(runtime, 'pm-agent');
}

/**
 * Notify PM of new user input
 */
export async function notifyNewUserInput(taskId: string): Promise<void> {
  const runtime = activeTasks.get(taskId);
  if (!runtime) {
    console.warn(`TaskRuntime for ${taskId} not found, cannot notify`);
    return;
  }

  runtime.lastActivity = new Date();
  const pmQueue = runtime.queues.get('pm-agent');
  if (pmQueue) {
    pmQueue.addMessage(PM_PROMPTS.newUserInput);
  }
}

/**
 * Handle a status request
 */
export async function handleStatusRequest(taskId: string): Promise<void> {
  const runtime = activeTasks.get(taskId);
  if (!runtime) {
    console.warn(`TaskRuntime for ${taskId} not found, cannot handle status`);
    return;
  }

  runtime.lastActivity = new Date();
  const pmQueue = runtime.queues.get('pm-agent');
  if (pmQueue) {
    pmQueue.addMessage(PM_PROMPTS.statusRequest);
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
    console.log(`[System] Task ${taskId} already stopped`);
    return;
  }

  runtime.isActive = false;

  // Stop all queues - this will cause agent generators to exit
  for (const queue of runtime.queues.values()) {
    queue.stop();
  }

  // Update status
  await updateTaskStatus(taskId, 'stopped');

  // Remove from active tasks
  activeTasks.delete(taskId);

  console.log(`[System] Task ${taskId} stopped`);
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
    console.log(`[System] Task ${taskId} already completed/stopped`);
    return;
  }

  runtime.isActive = false;

  // Stop all queues
  for (const queue of runtime.queues.values()) {
    queue.stop();
  }

  // Update status
  await updateTaskStatus(taskId, 'completed');

  // Remove from active tasks
  activeTasks.delete(taskId);

  console.log(`[System] Task ${taskId} completed`);
}

/**
 * Get the runtime for a task
 */
export function getTaskRuntime(taskId: string): TaskRuntimeState | undefined {
  return activeTasks.get(taskId);
}

/**
 * Check if a task is active
 */
export function isTaskActive(taskId: string): boolean {
  return activeTasks.has(taskId);
}

/**
 * Get all active task IDs
 */
export function getActiveTaskIds(): string[] {
  return Array.from(activeTasks.keys());
}

/**
 * Check if a specific agent is still running for a task
 */
export function isAgentRunning(taskId: string, agentName: AgentName): boolean {
  const runtime = activeTasks.get(taskId);
  if (!runtime) {
    return false;
  }

  const handle = runtime.handles.get(agentName);

  return handle?.isRunning ?? false;
}

/**
 * Get agent status for a task
 */
export function getAgentStatus(taskId: string): Record<string, boolean> {
  const runtime = activeTasks.get(taskId);
  if (!runtime) {
    return { pm: false, backend: false, mobile: false };
  }

  return {
    pm: runtime.handles.get('pm-agent')?.isRunning ?? false,
    backend: runtime.handles.get('backend-agent')?.isRunning ?? false,
    mobile: runtime.handles.get('mobile-agent')?.isRunning ?? false,
  };
}
