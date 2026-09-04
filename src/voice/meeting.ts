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

// 3h backstop, well within Cerebras' 131,072-token context -- a meeting's full context measures ~40k tokens worst case. The speaking call reads this same window: widening it is ~free, since time-to-first-byte is flat against input size (+2.3ms per 1000 tokens, R² = 0.000 across 156 samples).
const TRANSCRIPT_WINDOW_MS = 3 * 60 * 60 * 1000;
// Short, unlike the speaking window: widening it only adds chances to catch the name in an unaimed sentence and misfire, which voice-addressing.md treats as the worst outcome.
const ADDRESSING_WINDOW_MS = 60 * 1000;
const RETRY_FLOOR_MS = 2 * 1000;
const FOLLOW_UP_GRACE_MS = 10 * 1000;
// Timers fire after their window closes, not on the boundary tick (`>=` still reads that as live) -- else the engagement tile sticks green for the rest of the meeting.
const LAPSE_MARGIN_MS = 50;
// Zoom issues a new participant id on rejoin -- without reaping, a reconnect leaves the old stream open, billed by Deepgram for silence.
const STREAM_IDLE_MS = 2 * 60 * 1000;
const STREAM_REAP_INTERVAL_MS = 30 * 1000;
// Flux's `eot_timeout_ms` defaults to 5000ms, so a feed still delivering audio resolves its turn within ~5s; 10s of silence can only mean a dead connection. Needed because `isTurnOpen()` clears only on an EndOfTurn event, and an idle Flux connection sends none -- measured at 20 minutes silent, still reporting `Connected`.
const FLOOR_LIVENESS_MS = 10 * 1000;
const REOPEN_BACKOFF_MS = 15 * 1000;
// `openTurnStream` fails asynchronously, so a rejected key shows as a stream dying right after every open -- without this floor, that reconnects at packet rate.
const REOPEN_MIN_INTERVAL_MS = 2 * 1000;
// 24 kHz x 2 bytes = 48,000 bytes/s at the ~16.7 chars/s the speaking prompt itself assumes ("a hundred characters is roughly six seconds"). Only used for a turn that completed no sentence of its own to measure.
const DEFAULT_BYTES_PER_CHAR = 2_900;
// Synthesis finishes well before playback does (a 26-char goodbye is handed over in ~1.2s and plays for ~1.6s), and leaving drops whatever the page still holds -- so the farewell waits on the page's own report, then on the platform's pipeline behind it.
const LEAVE_TAIL_MS = 300;
// A page that never reports playback finishing must not hold the bot in the room.
const LEAVE_WAIT_MAX_MS = 20 * 1000;

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

// A token holds only letters and digits, so space-delimiting both sides turns `includes` into an exact whole-token sequence match: `darchie` and `a r c h i e` both miss.
function spaced(text: string): string {
  return ` ${tokenize(text).join(' ')} `;
}

const compiledPhrases = new WeakMap<readonly string[], { raw: string; phrase: string }[]>();

function compilePhrases(phrases: readonly string[]): { raw: string; phrase: string }[] {
  const cached = compiledPhrases.get(phrases);
  if (cached !== undefined) {
    return cached;
  }
  const built = phrases
    .map((raw) => ({ raw, phrase: spaced(raw) }))
    .filter((variant) => variant.phrase.trim().length > 0);
  compiledPhrases.set(phrases, built);
  return built;
}

export function matchTrigger(
  text: string,
  variants: readonly string[] = TRIGGER_VARIANTS,
): string | null {
  const haystack = spaced(text);
  for (const variant of compilePhrases(variants)) {
    if (haystack.includes(variant.phrase)) {
      return variant.raw;
    }
  }
  return null;
}

const BOT_KEY = spaced(BOT_NAME);

// Exported rather than folded into the meeting -- a connector needs this same check before any `Meeting` exists to ask it.
export function isArchie(name: string | null): boolean {
  return name !== null && spaced(name) === BOT_KEY;
}

// Strips control chars and the two Unicode line separators -- uncaught, either could forge a second attributed line (persistence.ts's `formatLogEntry` doesn't escape) or a line/closing tag inside the prompt block a name renders into.
function sanitizeForLog(value: string): string {
  return value.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim();
}

