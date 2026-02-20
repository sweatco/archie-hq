/**
 * Agent Prompts
 *
 * Shared prompt constants for spawn/recovery scenarios.
 * Used by task-runtime (startTask), agent-state (triggerRecovery),
 * and event-handler (notifyNewInput).
 */

export const AGENT_PROMPTS = {
  newTask: 'New task created, assign owner',
  existingTask: 'New input received. Check knowledge.log for the update.',
  recovery: 'Task was interrupted. Check knowledge.log for current state and continue where you left off.',

  // Stage 3: Reinforcement prompts for idle detection recovery
  reinforcePM: `RECOVERY: You went idle without completing the task.

Your turn must end with one of:
- send_message_to_agent: Delegate work to a specialist agent
- report_completion: Task done or waiting for user input
- request_edit_mode: Need user approval for code changes

Read knowledge.log to see where you left off, then take action.`,

  reinforceAgent: `RECOVERY: You went idle without reporting back.

Your turn must end with:
- send_message_to_agent: Report your findings to the requesting agent

Read knowledge.log to see what was requested, complete your work, then report back.`,
};
