/**
 * task-binding.ts — the seam between a live voice meeting and Archie's task system.
 *
 * The live registry is in-memory, process-local: the audio loop, sockets, `Meeting` closure can't survive a restart.
 *
 * The durable channel record (`RecallChannel` in metadata.json) links active at start, ends at stop, never removed. No lock — can go stale post-crash (`ended: false`); harmless: its only reader (channel-delivery.ts) checks the live registry.
 *
 * Every `MeetingHost` method built here is sync void, swallows failures: no global `unhandledRejection` handler exists in `src/`, so one uncaught rejection kills every other task and meeting. (Exceptions and per-method contracts: see types.ts.)
 */

import type { Meeting } from './meeting.js';
import type { MeetingHost, WrittenLine } from './types.js';
import { readWrittenExchange } from './written.js';
import { Task } from '../tasks/task.js';
import {
  appendMeetingEvent,
  appendMeetingExchange,
  appendMeetingTranscript,
  appendMeetingChat,
  getMeetingTranscriptPath,
  writeMeetingMetadata,
  writeMeetingCapabilities,
} from '../tasks/persistence.js';
import type { LiveMeetingParticipant, MeetingMetadata } from '../types/task.js';
import { AGENT_PROMPTS } from '../agents/prompts.js';
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
 * botName is only needed by readWrittenExchange (renders each agent's line under Archie's name). No `Meeting` param — must exist before `createMeeting` returns one to register. `consult` reaches the live meeting via `getLiveMeeting(taskId)`, not a captured reference: safe, firing well after registration.
 *
 * `endMeeting` is the connector's own teardown funnel, passed in rather than imported — this module is what the connector builds meetings out of.
 */
export function createTaskHost(
  taskId: string,
  sessionId: string,
  botName: string,
  endMeeting: (sessionId: string) => Promise<void>,
): MeetingHost {
  return {
    recordUtterance(speaker: string, text: string): void {
      appendMeetingTranscript(taskId, sessionId, speaker, text).catch((err) => {
        logger.warn(LOG, `Could not record meeting utterance for ${taskId}`, err);
      });
    },

    recordChat(speaker: string, text: string): void {
      appendMeetingChat(taskId, sessionId, speaker, text).catch((err) => {
        logger.warn(LOG, `Could not record a meeting chat line for ${taskId}`, err);
      });
    },

    readWrittenExchange(): Promise<WrittenLine[]> {
      // Never rejects (see written.ts) — a catch here would only hide it if that stopped being true.
      return readWrittenExchange(taskId, botName);
    },

    noteEvent(text: string): void {
      appendMeetingEvent(taskId, text).catch((err) => {
        logger.warn(LOG, `Could not record meeting event for ${taskId}`, err);
      });
    },

    consult(id: string, question: string): void {
      // 'voice' is the asked half of this meeting's exchange log; channel-delivery.ts writes the answered half as 'pm-agent'.
      appendMeetingExchange(taskId, sessionId, 'voice', question).catch((err) => {
        logger.warn(LOG, `Could not record the question for consult ${id} on task ${taskId}`, err);
      });
      void deliverConsultToPm(taskId, sessionId, recallChannelKey(sessionId), id, question);
    },

    leaveMeeting(): void {
      // Same teardown funnel as the status poll, DELETE route, process shutdown.
      void endMeeting(sessionId).catch((err) => {
        logger.warn(LOG, `Could not end meeting ${sessionId} for task ${taskId} after a LEAVE: request`, err);
      });
    },
  };
}

/**
 * The async body behind `consult`: wakes the PM via `post_to_user` at `channelKey` (`id` only in the logs). No `noteEvent` — `routeConsult` (meeting.ts) already did. On failure, self-answers via `deliverConsultAnswer` with a "could not be reached" notice; FIFO makes an id unnecessary. No PM turn for `deliverToRecallChannel`, so this writes exchange.log's "answered" half itself, as `'system'` not `'pm-agent'`.
 */
