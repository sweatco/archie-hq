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
import { appendFile, mkdir } from 'node:fs/promises';
import type { IncomingMessage, Server } from 'node:http';
import { join } from 'node:path';
import type { Application, Request, Response } from 'express';
import { createRequire } from 'module';
import { WebSocketServer, type WebSocket } from 'ws';

const require = createRequire(import.meta.url);
const express = require('express');

import { logger } from '../system/logger.js';
import { WORKDIR } from '../system/workdir.js';
import { createRecallClient } from './recall.js';
import { createAudioOutHub, renderPage } from './audio-out.js';
import { createMeeting, isArchie, type Meeting } from './meeting.js';
import { buildCapabilitySummary } from './capabilities.js';
import { BOT_NAME } from './types.js';
import type { MeetingHost, MeetingRow, MeetingRowParticipant, Participant, RosterEntry, VoiceConfig, VoiceTransport } from './types.js';
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
} from './task-binding.js';
import { appendMeetingRow } from '../tasks/persistence.js';
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

/** Mirrors `RosterEntry` (`src/voice/types.ts`) in camelCase; `snapshotLiveParticipants` converts back. */
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
  /** This meeting's own row writer, the same one its transport carries — teardown records `ended` through it after the `Meeting` is gone. */
  record: (row: MeetingRow) => void;
  /** Absent for the manual, unbound entry point. */
  binding?: { taskId: string; host: MeetingHost };
  /** Keyed by Recall's opaque participant id — a rejoin gets a fresh id, a new entry, not resumed. Humans only: `isArchie` filters our join/leave. */
  participants: Map<string, LiveParticipantState>;
  /** The last (platform, title) pair a `details` row recorded, so the poll appends one only when it changes. */
  details?: { platform: string | null; title: string | null };
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

/** Where an unbound meeting's rows land: no task folder to write into, but a manual test should still leave a record. Sanitised because this becomes a filename — a path separator from an API response must not escape the directory. */
function unboundRecordPath(sessionId: string): string {
  return join(WORKDIR, 'voice-logs', `${sessionId.replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`);
}

/**
 * This meeting's row writer, the whole of `VoiceTransport.record`.
 *
 * One chain per meeting, so two rows settling at once cannot interleave. The `catch` is what puts the chain back in a resolved state: without it, one failed append would skip every row after it.
 */
