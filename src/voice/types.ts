/**
 * Shared types for voice — the contract between the medium and whichever connector carries it.
 *
 * Types only, no logic, no imports from sibling modules or `src/connectors/`: voice knows a transport exists, never which one.
 */

/**
 * What the medium needs for a conversation, resolved from env at startup, handed down by the connector. Excludes connector detail (vendor, region, callback URL).
 *
 * The three keys are all required — the connector does not mount without them.
 */
export interface VoiceConfig {
  deepgramApiKey: string;
  /**
   * The name Archie answers to and introduces itself by.
   *
   * Must match the connector's display name, or the bot stays silent when addressed by the name people see.
   */
  botName: string;
  /** Serves both comprehension calls; see comprehension.ts. */
  cerebrasApiKey: string;
  // No scheme, e.g. `api.eu.deepgram.com`. Absent means `api.deepgram.com` (default in deepgram.ts).
  deepgramHost?: string;
  /**
   * Comma-separated codes, e.g. `en,ru`, bias Flux instead of guessing; absent sends no hint.
   *
   * No default list — a bad guess can fail the whole language, not merely degrade it.
   */
  languageHints?: string;
  /** Speaks every answer; see soniox.ts. */
  sonioxApiKey: string;
  // No scheme, e.g. `tts-rt.eu.soniox.com`. Absent means the US endpoint — the only region the key authenticates against.
  sonioxHost?: string;
  // Absent means the stock voice. A cloned voice needs its UUID — its display name gets `400 Invalid voice`.
  sonioxVoice?: string;
  /** Credentials held elsewhere, so deepgram.ts/soniox.ts scrubbers redact them too — every credential the process holds, not just their own (an echoed request isn't choosy about headers). Absent means the fields above are the whole set. */
  foreignSecrets?: string[];
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
 * One person the transport reports as in the room, whether or not they've made a sound. Not built from `onAudio` alone — a muted participant sends no audio; comes from a transport with join/leave events, via {@link Meeting.updateParticipants}. Snake_case: matches Recall's `metadata.json` shape (`LiveMeetingParticipant` in `src/types/task.ts`) — no reshaping needed.
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
 * One line of the written channel: reached Archie or the room in writing, not aloud. Two sources: the task's written exchange ({@link MeetingHost.readWrittenExchange}) and Archie's own chat posts ({@link MeetingHost.recordChat}). Separate from {@link Utterance} — Archie must never believe it *said* what it only *wrote* (`parseReply` in `comprehension.ts` keeps `CHAT:` out of the spoken transcript). No timestamp: nothing windows this channel.
 */
export interface WrittenLine {
  /** Plain rendered display name, no mention syntax or ids. Every agent renders as Archie; one Archie per room. */
  speaker: string;
  text: string;
}


/** One row in the activation log. Every trigger candidate is logged, suppressed or not. */
export interface ActivationLog {
  at: string;
  // = VoiceTransport.sessionId, the log filename. Older rows spell it `botId` — same id.
  sessionId: string;
  speaker: string;
  /** The completed turn under consideration. */
  candidate: string;
  /**
   * Which tier decided:
   * `name` — a trigger variant matched, no model call.
   * `follow-up` — bot spoke last, this arrived shortly after.
   * `model` — neither free tier fired; `wasAddressed` was asked.
   * `already-owed` — response already owed, no tier ran; logged for the window the answer formed from.
   *
   * Absent for a candidate recorded before any decision path.
   */
  tier?: 'name' | 'follow-up' | 'model' | 'already-owed';
  /** Which variant matched, when the `name` tier decided. */
  matched?: string;
  verdict: 'addressed' | 'suppressed' | 'error';
  /** What was spoken, once the response is known. */
  answer?: string;
  timings?: Record<string, number>;
  error?: string;
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
  /** Push a complete sentence or clause; may repeat. `onSentenceComplete` fires once this sentence's audio is fully handed to `onPcm` — synthesis, not room-heard ({@link AudioSink.playedBytes} measures that). Required: the caller anchors an interrupted answer's record on it, so a synthesizer that cannot report per-sentence completion cannot implement this interface. */
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

/**
 * Sink for audio going into the meeting, supplied by the transport. Recall's
 * implementation is `src/connectors/recall/audio-out.ts`.
 */
export interface AudioSink {
  /** Queue PCM16 mono 24kHz for playback in the meeting. Ignored while disabled. */
  play(pcm: Buffer): void;
  /** Drop everything queued and stop immediately (barge-in). */
  cut(): void;
  /** Output gate: whether anything we produce may reach the meeting. Defaults closed; only the transport opens it, once it has a live meeting (Recall does so on browser-attach). Conversation closes it only on teardown. Not what decides when the bot talks — that's room silence in meeting.ts, the coarser gate underneath it. */
  setEnabled(open: boolean): void;
  /** Whether Archie is engaged — the video tile: addressed-and-undischarged, or just-spoke with the follow-up window still open; grey otherwise. Distinct from `setEnabled` (opens once for the whole meeting, no per-turn state). Optional — a phone transport has no video cue for it. Never reroute into speech or chat. */
  setEngaged?(engaged: boolean): void;
  /** True while audio is queued or playing. */
  isSpeaking(): boolean;
  /** Cumulative PCM bytes, in `play()`'s stream, certainly already heard. Monotonic, never reset by `cut()` — diff two reads, don't trust one. Absent if the transport can't measure it. Conservative: counts only once past the pipeline tail. Under-counting is safe, over-counting isn't — opposite bias from {@link isSpeaking}. */
  playedBytes?(): number;
}

/**
 * What a transport supplies: a name, somewhere for speech, and (if any) text. `meeting.ts` never learns how it's connected. Recall's implementation: `src/connectors/recall/index.ts`. ASR and synthesis are a separate seam (`deepgram.ts`, `soniox.ts`).
 *
 * Audio flows in through `Meeting.onAudio`, not pulled — the transport calls the meeting, never the reverse. One participant is the simplest case: a telephone stream is a single speaker — room silence with N=1.
 */
export interface VoiceTransport {
  // Stable id: names the log lines and the activation log. Opaque — a transport may reuse whatever handle it has (Recall passes its bot id).
  sessionId: string;
  /** Where the bot's speech goes. */
  sink: AudioSink;
  /** Post text into the meeting: detail an answer won't speak (identifiers, hashes, paths, figures), and, on voice failure, the answer itself. Absent means no text channel — `meeting.ts` decides what happens then (`safeSendChat`, `answerWithoutVoice`). */
  sendChat?: (text: string) => Promise<void>;
}

/**
 * How a meeting reaches the rest of Archie. Absent for an unbound meeting — the manual POST entry point still works, unrecorded.
 *
 * Every method: sync void, never throws or rejects — the caller is Flux's end-of-turn reaction (~300ms), too fast for a disk write. No global `unhandledRejection` handler exists in `src/`; one uncaught rejection kills every other task and meeting.
 *
 * {@link MeetingHost.readWrittenExchange} is the exception: a pull, so it returns a promise. Called only from the model-and-speech turn, never end-of-turn, and must still never reject.
 */
export interface MeetingHost {
  /** One finalised line of what the room heard. Archie's own turns included. */
  recordUtterance(speaker: string, text: string): void;
  /** One line Archie posted into the meeting's chat — see {@link WrittenLine}. Separate from `recordUtterance` (different files: `transcript.log`, `chat.log`). The only record: a `CHAT:` reply lives nowhere else — not the transcript, `exchange.log`, `knowledge.log`, or `events.jsonl`. Without this, it's gone. */
  recordChat(speaker: string, text: string): void;
  /** The task's written exchange — Slack thread, or CLI conversation if none — as {@link WrittenLine}s, oldest first. Read fresh every turn, the only async method here: a cache could go stale silently, and one read costs microseconds against the model call it precedes. Safe because it's called only from `answerRoom`, already mid-async — never the audio path the other methods answer on. Resolves to an empty array on failure, never rejects. */
  readWrittenExchange(): Promise<WrittenLine[]>;
  /** A fact worth keeping outside the meeting: started, ended, question asked. */
  noteEvent(text: string): void;
  /**
   * Ask the PM. Returns immediately; the answer arrives via deliverConsultAnswer
   * carrying the same id. If undeliverable, the host must deliver a synthetic
   * answer on that id — never leave it silent.
   */
  consult(id: string, question: string): void;
  /** Archie decided to leave; the farewell has already been spoken in full — see `routeLeave`, the only caller. The host arranges the actual end on its own schedule, not inline. No arguments: id and task are closed over by `createTaskHost` (`task-binding.ts`); the farewell is already in the transcript (`recordUtterance` runs first). No host: dropped with a debug line — the unbound manual-entry meeting stays on the call. */
  leaveMeeting(): void;
}
