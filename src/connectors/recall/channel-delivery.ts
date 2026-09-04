/**
 * `deliverToRecallChannel`: whether a message at a `RecallChannel` reaches a room, and what to say if not. `Task.postToUser` calls it directly from its `recall` branch, the same way it calls `postSlackMessage` from its `slack` one; it reads `delivered` to gate `knowledge.log` and relays `note` verbatim.
 *
 * Identity check below — live `sessionId` vs the channel record's `session_id` — is what makes a stale key safe.
 * Records aren't removed at meeting end — a multi-meeting task carries one `recall` channel per meeting. `getLiveMeeting` alone (by taskId) finds whatever's live *now*: for an old key, that's nothing or a **different** meeting.
 * Comparing session ids stops a stale answer from landing in a later meeting on the same task.
 */
import type { Task } from '../../tasks/task.js';
import type { RecallChannel } from '../../types/task.js';
import { getLiveMeeting } from '../../voice/task-binding.js';

/**
 * `delivered` is whether the message actually reached a room — the only thing `postToUser` gates its `knowledge.log` append on, never `note`'s wording. `note` is always there and always relayed to the caller, delivered or not.
 */
export async function deliverToRecallChannel(args: {
  task: Task;
  channel: RecallChannel;
  message: string;
}): Promise<{ delivered: boolean; note: string }> {
  const { task, channel, message } = args;
  const meeting = getLiveMeeting(task.taskId);
  if (!meeting || meeting.sessionId !== channel.session_id) {
    return { delivered: false, note: 'That meeting has ended — the room has already dispersed. Post to the thread instead.' };
  }

  // Records its own `answer` row on the way in — nothing here writes to the meeting's record.
  const result = meeting.deliverConsultAnswer(message);
  if (!result.ok) {
    return { delivered: false, note: 'There is nothing outstanding to answer in this meeting right now.' };
  }
  return { delivered: true, note: 'Delivered — it will be spoken aloud to the room.' };
}
