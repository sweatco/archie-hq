/**
 * `deliverToRecallChannel`: whether a message at a `RecallChannel` reaches a room, and what to say if not. `Task.postToUser` reads `delivered` to gate `knowledge.log`; relays `note` verbatim.
 *
 * Identity check below — live `sessionId` vs the channel record's `session_id` — is what makes a stale key safe.
 * Records aren't removed at meeting end — a multi-meeting task carries one `recall` channel per meeting. `getLiveMeeting` alone (by taskId) finds whatever's live *now*: for an old key, that's nothing or a **different** meeting.
 * Comparing session ids stops a stale answer from landing in a later meeting on the same task.
 */
import type { ChannelDeliverer, ChannelRenderer } from '../tasks/channel-delivery.js';
import type { RecallChannel } from '../types/task.js';
import { getLiveMeeting } from './task-binding.js';

// The registry dispatches by kind, so the record handed to either function below is always this kind's.
export const deliverToRecallChannel: ChannelDeliverer = async ({ task, channel, message }) => {
  const meeting = getLiveMeeting(task.taskId);
  if (!meeting || meeting.sessionId !== (channel as RecallChannel).session_id) {
    return { delivered: false, note: 'That meeting has ended — the room has already dispersed. Post to the thread instead.' };
  }

  // Records its own `answer` row on the way in — nothing here writes to the meeting's record.
  const result = meeting.deliverConsultAnswer(message);
  if (!result.ok) {
    return { delivered: false, note: 'There is nothing outstanding to answer in this meeting right now.' };
  }
  return { delivered: true, note: 'Delivered — it will be spoken aloud to the room.' };
};

/** Kept post-meeting, so a task with several shows each in the PM's context. */
export const renderRecallChannel: ChannelRenderer = (channel) =>
  (channel as RecallChannel).ended ? 'Meeting (ended)' : 'Meeting (live)';
