
import { logger } from '../system/logger.js';
// Aliased on import -- `Response` is also a global here (undici's).
import {
  decideResponse,
  wasAddressed,
  type Decision,
  type Response as SpokenResponse,
  type SpeakingContext,
} from './comprehension.js';
import { openTurnStream, type TurnEvent, type TurnStream } from './deepgram.js';
import { createSonioxSpeechSession } from './soniox.js';
import { BOT_NAME } from './types.js';
import type {
  MeetingHost,
  MeetingRow,
  MeetingTurnTimings,
  Participant,
  RosterEntry,
  SpeechSession,
  SpeechStream,
  Utterance,
  VoiceConfig,
  VoiceTransport,
  WrittenLine,
} from './types.js';

const LOG = 'voice-meeting';

// 3h backstop, well within Cerebras' 131,072-token context -- a meeting's full context (transcript, prompt, written exchange) measures ~40k tokens (~31%) worst case.
const TRANSCRIPT_WINDOW_MS = 3 * 60 * 60 * 1000;

// Short, unlike SPEAKING_WINDOW_MS: widening it only adds chances to catch the name in an unaimed sentence and misfire -- voice-addressing.md treats false positives as the worst outcome.
const ADDRESSING_WINDOW_MS = 60 * 1000;

// = TRANSCRIPT_WINDOW_MS: costs ~nothing extra -- time-to-first-byte is flat against input size (+2.3ms per 1000 tokens, R² = 0.000 across 156 samples).
const SPEAKING_WINDOW_MS = TRANSCRIPT_WINDOW_MS;


const RETRY_FLOOR_MS = 2 * 1000;

const FOLLOW_UP_GRACE_MS = 10 * 1000;

// Fires after the follow-up window closes, not on the boundary tick (`isFollowUpAnchor`'s `>=` still reads it as live) -- else the engagement tile sticks green for the rest of the meeting, the bug `setEngaged` fixes.
const LAPSE_MARGIN_MS = 50;

// Zoom issues a new participant id on rejoin -- without reaping, a reconnect or blip leaves the old stream open, billed by Deepgram for silence.
const STREAM_IDLE_MS = 2 * 60 * 1000;

const STREAM_REAP_INTERVAL_MS = 30 * 1000;

// Flux's `eot_timeout_ms` defaults to 5000ms, so a feed still delivering audio resolves its turn within ~5s -- 10s of total silence can only mean a dead connection, never a live pause.
// Needed because `isTurnOpen()` clears only on an EndOfTurn event and an idle Flux connection sends none -- measured: 20 minutes silent, still reporting `Connected`.
const FLOOR_LIVENESS_MS = 10 * 1000;

const REOPEN_BACKOFF_MS = 15 * 1000;

// `openTurnStream` fails asynchronously, so a rejected key or blocked host shows as a stream dying right after every open -- without this floor, that reconnects at packet rate, tens per second per speaker.
const REOPEN_MIN_INTERVAL_MS = 2 * 1000;

// Matching is whole-token (see `matchTrigger`): a prefix like `arch` is harmless (never fires on `architecture`), but a real word like `art`/`archive` would fire constantly -- check any addition against that.
export const TRIGGER_VARIANTS: readonly string[] = [
  'archie',
  'archi',
  'archy',
  'arche',
  'artie',
  'arjy',
  'r.j.',
  'rj',
  'арчи',
  'арчик',
];

// Unicode-aware split (`\p{L}`/`\p{N}`), not `\b`: ASCII-only, never bounds a Cyrillic letter (`/\bарчи\b/u` matches nothing). NFKC first folds width/decomposition variants to the same tokens.
function tokenize(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

function containsSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) {
    return false;
  }
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let matchedAll = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        matchedAll = false;
        break;
      }
    }
    if (matchedAll) {
      return true;
    }
  }
  return false;
}

interface CompiledPhrase {
  raw: string;
  tokens: string[];
}

const compiledPhrases = new WeakMap<readonly string[], CompiledPhrase[]>();

function compilePhrases(phrases: readonly string[]): CompiledPhrase[] {
  const cached = compiledPhrases.get(phrases);
  if (cached) {
    return cached;
  }
  const built = phrases
    .map((raw) => ({ raw, tokens: tokenize(raw) }))
    .filter((phrase) => phrase.tokens.length > 0);
  compiledPhrases.set(phrases, built);
  return built;
}

export function matchTrigger(
  text: string,
  variants: readonly string[] = TRIGGER_VARIANTS,
): string | null {
  const tokens = tokenize(text);
  for (const variant of compilePhrases(variants)) {
    if (containsSequence(tokens, variant.tokens)) {
      return variant.raw;
    }
  }
  return null;
}

// Exported rather than folded into `isSelf` below -- a connector needs this same check before any `Meeting` exists to ask it.
export function isArchie(name: string | null): boolean {
  if (name === null) return false;
  return tokenize(name).join(' ') === tokenize(BOT_NAME).join(' ');
}

// One speaking decision's row, built field by field as the turn settles and recorded once, in `decide()`'s `finally`.
type TurnRecord = Extract<MeetingRow, { type: 'turn' }>;

