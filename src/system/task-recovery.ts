/**
 * Task Recovery
 *
 * All recovery logic in one place:
 * - Startup recovery: re-spawn agents for in_progress tasks after server restart
 * - Idle detection: detect when all agents go inactive
 * - Progressive recovery: reinforcement nudge → nuclear restart
 */

import { findTasksByStatus } from './task-manager.js';
import { saveTask } from './task-persistence.js';
import { logger } from './logger.js';
import { getIsShuttingDown } from './server.js';
import { AGENT_PROMPTS } from '../agents/prompts.js';
import type { TaskRuntimeState } from './active-tasks.js';
import type { AgentName } from '../types/index.js';

// ============================================================================
// Startup Recovery
// ============================================================================

/**
 * Recover all in_progress tasks after server restart.
 * Called once during startup, after server is ready to accept webhooks.
 */
export async function recoverActiveTasks(): Promise<void> {
  const tasks = await findTasksByStatus('in_progress');

  if (tasks.length === 0) {
    logger.system('Recovery: No in_progress tasks found');
    return;
  }

  logger.system(`Recovery: Found ${tasks.length} in_progress task(s), re-activating...`);

  // Lazy import to avoid circular dependency
  const { loadTask, sendMessage } = await import('./task-runtime.js');

  for (const task of tasks) {
    try {
      const runtime = await loadTask(task.task_id);
      await recoverTaskAgents(runtime, sendMessage);
      logger.system(`Recovery: Re-activated task ${task.task_id}`);
    } catch (error) {
      logger.error('recovery', `Failed to recover task ${task.task_id}`, error);
    }
  }
}

/**
 * Re-spawn previously active agents for a task, or fall back to PM.
 * Shared by startup recovery and nuclear recovery.
 */
async function recoverTaskAgents(
  runtime: TaskRuntimeState,
  sendMessage: (runtime: TaskRuntimeState, agentName: AgentName, message: string) => Promise<void>
): Promise<void> {
  let spawned = 0;
  for (const [agentName, session] of runtime.sessions) {
    if (!session.active) continue;
    await sendMessage(runtime, agentName as AgentName, AGENT_PROMPTS.recovery);
    spawned++;
  }

  // Fallback: if no agents were active (stale metadata), spawn PM
  if (spawned === 0) {
    await sendMessage(runtime, 'pm-agent' as AgentName, AGENT_PROMPTS.recovery);
  }
}

// ============================================================================
// Idle Detection & Progressive Recovery
// ============================================================================

/**
 * Schedule an idle check after an agent goes inactive.
 * Small delay to avoid racing with message delivery
 * (another agent may be about to send a message that wakes this one).
 */
export function scheduleIdleCheck(runtime: TaskRuntimeState): void {
  setTimeout(async () => {
    if (!runtime.isActive || getIsShuttingDown()) return;

    const allInactive = checkAllAgentsInactive(runtime);
    if (allInactive) {
      await triggerRecovery(runtime);
    }
  }, 3000);
}

/**
 * Check if all spawned agents are inactive.
 */
function checkAllAgentsInactive(runtime: TaskRuntimeState): boolean {
  if (runtime.spawned.size === 0) return false;

  for (const agentName of runtime.spawned) {
    const session = runtime.sessions.get(agentName);
    if (session?.active) return false;
  }
  return true;
}

/**
 * Progressive recovery when all agents go idle:
 * - Attempts 1-2: Reinforcement — nudge the lead agent with a prompt
 * - Attempt 3+: Nuclear — clear all sessions and restart with fresh context
 *
 * Works entirely in-memory. The debounced persist snapshots whatever
 * runtime.sessions looks like when it fires.
 */
async function triggerRecovery(runtime: TaskRuntimeState): Promise<void> {
  runtime.recoveryAttempts += 1;

  logger.warn('recovery', `All agents inactive for task ${runtime.taskId} (attempt ${runtime.recoveryAttempts})`);

  if (runtime.recoveryAttempts >= 3) {
    // Nuclear: clear all sessions in-memory so the final write saves empty state
    runtime.sessions.clear();
    runtime.recoveryAttempts = 0;

    // Lazy import to avoid circular dependency
    const { stopTask, loadTask, sendMessage } = await import('./task-runtime.js');

    await stopTask(runtime.taskId);

    // Re-load from disk and recover
    const newRuntime = await loadTask(runtime.taskId);
    await recoverTaskAgents(newRuntime, sendMessage);
  } else {
    // Reinforcement: nudge the lead agent
    const target = runtime.metadata.task_owner || 'pm-agent';
    const handle = runtime.handles.get(target as AgentName);
    const queue = runtime.queues.get(target as AgentName);

    // Only nudge if the agent process is actually running (not crashed)
    if (queue && handle?.isRunning) {
      const prompt = target === 'pm-agent'
        ? AGENT_PROMPTS.reinforcePM
        : AGENT_PROMPTS.reinforceAgent;
      queue.addMessage(prompt);

      // Mark agent as active after nudge
      const session = runtime.sessions.get(target as AgentName);
      if (session) {
        session.active = true;
        session.last_activity = new Date().toISOString();
      }
      saveTask(runtime);
    } else {
      // Agent process is dead — skip straight to nuclear on next idle check
      runtime.recoveryAttempts = 2;
    }
  }
}
