/**
 * Task Recovery
 *
 * All recovery logic in one place:
 * - Startup recovery: re-spawn the agent for in_progress tasks after server restart
 * - Idle detection: detect when the agent goes inactive
 * - Progressive recovery: reinforcement nudge → nuclear restart → pause
 *
 * "Nuclear" restarts the process, not the conversation: the task is stopped and
 * reloaded from disk, and the fresh spawn *resumes* the persisted SDK session
 * (rehydrated from `agent_sessions`) rather than clearing it, so the PM keeps
 * its history and picks up where it left off.
 *
 * Because a nuclear cycle leaves the task active again, a PM that keeps parking
 * without reporting completion would loop stop→resume until the wall-clock cap
 * (eight cycles in six minutes, observed live). `MAX_NUCLEAR_RECOVERY_CYCLES`
 * bounds that: past the cap the task is paused instead of respawned, and the
 * user's next message resumes it normally.
 */

import { findTaskIdsByStatus } from './persistence.js';
import { logger } from '../system/logger.js';
import { getIsShuttingDown } from '../system/shutdown.js';
import { AGENT_PROMPTS } from '../agents/prompts.js';
import type { Task } from './task.js';

// ============================================================================
// Startup Recovery
// ============================================================================

/**
 * Recover all in_progress tasks after server restart.
 * Called once during startup, after server is ready to accept webhooks.
 *
 * The scan is ids and statuses only (`findTaskIdsByStatus`) — no Task is
 * constructed for a folder this boot is not picking up. That distinction is the
 * whole point: `Task.get` runs the load-path migrations, so a scan that built
 * one per folder would migrate and stamp the entire fleet in memory at every
 * boot, logging about tasks that will never run here. Only an in_progress task
 * reaches `Task.get`, and it is activated in the same breath — which is where
 * the migration earns its write.
 */
export async function recoverActiveTasks(): Promise<void> {
  const taskIds = await findTaskIdsByStatus('in_progress');

  if (taskIds.length === 0) {
    logger.system('Recovery: No in_progress tasks found');
    return;
  }

  logger.system(`Recovery: Found ${taskIds.length} in_progress task(s), re-activating...`);

  // Lazy import to avoid circular dependency (task-recovery ↔ tasks/task)
  const { Task: TaskClass } = await import('./task.js');

  for (const taskId of taskIds) {
    try {
      const task = await TaskClass.get(taskId);
      await recoverTaskAgents(task);
      logger.system(`Recovery: Re-activated task ${taskId}`);
    } catch (error) {
      logger.error('recovery', `Failed to recover task ${taskId}`, error);
    }
  }
}

/**
 * Re-engage a task's agent. Shared by startup recovery and nuclear recovery.
 *
 * `agent_sessions` is still the on-disk record of what was live at shutdown,
 * but a task runs exactly one agent, so the outcome is the same either way: the
 * recovery prompt goes to the PM, whose spawn rehydrates its session id from
 * that record and resumes.
 */
async function recoverTaskAgents(task: Task): Promise<void> {
  await task.sendMessage(AGENT_PROMPTS.recovery);
}

// ============================================================================
// Idle Detection & Progressive Recovery
// ============================================================================

/**
 * What the idle-check should do for a task. Pure (no timers/IO) so the
 * completion-vs-recover-vs-wait decision is unit-testable:
 * - `'wait'`     — not active; a forced-stop teardown (request_edit_mode /
 *                  research-budget) is pending; or not yet quiescent (the agent
 *                  is active, has an in-flight background task, or has not spawned).
 * - `'complete'` — quiescent and PM signalled completion (report_completion).
 * - `'recover'`  — quiescent but nobody parked: the agent went idle without
 *                  reporting (a dropped ball).
 *
 * Quiescence relies on the agent being marked active at message *enqueue* (see
 * Task.sendMessage), so "idle" faithfully means "no work in flight." Shutdown is
 * handled by the caller (it owns the process-global flag).
 */