/** A sentence whose audio the synthesizer reported fully handed over, and the turn-relative byte count at that moment. */
type SentenceEnd = { text: string; endOffset: number };

// The mean of this turn's own rates, so the estimate rides the voice that is actually speaking rather than a nominal one.
function bytesPerChar(completed: readonly SentenceEnd[]): number {
  let rates = 0;
  let counted = 0;
  let previousEnd = 0;
  for (const sentence of completed) {
    if (sentence.text.length > 0) {
      rates += (sentence.endOffset - previousEnd) / sentence.text.length;
      counted++;
    }
    previousEnd = sentence.endOffset;
  }
  return counted === 0 ? DEFAULT_BYTES_PER_CHAR : rates / counted;
}

/** The words of the sentence being spoken when the room cut in, em-dashed to mark the cut; null when not even one whole word landed. */
function heardPartOf(text: string, start: number, end: number, confirmed: number): string | null {
  if (end <= start) {
    return null;
  }
  const fraction = Math.min(1, Math.max(0, (confirmed - start) / (end - start)));
  const heardChars = Math.floor(fraction * text.length);
  // Back to the nearest word boundary at or before that point -- crediting a word the room never heard is the one bias this must never make, and half a word is unreadable anyway.
  let boundary = heardChars === text.length ? heardChars : -1;
  for (let i = heardChars; boundary < 0 && i >= 0; i--) {
    if (/\s/.test(text[i])) {
      boundary = i;
    }
  }
  const words = boundary < 0 ? '' : text.slice(0, boundary).trimEnd();
  return words.length === 0 ? null : `${words}—`;
}

// One speaking decision's row, built field by field as the turn settles and recorded once, in `decide()`'s `finally`.
type TurnRecord = Extract<MeetingRow, { type: 'turn' }>;

// One addressing decision's row. Recorded the moment its tier settles -- never held for the decision behind it, which may never run at all.
type GateRecord = Extract<MeetingRow, { type: 'gate' }>;

type TimerKind = 'follow-up' | 'retry' | 'floor';

interface ParticipantState {
  id: string;
  name: string;
  stream: TurnStream | null;
  reopenAfter: number;
  lastAudioAt: number;
  staleFloorLogged: boolean;
}

interface Consult {
  id: string;
  question: string;
  // Holds a real PM answer, or (if `routeConsult` refuses to send it) a parenthesised note that it never left -- same field, so a refused question doesn't read to the model as still pending.
  answer?: string;
}

export interface Meeting {
  // Recall's bot id. A channel deliverer checks it against a `RecallChannel`'s `session_id` before delivering (connectors/recall/channel-delivery.ts) -- that check, not this field alone, stops a stale channel reaching a different meeting live on the same task.
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
  const consults: Consult[] = [];
  // What a turn is decided against besides the transcript: who is in the room, what Archie wrote rather than said, and what it can go find out.
  const standing = { roster: [] as RosterEntry[], chat: [] as WrittenLine[], capabilities: '' };
  // One fact in three parts: whether Archie owes the room, the earliest a retry may run, and when a consult answer last raised the debt (see `clearOwed`).
  const owe = { standing: false, notBefore: 0, answeredAt: 0 };
  // Monotonic markers, not lengths: `transcript` shrinks as the window slides, so its length is no freshness marker across an await.
  const revision = { transcript: 0, cut: 0 };
  // The one in-flight turn: whether a decision is running, a handle `stop()` can await, and a way into one already awaiting a model call or synthesis.
  const turn = { deciding: false, chain: Promise.resolve(), abandon: null as ((why: string) => void) | null };
  const timers = new Map<TimerKind, NodeJS.Timeout>();
  // Opened eagerly so its connection cost isn't paid in front of the first word; `session` is null only if opening threw -- then every answer goes through `answerWithoutVoice`.
  // Two flags for two audiences: `failureAnnounced` is the room's notice, sent once per meeting, and `failing` is the fact the model's own turn context carries. `failing` clears the moment audio reaches the room again, so a transient outage doesn't leave Archie believing it is mute for the rest of the meeting; the room is deliberately not told twice.
  const voice: { session: SpeechSession | null; failureAnnounced: boolean; failing: boolean } = {
    session: null,
    failureAnnounced: false,
    failing: false,
  };
  let stopped = false;

