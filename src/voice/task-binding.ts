/**
 * task-binding.ts — the seam between a live voice meeting and Archie's task system.
 *
 * The live registry is in-memory, process-local: the audio loop, sockets, `Meeting` closure can't survive a restart.
 *
 * The durable channel record (`RecallChannel` in metadata.json) links active at start, ends at stop, never removed. No lock — can go stale post-crash (`ended: false`); harmless: its only reader (channel-delivery.ts) checks the live registry.
 */

import type { Meeting } from './meeting.js';
import type { MeetingHost, WrittenLine } from './types.js';
import { readWrittenExchange } from './written.js';
import { Task } from '../tasks/task.js';
import { appendMeetingEvent, getMeetingRecordPath } from '../tasks/persistence.js';
import { loadPrompt } from '../utils/prompt-loader.js';
import { logger } from '../system/logger.js';

const LOG = 'voice-task-binding';


const liveMeetings = new Map<string, Meeting>();

// startMeeting awaits bot creation at Recall before registering: two close calls could both pass the "already live" check and orphan a bot (live, audible, unreachable). This set synchronously claims the slot first, so the second fails fast.
const reservedTaskIds = new Set<string>();

export function registerLiveMeeting(taskId: string, meeting: Meeting): void {
  reservedTaskIds.delete(taskId);
  liveMeetings.set(taskId, meeting);
}

export function getLiveMeeting(taskId: string): Meeting | undefined {
  return liveMeetings.get(taskId);
}

// Call at teardown's start, before awaiting Meeting.stop() — so a consult reply or new join in that window sees "no meeting live", not one registered but refusing everything.
export function unregisterLiveMeeting(taskId: string): void {
  liveMeetings.delete(taskId);
}

// False when the task already has a live meeting or another creation is in flight — caller must not proceed. Pair with releaseMeetingSlot in a catch, or a failed creation leaves the task stuck.
export function reserveMeetingSlot(taskId: string): boolean {
  if (liveMeetings.has(taskId) || reservedTaskIds.has(taskId)) {
    return false;
  }
  reservedTaskIds.add(taskId);
  return true;
}

export function releaseMeetingSlot(taskId: string): void {
  reservedTaskIds.delete(taskId);
}

// Sole source of this format string — linkRecallChannel and consult must never disagree on the exact value.
export function recallChannelKey(sessionId: string): string {
  return `recall:${sessionId}`;
}

/**
 * No `Meeting` param — must exist before `createMeeting` returns one to register. `consult` reaches the live meeting via `getLiveMeeting(taskId)`, not a captured reference: safe, firing well after registration.
 *
 * `endMeeting` is the connector's own teardown funnel, passed in rather than imported — this module is what the connector builds meetings out of.
 */
export function createTaskHost(
  taskId: string,
  sessionId: string,
  endMeeting: (sessionId: string) => Promise<void>,
): MeetingHost {
  return {
    readWrittenExchange(): Promise<WrittenLine[]> {
      return readWrittenExchange(taskId);
    },

    noteEvent(text: string): void {
      void appendMeetingEvent(taskId, text);
    },

    consult(id: string, question: string): void {
      // The question's own `consult` row is written by `routeConsult` (meeting.ts) before this runs; this method only carries it to the PM.
      void deliverConsultToPm(taskId, recallChannelKey(sessionId), id, question);
    },

    leaveMeeting(): void {
      // Same teardown funnel as the status poll, DELETE route, process shutdown.
      void endMeeting(sessionId);
    },
  };
}

/**
 * The async body behind `consult`: wakes the PM via `post_to_user` at `channelKey` (`id` only in the logs). No `noteEvent` — `routeConsult` (meeting.ts) already did. On failure, self-answers via `deliverConsultAnswer` with a "could not be reached" notice, labelled `'system'` so the record does not imply the PM ever answered; a cap of one outstanding question makes an id unnecessary here.
 */
async function deliverConsultToPm(taskId: string, channelKey: string, id: string, question: string): Promise<void> {
  try {
    const task = await Task.get(taskId);
    const prompt = await loadPrompt('voice-wakeup-question', { CHANNEL_KEY: channelKey, QUESTION: question });
    await task.sendMessage(prompt, 'pm-agent');
  } catch (err) {
    logger.warn(LOG, `Could not put consult ${id} to the PM for task ${taskId} — answering it myself`, err);
    getLiveMeeting(taskId)?.deliverConsultAnswer(
      'The team could not be reached — there is no answer to this one.',
      'system',
    );
  }
}


// Never assigns default_channel — the durable thread stays as-is. Awaited, swallows its own failure: a metadata hiccup shouldn't fail an already-succeeded join.
export async function linkRecallChannel(taskId: string, sessionId: string, url: string): Promise<void> {
  try {
    const task = await Task.get(taskId);
    task.metadata.channels[recallChannelKey(sessionId)] = {
      type: 'recall',
      session_id: sessionId,
      url,
      ended: false,
    };
    await task.save(true);
  } catch (err) {
    logger.warn(LOG, `Could not link the recall channel for ${taskId}`, err);
  }
}

export async function endRecallChannel(taskId: string, sessionId: string): Promise<void> {
  try {
    const task = await Task.get(taskId);
    const ch = task.metadata.channels[recallChannelKey(sessionId)];
    if (ch?.type === 'recall') {
      ch.ended = true;
      await task.save(true);
    }
  } catch (err) {
    logger.warn(LOG, `Could not mark the recall channel ended for ${taskId}`, err);
  }
}

/**
 * `src/connectors/recall/index.ts` calls this from `endMeeting`, the funnel every teardown path (status poll, DELETE route, shutdown) runs through. `sessionId` matters too: the record lives under that meeting's own folder, not one file per task.
 *
 * Not a `MeetingHost` method — those run inside the audio loop; this fires once, afterwards, from teardown, the one place that knows the meeting is gone.
 *
 * Fire-and-forget, doubly: shutdown awaits every `endMeeting` in its batch, so a hung wake-up would hang that exit too.
 */
export function notifyMeetingEnded(taskId: string, sessionId: string): void {
  void (async () => {
    const task = await Task.get(taskId);
    const prompt = await loadPrompt('voice-wakeup-ended', {
      RECORD_PATH: getMeetingRecordPath(taskId, sessionId),
    });
    await task.sendMessage(prompt, 'pm-agent');
  })();
}
