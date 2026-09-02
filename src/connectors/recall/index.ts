/**
 * Recall connector — Archie as an ordinary meeting participant (Zoom, Meet, Teams via Recall.ai).
 * Implements {@link VoiceTransport} for `src/voice/`.
 *
 * Three HTTP/WS paths on the engine's own server:
 *   /api/voice/audio        — per-participant audio; join/leave events ride the same socket.
 *   /api/voice/out/:pageId  — Output Media page receiving our synthesized speech.
 *   /api/voice/page/:pageId — page Recall's browser loads as camera+mic.
 * Frames attribute from `data.bot.id`, not the path — Recall assigns the bot id only once this URL is given.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Application, Request, Response } from 'express';
import { createRequire } from 'module';
import { WebSocketServer, type WebSocket } from 'ws';

const require = createRequire(import.meta.url);
const express = require('express');

import { logger } from '../../system/logger.js';
import { createRecallClient, type RecallConfig } from './recall.js';
import { createAudioOutHub, renderPage } from './audio-out.js';
import { createMeeting, isArchie, type Meeting } from '../../voice/meeting.js';
import { buildCapabilitySummary } from '../../voice/capabilities.js';
import type { MeetingHost, Participant, VoiceConfig, VoiceTransport } from '../../voice/types.js';
import {
  createTaskHost,
  registerLiveMeeting,
  unregisterLiveMeeting,
  reserveMeetingSlot,
  releaseMeetingSlot,
  setMeetingStarter,
  setMeetingStopper,
  notifyMeetingEnded,
  linkRecallChannel,
  endRecallChannel,
  writeMeetingMetadataStart,
  updateMeetingParticipantsLive,
  completeMeetingMetadata,
  recordMeetingCapabilities,
  type StartMeetingResult,
} from '../../voice/task-binding.js';
import type { LiveMeetingParticipant } from '../../types/task.js';
import { registerChannelDeliverer } from '../../tasks/channel-delivery.js';
import { deliverToRecallChannel, renderRecallChannel } from './channel-delivery.js';
import { registerConnectorPmTools } from '../../agents/connector-tools.js';
import { createRecallPmToolsServer } from './pm-tools.js';

export interface RecallLifecycle {
  /** Call once the HTTP server exists. */
  attach(server: Server): void;
  stop(): Promise<void>;
}

/** Mirrors `LiveMeetingParticipant` (`src/types/task.ts`) in camelCase; `snapshotLiveParticipants` converts back. */
interface LiveParticipantState {
  name: string | null;
  isHost: boolean | null;
  joinedAt: string | null;
  leftAt: string | null;
}

interface LiveMeeting {
  botId: string;
  /** Minted before the bot exists: `output_media` must ride the same create request returning the bot id, so the page URL can't include it. */
  pageId: string;
  meeting: Meeting;
  greeted: boolean;
  /** Wall-clock ms of the most recent audio frame, for idle teardown. */
  lastAudioAt: number;
  /** Absent for the manual, unbound entry point. `url`/`joinedAt` cached here so metadata.json's teardown write skips a second round trip. */
  binding?: { taskId: string; host: MeetingHost; url: string; joinedAt: string };
  /** Keyed by Recall's opaque participant id — a rejoin gets a fresh id, a new entry, not resumed. Humans only: `isArchie` filters our join/leave. */
  participants: Map<string, LiveParticipantState>;
  /** Armed empty-room teardown ({@link EMPTY_ROOM_GRACE_MS}) or null — at most one per meeting. */
  emptyRoomTimer: NodeJS.Timeout | null;
  /** Pending socket-close question ({@link SOCKET_CLOSE_SETTLE_MS}) or null — at most one per meeting. */
  socketCloseCheck: NodeJS.Timeout | null;
}

/** Requires the `/` after `prefix` — otherwise `/api/voice/outsider` would parse as page id "sider". */
function pageIdFromPath(url: string | undefined, prefix: string): string | null {
  if (!url) return null;
  const path = url.split('?')[0] ?? '';
  if (!path.startsWith(`${prefix}/`)) return null;
  const rest = path.slice(prefix.length + 1).replace(/^\/+|\/+$/g, '');
  return rest.length > 0 && !rest.includes('/') ? rest : null;
}

