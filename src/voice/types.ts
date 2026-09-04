/**
 * Shared types for voice — the contract between the conversation and the transport that carries it — plus the one name Archie answers to.
 *
 * No logic, no imports from sibling modules.
 */

/** The name Archie joins under, is addressed by, and introduces itself as. One constant because the join name, the trigger variants and the prompts must agree; separate knobs are separate ways for them to disagree. */
export const BOT_NAME = 'Archie';

/**
 * Every credential the medium holds, resolved from env at startup in `index.ts`. All required — a connector does not mount without them. A channel's own credentials are its config's business (`RecallConfig` in `src/connectors/recall/recall.ts`), never this one's.
 *
 * Credentials only: the vendors and their settings are fixed in `deepgram.ts`, `soniox.ts` and `comprehension.ts`. Each module's log scrubber redacts every key here — an echoed request isn't choosy about headers.
 */
export interface VoiceConfig {
  deepgramApiKey: string;
  /** Speaks every answer; see soniox.ts. */
  sonioxApiKey: string;
  /** Serves both comprehension calls; see comprehension.ts. */
  cerebrasApiKey: string;
}

/** Who an inbound audio packet came from. Only `id` and `name` are read; `email`/`isHost` ride along unused. A transport that can't separate speakers passes the same `Participant` every time. */
export interface Participant {
  /** Opaque key: compare for equality, use as a map key — never parse, order, or do arithmetic on it. String, not number: not every transport's id is numeric. Recall's own integer ids become strings at its connector boundary. */
  id: string;
  name: string | null;
  email: string | null;
  isHost: boolean | null;
}

/** One finalized utterance in the attributed transcript. */
export interface Utterance {
  /** Wall-clock ms when we finalized it. */
  at: number;
  speaker: string;
  text: string;
}

/**
 * One person the transport reports as in the room, whether or not they've made a sound. Not built from `onAudio` alone — a muted participant sends no audio; comes from a transport with join/leave events, via {@link Meeting.updateParticipants}. Snake_case, like the meeting record's own fields.
 *
 * `null` means "not reported"; `left_at === null` means still in the room.
 */
export interface RosterEntry {
  name: string | null;
  is_host: boolean | null;
  joined_at: string | null;
  left_at: string | null;
}

/**
 * One line of the written channel: reached Archie or the room in writing, not aloud. Two sources: the task's written exchange ({@link MeetingHost.readWrittenExchange}) and Archie's own chat posts (the `chat` rows of the meeting record). Separate from {@link Utterance} — Archie must never believe it *said* what it only *wrote* (`parseReply` in `comprehension.ts` keeps `CHAT:` out of the spoken transcript). No timestamp: nothing windows this channel.
 */
export interface WrittenLine {
  /** Plain rendered display name, no mention syntax or ids. Every agent renders as Archie; one Archie per room. */
  speaker: string;
  text: string;
}

/** Who joined or left, as the meeting record keeps them. Snake_case, like every other field on a row. */
export interface MeetingRowParticipant {
  id: string;
  name: string | null;
  is_host: boolean | null;
}

/**
 * One line of a meeting's record — the single append-only `meeting.jsonl` in that meeting's own folder, one JSON object per line, appended in settle order.
 *
 * The transport carries every row ({@link VoiceTransport.record}), so the conversation writes to no file of its own and the connector decides where a meeting's record lands. A field that is not known is omitted rather than written as `null`; the two `| null` fields below are the exceptions, where "asked and got nothing" is the fact worth recording.
 *
 * Derived views are the reader's job: the transcript is the `utterance` rows, the roster the `join`/`leave` rows, the consult trail the `consult`/`answer` pairs.
 */
