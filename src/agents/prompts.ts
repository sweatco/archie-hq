/**
 * Agent Prompts
 *
 * Shared prompt constants for spawn/recovery scenarios.
 * Used by task-runtime (sendMessage), task-recovery (triggerRecovery),
 * and event-handler (handleSlackEvent, GitHub webhook dispatch).
 *
 * Wakes CARRY THEIR CONTENT. A Slack message, a GitHub event or a system
 * notice arrives in the PM's stream as the text itself, framed by one of the
 * builders below — not as a pointer telling the PM to go and read something.
 * With one agent per task the indirection bought nothing and cost a tool call
 * per turn, and a pointer at a file the prompt no longer mentions is a wake the
 * PM cannot act on at all.
 *
 * The inline text is the line `src/tasks/persistence.ts` wrote to knowledge.log,
 * returned by the append function rather than re-rendered here — one renderer,
 * so the author line, the `msg:<ts>` id, the `[Attachments: …]` suffix and the
 * redaction placeholder are identical in both places. That `msg:<ts>` id is what
 * the reaction tools take as `message_id`, and the PM prompt tells it so.
 */

/**
 * Contentless fallbacks, private to this module. No caller reaches them
 * directly any more — every wake goes through a builder below — but a batch can
 * still come back empty when a Slack event turns out to have appended nothing
 * new, and the PM still has to be told something it can act on.
 */
const NEW_TASK =
  // Deliberately not 'New task created, assign owner' — a PM that read that
  // literally could conclude the trigger was a contentless system event and
  // silently complete the task without ever looking. Observed live: a user
  // @mentioned Archie and got no reply at all.
  'New task created. Read the request in your conversation, then handle it.';

// Deliberately NOT 'New input received'. That framing read as a work order, and the PM acted on it as
// one: woken by a reply that opened by addressing a colleague, it went straight from reading into four
// tool calls and then posted, uninvited, into two colleagues' exchange. The wording says the two things
// that were missing — the activity may not be for the PM at all, and whether it is yours to answer is
// decided BEFORE what to say.
const EXISTING_TASK =
  'New activity in a thread you are in — not necessarily a request for you. Read what arrived, then decide whether it is yours to answer before you decide what to say.';

/** Join a batch of inline entries into one block, blank-line separated. */
function block(entries: readonly string[]): string {
  return entries.join('\n\n');
}

export const AGENT_PROMPTS = {
  /**
   * The messages that opened a new task, inline. A batch, because a linked
   * thread is ingested whole: the PM gets the root and every reply that came
   * with it, in order.
   */
  inboundNewTask: (entries: readonly string[]): string =>
    entries.length === 0
      ? NEW_TASK
      : `New task. This is what arrived:\n\n${block(entries)}\n\nHandle it.`,

  /**
   * New Slack activity on a thread the task already follows (replies, edits).
   * Keeps the addressing gate of the contentless version: the content being
   * right here does not make it a work order.
   *
   * Each wake carries the messages appended by ITS event. Several arriving while
   * the PM is busy queue up as separate wakes, each with its own content, rather
   * than collapsing into one.
   */
  inboundActivity: (entries: readonly string[]): string =>
    entries.length === 0
      ? EXISTING_TASK
      : `New activity in a thread you are in — not necessarily a request for you:\n\n${block(entries)}\n\nDecide whether it is yours to answer before you decide what to say.`,

  recovery: 'Task was interrupted. Review the conversation for current state and continue where you left off.',

  /**
   * GitHub activity on work in flight — review comments, review bodies, PR
   * conversation comments, CI results. Distinct from `inboundActivity` because the
   * author is often the same person PM is talking to in Slack, and under the
   * generic prompt PM read the notification as news to relay: it narrated the
   * reviewer's own comments back at them and asked what they had meant. Saying
   * the PR is the place to answer keeps the reply where the reviewer is looking.
   * Merge outcomes (see connectors/github/merge.ts) are announcements, not
   * review traffic, so they go out as a `systemNotice` carrying the outcome.
   */
  githubActivity: (entry: string): string =>
    `Activity on GitHub for work in this task:\n\n${entry}\n\nAct on it there — the reply belongs on the PR, not in Slack, unless state changed or someone is blocked.`,

  /**
   * An engine-side event the PM did not observe: an approval resolved, a budget
   * extended, a mode flipped. Unlike Slack activity this IS addressed to the PM
   * — it is the answer to something the PM asked for — so there is no addressing
   * gate to apply, only the question of what it means for the work in flight.
   */
  systemNotice: (notice: string): string =>
    `System notice for this task:\n\n${notice}\n\nContinue from where you left off, taking this into account.`,

  // Stage 3: Reinforcement prompt for idle detection recovery
  reinforcePM: `RECOVERY: You went idle without completing the task.

Your turn must end with one of:
- a background worker running (spawn it with the Agent tool)
- report_completion: Task done or waiting for user input
- request_edit_mode: Need user approval for code changes

Review the conversation to see where you left off, then take action.`,

  reminder: (reason: string) => `Your scheduled reminder has fired. Reason: ${reason}\n\nReview the conversation for the latest context and decide what to do next.`,

  // Names neither the trigger directory nor the `trigger-task` skill: those belong in the
  // section buildTriggerDataPromptSection appends, while this message reaches the PM alone.
  // It also no longer claims "there is no prior conversation" — true of the thread,
  // misleading about a trigger that has run before.
  // Where the result goes is deliberately NOT stated here: that is the per-mode delivery
  // sentence `fireTrigger` builds and folds into `prompt`, because it differs between a
  // message fire (reply in the thread the task already owns) and a schedule fire (the first
  // post_to_user opens the task's own thread in its home channel).
  triggered: (prompt: string, context: string) => `A trigger you were set up with has fired (${context}).\n\nDo this now: ${prompt}\n\nNobody is waiting on the other end, so nothing reaches anyone unless you post it. You are read-only by default; if the work requires code changes, request edit mode first.`,
};
