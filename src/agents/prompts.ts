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
  // Deliberately NOT 'New input received' any more. That framing read as a work order, and the PM
  // acted on it as one: woken by a reply that opened by addressing a colleague, it went straight from
  // reading the log into four tool calls and then posted, uninvited, into two colleagues' exchange. The
  // wording now says the two things that were missing — the activity may not be for the PM at all,
  // and whether it is yours to answer is decided BEFORE what to say. It also stays true on the other
  // path that uses this prompt (GitHub merge outcomes), which really are PM's to announce.
  existingTask:
    'New activity in a thread you are in — not necessarily a request for you. Check knowledge.log for what arrived, then decide whether it is yours to answer before you decide what to say.',
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

  // Names neither the trigger directory nor the `trigger-task` skill: those belong in the
  // section buildTriggerDataPromptSection appends, which every track sees, while this
  // message reaches the PM alone. It also no longer claims "there is no prior
  // conversation" — true of the thread, misleading about a trigger that has run before.
  // Where the result goes is deliberately NOT stated here: that is the per-mode delivery
  // sentence `fireTrigger` builds and folds into `prompt`, because it differs between a
  // message fire (reply in the thread the task already owns) and a schedule fire (the first
  // post_to_user opens the task's own thread in its home channel).
  triggered: (prompt: string, context: string) => `A trigger you were set up with has fired (${context}).\n\nDo this now: ${prompt}\n\nNobody is waiting on the other end, so nothing reaches anyone unless you post it. You are read-only by default; if the work requires code changes, request edit mode first.`,

  reinforceAgent: `RECOVERY: You went idle without reporting back.

Your turn must end with:
- send_message_to_agent: Report your findings to the requesting agent

Read knowledge.log to see what was requested, complete your work, then report back.`,
};