function createRecorder(sessionId: string, taskId: string | undefined): (row: MeetingRow) => void {
  let chain: Promise<void> = Promise.resolve();
  return (row: MeetingRow): void => {
    chain = chain
      .then(async () => {
        if (taskId === undefined) {
          const path = unboundRecordPath(sessionId);
          await mkdir(join(WORKDIR, 'voice-logs'), { recursive: true });
          await appendFile(path, `${JSON.stringify(row)}\n`, 'utf8');
        } else {
          await appendMeetingRow(taskId, sessionId, row);
        }
      })
      .catch((error) => {
        logger.warn('voice', `Could not record a "${row.type}" row for meeting ${sessionId}`, error);
      });
  };
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
 * How often we ask Recall whether each live bot is still in its call. Recall decides the ending — it pulls the bot out on `everyone_left_timeout` (see `recall.ts`) or on a fatal error; this poll is how the engine finds out and releases the Deepgram sockets, Meeting closure and closing `ended` row behind it.
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
      const record = createRecorder(botId, taskId);

      const transport: VoiceTransport = {
        // bot id, not page id: it outlives every socket in the call — the stable key for this meeting's own record.
        sessionId: botId,
        sink: audioOut.sinkFor(pageId),
        sendChat: (text) => recall.sendChat(botId, text),
        record,
      };
      // The record's opening line, carrying the URL nothing else in it repeats.
      record({ at: new Date().toISOString(), type: 'started', url: meetingUrl, bot_id: botId });
      const meeting = createMeeting(cfg, transport, host);
      const binding = taskId !== undefined && host !== undefined ? { taskId, host } : undefined;
      live.set(botId, {
        botId,
        pageId,
        meeting,
        greeted: false,
        record,
        binding,
        participants: new Map(),
      });

      if (binding !== undefined) {
        registerLiveMeeting(binding.taskId, meeting);
        // Kept on the task after the meeting ends; awaited since there's no hot-path latency here.
        await linkRecallChannel(binding.taskId, botId, meetingUrl);
        // Points at the record, not the URL — knowledge.log is an index the PM reads every turn.
        binding.host.noteEvent(`meeting started — recall/${botId}/`);
        // Deliberately unawaited — awaiting would hold this live meeting behind the model's latency.
        void buildCapabilitySummary(cfg, binding.taskId).then((summary) => {
          meeting.setCapabilities(summary);
          // Trimmed to match byte-for-byte what `setCapabilities` sends the model, so a whitespace-only summary records as the empty block the meeting actually ran with.
          record({ at: new Date().toISOString(), type: 'capabilities', text: summary.trim() });
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
   * The single teardown funnel: the explicit routes (a spoken `LEAVE:`, `leave_recall_meeting`, `DELETE /meetings/:botId`, shutdown) and the status poll all come through here.
   * The `live.delete` above the first `await` is what makes that safe — whichever route arrives first, the rest find nothing to do.
   *
   * `callEndedAt` is Recall's own `call_ended` timestamp, which only the status poll has already read; every other route ends the meeting without asking, and records that honestly as `null`.
   */
  async function endMeeting(botId: string, callEndedAt?: string): Promise<void> {
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
      // After `stop()`, so the writer's chain puts it behind whatever the last turn recorded.
      entry.record({ at: new Date().toISOString(), type: 'ended', call_ended_at: callEndedAt ?? null });
      if (entry.binding !== undefined) {
        entry.binding.host.noteEvent(`meeting ended — recall/${botId}/`);
        // Fire-and-forget — an awaited wake-up that hung would hang `stop()`'s whole batch.
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

  /** This meeting's live-accumulated roster, in join order, as the conversation takes it. */
  function snapshotLiveParticipants(entry: LiveMeeting): RosterEntry[] {
    return [...entry.participants.values()].map((p) => ({
      name: p.name,
      is_host: p.isHost,
      joined_at: p.joinedAt,
      left_at: p.leftAt,
    }));
  }

  /**
   * `meeting.ts`'s map only sees who's spoken (`onAudio`); Recall omits muted participants, so this join/leave roster shows the agent four in the room, three muted.
   * The roster the model sees is in memory only — the record keeps the `join`/`leave` rows it was built from, and a reader reconstructs presence from those.
   */
  function pushLiveParticipants(entry: LiveMeeting): void {
    try {
      entry.meeting.updateParticipants(snapshotLiveParticipants(entry));
    } catch (error) {
      // Must not throw — runs from the audio socket handler; losing the roster costs context, not voice.
      logger.warn('voice', `Could not hand the roster to meeting ${entry.botId}`, error);
    }
  }

  /** The row shape for a join or a leave; Recall's own participant id rides along, so a rejoin under a fresh id reads as the separate visit it is. */
  function participantRow(participant: Participant): MeetingRowParticipant {
    return { id: participant.id, name: participant.name, is_host: participant.isHost };
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
    entry.record({ at: new Date().toISOString(), type: 'join', participant: participantRow(participant) });
    pushLiveParticipants(entry);
  }

  /**
   * Closes the entry (`LiveParticipantState`) rather than removing it, so the in-memory roster keeps a departure's both timestamps. An orphaned leave — one with no join this connector ever witnessed — is still recorded, with `joinedAt: null`.
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
    entry.record({ at: now, type: 'leave', participant: participantRow(participant) });
    pushLiveParticipants(entry);
  }

  /** Recall produces a title asynchronously once the bot is in the call, so a row goes down only when the pair actually changes — usually one on the first tick and at most one more when the title lands. */
  function recordDetails(entry: LiveMeeting, platform: string | null, title: string | null): void {
    if (entry.details?.platform === platform && entry.details?.title === title) return;
    entry.details = { platform, title };
    entry.record({ at: new Date().toISOString(), type: 'details', platform, title });
  }

  /**
   * One tick of the status poll: asks Recall about each live bot, records what it says the occasion is, and ends the meetings it reports out of the call.
   * A failed GET leaves that meeting live — a network error is not an ending, and the next tick asks again.
   */
  async function pollBotStatuses(): Promise<void> {
    for (const entry of [...live.values()]) {
      let bot: Awaited<ReturnType<typeof recall.getBotDetails>>;
      try {
        bot = await recall.getBotDetails(entry.botId);
      } catch (error) {
        logger.warn('voice', `Could not ask Recall whether bot ${entry.botId} is still in its call — leaving the meeting live`, error);
        continue;
      }
      recordDetails(entry, bot.platform, bot.title);
      // Checks ANY terminal code, not just the last — a bot never rejoins, so a later non-terminal entry (post-processing, breakout room) can't un-terminal it.
      const terminal = bot.statusChanges.find((s) => TERMINAL_BOT_STATUSES.has(s.code));
      if (terminal !== undefined) {
        logger.system(`Voice: bot ${entry.botId} — Recall reports "${terminal.code}", ending the meeting`);
        // `call_ended`, not `done`: the moment the call ended, where `done` marks Recall's later post-processing. Absent for a `fatal` with no `call_ended` before it.
        await endMeeting(entry.botId, bot.statusChanges.find((s) => s.code === 'call_ended')?.createdAt);
      }
    }
  }

  /** Triggered by the output page connecting, not first audio — waiting for a human to speak first is backwards. */
  function greetOnce(entry: LiveMeeting): void {
    if (!entry.greeted) {
      entry.greeted = true;
      void recall.sendChat(
        entry.botId,
        `Hi, I'm ${BOT_NAME}. I'm listening to this meeting — say my name and I'll chime in.`,
      );
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