  try {
    voice.session = createSonioxSpeechSession(cfg);
  } catch (err) {
    logger.error(LOG, 'Could not open the speech session — nothing can be spoken', err);
  }

  // One scheduler for the three timers a meeting arms; each kind holds at most one. `restart` is what a fresh answer does to the follow-up window.
  function arm(kind: TimerKind, delayMs: number, run: () => void, restart = false): void {
    if (restart) {
      clearTimeout(timers.get(kind));
      timers.delete(kind);
    }
    if (!timers.has(kind)) {
      const timer = setTimeout(() => {
        timers.delete(kind);
        run();
      }, delayMs);
      timer.unref();
      timers.set(kind, timer);
    }
  }

  function recordTiming(row: TurnRecord, key: keyof MeetingTurnTimings, ms: number): void {
    row.timings = { ...row.timings, [key]: ms };
  }

  function newGateRow(speaker: string, candidate: string, tier: GateRecord['tier']): GateRecord {
    return { at: new Date().toISOString(), type: 'gate', speaker, candidate, tier, addressed: false };
  }

  function addUtterance(speaker: string, text: string): void {
    const at = Date.now();
    transcript.push({ at, speaker, text });
    revision.transcript++;
    record({ at: new Date(at).toISOString(), type: 'utterance', speaker, text });
    owe.notBefore = 0;
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

  // `-1` asks whether our own line is the latest one (the follow-up window is live); `-2`, whether the room replied straight after it.
  function spokeWithinGrace(offset: -1 | -2): boolean {
    const utterance = transcript.at(offset);
    return (
      utterance !== undefined &&
      utterance.speaker === BOT_NAME &&
      utterance.at >= Date.now() - FOLLOW_UP_GRACE_MS
    );
  }

  // Not called on barge-in -- being cut off doesn't settle the debt, so the tile keeps showing Archie is still on the hook.
  function applyEngagement(): void {
    sink.setEngaged(!stopped && (owe.standing || spokeWithinGrace(-1)));
  }

  function noteOwnAnswer(text: string): void {
    addUtterance(BOT_NAME, text);
    arm('follow-up', FOLLOW_UP_GRACE_MS + LAPSE_MARGIN_MS, applyEngagement, true);
  }

  // The revision must be read before `addUtterance` runs -- that bumps it itself, our own line included.
  function fileConfirmedLine(text: string | null, asOf: number): void {
    if (text === null) {
      return;
    }
    const roomSpokeSince = revision.transcript !== asOf;
    addUtterance(BOT_NAME, text);
    if (!roomSpokeSince) {
      owe.notBefore = Date.now() + RETRY_FLOOR_MS;
    }
  }

  // The only record of these lines: they leave through the transport's chat channel, reaching neither the room's speech nor knowledge.log. The `chat` row isn't a convenience copy -- without it, they're gone.
  function noteOwnChat(chat: string | undefined): void {
    if (chat !== undefined) {
      const text = sanitizeForLog(chat);
      if (text.length > 0) {
        standing.chat.push({ speaker: BOT_NAME, text });
        record({ at: new Date().toISOString(), type: 'chat', speaker: BOT_NAME, text });
      }
    }
  }

  // A stream that throws counts as not holding the floor -- a broken connection must not veto Archie speaking for the rest of the meeting.
  function anyTurnOpen(): boolean {
    const liveSince = Date.now() - FLOOR_LIVENESS_MS;
    for (const state of participants.values()) {
      if (state.stream !== null) {
        try {
          if (state.stream.isTurnOpen()) {
            if (state.lastAudioAt >= liveSince) {
              return true;
            } else if (!state.staleFloorLogged) {
              state.staleFloorLogged = true;
              logger.warn(
                LOG,
                `${state.name} (#${state.id}) has an open turn but has sent no audio for ` +
                `${Math.round((Date.now() - state.lastAudioAt) / 1000)}s — ignoring their claim on the floor`,
              );
            }
          }
        } catch (err) {
          logger.warn(LOG, `Could not read ${state.name}'s turn state — assuming silence`, err);
        }
      }
    }
    return false;
  }

  // Load-bearing, not defensive: with the settle delay gone, this check and the identical one on the first audio chunk are all that stops Archie talking over somebody.
  function roomMovedOn(asOf: number): boolean {
    return revision.transcript !== asOf || anyTurnOpen();
  }

  function maybeDecide(): void {
    if (!owe.standing || stopped) {
      return;
    }
    if (anyTurnOpen()) {
      // The one poll in an otherwise event-driven design -- a stuck participant's audio simply stops, firing no turn-end event to return here.
      arm('floor', FLOOR_LIVENESS_MS + LAPSE_MARGIN_MS, maybeDecide);
    } else if (turn.deciding) {
      // The decision in flight comes back through here when it settles.
    } else if (Date.now() < owe.notBefore) {
      arm('retry', owe.notBefore - Date.now(), maybeDecide);
    } else {
      turn.chain = decide().catch((err) => {
        logger.error(LOG, 'The speaking decision rejected unexpectedly', err);
      });
    }
  }

  function setOwed(why: string): void {
    if (!owe.standing) {
      owe.standing = true;
      logger.debug(LOG, `Archie owes the room a response — ${why}`);
    }
    // Runs even when the flag was already set -- the addressing gate's verdict often lands after the turn end that would have triggered a decision; skipping this loses that activation silently.
    applyEngagement();
    maybeDecide();
  }

  // Compares against the last consult answer rather than clearing unconditionally -- an answer raises the debt without touching the transcript or opening a turn, so an unrelated in-flight decision must not discard it on settling.
  function clearOwed(askedAt: number): void {
    if (owe.answeredAt <= askedAt) {
      owe.standing = false;
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
    } else if (spokeWithinGrace(-2)) {
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
    // meetingOrdinal first -- collision-proof across concurrent meetings. Kept short to round-trip cleanly through a model's reply.
    return `m${meetingOrdinal}c${consults.length + 1}`;
  }

  // Invariant: at most one consult outstanding, so an answer can only pair with one question -- no id needed on the seam. A refused question records pre-answered, so it doesn't block the next.
  function outstandingConsult(): Consult | undefined {
    return consults.find((c) => c.answer === undefined);
  }

  function routeConsult(question: string | undefined): string | undefined {
    if (question === undefined) {
      return undefined;
    }
    const blocking = outstandingConsult();
    if (stopped) {
      logger.debug(LOG, `The meeting has stopped — dropped a PM: question: ${question}`);
      return 'the meeting had stopped';
    } else if (host === undefined) {
      logger.debug(LOG, `No host on this meeting — dropped a PM: question: ${question}`);
      return 'this meeting has no host to ask';
    } else if (blocking !== undefined) {
      // No consult id in the note -- the speaking prompt has no rule for an unspeakable string like "m1c1"; the only rule that fits sends it to the room's chat.
      consults.push({
        id: nextConsultId(),
        question,
        answer: '(not sent — an earlier question was still unanswered, so nothing is on its way for this one)',
      });
      logger.warn(LOG, `A question is already outstanding (${blocking.id}) — did not ask a second: ${question}`);
      return `${blocking.id} was still outstanding`;
    } else {
      const id = nextConsultId();
      consults.push({ id, question });
      record({ at: new Date().toISOString(), type: 'consult', id, question });
      host.noteEvent(`consult: ${question} — recall/${sessionId}/meeting.jsonl`);
      host.consult(id, question);
      return undefined;
    }
  }

  /** `how` names the channel the farewell actually reached, which is the whole difference between the two doors into here. */
  function routeLeave(how: string): void {
    if (host === undefined) {
      logger.debug(LOG, 'No host on this meeting — dropped a LEAVE: request');
    } else {
      logger.system(`Voice meeting ${sessionId} is ending — ${BOT_NAME} asked to leave and ${how}`);
      host.leaveMeeting();
    }
  }

  /** Holds the turn until the room has actually heard the farewell, then leaves -- unless a barge-in or a teardown overtakes the wait. Only reached when speech works: with synthesis dead the wait could never end, so that case leaves from `answerWithoutVoice` instead. See "Leaving the room" in docs/architecture/voice.md. */
  async function leaveOnceHeard(row: TurnRecord, cutAtStart: number): Promise<void> {
    const pause = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref();
      });
    const overtaken = (): boolean => stopped || revision.cut !== cutAtStart;
    const giveUpAt = Date.now() + LEAVE_WAIT_MAX_MS;
    while (sink.isSpeaking() && !overtaken() && Date.now() < giveUpAt) {
      // 100ms: the page reports every ~170ms, so a finer poll only re-reads the same value.
      await pause(100);
    }
    if (!overtaken() && sink.isSpeaking()) {
      logger.warn(
        LOG,
        `The room still reports the farewell playing ${LEAVE_WAIT_MAX_MS / 1000}s on — leaving anyway`,
      );
    } else if (!overtaken()) {
      await pause(LEAVE_TAIL_MS);
    }
    if (stopped) {
      logger.debug(LOG, 'The meeting was already being torn down — left the ending to it');
    } else if (revision.cut !== cutAtStart) {
      // An interrupted goodbye leaves Archie in the room, the same as any other answer cut short.
      row.error = 'the farewell was interrupted, so Archie stayed';
      logger.debug(LOG, 'Somebody cut in over the farewell — staying to reconsider at the next quiet moment');
    } else {
      routeLeave('its farewell was delivered in full');
    }
  }