/** Recall sends integer ids; stringified since `src/voice/` mustn't see Recall's wire format. Falls back to `'unknown'` rather than reject an unfamiliar shape. */
function participantId(raw: unknown): string {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return String(raw);
  } else if (typeof raw === 'string' && raw.length > 0) {
    return raw;
  } else {
    return 'unknown';
  }
}

/** Parse Recall's participant object, shared by the audio path and both participant-event handlers. */
function parseParticipant(raw: unknown): Participant {
  const p = (raw ?? {}) as Record<string, unknown>;
  return {
    id: participantId(p.id),
    name: typeof p.name === 'string' ? p.name : null,
    email: typeof p.email === 'string' ? p.email : null,
    isHost: typeof p.is_host === 'boolean' ? p.is_host : null,
  };
}

/**
 * On Zoom, a rejoin gets a fresh id: `leave(id1)` then `join(id2)` — indistinguishable from empty until the second event.
 * 45s covers a dropped connection (~30-45s reconnect) and a deliberate rejoin; tearing down early speaks the summary into a still-live room.
 * See `handleParticipantLeave`.
 */
const EMPTY_ROOM_GRACE_MS = 45 * 1000;

/**
 * Statuses (`status_changes[].code`, bare — no `bot.` prefix, unlike webhook names) proving no more audio can reach this bot:
 *   - `call_ended` — bot left the call; ordinary end.
 *   - `done` — shutdown complete; always follows `call_ended`.
 *   - `fatal` — bot errored out; terminal even mid-meeting, since Archie can't return without a fresh join.
 * Closed "certainly out" set on purpose: an unfamiliar code falls through to other teardown paths — late, never a wrong early one.
 */
const TERMINAL_BOT_STATUSES = new Set(['call_ended', 'done', 'fatal']);

/**
 * Recall's status ledger lags its own audio — observed live: socket closed at 11:44:40, `call_ended` landed at 11:44:43.
 * 10s is ~3x that lag, still well inside {@link IDLE_TEARDOWN_MS}; skipped if audio resumes first.
 */
const SOCKET_CLOSE_SETTLE_MS = 10 * 1000;

/**
 * Backstop for what neither `.leave` nor a socket-close answer catches: an idle room with no `.leave`/close, or a failed/inconclusive close check.
 * Without it, an idle Deepgram socket bills forever.
 * Safe against double-firing: `endMeeting` deletes from `live` synchronously before its first `await` — whichever route wins, the rest find nothing to do.
 */
const IDLE_TEARDOWN_MS = 3 * 60 * 1000;
const IDLE_SWEEP_MS = 30 * 1000;