// One addressing decision's row. Recorded the moment its tier settles -- never held for the decision behind it, which may never run at all.
type GateRecord = Extract<MeetingRow, { type: 'gate' }>;

interface ParticipantState {
  id: string;
  name: string;
  stream: TurnStream | null;
  reopenAfter: number;
  lastAudioAt: number;
  staleFloorLogged: boolean;
}

export interface Meeting {
  // Recall's bot id. A channel deliverer checks it against a `RecallChannel`'s `session_id` before delivering (voice/channel-delivery.ts) -- that check, not this field alone, stops a stale channel reaching a different meeting live on the same task.
  readonly sessionId: string;
  onAudio(p: Participant, pcm: Buffer): void;
  // Inbound only: Recall sends no audio for a muted participant, so `onAudio`-only state can't see the whole room. Whole roster each call, not a delta, so a transport missing one event self-corrects on the next.
  updateParticipants(participants: readonly RosterEntry[]): void;
  setCapabilities(summary: string): void;
  deliverConsultAnswer(text: string, from?: 'pm-agent' | 'system'): { ok: true; id: string } | { ok: false };
  // Await before finalising anything else -- a turn mid-answer holds a model call, and this waits it out (bounded by its own timeout, ~15s worst case).
  stop(): Promise<void>;
}

let meetingSeq = 0;