  // Voice failed, so the answer goes out in writing instead -- still an error row: the room got text where it was owed speech.
  function answerWithoutVoice(row: TurnRecord, answer: SpokenResponse, why: string, askedAt: number): void {
    row.verdict = 'error';
    row.speech = '';
    // Recorded for the model, not only for the room: `noteOwnAnswer` below files this answer as an utterance, so without this fact the next turn reads it as something it said aloud.
    voice.failing = true;
    clearOwed(askedAt);
    row.error = `${why} — answered in the meeting chat instead`;
    noteOwnAnswer(answer.speech);
    if (!voice.failureAnnounced) {
      voice.failureAnnounced = true;
      logger.error(LOG, 'Cannot speak — falling back to the meeting chat');
      if (!stopped) {
        void sendChat("I can hear you, but my voice isn't working right now — I'll answer here instead.");
      }
    }
    let posted: Promise<void> = Promise.resolve();
    if (!stopped) {
      posted = sendChat(answer.chat === undefined ? answer.speech : `${answer.speech}\n\n${answer.chat}`);
    }
    noteOwnChat(answer.chat);
    if (answer.leave === true) {
      // Leaving is not conditional on working speech. `leaveOnceHeard` waits on a farewell the room can hear, which is exactly what is missing here, so waiting could only wait forever: both of a user's explicit "leave now" instructions registered and neither could complete, and the bot was still in the call when they hung up.
      // The wait that does belong here is on the chat post, the only channel reaching the room: leaving tears the meeting down, and a post still in flight would go down with it.
      void posted
        .catch((err) => {
          logger.warn(LOG, 'Posting the farewell to the meeting chat failed — leaving anyway', err);
        })
        .then(() => {
          if (stopped) {
            logger.debug(LOG, 'The meeting was already being torn down — left the ending to it');
          } else {
            routeLeave('its farewell went to the meeting chat, because its voice was not working');
          }
        });
    }
  }

