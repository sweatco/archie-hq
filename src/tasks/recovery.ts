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
import type { Task } from './task.js';
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
/**
 * What the idle-check should do for a task. Pure (no timers/IO) so the
 * completion-vs-recover-vs-wait decision is unit-testable:
 * - `'wait'`     — not active; a forced-stop teardown (request_edit_mode /
 *                  research-budget) is pending; or not yet quiescent (an agent is
 *                  active, has an in-flight background task, or none are spawned).
 * - `'complete'` — quiescent and PM signalled completion (report_completion).
 * - `'recover'`  — quiescent but nobody parked: an agent went idle without
 *                  reporting (a dropped ball).
 *
 * Quiescence relies on agents being marked active at message *enqueue* (see
 * Task.sendMessage / toolSendMessage), so "all idle" faithfully means "no work
 * in flight." Shutdown is handled by the caller (it owns the process-global flag).
 */
export function idleDecision(
  task: Pick<Task, 'isActive' | 'completionIntent' | 'agentProcesses'>,
): 'wait' | 'complete' | 'recover' {
  if (!task.isActive) return 'wait';
  const agents = [...task.agentProcesses.values()];
  // A pending teardown means a forced stop already called task.stop(), deferred
  // to this turn's SDK `result` event. The Stop hook that arms this check fires
  // *before* that event (gap can exceed the 3s delay), so without this guard the
  // check would "recover" an agent that stop() then orphans mid-turn.
  if (agents.some((a) => a.pendingTeardown)) return 'wait';
  // Quiescent = at least one agent spawned and none busy. An agent is busy if its
  // turn is active OR it has an in-flight background task (a backgrounded wait /
  // subagent the SDK will settle later) — without the latter, recovery would fire
  // under a legitimate wait, since the agent's turn ends while the task runs.
  if (agents.length === 0) return 'wait';
  if (agents.some((a) => a.session.active || a.backgroundTasks.size > 0)) return 'wait';
  return task.completionIntent ? 'complete' : 'recover';
}

export function scheduleIdleCheck(task: Task): void {
  setTimeout(async () => {
    if (getIsShuttingDown()) return;
    const action = idleDecision(task);
    if (action === 'complete') {
      await task.complete();
    } else if (action === 'recover') {
      await triggerRecovery(task);
    }
  }, 3000);
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
    // Reinforcement: nudge a *live, idle* agent so it ends its turn properly
    // (report_completion when waiting on the user, or re-delegate).
    //
    // Prefer the task owner, then fall back to the PM. The fallback is the
    // whole fix: a message-driven resume only spawns the PM (Task.get →
    // sendMessage(pm)), so a blind nudge at `task_owner` — often a specialist
    // like ops-agent that was NOT respawned — hit no live process, set
    // recoveryAttempts=2, and silently stalled (no new agent:inactive event
    // ever re-arms the idle check). The task then hung until the 30-min
    // wall-clock. The PM owns the user conversation and is the right agent to
    // either continue or park. (Playstorm 2026-06-11 stall.)
    const owner = (task.metadata.task_owner || 'pm-agent') as AgentName;
    const candidates: AgentName[] =
      owner === 'pm-agent' ? ['pm-agent'] : [owner, 'pm-agent'];
    const target = candidates.find((name) => task.agentProcesses.get(name)?.isRunning);
    const targetAgent = target ? task.agentProcesses.get(target) : undefined;

    if (targetAgent) {
      const prompt = target === 'pm-agent'
        ? AGENT_PROMPTS.reinforcePM
        : AGENT_PROMPTS.reinforceAgent;
      targetAgent.queue.addMessage(prompt);

      // Mark active after nudge — via updateAgentState (not updateSession) so it
      // emits agent:active and clears any stale completionIntent on a nudged PM
      // (which would otherwise park on the next quiescence instead of re-deciding).
      task.updateAgentState(targetAgent.def.id, true);
    } else {
      // No live agent to nudge — re-spawn rather than silently stalling.
      // recoverTaskAgents re-sends the recovery prompt to previously-active
      // agents, falling back to the PM, which re-arms the lifecycle.
      await recoverTaskAgents(task);
    }
  }
}