export type MeetingRow =
  /** The bot was created and is on its way into the call. */
  | { at: string; type: 'started'; url: string; bot_id: string }
  /**
   * What Recall says the occasion is, as the status poll learns it. Appended whenever the pair changes, since Recall produces a title asynchronously once the bot is in the call — the last such row is the current answer, and no row at all means Recall never supplied either.
   */
  | { at: string; type: 'details'; platform: string | null; title: string | null }
  /** The `<capabilities>` block this meeting's model calls were given, verbatim; `''` when the summariser produced none. */
  | { at: string; type: 'capabilities'; text: string }
  | { at: string; type: 'join'; participant: MeetingRowParticipant }
  | { at: string; type: 'leave'; participant: MeetingRowParticipant }
  /** One finalised line the room heard, Archie's own turns included. */
  | { at: string; type: 'utterance'; speaker: string; text: string }
  /** One line Archie posted into the meeting's own chat rather than saying aloud. Nothing else records these. */
  | { at: string; type: 'chat'; speaker: string; text: string }
  /** A question left for the PM. Only a question that actually went out gets a row; a refused one shows as `pm_dropped` on its turn. */
  | { at: string; type: 'consult'; id: string; question: string }
  /** What came back on that question — from the PM, or `'system'` for the self-answer when the team could not be reached. */
  | { at: string; type: 'answer'; id: string; text: string; from: 'pm-agent' | 'system' }
  /**
   * How one candidate turn was judged. `tier` is which one decided: `name` (a trigger variant matched, no model call), `follow-up` (the bot spoke last and this arrived shortly after), `model` (neither free tier fired, so `wasAddressed` was asked), `already-owed` (a response was owed already, so no tier ran).
   */
  | {
      at: string;
      type: 'gate';
      speaker: string;
      candidate: string;
      tier: 'name' | 'follow-up' | 'model' | 'already-owed';
      /** Which variant matched, when the `name` tier decided. */
      matched?: string;
      addressed: boolean;
      gate_ms?: number;
      error?: string;
    }
  /**
   * How one speaking decision settled. Its own row, never merged with the `gate` row that led to it: a turn can be judged and never reach a decision at all.
   *
   * `answer` is the whole of what the model decided to say, whatever became of it; `speech` is what the room is confirmed to have heard — `''` claims nothing was, which is a stronger statement than the field being absent.
   */
  | {
      at: string;
      type: 'turn';
      verdict: 'addressed' | 'suppressed' | 'error';
      answer?: string;
      speech?: string;
      chat?: string;
      pm?: string;
      /** Why a `PM:` question never left — a reason string, so the escalation rate does not count questions nobody was asked. */
      pm_dropped?: string;
      leave?: boolean;
      thought?: string;
      error?: string;
      timings?: MeetingTurnTimings;
    }
  /** Recall's own `call_ended` timestamp when the poll saw one; `null` for an ending nobody asked Recall about. */
  | { at: string; type: 'ended'; call_ended_at: string | null };

/** `decideMs`: the model call choosing what to say. `ttfbMs`: the first synthesis byte. `synthMs`: first sentence to last chunk. `speakMs`: turn end to first sound, the latency the room feels. */
export interface MeetingTurnTimings {
  decideMs?: number;
  ttfbMs?: number;
  synthMs?: number;
  speakMs?: number;
}

/** What one answer's synthesis produced. Reported by both synthesizers. */
export interface SpeechResult {
  /** Total PCM bytes handed to `onPcm`. Zero means nothing was spoken. */
  bytes: number;
  /** Ms from the first text going out to the first audio chunk; null if none arrived. */
  msToFirstByte: number | null;
  /** Why synthesis stopped short, or null if complete. `bytes` alone can't distinguish truncated from complete — recording full text when the room heard half is how the transcript starts lying. */
  incomplete: string | null;
}

/** One answer being spoken. Text may arrive in pieces as the model writes it. */
export interface SpeechStream {
  /** Push a complete sentence or clause; may repeat. `onSentenceComplete` fires once this sentence's audio is fully handed to `onPcm` — synthesis, not room-heard ({@link AudioSink.played} measures that). Required: the caller anchors an interrupted answer's record on it, so a synthesizer that cannot report per-sentence completion cannot implement this interface. */
  say(text: string, onSentenceComplete: () => void): void;
  /** No more text coming; resolves when all audio has been delivered. */
  end(): Promise<SpeechResult>;
  /** Abandon: stop the synthesizer generating and stop delivering audio. */
  abort(): void;
}

/** The meeting's connection to the synthesizer; see soniox.ts. */
export interface SpeechSession {
  // Only one answer in flight — a second abandons the first, so an unfinished stream can't wedge the socket.
  speak(onPcm: (pcm: Buffer) => void): SpeechStream;
  /** Release the connection. Call on meeting teardown. */
  close(): void;
}