export function mountRecallConnector(app: Application, cfg: RecallConfig): RecallLifecycle {
  /** Adds our API key to `foreignSecrets` so voice's log scrubber can redact it — no other way to learn it. */
  const voice: VoiceConfig = {
    ...cfg.voice,
    foreignSecrets: [...(cfg.voice.foreignSecrets ?? []), cfg.recallApiKey],
  };
  /** Must match the wake word — see {@link VoiceConfig.botName}. */
  const botName = voice.botName;

  const recall = createRecallClient(cfg);
  const audioOut = createAudioOutHub();
  const live = new Map<string, LiveMeeting>();
  const audioSockets = new Set<WebSocket>();
  let idleSweep: NodeJS.Timeout | null = null;

  const router = express.Router();
  router.use(express.json());

  // Keyed by our own page id, not the bot id — see LiveMeeting.pageId.
  router.get('/page/:pageId', (req: Request, res: Response) => {
    const pageId = req.params.pageId as string;
    const wsUrl = `${cfg.publicUrl.replace(/^http/, 'ws')}/api/voice/out/${pageId}`;
    res.type('html').send(renderPage(pageId, wsUrl, botName));
  });

  /**
   * Reservation precedes the `await`, or two concurrent `startMeeting`s on one task both see an empty registry and both create a bot, orphaning one: live, audible, unreachable.
   * Released on any failure so a dead attempt can't strand the task.
   */
  async function startMeeting(meetingUrl: string, taskId: string | undefined): Promise<StartMeetingResult> {
    if (taskId !== undefined && !reserveMeetingSlot(taskId)) {
      return { ok: false, reason: 'A meeting is already live on this task.' };
    }

    try {
      const pageId = randomUUID();
      const botId = await recall.createBot({
        meetingUrl,
        botName,
        audioWsUrl: `${cfg.publicUrl.replace(/^http/, 'ws')}/api/voice/audio`,
        pageUrl: `${cfg.publicUrl}/api/voice/page/${pageId}`,
      });

      const host = taskId === undefined ? undefined : createTaskHost(taskId, botId, botName);

      const transport: VoiceTransport = {
        // bot id, not page id: it outlives every socket in the call — the stable key for the activation log.
        sessionId: botId,
        sink: audioOut.sinkFor(pageId),
        sendChat: (text) => recall.sendChat(botId, text),
      };
      const meeting = createMeeting(voice, transport, host);
      // Best-effort; teardown may find a more authoritative time in Recall's own status_changes ledger.
      const joinedAt = new Date().toISOString();
      const binding =
        taskId !== undefined && host !== undefined
          ? { taskId, host, url: meetingUrl, joinedAt }
          : undefined;
      live.set(botId, {
        botId,
        pageId,
        meeting,
        greeted: false,
        lastAudioAt: Date.now(),
        binding,
        participants: new Map(),
        emptyRoomTimer: null,
        socketCloseCheck: null,
      });

      if (binding !== undefined) {
        registerLiveMeeting(binding.taskId, meeting);
        // Kept on the task after the meeting ends; awaited since there's no hot-path latency here.
        await linkRecallChannel(binding.taskId, botId, meetingUrl);
        // metadata.json's first write, with whatever is known this early.
        await writeMeetingMetadataStart(binding.taskId, botId, meetingUrl, joinedAt);
        // Points at the record, not the URL — knowledge.log is an index the PM reads every turn.
        binding.host.noteEvent(`meeting started — recall/${botId}/`);
        // 'meeting' is a reserved speaker name — no participant can be named that.
        binding.host.recordUtterance('meeting', `started — bot ${botId} joined ${meetingUrl}`);
        // Deliberately unawaited — awaiting would hold this live meeting behind the model's latency; caught so a throw here can't crash the process (no unhandledRejection handler).
        void buildCapabilitySummary(voice, binding.taskId).then((summary) => {
          meeting.setCapabilities(summary);
          recordMeetingCapabilities(binding.taskId, botId, summary);
        })
        .catch((error) => {
          logger.warn(
            'voice',
            `The capability summary for ${binding.taskId} threw instead of landing — this meeting will run with no capability block, and none was recorded either`,
            error,
          );
        });
      }

      logger.system(
        `Voice: bot ${botId} joining ${meetingUrl} (output page ${pageId})` +
        (binding !== undefined ? ` for task ${binding.taskId}` : ''),
      );
      return { ok: true, botId };
    } catch (error) {
      if (taskId !== undefined) {
        releaseMeetingSlot(taskId);
      }
      logger.error('voice', 'Failed to start meeting', error);
      return { ok: false, reason: 'failed to start meeting' };
    }
  }

  // `task_id` is optional — omit for an unbound meeting: no record, no consulting.
  router.post('/meetings', async (req: Request, res: Response) => {
    const meetingUrl = (req.body ?? {}).meeting_url;
    if (typeof meetingUrl !== 'string' || meetingUrl.length === 0) {
      res.status(400).json({ error: 'meeting_url is required' });
      return;
    }
    const rawTaskId = (req.body ?? {}).task_id;
    const taskId = typeof rawTaskId === 'string' && rawTaskId.length > 0 ? rawTaskId : undefined;

    const result = await startMeeting(meetingUrl, taskId);
    if (!result.ok) {
      res.status(500).json({ error: result.reason });
      return;
    }
    res.status(201).json({ bot_id: result.botId });
  });

  // Lets `join_recall_meeting` reach this connector without a direct import from `src/agents/`.
  setMeetingStarter((taskId, meetingUrl) => startMeeting(meetingUrl, taskId));
  setMeetingStopper(endMeeting);

  // Registered at mount, not always: if Recall isn't configured, the PM never sees these tools rather than sees them fail.
  registerChannelDeliverer('recall', deliverToRecallChannel, renderRecallChannel);
  registerConnectorPmTools('recall-tools', createRecallPmToolsServer);

  router.delete('/meetings/:botId', async (req: Request, res: Response) => {
    const botId = req.params.botId as string;
    await endMeeting(botId);
    res.json({ ok: true });
  });

  app.use('/api/voice', router);

  /**
   * Never throws — resolves, honestly partial on failure, so `endMeeting` can't hang or throw into shutdown.
   * Participants fetch has its own try/catch: bot-details succeeding doesn't mean Recall's roster is ready yet.
   */
  async function fetchTeardownDetails(botId: string): Promise<{
    platform: string | null;
    title: string | null;
    meetingEndedAt: string | null;
    participants: Array<{ name: string | null; isHost: boolean | null }> | null;
  }> {
    let platform: string | null = null;
    let title: string | null = null;
    let meetingEndedAt: string | null = null;
    let participants: Array<{ name: string | null; isHost: boolean | null }> | null = null;
    try {
      const bot = await recall.getBotDetails(botId);
      platform = bot.platform;
      title = bot.title;
      // `call_ended`, not `done`: wants the moment the call ended; `done` marks Recall's later post-processing.
      const ended = bot.statusChanges.find((s) => s.code === 'call_ended');
      if (ended) meetingEndedAt = ended.createdAt;
      if (bot.participantsDownloadUrl) {
        try {
          participants = await recall.fetchParticipants(bot.participantsDownloadUrl);
        } catch (error) {
          logger.warn('voice', `Could not download the participant roster for bot ${botId}`, error);
        }
      }
    } catch (error) {
      logger.warn('voice', `Could not fetch bot details for ${botId} — meeting metadata will stay partial`, error);
    }
    return { platform, title, meetingEndedAt, participants };
  }

  function cancelEmptyRoomTeardown(entry: LiveMeeting, because: string): void {
    if (entry.emptyRoomTimer !== null) {
      clearTimeout(entry.emptyRoomTimer);
      entry.emptyRoomTimer = null;
      logger.system(`Voice: bot ${entry.botId} — ${because}, standing down the pending empty-room teardown`);
    }
  }

  function cancelSocketCloseCheck(entry: LiveMeeting, because: string): void {
    if (entry.socketCloseCheck !== null) {
      clearTimeout(entry.socketCloseCheck);
      entry.socketCloseCheck = null;
      logger.system(`Voice: bot ${entry.botId} — ${because}, dropping the pending socket-close question`);
    }
  }

  async function endMeeting(botId: string): Promise<void> {
    const entry = live.get(botId);
    live.delete(botId);
    if (entry) {
      // Before any `await`: an armed timer would still fire — harmless, a redundant leave_call to Recall.
      cancelEmptyRoomTeardown(entry, 'the meeting is ending');
      cancelSocketCloseCheck(entry, 'the meeting is ending');
      if (entry.binding !== undefined) {
        // Before `stop()`, not after — else a channel post could reach a meeting only looking live mid-stop().
        unregisterLiveMeeting(entry.binding.taskId);
        // Marking ended here is bookkeeping only — delivery correctness is `deliverToRecallChannel`'s session-id check.
        await endRecallChannel(entry.binding.taskId, botId);
      }
      try {
        await entry.meeting.stop();
      } catch (error) {
        logger.error('voice', `Error stopping meeting ${botId}`, error);
      }
      audioOut.dispose(entry.pageId);
      if (entry.binding !== undefined) {
        entry.binding.host.noteEvent(`meeting ended — recall/${botId}/`);
        // Safe to await — never throws (unlike `notifyMeetingEnded` below).
        const details = await fetchTeardownDetails(botId);
        await completeMeetingMetadata(entry.binding.taskId, botId, {
          url: entry.binding.url,
          archieJoinedAt: entry.binding.joinedAt,
          ...details,
          liveParticipants: snapshotLiveParticipants(entry),
        });
        // Fire-and-forget — an awaited wake-up that hung would hang `stop()`'s whole batch. After the metadata write, so the PM finds it already finished.
        notifyMeetingEnded(entry.binding.taskId, botId);
      }
    }
    try {
      await recall.leave(botId);
    } catch (error) {
      logger.error('voice', `Error making bot ${botId} leave`, error);
    }
  }

  /**
   * Recall's envelope, verified live (shared by audio + both participant events — see `events` in `recall.ts`):
   *   { event, data: { bot: { id }, data: { participant, buffer?, timestamp } } }
   * Parsed here so `meeting.ts` never sees the wire shape.
   *
   * Returns the bot this message belonged to (the socket then knows which meeting it carries — see `connection`), or `null` if unparseable, unattributed, or untracked.
   */
  function handleAudioMessage(raw: string): string | null {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return null;
    }
    const m = msg as {
      event?: string;
      data?: { data?: Record<string, unknown>; bot?: { id?: string } };
    };

    const botId = m.data?.bot?.id;
    const entry = botId ? live.get(botId) : undefined;
    if (!entry) return null;

    const d = m.data?.data ?? {};

    if (m.event === 'audio_separate_raw.data') {
      entry.lastAudioAt = Date.now();

      const raw64 = typeof d.buffer === 'string' ? d.buffer : '';
      const participant = parseParticipant(d.participant);
      // Belt-and-suspenders: Recall excludes our audio by default, but a slip-through would fire barge-in on it.
      if (raw64.length > 0 && !isArchie(participant.name, botName)) {
        entry.meeting.onAudio(participant, Buffer.from(raw64, 'base64'));
      }
    } else if (m.event === 'participant_events.join') {
      handleParticipantJoin(entry, parseParticipant(d.participant));
    } else if (m.event === 'participant_events.leave') {
      handleParticipantLeave(entry, parseParticipant(d.participant));
    }
    // Anything else is ignored (see the "ignores frames it cannot place" test).
    return entry.botId;
  }

  /** The persisted shape of a meeting's live-accumulated roster, in join order. */
  function snapshotLiveParticipants(entry: LiveMeeting): LiveMeetingParticipant[] {
    return [...entry.participants.values()].map((p) => ({
      name: p.name,
      is_host: p.isHost,
      joined_at: p.joinedAt,
      left_at: p.leftAt,
    }));
  }

  /** Push this meeting's live roster to its metadata.json. No-op for an unbound meeting — no task to write to. */
  function persistLiveParticipants(entry: LiveMeeting): void {
    if (entry.binding === undefined) return;
    void updateMeetingParticipantsLive(
      entry.binding.taskId,
      entry.botId,
      entry.binding.url,
      entry.binding.joinedAt,
      snapshotLiveParticipants(entry),
    );
  }

  /**
   * `meeting.ts`'s map only sees who's spoken (`onAudio`); Recall omits muted participants, so this join/leave roster shows the agent four in the room, three muted.
   * Same shape as `snapshotLiveParticipants`'s output (`RosterEntry`, `src/voice/types.ts`) by design — one shaping function, not two.
   * Runs for an unbound meeting too.
   */
  function pushLiveParticipants(entry: LiveMeeting): void {
    try {
      entry.meeting.updateParticipants(snapshotLiveParticipants(entry));
    } catch (error) {
      // Must not throw — runs from the audio socket handler; losing the roster costs context, not voice.
      logger.warn('voice', `Could not hand the roster to meeting ${entry.botId}`, error);
    }
  }

  /**
   * Replaces, not duplicates, a repeat `.join` for the id — a malformed/duplicate event can't invent a second occupant.
   * Disarms the empty-room timer (see `EMPTY_ROOM_GRACE_MS`): a join is that grace period's rejoin half.
   */
  function handleParticipantJoin(entry: LiveMeeting, participant: Participant): void {
    if (isArchie(participant.name, botName)) return;
    entry.participants.set(participant.id, {
      name: participant.name,
      isHost: participant.isHost,
      joinedAt: new Date().toISOString(),
      leftAt: null,
    });
    cancelEmptyRoomTeardown(entry, 'somebody joined');
    persistLiveParticipants(entry);
    pushLiveParticipants(entry);
  }

  /**
   * Closes the entry (`LiveParticipantState`); once empty, arms the empty-room teardown (`EMPTY_ROOM_GRACE_MS`) instead of tearing down immediately.
   *
   * `everWitnessedAJoin` needs a real `.join` (`joinedAt !== null`), stricter than "roster non-empty": an orphaned leave alone can populate the roster on a meeting's first event without meaning "the room emptied."
   * Such a leave is still recorded (`joinedAt: null`), and still counts toward `stillPresent` once a real join happens elsewhere.
   */
  function handleParticipantLeave(entry: LiveMeeting, participant: Participant): void {
    if (isArchie(participant.name, botName)) return;
    const now = new Date().toISOString();
    const existing = entry.participants.get(participant.id);
    if (existing) {
      existing.leftAt = now;
    } else {
      entry.participants.set(participant.id, {
        name: participant.name,
        isHost: participant.isHost,
        joinedAt: null,
        leftAt: now,
      });
    }
    persistLiveParticipants(entry);
    pushLiveParticipants(entry);

    const everWitnessedAJoin = [...entry.participants.values()].some((p) => p.joinedAt !== null);
    const stillPresent = [...entry.participants.values()].some((p) => p.leftAt === null);
    if (everWitnessedAJoin && !stillPresent && entry.emptyRoomTimer === null) {
      logger.system(
        `Voice: bot ${entry.botId} — last participant left, ending the meeting in ` +
        `${EMPTY_ROOM_GRACE_MS / 1000}s unless somebody rejoins`,
      );
      const timer = setTimeout(() => {
        // Cleared before teardown — endMeeting must not be handed an already-fired timer handle.
        entry.emptyRoomTimer = null;
        logger.system(`Voice: bot ${entry.botId} — the room stayed empty, ending the meeting`);
        void endMeeting(entry.botId);
      }, EMPTY_ROOM_GRACE_MS);
      // unref'd — must not keep the process alive on its own.
      timer.unref();
      entry.emptyRoomTimer = timer;
    }
  }

  /**
   * Audio socket closing is ambiguous — network blip vs. real end look identical — so this asks Recall rather than deciding locally.
   * Necessary since Recall doesn't always send `.leave` — one observed departure left `left_at: null`, no leave event, no armed timer; only the idle sweep caught it, minutes late.
   */
  function handleAudioSocketClose(botId: string | null): void {
    const entry = botId === null ? undefined : live.get(botId);
    if (botId === null) {
      // No frame arrived — Recall opens the socket before the bot is admitted; ordinary, not a lost meeting.
      logger.system('Voice: Recall audio socket closed before it carried any meeting');
    } else if (entry === undefined) {
      // Ordinary during shutdown — `stop()` ends every meeting before closing sockets.
      logger.system(`Voice: Recall audio socket closed for bot ${botId}, which is no longer live`);
    } else if (entry.socketCloseCheck !== null) {
      // A close storm (several drops in a row) asks once, not once per close.
      logger.system(`Voice: Recall audio socket closed for bot ${botId} — a question is already pending`);
    } else {
      logger.system(
        `Voice: Recall audio socket closed for bot ${botId} — asking Recall what happened in ` +
        `${SOCKET_CLOSE_SETTLE_MS / 1000}s`,
      );
      const closedAt = Date.now();
      const timer = setTimeout(() => {
        // Cleared before the ask — same reason as the grace timer: don't hand endMeeting a spent handle.
        entry.socketCloseCheck = null;
        void askWhetherWeAreStillInTheCall(entry.botId, closedAt);
      }, SOCKET_CLOSE_SETTLE_MS);
      // unref'd, same reason.
      timer.unref();
      entry.socketCloseCheck = timer;
    }
  }

  /** Second half of `handleAudioSocketClose`. Never throws; ends the meeting only on a terminal status. */
  async function askWhetherWeAreStillInTheCall(botId: string, closedAt: number): Promise<void> {
    const entry = live.get(botId);
    if (entry === undefined) {
      return; // ended by another route while we waited — nothing to ask about
    }
    if (entry.lastAudioAt > closedAt) {
      logger.system(`Voice: bot ${botId} — audio resumed after the socket closed, so nothing to ask`);
      return;
    }

    let codes: string[];
    try {
      codes = (await recall.getBotDetails(botId)).statusChanges.map((s) => s.code);
    } catch (error) {
      // Loud on purpose: if this fetch fails, the idle sweep still ends the meeting minutes later — this log is the only trace of why it didn't end here.
      logger.warn(
        'voice',
        `Could not ask Recall whether bot ${botId} is still in the call — leaving the meeting live ` +
        `for the idle sweep to reach`,
        error,
      );
      return;
    }

    // Checks ANY terminal code, not just the last — a bot never rejoins, so a later non-terminal entry (post-processing, breakout room) can't un-terminal it.
    const terminal = codes.find((code) => TERMINAL_BOT_STATUSES.has(code));
    if (terminal === undefined) {
      logger.system(
        `Voice: bot ${botId} — Recall still has it in the call (latest status ` +
        `"${codes[codes.length - 1] ?? 'none'}"), so the closed socket was a blip`,
      );
    } else if (!live.has(botId)) {
      // Ended by another route while the GET was in flight; no `await` between this check and the call below — can't race further.
      logger.system(`Voice: bot ${botId} — Recall reports "${terminal}", but the meeting has already ended`);
    } else {
      logger.system(`Voice: bot ${botId} — Recall reports "${terminal}", ending the meeting now`);
      await endMeeting(botId);
    }
  }

  /** Triggered by the output page connecting, not first audio — waiting for a human to speak first is backwards. */
  function greetOnce(entry: LiveMeeting): void {
    if (!entry.greeted) {
      entry.greeted = true;
      void recall
        .sendChat(
          entry.botId,
          `Hi, I'm ${botName}. I'm listening to this meeting — say my name and I'll chime in.`,
        )
        .catch((error) => logger.warn('voice', `Greeting failed for ${entry.botId}`, error));
    }
  }

  function findByPage(pageId: string): LiveMeeting | undefined {
    for (const entry of live.values()) {
      if (entry.pageId === pageId) return entry;
    }
    return undefined;
  }

  const audioWss = new WebSocketServer({ noServer: true });
  const pageWss = new WebSocketServer({ noServer: true });

  audioWss.on('connection', (ws: WebSocket) => {
    logger.system('Voice: Recall audio socket open');
    audioSockets.add(ws);
    /** Learned from frames — close carries no bot id (Recall assigns it only once handed the URL); otherwise a close means asking every live meeting. */
    let carrying: string | null = null;
    ws.on('message', (data) => {
      // A throw here would take down the process, so the audio path is sealed.
      try {
        carrying = handleAudioMessage(data.toString()) ?? carrying;
      } catch (error) {
        logger.error('voice', 'Audio handling failed', error);
      }
    });
    ws.on('close', () => {
      audioSockets.delete(ws);
      handleAudioSocketClose(carrying);
    });
  });

  pageWss.on('connection', (ws: WebSocket, _req: IncomingMessage, pageId: string) => {
    logger.system(`Voice: output page connected for ${pageId}`);
    audioOut.handlePageSocket(pageId, ws);
    const entry = findByPage(pageId);
    if (entry) {
      greetOnce(entry);
      // Sink defaults closed; opened here since Recall is now rendering our page.
      audioOut.sinkFor(pageId).setEnabled(true);
    } else {
      logger.warn('voice', `Output page connected for unknown page id ${pageId}`);
    }
  });

  return {
    attach(server: Server): void {
      server.on('upgrade', (req, socket, head) => {
        const pageId = pageIdFromPath(req.url, '/api/voice/out');
        const path = (req.url ?? '').split('?')[0]?.replace(/\/+$/, '') ?? '';
        if (path === '/api/voice/audio') {
          audioWss.handleUpgrade(req, socket, head, (ws) => audioWss.emit('connection', ws, req));
        } else if (pageId) {
          pageWss.handleUpgrade(req, socket, head, (ws) => pageWss.emit('connection', ws, req, pageId));
        } else {
          // Node won't close an unhandled upgrade socket on its own — destroy it, or it sits half-open forever.
          socket.destroy();
        }
      });

      idleSweep = setInterval(() => {
        const cutoff = Date.now() - IDLE_TEARDOWN_MS;
        for (const entry of [...live.values()]) {
          if (entry.lastAudioAt < cutoff) {
            logger.system(`Voice: bot ${entry.botId} idle, tearing down`);
            void endMeeting(entry.botId);
          }
        }
      }, IDLE_SWEEP_MS);
      idleSweep.unref();

      logger.plain('Voice participant ready — POST /api/voice/meetings { meeting_url }');
    },

    async stop(): Promise<void> {
      if (idleSweep) {
        clearInterval(idleSweep);
        idleSweep = null;
      }
      await Promise.all([...live.keys()].map((botId) => endMeeting(botId)));
      // close() only stops accepting NEW sockets; established ones outlive it.
      for (const ws of audioSockets) ws.close();
      audioSockets.clear();
      audioWss.close();
      pageWss.close();
    },
  };
}