  async function decide(): Promise<void> {
    turn.deciding = true;
    const askedAt = Date.now();
    const asOf = revision.transcript;
    const window = transcriptSince(TRANSCRIPT_WINDOW_MS);
    // 'suppressed' is the safe default, not proof the room heard nothing -- a turn cut off mid-answer settles here too. `speech` is what was actually heard.
    const row: TurnRecord = { at: new Date().toISOString(), type: 'turn', verdict: 'suppressed' };
    try {
      await answerRoom(row, window, askedAt, asOf);
    } catch (err) {
      // Drops the debt rather than retrying -- a fault paired with a standing flag is an unbounded loop of failing model calls.
      clearOwed(askedAt);
      row.verdict = 'error';
      row.error = `the speaking decision threw: ${String(err)}`;
      logger.error(LOG, 'The speaking decision threw', err);
    } finally {
      turn.deciding = false;
      if (owe.standing && revision.transcript === asOf && owe.answeredAt <= askedAt) {
        owe.notBefore = Date.now() + RETRY_FLOOR_MS;
      }
      record(row);
      applyEngagement();
      maybeDecide();
    }
  }

  // The floor is ~935ms, not ~700ms (once assumed for token-by-token streaming): ~620ms time-to-first-byte, plus text arrives in ~313ms quanta, and the first delta (3-10 chars) is too short for a sentence to complete.
  async function answerRoom(row: TurnRecord, window: string, askedAt: number, asOf: number): Promise<void> {
    const cutAtStart = revision.cut;
    let stream: SpeechStream | null = null;
    let heardAnything = false;
    let abandoned: string | null = null;
    let firstSayAt: number | null = null;
    let decision: Decision | null = null;
    let consult: string | undefined;

    let pcmSentToSink = 0;
    const sentenceOffsets: SentenceEnd[] = [];
    // Soniox serializes its per-sentence streams, so completion order is handed order: index i of one lines up with index i of the other.
    const handedSentences: string[] = [];
    // Asked for here, awaited later: the turn must reach the speaking call in the same tick, and the sink answers with the count as of this call anyway.
    const playedBaseline = sink.played();

    const confirmedPrefix = async (): Promise<string | null> => {
      const [baseline, now] = await Promise.all([playedBaseline, sink.played()]);
      const confirmed = now - baseline;
      const heard = sentenceOffsets.filter((s) => s.endOffset <= confirmed);
      const spoken = heard.map((s) => s.text);
      const cutSentence = handedSentences[heard.length];
      if (cutSentence !== undefined) {
        const start = heard.length === 0 ? 0 : heard[heard.length - 1].endOffset;
        const own = sentenceOffsets[heard.length];
        // Exact when this sentence's own audio had all arrived; otherwise how long it was going to be, at this turn's measured speech rate.
        const end =
          own === undefined ? start + cutSentence.length * bytesPerChar(sentenceOffsets) : own.endOffset;
        const partial = heardPartOf(cutSentence, start, end, confirmed);
        if (partial !== null) {
          spoken.push(partial);
        }
      }
      return spoken.length === 0 ? null : spoken.join(' ');
    };

    // `abort()` stops the synthesizer server-side, not just this turn's delivery: `onPcm` already drops whatever arrives once the turn is abandoned, but audio the room will never hear should not be generated at all.
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
        return;
      }
      if (revision.cut !== cutAtStart) {
        abandon('cut off by somebody starting to speak');
      } else if (!heardAnything && roomMovedOn(asOf)) {
        abandon('the room took the floor before the first word of the answer');
      } else {
        if (!heardAnything) {
          heardAnything = true;
          recordTiming(row, 'speakMs', Date.now() - askedAt);
          // Cleared on bytes actually going to the room rather than on a turn settling: this is the only evidence that speech works, and a turn can settle every other way without it.
          voice.failing = false;
        }
        pcmSentToSink += pcm.length;
        sink.play(pcm);
      }
    };

    const haveSentence = (text: string): void => {
      if (abandoned !== null) {
        return;
      }
      if (revision.cut !== cutAtStart) {
        abandon('cut off by somebody starting to speak');
      } else {
        if (firstSayAt === null) {
          firstSayAt = Date.now();
        }
        // Noted before `say`, so a completion can never land ahead of the sentence it belongs to; popped again if the hand-over itself failed, since nothing will be spoken of it.
        handedSentences.push(text);
        try {
          stream?.say(text, () => {
            sentenceOffsets.push({ text, endOffset: pcmSentToSink });
          });
        } catch (err) {
          handedSentences.pop();
          logger.warn(LOG, 'Handing a sentence to the speech stream failed', err);
        }
      }
    };

    turn.abandon = abandon;

    try {
      if (voice.session !== null) {
        stream = voice.session.speak(onPcm);
      }

      const trail = consults.map((c) => ({ id: c.id, question: c.question, answer: c.answer }));
      // The `await` is never evaluated without a host, so an unbound meeting reaches the speaking call in the same tick -- pinned by two tests in room-silence.test.ts ("no delay in front of the decision").
      const written = [...(host === undefined ? [] : await host.readWrittenExchange()), ...standing.chat];
      const context: SpeakingContext = {};
      if (standing.roster.length > 0) {
        // Copied, not referenced: the snapshot outlives the model call it was built for, and a roster replaced mid-call mustn't change what was already sent.
        context.participants = [...standing.roster];
      }
      if (written.length > 0) {
        context.written = written;
      }
      if (standing.capabilities.length > 0) {
        context.capabilities = standing.capabilities;
      }
      if (voice.failing) {
        // Set only while it is true, like every other block here: a meeting whose speech has never failed sends the request it always did.
        context.voiceFailed = true;
      }

      const startedAt = Date.now();
      decision = await decideResponse(cfg, {
        transcript: window,
        onSentence: stream === null ? undefined : haveSentence,
        consults: trail,
        context,
      });
      recordTiming(row, 'decideMs', Date.now() - startedAt);

      if (decision.outcome === 'silence') {
        consult = decision.pm;
        abandon('the model decided to say nothing');
        clearOwed(askedAt);
        row.verdict = 'suppressed';
        // `null` means no sentence was confirmed heard, which `speech: ''` says exactly.
        row.speech = (await confirmedPrefix()) ?? '';
        if (decision.pm !== undefined) {
          row.pm = decision.pm;
        }
        if (decision.thought !== undefined) {
          row.thought = decision.thought;
        }
        logger.debug(LOG, 'Decided to say nothing');
      } else if (decision.outcome === 'failed') {
        const { why, handedOver } = decision;
        abandon(`the decision failed: ${why}`);
        const heard = heardAnything;
        const prefix = await confirmedPrefix();
        row.verdict = 'error';
        row.speech = prefix ?? '';
        if (heard) {
          row.error = `spoke part of the answer, then the decision failed: ${why}`;
          logger.warn(LOG, `The decision failed after ${handedOver} sentence(s) had been spoken — ${why}`);
          fileConfirmedLine(prefix, asOf);
        } else {
          clearOwed(askedAt);
          row.error = `the decision failed: ${why}`;
          logger.debug(LOG, `Said nothing — the decision failed: ${why}`);
        }
      } else {
        const answer = decision.response;
        consult = answer.pm;
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

        if (stream === null) {
          answerWithoutVoice(row, answer, 'there is no speech session to say it with', askedAt);
        } else {
          if (!heardAnything && roomMovedOn(asOf)) {
            abandon('the room moved on while we were deciding');
          }
          const result = await stream.end();
          if (firstSayAt !== null) {
            recordTiming(row, 'synthMs', Date.now() - firstSayAt);
          }
          if (result.msToFirstByte !== null) {
            recordTiming(row, 'ttfbMs', result.msToFirstByte);
          }
          const partial = abandoned ?? result.incomplete;
          const heard = heardAnything;
          const prefix = await confirmedPrefix();
          if (heard && partial !== null) {
            row.error = `spoke part of the answer, then ${partial}`;
            logger.debug(LOG, `Interrupted mid-answer — ${partial}`);
            row.speech = prefix ?? '';
            fileConfirmedLine(prefix, asOf);
          } else if (heard) {
            clearOwed(askedAt);
            row.verdict = 'addressed';
            // Reads `answer.speech` directly, not the sink's watermark -- the room reports what it has rendered at intervals, so `played()` can lag a sentence behind at the moment the round closes.
            row.speech = answer.speech;
            noteOwnAnswer(answer.speech);
            // Not awaited -- audio is already playing, and the room shouldn't wait on the chat channel before the next decision can run. Dropped once stopped: a post after teardown reaches a room that has dispersed.
            if (answer.chat !== undefined && !stopped) {
              void sendChat(answer.chat);
            }
            noteOwnChat(answer.chat);
            logger.debug(LOG, `Said: ${answer.speech}`);
            if (answer.leave === true) {
              // Only reachable here -- the farewell must be delivered in full before the meeting may act on it, and heard in full before it leaves.
              await leaveOnceHeard(row, cutAtStart);
            }
          } else if (abandoned !== null) {
            row.error = `${abandoned} — reconsidering now`;
            row.speech = '';
          } else {
            answerWithoutVoice(row, answer, result.incomplete ?? 'synthesis produced no audio', askedAt);
          }
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
            row.speech = (await confirmedPrefix()) ?? '';
          }
        } else {
          answerWithoutVoice(row, answer, `speaking threw: ${String(err)}`, askedAt);
        }
      }
    } finally {
      turn.abandon = null;
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

  function onTurnEnd(state: ParticipantState, text: string): void {
    const spoken = text.trim();
    if (spoken.length > 0 && !stopped) {
      addUtterance(state.name, spoken);
      if (owe.standing) {
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

  function displayName(participant: Participant): string {
    const name = sanitizeForLog(participant.name?.trim() ?? '');
    return name.length > 0 ? name : `participant ${participant.id}`;
  }

  function openStreamFor(state: ParticipantState): TurnStream | null {
    try {
      return openTurnStream(cfg, {
        label: state.name,
        // Catches its own faults -- runs inside deepgram's socket handlers, and a throw here would unwind into that socket.
        onEvent: (event: TurnEvent) => {
          try {
            if (event.kind === 'start') {
              // Unconditional, unclassified -- no judgement on whether they were talking to us. The debt stays untouched: barge-in doesn't settle it.
              if (sink.isSpeaking()) {
                logger.debug(LOG, `${state.name} started speaking over us — cutting`);
                revision.cut++;
                sink.cut();
              }
            } else {
              onTurnEnd(state, event.transcript);
            }
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
    if (state.stream !== null && !state.stream.isAlive()) {
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
      // The self check guards against a transport leaking our own audio back -- a self-sustaining loop of transcribing, cutting off, and answering ourselves.
      if (stopped || isArchie(participant.name)) {
        return;
      }
      const state = ensureParticipant(participant);
      state.lastAudioAt = Date.now();
      state.staleFloorLogged = false;
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
      standing.roster = participants.map((p) => ({
        name: p.name === null ? null : sanitizeForLog(p.name),
        is_host: p.is_host,
        joined_at: p.joined_at,
        left_at: p.left_at,
      }));
      logger.debug(
        LOG,
        `Roster updated: ${standing.roster.filter((p) => p.left_at === null).length} of ${standing.roster.length} still in the room`,
      );
    },

    setCapabilities(summary: string): void {
      if (stopped) {
        return;
      }
      standing.capabilities = summary.trim();
      if (standing.capabilities.length === 0) {
        logger.warn(LOG, 'No capability summary for this meeting — running without one');
      } else {
        logger.debug(LOG, `Capability summary loaded: ${standing.capabilities.length} chars`);
      }
    },

    deliverConsultAnswer(text: string, from: 'pm-agent' | 'system' = 'pm-agent'): { ok: true; id: string } | { ok: false } {
      // `stopped` matters here: teardown (`endMeeting`, connectors/recall/index.ts) awaits this meeting's streams before unregistering it; a reply landing in that window must not raise the debt again.
      const consult = stopped ? undefined : outstandingConsult();
      if (consult === undefined) {
        return { ok: false };
      }
      consult.answer = text;
      owe.answeredAt = Date.now();
      record({ at: new Date().toISOString(), type: 'answer', id: consult.id, text, from });
      setOwed(`the PM answered consult ${consult.id}`);
      return { ok: true, id: consult.id };
    },

    async stop(): Promise<void> {
      stopped = true;
      owe.standing = false;
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
      applyEngagement();
      clearInterval(reaper);

      for (const state of participants.values()) {
        closeStream(state);
      }
      participants.clear();

      // Must run before `close()` below -- closing with no `why` reads like a full delivery, filing an `utterance` row and posting CHAT:/LEAVE:/PM: as if the room were still there.
      turn.abandon?.('the meeting was torn down');

      if (voice.session !== null) {
        try {
          voice.session.close();
        } catch (err) {
          logger.warn(LOG, 'Closing the speech session failed', err);
        }
        voice.session = null;
      }

      sink.cut();
      sink.setEnabled(false);

      // Waits out the in-flight turn so its row is handed to the transport before teardown reads final state; the transport owns getting it to disk.
      await turn.chain;

      logger.system(`Voice meeting stopped for session ${sessionId}`);
    },
  };
}