/** Sink for audio going into the meeting, supplied by the transport; implemented in `src/connectors/recall/audio-out.ts`. */
export interface AudioSink {
  /** Queue PCM16 mono 24kHz for playback in the meeting. Ignored while disabled. */
  play(pcm: Buffer): void;
  /** Drop everything queued and stop immediately (barge-in). */
  cut(): void;
  /** Output gate: whether anything we produce may reach the meeting. Defaults closed; only the transport opens it, once it has a live meeting (Recall does so on browser-attach). Conversation closes it only on teardown. Not what decides when the bot talks — that's room silence in meeting.ts, the coarser gate underneath it. */
  setEnabled(open: boolean): void;
  /** Paints the video tile: green while Archie is engaged — addressed-and-undischarged, or just-spoke with the follow-up window still open — grey otherwise. Distinct from `setEnabled` (opens once for the whole meeting, no per-turn state). Never reroute into speech or chat. */
  setEngaged(engaged: boolean): void;
  /** True while audio is queued or playing, from the room's own end rather than an estimate: up to one report interval stale mid-utterance, exact after a `cut()`, which the page answers with a report. */
  isSpeaking(): boolean;
  /** Cumulative PCM bytes, in `play()`'s stream, the room is confirmed to have heard — counted by whatever renders the audio, not inferred from what was sent. Monotonic, never reset by `cut()` — diff two reads, don't trust one. Resolves at once unless a `cut()`'s exact count is still outstanding, and never waits longer than half a second for it: under-counting is safe, over-counting isn't — opposite bias from {@link isSpeaking}. */
  played(): Promise<number>;
}

/**
 * What a transport supplies: a name, somewhere for speech, and somewhere for text. `meeting.ts` never learns how it's connected — Recall's implementation is `src/connectors/recall/index.ts`. ASR and synthesis are a separate seam (`deepgram.ts`, `soniox.ts`).
 *
 * Audio flows in through `Meeting.onAudio`, not pulled — the transport calls the meeting, never the reverse. One participant is the simplest case: a telephone stream is a single speaker — room silence with N=1.
 */
export interface VoiceTransport {
  // Stable id: names the log lines and the meeting's own record. Opaque — a transport may reuse whatever handle it has (Recall passes its bot id).
  sessionId: string;
  /** Where the bot's speech goes. */
  sink: AudioSink;
  /** Post text into the meeting's chat: detail an answer won't speak (identifiers, hashes, paths, figures), and, on voice failure, the answer itself. */
  sendChat: (text: string) => Promise<void>;
  /** Append one line to this meeting's record. Sync void: it is called from the audio path, and the transport owns both the destination and the serialisation. */
  record: (row: MeetingRow) => void;
}

/**
 * How a meeting reaches the rest of Archie. Absent for an unbound meeting — the manual POST entry point still works, with no task to reach (its record still lands, through the transport).
 *
 * Every method but {@link MeetingHost.readWrittenExchange} is sync void: the caller is Flux's end-of-turn reaction (~300ms), too fast to wait on a disk write.
 */
export interface MeetingHost {
  /** The task's written exchange — Slack thread, or CLI conversation if none — as {@link WrittenLine}s, oldest first. Read fresh every turn, the only async method here: a cache could go stale silently, and one read costs microseconds against the model call it precedes. Called only from `answerRoom`, already mid-async — never the audio path the other methods answer on. Resolves to an empty array on failure, so a turn runs without it (see written.ts). */
  readWrittenExchange(): Promise<WrittenLine[]>;
  /** A fact worth keeping outside the meeting: started, ended, question asked. */
  noteEvent(text: string): void;
  /**
   * Ask the PM. Returns immediately; the answer arrives via deliverConsultAnswer
   * carrying the same id. If undeliverable, the host must deliver a synthetic
   * answer on that id — never leave it silent.
   */
  consult(id: string, question: string): void;
  /** Archie decided to leave; the farewell has already been spoken in full — see `routeLeave`, the only caller. The host arranges the actual end on its own schedule, not inline. No arguments: id and task are closed over by `createTaskHost` (`task-binding.ts`); the farewell is already in the record as an `utterance` row. No host: dropped with a debug line — the unbound manual-entry meeting stays on the call. */
  leaveMeeting(): void;
}
