/**
 * Task Recovery
 *
 * All recovery logic in one place:
 * - Startup recovery: re-spawn agents for in_progress tasks after server restart
 * - Idle detection: detect when all agents go inactive
 * - Progressive recovery: reinforcement nudge → nuclear restart
 */

import { findTasksByStatus } from './persistence.js';
import { logger } from '../system/logger.js';
import { getIsShuttingDown } from '../system/shutdown.js';
import { AGENT_PROMPTS } from '../agents/prompts.js';
import { type Task, activeTasks } from './task.js';
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

  // Lazy import to avoid circular dependency (task-recovery ↔ tasks/task)
  const { Task: TaskClass } = await import('./task.js');

  for (const taskMeta of tasks) {
    // Skip subtasks — they cannot run independently
    if (taskMeta.parent_task_id) {
      logger.system(`Recovery: Skipping subtask ${taskMeta.task_id} (parent: ${taskMeta.parent_task_id})`);
      continue;
    }

    try {
      const task = await TaskClass.get(taskMeta.task_id);
      await recoverTaskAgents(task);
      logger.system(`Recovery: Re-activated task ${taskMeta.task_id}`);
    } catch (error) {
      logger.error('recovery', `Failed to recover task ${taskMeta.task_id}`, error);
    }
  }
}

/**
 * Re-spawn previously active agents for a task, or fall back to PM.
 * Shared by startup recovery and nuclear recovery.
 */
async function recoverTaskAgents(task: Task): Promise<void> {
  let spawned = 0;
  for (const [agentName, session] of Object.entries(task.metadata.agent_sessions)) {
    const sessionState = typeof session === 'string' ? { active: false } : session;
    if (!sessionState.active) continue;
    await task.sendMessage(AGENT_PROMPTS.recovery, agentName as AgentName);
    spawned++;
  }

  // Fallback: if no agents were active (stale metadata), spawn PM
  if (spawned === 0) {
    await task.sendMessage(AGENT_PROMPTS.recovery, 'pm-agent' as AgentName);
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
export function scheduleIdleCheck(task: Task): void {
  setTimeout(async () => {
    if (!task.isActive || getIsShuttingDown()) return;

    const allInactive = checkAllAgentsInactive(task);
    if (allInactive) {
      await triggerRecovery(task);
    }
  }, 3000);
}

/**
 * Check if all spawned agents are inactive.
 * Also considers active subtasks — if any subtask is still running,
 * the task is waiting for results and is not truly idle.
 */
function checkAllAgentsInactive(task: Task): boolean {
  if (task.agentProcesses.size === 0) return false;

  for (const [, agent] of task.agentProcesses) {
    if (agent.session.active) return false;
  }

  // If any subtask is still active, we're waiting for it — not idle
  if (task.metadata.subtask_ids?.length) {
    for (const subtaskId of task.metadata.subtask_ids) {
      const subtask = activeTasks.get(subtaskId);
      if (subtask?.isActive) return false;
    }
  }
  return true;
}

/**
 * Progressive recovery when all agents go idle:
 * - Attempts 1-2: Reinforcement — nudge the lead agent with a prompt
 * - Attempt 3+: Nuclear — clear all sessions and restart with fresh context
 *
 * Works entirely in-memory. The debounced persist snapshots whatever
 * state looks like when it fires.
 */
async function triggerRecovery(task: Task): Promise<void> {
  task.recoveryAttempts += 1;

  logger.warn('recovery', `All agents inactive for task ${task.taskId} (attempt ${task.recoveryAttempts})`);

  if (task.recoveryAttempts >= 3) {
    // Nuclear: reset recovery counter before stop
    task.recoveryAttempts = 0;

    // Lazy import to avoid circular dependency
    const { Task: TaskClass } = await import('./task.js');

    await task.stop();

    // Re-load from disk and recover
    const newTask = await TaskClass.get(task.taskId);
    await recoverTaskAgents(newTask);
  } else {
    // Reinforcement: nudge the lead agent
    const target = (task.metadata.task_owner || 'pm-agent') as AgentName;
    const agent = task.agentProcesses.get(target);

    // Only nudge if the agent process is actually running (not crashed)
    if (agent && agent.isRunning) {
      const prompt = target === 'pm-agent'
        ? AGENT_PROMPTS.reinforcePM
        : AGENT_PROMPTS.reinforceAgent;
      agent.queue.addMessage(prompt);

      // Mark agent as active after nudge
      agent.updateSession(true);
      task.save();
    } else {
      // Agent process is dead — skip straight to nuclear on next idle check
      task.recoveryAttempts = 2;
    }
  }
}
