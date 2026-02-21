/**
 * Active Tasks Registry
 *
 * Shared state for tracking active tasks.
 * Extracted to avoid circular imports between task-runtime and triage-worker.
 */

import type { AgentName, AgentSessionState } from '../types/index.js';
import type { AgentHandle } from '../types/agent.js';
import { MessageQueue } from './message-queue.js';
import type { TaskMetadata } from '../types/index.js';

/**
 * Resource budgets for a task (Defense 4 — per-task limits)
 */
export interface TaskBudgets {
  researchRequestCount: number;     // web_research calls made
  researchRequestLimit: number;     // default: 5
  interAgentMessageCount: number;   // send_message_to_agent calls
  interAgentMessageLimit: number;   // default: 100
  taskStartTime: Date;              // for wall-clock timeout
  taskTimeoutMs: number;            // default: 1_800_000 (30 minutes)
}

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

  // Per-agent session state for resume + active tracking (dynamic, keyed by agent name)
  sessions: Map<AgentName, AgentSessionState>;

  // Track which agents have been spawned (dynamic, keyed by agent name)
  spawned: Set<AgentName>;

  // Activity tracking
  lastActivity: Date;
  isActive: boolean;

  // Resource budgets (Defense 4)
  budgets: TaskBudgets;

  // Wall-clock timeout interval (cleared on stop/complete)
  timeoutInterval?: ReturnType<typeof setInterval>;

  // Consecutive idle-detection recovery attempts (resets on nuclear restart)
  recoveryAttempts: number;
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