export function idleDecision(
  task: Pick<Task, 'isActive' | 'completionIntent' | 'agent'>,
): 'wait' | 'complete' | 'recover' {
  if (!task.isActive) return 'wait';
  const agent = task.agent;
  // Quiescent = the agent has spawned and is not busy. It is busy if its turn is
  // active OR it has an in-flight background task (a backgrounded wait /
  // subagent the SDK will settle later) — without the latter, recovery would fire
  // under a legitimate wait, since the agent's turn ends while the task runs.
  if (!agent) return 'wait';
  // A pending teardown means a forced stop already called task.stop(), deferred
  // to this turn's SDK `result` event. The Stop hook that arms this check fires
  // *before* that event (gap can exceed the 3s delay), so without this guard the
  // check would "recover" an agent that stop() then orphans mid-turn.
  if (agent.pendingTeardown) return 'wait';
  if (agent.session.active || agent.backgroundTasks.size > 0) return 'wait';
  return task.completionIntent ? 'complete' : 'recover';
}

/**
 * Schedule an idle check after the agent goes inactive. Small delay to avoid
 * racing with message delivery (a webhook may be about to wake it).
 */
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

/** Nuclear recovery cycles allowed per task activation before the task is paused. */
const MAX_NUCLEAR_RECOVERY_CYCLES = 3;

/** Posted once when the cap is hit. No failure verdict — just how to resume. */
const PAUSED_NOTICE =
  "⏸️ I've paused this task — I tried a few times to get it moving again and it kept stalling. Send a new message in this thread and I'll pick it back up.";

/**
 * Progressive recovery when the agent goes idle without reporting:
 * - Attempts 1-2: Reinforcement — nudge it with a prompt
 * - Attempt 3+: Nuclear — stop the task and resume it from disk
 * - Past MAX_NUCLEAR_RECOVERY_CYCLES nuclears in one activation: pause instead
 *
 * Works entirely in-memory. The debounced persist snapshots whatever
 * state looks like when it fires.
 */
async function triggerRecovery(task: Task): Promise<void> {
  task.recoveryAttempts += 1;

  logger.warn('recovery', `Agent inactive for task ${task.taskId} (attempt ${task.recoveryAttempts})`);

  if (task.recoveryAttempts >= 3) {
    const cycle = task.nuclearRecoveryCycles + 1;

    if (cycle > MAX_NUCLEAR_RECOVERY_CYCLES) {
      // Respawning again would just start cycle N+1 of the same loop, so stop
      // here and hand it back to the user. A new inbound message resumes the
      // stopped task through the normal sendMessage → ensurePm path, which
      // rehydrates the stored session id.
      logger.warn(
        'recovery',
        `Task ${task.taskId} stalled after ${MAX_NUCLEAR_RECOVERY_CYCLES} nuclear recovery cycles (cycle ${cycle}) — pausing instead of respawning`,
      );
      await task.postToUser(PAUSED_NOTICE).catch((err: unknown) =>
        logger.error('recovery', 'Failed to post recovery pause message', err),
      );
      await task.stop();
    } else {
      // Nuclear: reset recovery counter before stop
      task.recoveryAttempts = 0;

      // Lazy import to avoid circular dependency
      const { Task: TaskClass } = await import('./task.js');

      await task.stop();

      // Re-load from disk and recover
      const newTask = await TaskClass.get(task.taskId);
      await recoverTaskAgents(newTask);

      // The respawn re-activated the reloaded instance, and activate() zeroes
      // the budget — re-apply the count so consecutive nuclears reach the cap.
      newTask.nuclearRecoveryCycles = cycle;
    }
  } else {
    // Reinforcement: nudge the *live, idle* agent so it ends its turn properly
    // (report_completion when waiting on the user, or pick the work back up).
    const agent = task.agent;
    if (agent?.isRunning) {
      agent.queue.addMessage(AGENT_PROMPTS.reinforcePM);

      // Mark active after nudge — via updateAgentState (not updateSession) so it
      // emits agent:active and clears any stale completionIntent (which would
      // otherwise park on the next quiescence instead of re-deciding).
      task.updateAgentState(true);
    } else {
      // The process is dead — re-spawn rather than silently stalling. Before
      // this fallback existed a nudge at a dead process set recoveryAttempts=2
      // and stalled: no new agent:inactive event ever re-armed the idle check,
      // so the task hung until the wall-clock cap. (Playstorm 2026-06-11.)
      await recoverTaskAgents(task);
    }
  }
}