async function deliverConsultToPm(taskId: string, sessionId: string, channelKey: string, id: string, question: string): Promise<void> {
  try {
    const task = await Task.get(taskId);
    await task.sendMessage(AGENT_PROMPTS.voiceQuestion(channelKey, question), 'pm-agent');
  } catch (err) {
    logger.warn(LOG, `Could not put consult ${id} to the PM for task ${taskId} — answering it myself`, err);
    const failureNotice = 'The team could not be reached — there is no answer to this one.';
    getLiveMeeting(taskId)?.deliverConsultAnswer(failureNotice);
    appendMeetingExchange(taskId, sessionId, 'system', failureNotice).catch((err2) => {
      logger.warn(LOG, `Could not record the failure notice for consult ${id} on task ${taskId}`, err2);
    });
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

// MeetingMetadata: src/types/task.ts; reaches disk via writeMeetingMetadata (persistence.ts).

// Fields only the teardown fetch can supply stay null until completeMeetingMetadata fills them in — same awaited-but-swallowed pattern as linkRecallChannel.
export async function writeMeetingMetadataStart(
  taskId: string,
  sessionId: string,
  url: string,
  archieJoinedAt: string,
): Promise<void> {
  try {
    await writeMeetingMetadata(taskId, sessionId, {
      session_id: sessionId,
      url,
      platform: null,
      title: null,
      archie_joined_at: archieJoinedAt,
      meeting_ended_at: null,
      duration_seconds: null,
      participants: null,
      // [] not null: unlike the other fields, not a fetch that could fail — in-memory state from the first write on.
      live_participants: [],
    });
  } catch (err) {
    logger.warn(LOG, `Could not write the initial meeting metadata for ${taskId}`, err);
  }
}

// Other fields are re-asserted as writeMeetingMetadataStart left them (non-null only after completeMeetingMetadata's teardown write). Not a read-modify-write: metadata.json has no lock; reading first adds another race.
export async function updateMeetingParticipantsLive(
  taskId: string,
  sessionId: string,
  url: string,
  archieJoinedAt: string,
  liveParticipants: LiveMeetingParticipant[],
): Promise<void> {
  try {
    await writeMeetingMetadata(taskId, sessionId, {
      session_id: sessionId,
      url,
      platform: null,
      title: null,
      archie_joined_at: archieJoinedAt,
      meeting_ended_at: null,
      duration_seconds: null,
      participants: null,
      live_participants: liveParticipants,
    });
  } catch (err) {
    logger.warn(LOG, `Could not update the live participant roster for ${taskId}`, err);
  }
}

/**
 * `info` is connector-agnostic (bare platform string, `{name, isHost}` pairs) — `connector.ts` normalizes Recall's raw shape first.
 *
 * Best-effort, may be empty; unfielded values stay `null`, never guessed. `info.liveParticipants` carries forward verbatim, never rewritten to close `left_at: null` — an unheard departure is invented, which this file refuses.
 */
export async function completeMeetingMetadata(
  taskId: string,
  sessionId: string,
  info: {
    url: string;
    archieJoinedAt: string;
    platform: string | null;
    title: string | null;
    meetingEndedAt: string | null;
    participants: Array<{ name: string | null; isHost: boolean | null }> | null;
    liveParticipants: LiveMeetingParticipant[];
  },
): Promise<void> {
  const meetingEndedAt = info.meetingEndedAt ?? new Date().toISOString();
  const joinedMs = Date.parse(info.archieJoinedAt);
  const endedMs = Date.parse(meetingEndedAt);
  // A negative span just means the two clocks disagree — null beats a nonsensical duration.
  const durationSeconds =
    Number.isFinite(joinedMs) && Number.isFinite(endedMs) && endedMs >= joinedMs
      ? Math.round((endedMs - joinedMs) / 1000)
      : null;
  try {
    await writeMeetingMetadata(taskId, sessionId, {
      session_id: sessionId,
      url: info.url,
      platform: info.platform,
      title: info.title,
      archie_joined_at: info.archieJoinedAt,
      meeting_ended_at: meetingEndedAt,
      duration_seconds: durationSeconds,
      participants: info.participants?.map((p) => ({ name: p.name, is_host: p.isHost })) ?? null,
      live_participants: info.liveParticipants,
    });
  } catch (err) {
    logger.warn(LOG, `Could not complete the meeting metadata for ${taskId}`, err);
  }
}

// MeetingCapabilities: src/types/task.ts.

/**
 * Sync void, fire-and-forget, like `MeetingHost` — called from `startMeeting`'s un-awaited `.then()` (`connector.ts`), so a failed write can't stop a meeting.
 *
 * Three outcomes, kept apart on disk and in the log:
 *
 *  - **Written.** File exists, holds it; `debug` says how big and where.
 *  - **No block.** File exists saying `outcome: 'empty'` — fail-safe, not re-logged since `setCapabilities` (meeting.ts) already warns for this.
 *  - **Write failed.** No file, `warn` naming the meeting — distinct from a pre-record build, which also leaves no file but says nothing.
 */
export function recordMeetingCapabilities(taskId: string, sessionId: string, summary: string): void {
  // Trimmed to match byte-for-byte what setCapabilities sends the model, so a whitespace-only summary records as empty, not a block of spaces.
  const text = summary.trim();
  const outcome = text.length > 0 ? 'summarised' : 'empty';
  writeMeetingCapabilities(taskId, sessionId, {
    session_id: sessionId,
    outcome,
    summary: text,
    captured_at: new Date().toISOString(),
  })
    .then(() => {
      if (outcome === 'summarised') {
        logger.debug(LOG, `Recorded the capability block for ${taskId} — ${text.length} chars in recall/${sessionId}/capabilities.json`);
      } else {
        logger.debug(LOG, `Recorded an empty capability block for ${taskId} in recall/${sessionId}/capabilities.json — this meeting ran without one`);
      }
    })
    .catch((err) => {
      logger.warn(LOG, `Could not record the capability block for ${taskId} — nothing on disk will say what this meeting was told it could do`, err);
    });
}


/**
 * `connector.ts` calls this from `endMeeting`, the funnel every teardown path (status poll, DELETE route, shutdown) runs through. `sessionId` matters too: the transcript lives under that meeting's own folder, not one file per task.
 *
 * Not a `MeetingHost` method — those run inside the audio loop; this fires once, afterwards, from teardown, the one place that knows the meeting is gone.
 *
 * Fire-and-forget, doubly: shutdown awaits every `endMeeting` in its batch, so a hung wake-up would hang that exit too.
 */
export function notifyMeetingEnded(taskId: string, sessionId: string): void {
  void (async () => {
    try {
      const task = await Task.get(taskId);
      await task.sendMessage(AGENT_PROMPTS.meetingEnded(getMeetingTranscriptPath(taskId, sessionId)), 'pm-agent');
    } catch (err) {
      logger.warn(LOG, `Could not wake the PM about the ended meeting for ${taskId}`, err);
    }
  })();
}
