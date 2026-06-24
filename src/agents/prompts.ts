/**
 * Agent Prompts
 *
 * Shared prompt constants for spawn/recovery scenarios.
 * Used by task-runtime (sendMessage), task-recovery (triggerRecovery),
 * and event-handler (handleSlackEvent, GitHub webhook dispatch).
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

  reminder: (reason: string) => `Your scheduled reminder has fired. Reason: ${reason}\n\nCheck knowledge.log for the latest context and decide what to do next.`,

  triggered: (prompt: string, context: string) => `A trigger you were set up with has fired (${context}).\n\nDo the following now: ${prompt}\n\nThis is a fresh task spawned by the trigger — there is no prior conversation. Carry out the instruction and post the result to the bound channel. You are read-only by default; if the work requires code changes, request edit mode first.`,

  reinforceAgent: `RECOVERY: You went idle without reporting back.

Your turn must end with:
- send_message_to_agent: Report your findings to the requesting agent

Read knowledge.log to see what was requested, complete your work, then report back.`,
};
