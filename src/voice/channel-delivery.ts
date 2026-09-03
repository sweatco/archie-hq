/**
 * `deliverToRecallChannel`: whether a message at a `RecallChannel` reaches a room, and what to say if not. `Task.postToUser` reads `delivered` to gate `knowledge.log`; relays `note` verbatim.
 *
 * Identity check below — live `sessionId` vs the channel record's `session_id` — is what makes a stale key safe.
 * Records aren't removed at meeting end — a multi-meeting task carries one `recall` channel per meeting. `getLiveMeeting` alone (by taskId) finds whatever's live *now*: for an old key, that's nothing or a **different** meeting.
 * Comparing session ids stops a stale answer from landing in a later meeting on the same task.
 */
import type { ChannelDeliverer, ChannelRenderer } from '../tasks/channel-delivery.js';
import { appendMeetingExchange } from '../tasks/persistence.js';
import { getLiveMeeting } from './task-binding.js';
import { logger } from '../system/logger.js';

const LOG = 'recall-channel-delivery';

export const deliverToRecallChannel: ChannelDeliverer = async ({ task, channel, message }) => {
  if (channel.type !== 'recall') {
    // Defensive only — registry never calls a deliverer with another kind's channel.
    logger.warn(LOG, `deliverToRecallChannel invoked with a non-recall channel (${channel.type}) on task ${task.taskId}`);
    return undefined;
  }

  const meeting = getLiveMeeting(task.taskId);
  if (!meeting || meeting.sessionId !== channel.session_id) {
    return { delivered: false, note: 'That meeting has ended — the room has already dispersed. Post to the thread instead.' };
  }

  const result = meeting.deliverConsultAnswer(message);
  if (!result.ok) {
    return { delivered: false, note: 'There is nothing outstanding to answer in this meeting right now.' };
  }
  // "Answered" half of this exchange log — "asked" half is written from `task-binding.ts` when the question goes out.
  // Wrapped, not just awaited: a disk hiccup mustn't turn a delivered answer into a throw — this deliverer must never throw.
  try {
    await appendMeetingExchange(task.taskId, channel.session_id, 'pm-agent', message);
  } catch (err) {
    logger.warn(LOG, `Could not record the exchange for task ${task.taskId}`, err);
  }
  return { delivered: true, note: 'Delivered — it will be spoken aloud to the room.' };
};

/** Kept post-meeting, so a task with several shows each in the PM's context. */
export const renderRecallChannel: ChannelRenderer = (channel) => {
  if (channel.type !== 'recall') {
    // Defensive only, as above — registry never calls a renderer with a different kind's channel.
    logger.warn(LOG, `renderRecallChannel invoked with a non-recall channel (${channel.type})`);
    return channel.type;
  }
  return channel.ended ? 'Meeting (ended)' : 'Meeting (live)';
};
