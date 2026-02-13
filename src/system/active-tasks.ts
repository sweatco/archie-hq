/**
 * Active Tasks Registry
 *
 * Shared state for tracking active tasks.
 * Extracted to avoid circular imports between task-runtime and triage-worker.
 */

import type { AgentName } from '../types/index.js';
import type { AgentHandle } from '../types/agent.js';
import { MessageQueue } from './message-queue.js';
import type { TaskMetadata } from '../types/index.js';

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
  isActive: boolean;
}

/**
 * Global map of active tasks
 */
export const activeTasks = new Map<string, TaskRuntimeState>();

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
 * Get the runtime for a task
 */
export function getTaskRuntime(taskId: string): TaskRuntimeState | undefined {
  return activeTasks.get(taskId);
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
    return {};
  }

  const status: Record<string, boolean> = {};
  for (const [agentName, handle] of runtime.handles) {
    status[agentName] = handle.isRunning;
  }
  return status;
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
