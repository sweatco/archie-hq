/**
 * Recall connector — Archie as an ordinary meeting participant (Zoom, Meet, Teams via Recall.ai).
 * Implements {@link VoiceTransport} for the conversation in `meeting.ts`.
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

import { logger } from '../system/logger.js';
import { createRecallClient } from './recall.js';
import { createAudioOutHub, renderPage } from './audio-out.js';
import { createMeeting, isArchie, type Meeting } from './meeting.js';
import { buildCapabilitySummary } from './capabilities.js';
import { BOT_NAME } from './types.js';
import type { MeetingHost, Participant, VoiceConfig, VoiceTransport } from './types.js';
import {
  createTaskHost,
  registerLiveMeeting,
  unregisterLiveMeeting,
  reserveMeetingSlot,
  releaseMeetingSlot,
  getLiveMeeting,
  notifyMeetingEnded,
  linkRecallChannel,
  endRecallChannel,
  writeMeetingMetadataStart,
  updateMeetingParticipantsLive,
  completeMeetingMetadata,
  recordMeetingCapabilities,
} from './task-binding.js';
import type { LiveMeetingParticipant } from '../types/task.js';
import { registerChannelDeliverer } from '../tasks/channel-delivery.js';
import { deliverToRecallChannel, renderRecallChannel } from './channel-delivery.js';
import { registerConnectorPmTools } from '../agents/connector-tools.js';
import { createRecallPmToolsServer, type MeetingOps } from './pm-tools.js';

export interface RecallLifecycle {
  /** Call once the HTTP server exists. */
  attach(server: Server): void;
  stop(): Promise<void>;
}

export type StartMeetingResult = { ok: true; botId: string } | { ok: false; reason: string };

export type StopMeetingResult = { ok: true } | { ok: false; reason: string };

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
  /** Absent for the manual, unbound entry point. `url`/`joinedAt` cached here so metadata.json's teardown write skips a second round trip. */
  binding?: { taskId: string; host: MeetingHost; url: string; joinedAt: string };
  /** Keyed by Recall's opaque participant id — a rejoin gets a fresh id, a new entry, not resumed. Humans only: `isArchie` filters our join/leave. */
  participants: Map<string, LiveParticipantState>;
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
 * Statuses (`status_changes[].code`, bare — no `bot.` prefix, unlike webhook names) proving no more audio can reach this bot:
 *   - `call_ended` — bot left the call; ordinary end.
 *   - `done` — shutdown complete; always follows `call_ended`.
 *   - `fatal` — bot errored out; terminal even mid-meeting, since Archie can't return without a fresh join.
 * Closed "certainly out" set on purpose: an unfamiliar code leaves the meeting live — late, never a wrong early ending.
 */
const TERMINAL_BOT_STATUSES = new Set(['call_ended', 'done', 'fatal']);

/**
 * How often we ask Recall whether each live bot is still in its call. Recall decides the ending — it pulls the bot out on `everyone_left_timeout` (see `recall.ts`) or on a fatal error; this poll is how the engine finds out and releases the Deepgram sockets, Meeting closure and metadata write behind it.
 * Recall's own ledger lags its audio by a few seconds (observed: socket closed 11:44:40, `call_ended` landed 11:44:43), so a 30s tick costs at most that plus one interval.
 */
const STATUS_POLL_MS = 30_000;