export function createMeeting(cfg: VoiceConfig, transport: VoiceTransport, host?: MeetingHost): Meeting {
  const { sessionId, sink, sendChat, record } = transport;
  // Captured before anything else per-meeting; see nextConsultId for why order matters.
  const meetingOrdinal = ++meetingSeq;

  const transcript: Utterance[] = [];
  const participants = new Map<string, ParticipantState>();

  const selfByName = new Map<string, boolean>();

  interface Consult {
    id: string;
    at: number;
    question: string;
    // Holds a real PM answer, or (if `routeConsult` refuses to send it) a parenthesised note that it never left -- same field, so a refused question doesn't read to the model as still pending.
    answer?: string;
    answeredAt?: number;
  }
  const consults: Consult[] = [];
  let consultSeq = 0;
  let lastConsultAnswerAt = 0;

  let roster: RosterEntry[] = [];
  let capabilities = '';
  const chatPosts: WrittenLine[] = [];

  let owes = false;

  // Not `transcript.length`: that shrinks as the window slides, not a reliable freshness marker across an await.
  let transcriptRevision = 0;

  let deciding = false;

  // A second handle on the same fact as `deciding` -- `stop()` awaits the last turn finishing, which a boolean can't answer.
  let turnChain: Promise<void> = Promise.resolve();

  // Lets `stop()` reach into a turn already awaiting a model call or synthesis; set only while one is in flight.
  let abandonTurn: ((why: string) => void) | null = null;

  let cutRevision = 0;

  let followUpTimer: NodeJS.Timeout | null = null;

  let retryAfter = 0;
  let retryTimer: NodeJS.Timeout | null = null;

  let floorTimer: NodeJS.Timeout | null = null;

  let voiceFailureAnnounced = false;
  let stopped = false;

  // Opened eagerly so its connection cost isn't paid in front of the first word; null only if opening threw -- then every answer goes through `answerWithoutVoice`.
  let speech: SpeechSession | null = null;
  try {
    speech = createSonioxSpeechSession(cfg);
  } catch (err) {
    logger.error(LOG, 'Could not open the speech session — nothing can be spoken', err);
  }


  function newGateRow(speaker: string, candidate: string, tier: GateRecord['tier']): GateRecord {
    return { at: new Date().toISOString(), type: 'gate', speaker, candidate, tier, addressed: false };
  }

  function recordTiming(row: TurnRecord, key: keyof MeetingTurnTimings, ms: number): void {
    row.timings = { ...row.timings, [key]: ms };
  }

  // `null` means no sentence was confirmed heard, which `speech: ''` says exactly.
  function recordHeard(row: TurnRecord, heard: string | null): void {
    row.speech = heard ?? '';
  }


  function addUtterance(speaker: string, text: string): void {
    const at = Date.now();
    transcript.push({ at, speaker, text });
    transcriptRevision++;
    record({ at: new Date(at).toISOString(), type: 'utterance', speaker, text });
    retryAfter = 0;
    const cutoff = at - TRANSCRIPT_WINDOW_MS;
    while (transcript.length > 0 && transcript[0].at < cutoff) {
      transcript.shift();
    }
  }

  function transcriptSince(windowMs: number): string {
    const cutoff = Date.now() - windowMs;
    return transcript
      .filter((utterance) => utterance.at >= cutoff)
      .map((utterance) => `${utterance.speaker}: ${utterance.text}`)
      .join('\n');
  }

  // Copied, not referenced: the snapshot outlives the model call it was built for, and a roster replaced mid-call mustn't change what was already sent.
  function speakingContext(exchange: readonly WrittenLine[]): SpeakingContext {
    const context: SpeakingContext = {};
    if (roster.length > 0) {
      context.participants = [...roster];
    }
    const written = [...exchange, ...chatPosts];
    if (written.length > 0) {
      context.written = written;
    }
    if (capabilities.length > 0) {
      context.capabilities = capabilities;
    }
    return context;
  }

  async function safeReadWrittenExchange(): Promise<WrittenLine[]> {
    try {
      return (await host?.readWrittenExchange()) ?? [];
    } catch (err) {
      logger.warn(LOG, 'Reading the task written exchange failed — this turn runs without it', err);
      return [];
    }
  }

  function isFollowUpAnchor(utterance: Utterance | undefined, graceMs: number): boolean {
    return (
      utterance !== undefined &&
      utterance.speaker === BOT_NAME &&
      utterance.at >= Date.now() - graceMs
    );
  }

  function spokeLastWithin(graceMs: number): boolean {
    return isFollowUpAnchor(transcript.at(-2), graceMs);
  }

  function followUpWindowLive(): boolean {
    return isFollowUpAnchor(transcript.at(-1), FOLLOW_UP_GRACE_MS);
  }

  function noteOwnAnswer(text: string): void {
    addUtterance(BOT_NAME, text);
    if (followUpTimer !== null) {
      clearTimeout(followUpTimer);
    }
    followUpTimer = setTimeout(() => {
      followUpTimer = null;
      applyEngagement();
    }, FOLLOW_UP_GRACE_MS + LAPSE_MARGIN_MS);
    followUpTimer.unref();
  }

  // `roomSpokeSince` must be read before `addUtterance` runs -- that bumps `transcriptRevision` itself, our own line included.
  function fileConfirmedLine(text: string, revision: number): void {
    const roomSpokeSince = transcriptRevision !== revision;
    addUtterance(BOT_NAME, text);
    if (!roomSpokeSince) {
      retryAfter = Date.now() + RETRY_FLOOR_MS;
    }
  }

  // The only record of these lines: they leave through the transport's chat channel, reaching neither the room's speech nor knowledge.log. The `chat` row below isn't a convenience copy -- without it, they're gone.
  function noteOwnChat(chat: string | undefined): void {
    if (chat !== undefined) {
      const text = sanitizeForLog(chat);
      if (text.length > 0) {
        chatPosts.push({ speaker: BOT_NAME, text });
        record({ at: new Date().toISOString(), type: 'chat', speaker: BOT_NAME, text });
      }
    }
  }

  // Not called on barge-in -- being cut off doesn't settle the debt, so the tile keeps showing Archie is still on the hook.
  function applyEngagement(): void {
    safeSetEngaged(!stopped && (owes || followUpWindowLive()));
  }


  // A stream that throws counts as not holding the floor -- a broken connection must not veto Archie speaking for the rest of the meeting.
  function anyTurnOpen(): boolean {
    const liveSince = Date.now() - FLOOR_LIVENESS_MS;
    for (const state of participants.values()) {
      if (state.stream !== null) {
        try {
          if (!state.stream.isTurnOpen()) {
          } else if (state.lastAudioAt >= liveSince) {
            return true;
          } else if (!state.staleFloorLogged) {
            state.staleFloorLogged = true;
            logger.warn(
              LOG,
              `${state.name} (#${state.id}) has an open turn but has sent no audio for ` +
              `${Math.round((Date.now() - state.lastAudioAt) / 1000)}s — ignoring their claim on the floor`,
            );
          }
        } catch (err) {
          logger.warn(LOG, `Could not read ${state.name}'s turn state — assuming silence`, err);
        }
      }
    }
    return false;
  }

  // Load-bearing, not defensive: with the settle delay gone, this check and the identical one on the first audio chunk are all that stops Archie talking over somebody.
  function roomMovedOn(revision: number): boolean {
    return transcriptRevision !== revision || anyTurnOpen();
  }

  function maybeDecide(): void {
    if (!owes || stopped) {
    } else if (anyTurnOpen()) {
      scheduleFloorCheck();
    } else if (deciding) {
    } else if (Date.now() < retryAfter) {
      scheduleRetry(retryAfter - Date.now());
    } else {
      turnChain = decide().catch((err) => {
        logger.error(LOG, 'The speaking decision rejected unexpectedly', err);
      });
    }
  }

  // The one poll in an otherwise event-driven design -- a stuck participant's audio simply stops, firing no turn-end event to return here.
  function scheduleFloorCheck(): void {
    if (floorTimer === null) {
      floorTimer = setTimeout(() => {
        floorTimer = null;
        maybeDecide();
      }, FLOOR_LIVENESS_MS + LAPSE_MARGIN_MS);
      floorTimer.unref();
    }
  }

  function scheduleRetry(delayMs: number): void {
    if (retryTimer === null) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        maybeDecide();
      }, delayMs);
      retryTimer.unref();
    }
  }


  function setOwed(why: string): void {
    if (!owes) {
      owes = true;
      logger.debug(LOG, `Archie owes the room a response — ${why}`);
    }
    // Runs even when the flag was already set -- the addressing gate's verdict often lands after the turn end that would have triggered a decision; skipping this loses that activation silently.
    applyEngagement();
    maybeDecide();
  }

  // Compares against `lastConsultAnswerAt` rather than clearing unconditionally -- a consult answer raises the debt without touching `transcriptRevision` or opening a turn, so an unrelated in-flight `decide()` must not discard it on settling.
  function clearOwed(askedAt: number): void {
    if (lastConsultAnswerAt <= askedAt) {
      owes = false;
    }
  }

  // The row is recorded before `setOwed`, never after -- that can run the whole decision synchronously, and the record reads in settle order.
  function decideOwing(speaker: string, text: string): void {
    const matched = matchTrigger(text);
    if (matched !== null) {
      const row = newGateRow(speaker, text, 'name');
      row.matched = matched;
      row.addressed = true;
      record(row);
      setOwed(`${speaker} said the name`);
    } else if (spokeLastWithin(FOLLOW_UP_GRACE_MS)) {
      const row = newGateRow(speaker, text, 'follow-up');
      row.addressed = true;
      record(row);
      setOwed(`${speaker} replied straight after our own turn`);
    } else {
      void runAddressingGate(newGateRow(speaker, text, 'model'), text);
    }
  }

  async function runAddressingGate(row: GateRecord, text: string): Promise<void> {
    const startedAt = Date.now();
    try {
      const addressed = await wasAddressed(cfg, {
        transcript: transcriptSince(ADDRESSING_WINDOW_MS),
        utterance: text,
      });
      row.gate_ms = Date.now() - startedAt;
      row.addressed = addressed;
    } catch (err) {
      row.error = `the addressing gate threw: ${String(err)}`;
      logger.error(LOG, 'The addressing gate threw', err);
    } finally {
      record(row);
      if (row.addressed) {
        setOwed(`the addressing gate said yes to ${row.speaker}`);
      }
    }
  }


  function nextConsultId(): string {
    consultSeq += 1;
    // meetingOrdinal first -- collision-proof across concurrent meetings. Kept short to round-trip cleanly through a model's reply.
    return `m${meetingOrdinal}c${consultSeq}`;
  }

  // Invariant: at most one consult outstanding, so an answer can only pair with one question -- no id needed on the seam. A refused question (`routeConsult`) records pre-answered, so it doesn't block the next.
  function outstandingConsult(): Consult | undefined {
    return consults.find((c) => c.answer === undefined);
  }

  function consultOf(decision: Decision): string | undefined {
    if (decision.outcome === 'speak') {
      return decision.response.pm;
    } else if (decision.outcome === 'silence') {
      return decision.pm;
    } else {
      return undefined;
    }
  }

  function routeConsult(question: string | undefined): string | undefined {
    let dropped: string | undefined;
    const blocking = outstandingConsult();
    if (question === undefined) {
    } else if (stopped) {
      logger.debug(LOG, `The meeting has stopped — dropped a PM: question: ${question}`);
      dropped = 'the meeting had stopped';
    } else if (host === undefined) {
      logger.debug(LOG, `No host on this meeting — dropped a PM: question: ${question}`);
      dropped = 'this meeting has no host to ask';
    } else if (blocking !== undefined) {
      // No consult id here -- the speaking prompt has no rule for an unspeakable string like "m1c1"; the only rule that fits sends it to the room's chat.
      consults.push({
        id: nextConsultId(),
        at: Date.now(),
        question,
        answer: '(not sent — an earlier question was still unanswered, so nothing is on its way for this one)',
        answeredAt: Date.now(),
      });
      logger.warn(LOG, `A question is already outstanding (${blocking.id}) — did not ask a second: ${question}`);
      dropped = `${blocking.id} was still outstanding`;
    } else {
      const id = nextConsultId();
      consults.push({ id, at: Date.now(), question });
      record({ at: new Date().toISOString(), type: 'consult', id, question });
      host.noteEvent(`consult: ${question} — recall/${sessionId}/meeting.jsonl`);
      host.consult(id, question);
    }
    return dropped;
  }

  function routeLeave(): void {
    if (host === undefined) {
      logger.debug(LOG, 'No host on this meeting — dropped a LEAVE: request');
    } else {
      logger.system(
        `Voice meeting ${sessionId} is ending — ${BOT_NAME} asked to leave and its farewell was delivered in full`,
      );
      host.leaveMeeting();
    }
  }


  async function decide(): Promise<void> {
    deciding = true;
    const askedAt = Date.now();
    const revision = transcriptRevision;
    const speakingWindow = transcriptSince(SPEAKING_WINDOW_MS);
    // 'suppressed' is the safe default, not proof the room heard nothing -- a turn cut off mid-answer settles here too. `speech` is what was actually heard.
    const row: TurnRecord = { at: new Date().toISOString(), type: 'turn', verdict: 'suppressed' };
    try {
      await answerRoom(row, speakingWindow, askedAt, revision);
    } catch (err) {
      // Drops the debt rather than retrying -- a fault paired with a standing flag is an unbounded loop of failing model calls.
      clearOwed(askedAt);
      row.verdict = 'error';
      row.error = `the speaking decision threw: ${String(err)}`;
      logger.error(LOG, 'The speaking decision threw', err);
    } finally {
      deciding = false;
      if (owes && transcriptRevision === revision && lastConsultAnswerAt <= askedAt) {
        retryAfter = Date.now() + RETRY_FLOOR_MS;
      }
      record(row);
      applyEngagement();
      maybeDecide();
    }
  }

  function recordAnswer(row: TurnRecord, answer: SpokenResponse): void {
    row.answer = answer.speech;
    if (answer.chat !== undefined) {
      row.chat = answer.chat;
    }
    if (answer.pm !== undefined) {
      row.pm = answer.pm;
    }
    if (answer.leave === true) {
      row.leave = true;
    }
    if (answer.thought !== undefined) {
      row.thought = answer.thought;
    }
  }

  // The floor is ~935ms, not ~700ms (once assumed for token-by-token streaming): ~620ms time-to-first-byte, plus text arrives in ~313ms quanta, and the first delta (3-10 chars) is too short for a sentence to complete.
  async function answerRoom(
    row: TurnRecord,
    speakingWindow: string,
    askedAt: number,
    revision: number,
  ): Promise<void> {
    const cutAtStart = cutRevision;
    let stream: SpeechStream | null = null;
    let heardAnything = false;
    let abandoned: string | null = null;
    let firstSayAt: number | null = null;
    let decision: Decision | null = null;
    let consult: string | undefined;

    let pcmSentToSink = 0;
    const sentenceOffsets: { text: string; endOffset: number }[] = [];
    const playedBytesBaseline = sink.playedBytes();

    const confirmedHeardPrefix = (): string | null => {
      const confirmed = sink.playedBytes() - playedBytesBaseline;
      const heard = sentenceOffsets.filter((s) => s.endOffset <= confirmed);
      return heard.length === 0 ? null : heard.map((s) => s.text).join(' ');
    };

    // `abort()` stops the synthesizer server-side, not just local playback -- otherwise audio keeps arriving until the sink's post-cut suppression gives up (Recall's `MAX_SUPPRESSION_MS`, audio-out.ts), and Archie resumes mid-word over someone else.
    const abandon = (why: string): void => {
      if (abandoned === null) {
        abandoned = why;
        try {
          stream?.abort();
        } catch (err) {
          logger.warn(LOG, 'Aborting the answer failed', err);
        }
      }
    };

    const onPcm = (pcm: Buffer): void => {
      if (abandoned !== null) {
      } else if (cutRevision !== cutAtStart) {
        abandon('cut off by somebody starting to speak');
      } else if (!heardAnything && roomMovedOn(revision)) {
        abandon('the room took the floor before the first word of the answer');
      } else {
        if (!heardAnything) {
          heardAnything = true;
          recordTiming(row, 'speakMs', Date.now() - askedAt);
        }
        pcmSentToSink += pcm.length;
        safePlay(pcm);
      }
    };

    const haveSentence = (text: string): void => {
      if (abandoned !== null) {
      } else if (cutRevision !== cutAtStart) {
        abandon('cut off by somebody starting to speak');
      } else {
        if (firstSayAt === null) {
          firstSayAt = Date.now();
        }
        try {
          stream?.say(text, () => {
            sentenceOffsets.push({ text, endOffset: pcmSentToSink });
          });
        } catch (err) {
          logger.warn(LOG, 'Handing a sentence to the speech stream failed', err);
        }
      }
    };

    abandonTurn = abandon;

    try {
      if (speech !== null) {
        stream = speech.speak(onPcm);
      }

      const exchange = consults.map((c) => ({ id: c.id, question: c.question, answer: c.answer }));
      // Must stay synchronous: `speakingContext` takes the exchange rather than reading it, so an unbound meeting reaches the speaking call in the same tick -- pinned by two tests in room-silence.test.ts ("no delay in front of the decision").
      const context =
        host === undefined ? speakingContext([]) : speakingContext(await safeReadWrittenExchange());

      const startedAt = Date.now();
      decision = await decideResponse(cfg, {
        transcript: speakingWindow,
        onSentence: stream === null ? undefined : haveSentence,
        consults: exchange,
        context,
      });
      recordTiming(row, 'decideMs', Date.now() - startedAt);
      consult = consultOf(decision);

      if (decision.outcome === 'silence') {
        abandon('the model decided to say nothing');
        clearOwed(askedAt);
        row.verdict = 'suppressed';
        recordHeard(row, confirmedHeardPrefix());
        if (decision.pm !== undefined) {
          row.pm = decision.pm;
        }
        if (decision.thought !== undefined) {
          row.thought = decision.thought;
        }
        logger.debug(LOG, 'Decided to say nothing');
      } else if (decision.outcome === 'failed') {
        abandon(`the decision failed: ${decision.why}`);
        settleFailure(
          row,
          decision.why,
          decision.handedOver,
          heardAnything,
          askedAt,
          revision,
          confirmedHeardPrefix(),
        );
      } else {
        const answer = decision.response;
        recordAnswer(row, answer);
        if (stream === null) {
          answerWithoutVoice(row, answer, 'there is no speech session to say it with', askedAt);
        } else {
          if (!heardAnything && roomMovedOn(revision)) {
            abandon('the room moved on while we were deciding');
          }
          const result = await stream.end();
          if (firstSayAt !== null) {
            recordTiming(row, 'synthMs', Date.now() - firstSayAt);
          }
          if (result.msToFirstByte !== null) {
            recordTiming(row, 'ttfbMs', result.msToFirstByte);
          }
          settleAnswer(
            row,
            answer,
            heardAnything,
            abandoned,
            result.incomplete,
            askedAt,
            revision,
            confirmedHeardPrefix(),
          );
        }
      }
    } catch (err) {
      abandon(`the answer failed: ${String(err)}`);
      const answer = decision !== null && decision.outcome === 'speak' ? decision.response : null;
      if (answer === null) {
        throw err;
      } else {
        logger.error(LOG, 'Speaking failed', err);
        if (heardAnything) {
          row.error = `spoke part of the answer, then speaking threw: ${String(err)}`;
          if (row.speech === undefined) {
            recordHeard(row, confirmedHeardPrefix());
          }
        } else {
          answerWithoutVoice(row, answer, `speaking threw: ${String(err)}`, askedAt);
        }
      }
    } finally {
      abandonTurn = null;
      // The one place this turn's PM: question routes -- exactly once, whatever became of the speech (full, cut short, chat fallback, or a throw). Wrapped: a throw here would replace decide()'s own error, the only report that a turn broke.
      try {
        const dropped = routeConsult(consult);
        if (dropped !== undefined) {
          row.pm_dropped = dropped;
        }
      } catch (err) {
        logger.error(LOG, `Routing a PM: question threw — it may never have been asked: ${consult}`, err);
      }
    }
  }

  function settleFailure(
    row: TurnRecord,
    why: string,
    handedOver: number,
    heardAnything: boolean,
    askedAt: number,
    revision: number,
    confirmedPrefix: string | null,
  ): void {
    row.verdict = 'error';
    recordHeard(row, confirmedPrefix);
    if (heardAnything) {
      row.error = `spoke part of the answer, then the decision failed: ${why}`;
      logger.warn(LOG, `The decision failed after ${handedOver} sentence(s) had been spoken — ${why}`);
      if (confirmedPrefix !== null) {
        fileConfirmedLine(confirmedPrefix, revision);
      }
    } else {
      clearOwed(askedAt);
      row.error = `the decision failed: ${why}`;
      logger.debug(LOG, `Said nothing — the decision failed: ${why}`);
    }
  }

  function settleAnswer(
    row: TurnRecord,
    answer: SpokenResponse,
    heardAnything: boolean,
    abandoned: string | null,
    truncated: string | null,
    askedAt: number,
    revision: number,
    confirmedPrefix: string | null,
  ): void {
    const partial = abandoned ?? truncated;
    if (heardAnything && partial !== null) {
      row.error = `spoke part of the answer, then ${partial}`;
      logger.debug(LOG, `Interrupted mid-answer — ${partial}`);
      recordHeard(row, confirmedPrefix);
      if (confirmedPrefix !== null) {
        fileConfirmedLine(confirmedPrefix, revision);
      }
    } else if (heardAnything) {
      clearOwed(askedAt);
      row.verdict = 'addressed';
      // Reads `answer.speech` directly, not the sink's watermark -- `playedBytes` is conservative by contract and can lag a sentence behind at the moment the round closes.
      recordHeard(row, answer.speech);
      noteOwnAnswer(answer.speech);
      if (answer.chat !== undefined) {
        // Not awaited -- audio is already playing, and the room shouldn't wait on the chat channel before the next decision can run.
        void safeSendChat(answer.chat);
      }
      noteOwnChat(answer.chat);
      logger.debug(LOG, `Said: ${answer.speech}`);
      if (answer.leave === true) {
        // Only reachable here -- the farewell must be confirmed delivered in full before the meeting may act on it.
        routeLeave();
      }
    } else if (abandoned !== null) {
      row.error = `${abandoned} — reconsidering now`;
      recordHeard(row, '');
    } else {
      answerWithoutVoice(row, answer, truncated ?? 'synthesis produced no audio', askedAt);
    }
  }

  // Voice failed, so the answer goes out in writing instead -- still an error row: the room got text where it was owed speech.
  function answerWithoutVoice(row: TurnRecord, answer: SpokenResponse, why: string, askedAt: number): void {
    row.verdict = 'error';
    recordHeard(row, '');
    clearOwed(askedAt);
    row.error = `${why} — answered in the meeting chat instead`;
    noteOwnAnswer(answer.speech);
    announceVoiceUnavailableOnce();
    void safeSendChat(chatFallbackText(answer));
    noteOwnChat(answer.chat);
  }

  function chatFallbackText(answer: SpokenResponse): string {
    if (answer.chat === undefined) {
      return answer.speech;
    } else {
      return `${answer.speech}\n\n${answer.chat}`;
    }
  }


  function handleTurnEvent(state: ParticipantState, event: TurnEvent): void {
    if (event.kind === 'start') {
      onTurnStart(state);
    } else {
      onTurnEnd(state, event.transcript);
    }
  }

  // Unconditional, unclassified -- no judgement on whether they were talking to us. `owes` stays untouched: barge-in doesn't settle the debt.
  function onTurnStart(state: ParticipantState): void {
    if (safeIsSpeaking()) {
      logger.debug(LOG, `${state.name} started speaking over us — cutting`);
      cutRevision++;
      safeCut();
    }
  }

  function onTurnEnd(state: ParticipantState, text: string): void {
    const spoken = text.trim();
    if (spoken.length > 0 && !stopped) {
      addUtterance(state.name, spoken);
      if (owes) {
        // Recorded even though this turn triggers no decision of its own -- otherwise nothing says the turn was heard while a response was already owed.
        const row = newGateRow(state.name, spoken, 'already-owed');
        row.addressed = true;
        record(row);
      } else {
        decideOwing(state.name, spoken);
      }
    }
    maybeDecide();
  }


  // Strips control chars and the two Unicode line separators -- uncaught, either could forge a second attributed line (persistence.ts's `formatLogEntry` doesn't escape) or a line/closing tag inside the prompt block a name renders into.
  function sanitizeForLog(value: string): string {
    return value.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim();
  }

  function displayName(participant: Participant): string {
    const name = sanitizeForLog(participant.name?.trim() ?? '');
    return name.length > 0 ? name : `participant ${participant.id}`;
  }

  // Guards against a transport leaking our own audio back -- a self-sustaining loop of transcribing, cutting off, and answering ourselves. Cached per name: runs on every inbound packet, tens per second per speaker.
  function isSelf(participant: Participant): boolean {
    if (participant.name === null) {
      return false;
    } else {
      const cached = selfByName.get(participant.name);
      if (cached === undefined) {
        const verdict = isArchie(participant.name);
        selfByName.set(participant.name, verdict);
        return verdict;
      } else {
        return cached;
      }
    }
  }

  function openStreamFor(state: ParticipantState): TurnStream | null {
    try {
      return openTurnStream(cfg, {
        label: state.name,
        // Catches its own faults -- runs inside deepgram's socket handlers, and a throw here would unwind into that socket.
        onEvent: (event: TurnEvent) => {
          try {
            handleTurnEvent(state, event);
          } catch (err) {
            logger.error(LOG, `Failed to handle a turn event from ${state.name}`, err);
          }
        },
      });
    } catch (err) {
      state.reopenAfter = Date.now() + REOPEN_BACKOFF_MS;
      logger.error(LOG, `Could not open a turn stream for ${state.name} — retrying later`, err);
      return null;
    }
  }

  // Unlike `isTurnOpen` and `isSpeaking`, a throw here counts as *alive* -- assuming death would replace a working stream on every audio packet.
  function safeIsAlive(stream: TurnStream, name: string): boolean {
    try {
      return stream.isAlive();
    } catch (err) {
      logger.warn(LOG, `Could not read whether ${name}'s turn stream is alive`, err);
      return true;
    }
  }

  function closeStream(state: ParticipantState): void {
    if (state.stream !== null) {
      const stream = state.stream;
      state.stream = null;
      try {
        stream.close();
      } catch (err) {
        logger.warn(LOG, `Closing the turn stream for ${state.name} failed`, err);
      }
    }
  }

  function reapIdleStreams(): void {
    const cutoff = Date.now() - STREAM_IDLE_MS;
    let reaped = false;
    for (const [id, state] of participants) {
      if (state.lastAudioAt < cutoff) {
        closeStream(state);
        participants.delete(id);
        reaped = true;
        logger.debug(LOG, `Closed the idle turn stream for ${state.name} (#${id})`);
      }
    }
    if (reaped) {
      maybeDecide();
    }
  }

  function ensureParticipant(participant: Participant): ParticipantState {
    let state = participants.get(participant.id);
    if (state === undefined) {
      state = {
        id: participant.id,
        name: displayName(participant),
        stream: null,
        reopenAfter: 0,
        lastAudioAt: Date.now(),
        staleFloorLogged: false,
      };
      participants.set(participant.id, state);
      logger.debug(LOG, `New speaker on the audio stream: ${state.name} (#${participant.id})`);
    } else {
      // The name rides every packet (Recall re-sends it), so a rename follows.
      const name = displayName(participant);
      if (name !== state.name && participant.name !== null) {
        logger.debug(LOG, `Speaker #${participant.id} renamed ${state.name} → ${name}`);
        state.name = name;
      }
    }
    // A stream can die silently under us (socket drop, Deepgram rejecting the key) -- `write()` on a dead stream swallows audio: one participant goes permanently unheard while the rest transcribe normally, harder to notice than the bot going quiet.
    if (state.stream !== null && !safeIsAlive(state.stream, state.name)) {
      logger.warn(LOG, `The turn stream for ${state.name} died — reopening`);
      closeStream(state);
      maybeDecide();
    }
    if (state.stream === null && Date.now() >= state.reopenAfter) {
      // Set before the attempt -- if opening throws, the backoff still holds instead of allowing an immediate retry storm.
      state.reopenAfter = Date.now() + REOPEN_MIN_INTERVAL_MS;
      state.stream = openStreamFor(state);
    }
    return state;
  }


  function safePlay(pcm: Buffer): void {
    try {
      sink.play(pcm);
    } catch (err) {
      logger.error(LOG, 'Pushing speech to the output sink failed', err);
    }
  }

  function safeIsSpeaking(): boolean {
    try {
      return sink.isSpeaking();
    } catch (err) {
      logger.warn(LOG, 'Asking the output sink whether it is speaking failed', err);
      return false;
    }
  }

  function safeCut(): void {
    try {
      sink.cut();
    } catch (err) {
      logger.warn(LOG, 'Cutting queued audio failed', err);
    }
  }

  function safeSetEngaged(engaged: boolean): void {
    try {
      sink.setEngaged(engaged);
    } catch (err) {
      logger.error(LOG, `Setting the tile to ${engaged ? 'engaged' : 'disengaged'} failed`, err);
    }
  }

  function safeSetSinkEnabled(open: boolean): void {
    try {
      sink.setEnabled(open);
    } catch (err) {
      logger.error(LOG, `Setting the output sink to ${open ? 'enabled' : 'disabled'} failed`, err);
    }
  }

  async function safeSendChat(text: string): Promise<void> {
    if (stopped) {
      logger.debug(LOG, `The meeting has stopped — dropped ${text.length} chars of text`);
    } else {
      try {
        await sendChat(text);
      } catch (err) {
        logger.error(LOG, 'Sending the meeting chat message failed', err);
      }
    }
  }

  function announceVoiceUnavailableOnce(): void {
    if (!voiceFailureAnnounced) {
      voiceFailureAnnounced = true;
      logger.error(LOG, 'Cannot speak — falling back to the meeting chat');
      void safeSendChat(
        "I can hear you, but my voice isn't working right now — I'll answer here instead.",
      );
    }
  }


  // Explicit, not assumed -- relying on the sink's own default state is how the engagement tile ends up stuck green (see setEngaged).
  applyEngagement();

  const reaper = setInterval(reapIdleStreams, STREAM_REAP_INTERVAL_MS);
  reaper.unref();

  logger.system(
    `Voice meeting ready for session ${sessionId} — ${TRIGGER_VARIANTS.length} trigger variants`,
  );

  return {
    sessionId,
    onAudio(participant: Participant, pcm: Buffer): void {
      if (stopped || isSelf(participant)) {
        return;
      }
      const state = ensureParticipant(participant);
      state.lastAudioAt = Date.now();
      if (state.staleFloorLogged) {
        state.staleFloorLogged = false;
      }
      if (state.stream !== null) {
        try {
          state.stream.write(pcm);
        } catch (err) {
          logger.warn(LOG, `Writing audio for ${state.name} failed — reopening later`, err);
          closeStream(state);
          state.reopenAfter = Date.now() + REOPEN_BACKOFF_MS;
        }
      }
    },

    updateParticipants(participants: readonly RosterEntry[]): void {
      if (stopped) {
        return;
      }
      roster = participants.map((p) => ({
        name: p.name === null ? null : sanitizeForLog(p.name),
        is_host: p.is_host,
        joined_at: p.joined_at,
        left_at: p.left_at,
      }));
      logger.debug(
        LOG,
        `Roster updated: ${roster.filter((p) => p.left_at === null).length} of ${roster.length} still in the room`,
      );
    },

    setCapabilities(summary: string): void {
      if (stopped) {
        return;
      }
      capabilities = summary.trim();
      if (capabilities.length === 0) {
        logger.warn(LOG, 'No capability summary for this meeting — running without one');
      } else {
        logger.debug(LOG, `Capability summary loaded: ${capabilities.length} chars`);
      }
    },

    deliverConsultAnswer(text: string, from: 'pm-agent' | 'system' = 'pm-agent'): { ok: true; id: string } | { ok: false } {
      // `stopped` matters here: teardown (`endMeeting`, voice/connector.ts) awaits this meeting's streams before unregistering it; a reply landing in that window must not raise the debt again.
      const consult = stopped ? undefined : outstandingConsult();
      if (consult === undefined) {
        return { ok: false };
      }
      consult.answer = text;
      consult.answeredAt = Date.now();
      lastConsultAnswerAt = Date.now();
      record({ at: new Date().toISOString(), type: 'answer', id: consult.id, text, from });
      setOwed(`the PM answered consult ${consult.id}`);
      return { ok: true, id: consult.id };
    },

    async stop(): Promise<void> {
      stopped = true;
      owes = false;
      if (followUpTimer !== null) {
        clearTimeout(followUpTimer);
        followUpTimer = null;
      }
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (floorTimer !== null) {
        clearTimeout(floorTimer);
        floorTimer = null;
      }
      applyEngagement();
      clearInterval(reaper);

      for (const state of participants.values()) {
        closeStream(state);
      }
      participants.clear();

      // Must run before `speech.close()` below -- closing with no `why` reads like a full delivery, filing an `utterance` row and posting CHAT:/LEAVE:/PM: as if the room were still there.
      abandonTurn?.('the meeting was torn down');

      if (speech !== null) {
        try {
          speech.close();
        } catch (err) {
          logger.warn(LOG, 'Closing the speech session failed', err);
        }
        speech = null;
      }

      safeCut();
      safeSetSinkEnabled(false);

      // Waits out the in-flight turn so its row is handed to the transport before teardown reads final state; the transport owns getting it to disk.
      await turnChain;

      logger.system(`Voice meeting stopped for session ${sessionId}`);
    },
  };
}
