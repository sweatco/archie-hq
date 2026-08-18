/**
 * Agent Prompts
 *
 * Shared prompt constants for spawn/recovery scenarios.
 * Used by task-runtime (sendMessage), task-recovery (triggerRecovery),
 * and event-handler (handleSlackEvent, GitHub webhook dispatch).
 */

export const AGENT_PROMPTS = {
  // Every trigger here names knowledge.log, because none of them carry the
  // request itself — the user's message is only ever in the log. `newTask` used
  // to be the exception ('New task created, assign owner'), and a PM that read
  // it literally could conclude the trigger was a contentless system event and
  // silently complete the task without ever opening the log. Observed live: a
  // user @mentioned Archie and got no reply at all.
  newTask: 'New task created. Check knowledge.log for the request, then assign an owner.',
  existingTask: 'New input received. Check knowledge.log for the update.',
  recovery: 'Task was interrupted. Check knowledge.log for current state and continue where you left off.',

  // GitHub activity on work PM has already delegated — review comments, review
  // bodies, PR conversation comments, CI results. Distinct from `existingTask`
  // because the author is often the same person PM is talking to in Slack, and
  // under the generic prompt PM read the notification as news to relay: it
  // narrated the reviewer's own comments back at them and asked what they had
  // meant. Naming the owner instead points the input at the agent holding the
  // branch, which is the only party that can answer on the PR. Merge outcomes
  // (see connectors/github/merge.ts) keep `existingTask` — those really are PM's
  // to announce, not to delegate.
  githubInput: 'Activity on GitHub for work you delegated — check knowledge.log for what it is and which PR. Hand it to the agent that owns that branch.',

  // Stage 3: Reinforcement prompts for idle detection recovery
  reinforcePM: `RECOVERY: You went idle without completing the task.

Your turn must end with one of:
- send_message_to_agent: Delegate work to a specialist agent
- report_completion: Task done or waiting for user input
- request_edit_mode: Need user approval for code changes

Read knowledge.log to see where you left off, then take action.`,

  reminder: (reason: string) => `Your scheduled reminder has fired. Reason: ${reason}\n\nCheck knowledge.log for the latest context and decide what to do next.`,

  // Two sentences, because everything else a trigger-fired PM needs is already a default
  // it carries into every task. It used to close with "post the result to the bound
  // channel" — which on a message fire contradicted the delivery line above it — and with
  // a read-only reminder that no other wake prompt here bothers to give.
  //
  // Delivery lives in `buildTriggerSeed` (src/system/trigger-scheduler.ts), the only place
  // that knows the fire kind, and it says nothing at all for a message fire: the thread is
  // linked as the task's default channel, which is where `post_to_user` routes anyway.
  // A message fire's message is not here either — `Task.append` puts it in knowledge.log,
  // which the PM reads every turn and which is the only place a delegate can see it.
  triggered: (prompt: string, reason: string) =>
    `A trigger you were set up with has fired (${reason}).\n\nDo this now: ${prompt}`,

  reinforceAgent: `RECOVERY: You went idle without reporting back.

Your turn must end with:
- send_message_to_agent: Report your findings to the requesting agent

Read knowledge.log to see what was requested, complete your work, then report back.`,
};