export function mountRecallConnector(app: Application, cfg: VoiceConfig): RecallLifecycle {
  const recall = createRecallClient(cfg);
  const audioOut = createAudioOutHub();
  const live = new Map<string, LiveMeeting>();
  const audioSockets = new Set<WebSocket>();
  let statusPoll: NodeJS.Timeout | null = null;
  // One tick at a time: a slow round of GETs must not stack with the next tick's.
  let polling = false;

  const router = express.Router();
  router.use(express.json());

  // Keyed by our own page id, not the bot id — see LiveMeeting.pageId.
  router.get('/page/:pageId', (req: Request, res: Response) => {
    const pageId = req.params.pageId as string;
    const wsUrl = `${cfg.publicUrl.replace(/^http/, 'ws')}/api/voice/out/${pageId}`;
    res.type('html').send(renderPage(pageId, wsUrl));
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
        botName: BOT_NAME,
        audioWsUrl: `${cfg.publicUrl.replace(/^http/, 'ws')}/api/voice/audio`,
        pageUrl: `${cfg.publicUrl}/api/voice/page/${pageId}`,
      });

      const host = taskId === undefined ? undefined : createTaskHost(taskId, botId, endMeeting);

      const transport: VoiceTransport = {
        // bot id, not page id: it outlives every socket in the call — the stable key for the activation log.
        sessionId: botId,
        sink: audioOut.sinkFor(pageId),
        sendChat: (text) => recall.sendChat(botId, text),
      };
      const meeting = createMeeting(cfg, transport, host);
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
        binding,
        participants: new Map(),
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
        void buildCapabilitySummary(cfg, binding.taskId).then((summary) => {
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

  /** `leave_recall_meeting` names a task, not a bot; the live registry is what turns one into the other. */
  async function stopForTask(taskId: string): Promise<StopMeetingResult> {
    const meeting = getLiveMeeting(taskId);
    if (meeting === undefined) {
      return { ok: false, reason: 'No meeting is live on this task.' };
    }
    // Awaited to completion, unlike MeetingHost.leaveMeeting: a PM tool can afford to say "ended" only once it is.
    await endMeeting(meeting.sessionId);
    return { ok: true };
  }

  const ops: MeetingOps = {
    start: (taskId, meetingUrl) => startMeeting(meetingUrl, taskId),
    stop: stopForTask,
  };

  // Registered at mount, not always: if Recall isn't configured, the PM never sees these tools rather than sees them fail.
  registerChannelDeliverer('recall', deliverToRecallChannel, renderRecallChannel);
  registerConnectorPmTools('recall-tools', (agent, task) => createRecallPmToolsServer(agent, task, ops));

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

  /**
   * The single teardown funnel: the explicit routes (a spoken `LEAVE:`, `leave_recall_meeting`, `DELETE /meetings/:botId`, shutdown) and the status poll all come through here.
   * The `live.delete` above the first `await` is what makes that safe — whichever route arrives first, the rest find nothing to do.
   */
  async function endMeeting(botId: string): Promise<void> {
    const entry = live.get(botId);
    live.delete(botId);
    if (entry) {
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
   * Parsed here so `meeting.ts` never sees the wire shape. A frame that is unparseable, unattributed or for a bot no longer live is dropped.
   */
  function handleAudioMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const m = msg as {
      event?: string;
      data?: { data?: Record<string, unknown>; bot?: { id?: string } };
    };

    const botId = m.data?.bot?.id;
    const entry = botId ? live.get(botId) : undefined;
    if (!entry) return;

    const d = m.data?.data ?? {};

    if (m.event === 'audio_separate_raw.data') {
      const raw64 = typeof d.buffer === 'string' ? d.buffer : '';
      const participant = parseParticipant(d.participant);
      // Belt-and-suspenders: Recall excludes our audio by default, but a slip-through would fire barge-in on it.
      if (raw64.length > 0 && !isArchie(participant.name)) {
        entry.meeting.onAudio(participant, Buffer.from(raw64, 'base64'));
      }
    } else if (m.event === 'participant_events.join') {
      handleParticipantJoin(entry, parseParticipant(d.participant));
    } else if (m.event === 'participant_events.leave') {
      handleParticipantLeave(entry, parseParticipant(d.participant));
    }
    // Anything else is ignored (see the "ignores frames it cannot place" test).
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

  /** Replaces, not duplicates, a repeat `.join` for the id — a malformed/duplicate event can't invent a second occupant. */
  function handleParticipantJoin(entry: LiveMeeting, participant: Participant): void {
    if (isArchie(participant.name)) return;
    entry.participants.set(participant.id, {
      name: participant.name,
      isHost: participant.isHost,
      joinedAt: new Date().toISOString(),
      leftAt: null,
    });
    persistLiveParticipants(entry);
    pushLiveParticipants(entry);
  }

  /**
   * Closes the entry (`LiveParticipantState`) rather than removing it, so a departure keeps both of its timestamps. An orphaned leave — one with no join this connector ever witnessed — is still recorded, with `joinedAt: null`.
   *
   * Records only: whether the room has emptied is Recall's call, not this roster's (`everyone_left_timeout` in `recall.ts`).
   */
  function handleParticipantLeave(entry: LiveMeeting, participant: Participant): void {
    if (isArchie(participant.name)) return;
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
  }

  /**
   * One tick of the status poll: asks Recall about each live bot and ends the meetings it reports out of the call.
   * A failed GET leaves that meeting live — a network error is not an ending, and the next tick asks again.
   */
  async function pollBotStatuses(): Promise<void> {
    for (const entry of [...live.values()]) {
      let codes: string[];
      try {
        codes = (await recall.getBotDetails(entry.botId)).statusChanges.map((s) => s.code);
      } catch (error) {
        logger.warn('voice', `Could not ask Recall whether bot ${entry.botId} is still in its call — leaving the meeting live`, error);
        continue;
      }
      // Checks ANY terminal code, not just the last — a bot never rejoins, so a later non-terminal entry (post-processing, breakout room) can't un-terminal it.
      const terminal = codes.find((code) => TERMINAL_BOT_STATUSES.has(code));
      if (terminal !== undefined) {
        logger.system(`Voice: bot ${entry.botId} — Recall reports "${terminal}", ending the meeting`);
        await endMeeting(entry.botId);
      }
    }
  }

  /** Triggered by the output page connecting, not first audio — waiting for a human to speak first is backwards. */
  function greetOnce(entry: LiveMeeting): void {
    if (!entry.greeted) {
      entry.greeted = true;
      void recall
        .sendChat(
          entry.botId,
          `Hi, I'm ${BOT_NAME}. I'm listening to this meeting — say my name and I'll chime in.`,
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
    ws.on('message', (data) => {
      // A throw here would take down the process, so the audio path is sealed.
      try {
        handleAudioMessage(data.toString());
      } catch (error) {
        logger.error('voice', 'Audio handling failed', error);
      }
    });
    // A close says nothing about the call: a blip and a real ending look identical here, and the socket carries no bot id anyway. The status poll is what decides.
    ws.on('close', () => {
      audioSockets.delete(ws);
      logger.system('Voice: Recall audio socket closed');
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

      statusPoll = setInterval(() => {
        if (!polling) {
          polling = true;
          void pollBotStatuses().finally(() => {
            polling = false;
          });
        }
      }, STATUS_POLL_MS);
      // unref'd — must not keep the process alive on its own.
      statusPoll.unref();

      logger.plain('Voice participant ready — POST /api/voice/meetings { meeting_url }');
    },

    async stop(): Promise<void> {
      if (statusPoll) {
        clearInterval(statusPoll);
        statusPoll = null;
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
