/**
 * comprehension.ts — decides whether Archie speaks, where the answer comes from, and what it says aloud versus posts to chat.
 *
 * *When* to speak lives in `meeting.ts`; *what the conversation means* lives here, in the model.
 *
 * {@link runTriageGate} and {@link decideResponse} share {@link buildSpeakingUserMessage}, reasoning over the same window. {@link summariseCapabilities} runs once at join, not part of a turn.
 *
 * Two rules:
 *
 *  1. **Every failure biases to silence.** Timeout, bad status, unparseable reply, missing prompt file all resolve to `false` / `null` / `''`; none throws.
 *  2. **The prompts are the contract, not this file.** Reasoning lives in `prompts/voice-addressing.md`, `prompts/voice-triage.md`, `prompts/voice-speaking.md`, `prompts/voice-capabilities.md`; this module only loads, frames, and parses. No prompt prose in TypeScript.
 */

import { logger } from '../system/logger.js';
import { loadPrompt } from '../utils/prompt-loader.js';
import type { RosterEntry, VoiceConfig, WrittenLine } from './types.js';

const LOG = 'voice-comprehension';

/** How much of a failing response body reaches the log. */
const MAX_ERROR_BODY = 500;

/** Runs on every candidate turn: a verdict not back in five seconds has lost its turn. */
const ADDRESSING_TIMEOUT_MS = 5_000;
const ADDRESSING_MAX_TOKENS = 64;

/**
 * A guard against a hung socket, not a latency budget — every ms of this call is silence before Archie's first word.
 *
 * 1500ms clears the two measured bounds by ~250ms: admission latency (slow mode ~1150ms) plus generation (capped at {@link TRIAGE_MAX_TOKENS}, ≤103ms).
 *
 * Copied in `tools/voice-cases/triage.mjs` as `PRODUCTION_TRIAGE_DEADLINE_MS`; `triage.test.ts` reads this source and fails on drift.
 */
const TRIAGE_TIMEOUT_MS = 1500;

/** `{"where": "outside", "preamble": "..."}`, a few dozen tokens. Roomy: Russian tokenizes heavier than English, and a reply cut mid-string is unparseable, losing the whole verdict. */
const TRIAGE_MAX_TOKENS = 96;

/** Speaking has no deadline — if the room never goes quiet, Archie never speaks. Only stops a hung connection holding the owe flag open. `SPEAKING_MAX_TOKENS` is headroom, not a target: `voice-speaking.md` sets no length cap. */
const SPEAKING_TIMEOUT_MS = 15_000;
const SPEAKING_MAX_TOKENS = 600;

/**
 * Runs once, at join, with nobody waiting — the room owes nothing until somebody says the name — so this deadline can be generous, only stopping a hung connection from leaving the promise pending.
 *
 * `CAPABILITY_MAX_TOKENS` fits one short line per capability (two dozen or so) plus a Russian rendering. Running out truncates the final line, not the whole summary — prose, not JSON.
 */
const CAPABILITY_TIMEOUT_MS = 20_000;
const CAPABILITY_MAX_TOKENS = 900;

/** The literal token `voice-speaking.md` returns for "say nothing". */
const SILENCE_TOKEN = 'SILENCE';

/**
 * Markers opening a trailing section of a speaking reply — everything before the first line with one is spoken; each section runs to the next marker or the reply's end.
 *
 * `CHAT:` carries detail not spoken (hashes, paths, exact figures); `PM:` carries a question for the PM; `LEAVE:` carries nothing — its presence alone marks Archie's last turn, acted on once the speech ahead of it reaches the room (`routeLeave`).
 *
 * Exported so `tools/voice-cases/` finds where the spoken region ends in the model's raw, pre-markdown-strip text.
 */
const CHAT_MARKER = 'CHAT:';
const PM_MARKER = 'PM:';
const LEAVE_MARKER = 'LEAVE:';
export const TAIL_MARKERS = [CHAT_MARKER, PM_MARKER, LEAVE_MARKER] as const;
type TailMarker = (typeof TAIL_MARKERS)[number];

/** Which marker, if any, opens this line. */
function markerOf(line: string): TailMarker | null {
  const trimmed = line.trimStart();
  for (const marker of TAIL_MARKERS) {
    if (trimmed.startsWith(marker)) {
      return marker;
    }
  }
  return null;
}

/**
 * Tags around reasoning the agent chooses not to speak — see {@link Response.thought} for the content, {@link stripThinkBlocks} for how it's found.
 *
 * Unlike TAIL_MARKERS, not line-anchored: opens/closes mid-line, can bracket a single word, and speech resumes once closed. Optional, never forced — see `voice-speaking.md`.
 */
const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/**
 * What to say, and optionally what to post.
 *
 * Shadows the global `Response` (this module calls `fetch` too) — no conflict today, but a future annotated fetch result should use `globalThis.Response`.
 */
export interface Response {
  /** Spoken aloud. Never empty when a Response is returned. */
  speech: string;
  /** Posted to the meeting chat, never spoken. Absent when there is no detail. */
  chat?: string;
  /** A question for the PM. Fire-and-forget: `meeting.ts` routes it through `MeetingHost.consult`; the answer arrives later via `deliverConsultAnswer`. Absent when the reply had no `PM:` section. */
  pm?: string;
  /** Present and `true` when the reply carried a `LEAVE:` marker. Unlike `pm`, doesn't survive a reply with nothing spoken — see {@link parseReply}. Not permission to leave itself: `meeting.ts`'s `routeLeave` acts on it only once the speech above has fully reached the room. */
  leave?: boolean;
  /**
   * Concatenated `<think>...</think>` block content, in order, joined by blank lines. Absent when none. Never spoken or posted — for the activation log (`recordAnswer` in `meeting.ts`).
   *
   * Survives even when nothing is spoken, like `pm` (see {@link Decision.silence}): a silent turn's reasoning is worth keeping too.
   */
  thought?: string;
}

/**
 * The outcome of one speaking decision.
 *
 * A union rather than `Response | null`: null would conflate chose-silence, call-failed, and call-abandoned. A stream dying mid-answer, after sentences already reached the room as audio, is not "decided to say nothing" — the transcript still needs those words.
 *
 * The failure carries how much of the answer had already gone out.
 */
export type Decision =
  | { outcome: 'speak'; response: Response }
  | {
      /** The model read the window and concluded the room does not need us. */
      outcome: 'silence';
      /** A `PM:` question riding on a reply with nothing spoken — survives when `CHAT:` and `LEAVE:` don't, see {@link parseReply}. Fire-and-forget, same as {@link Response.pm}. Absent for ordinary silence. */
      pm?: string;
      /** Reasoning behind the silence, when the reply carried a `<think>` block — same shape as {@link Response.thought}. Absent when the reply carried no block. */
      thought?: string;
    }
  | {
      outcome: 'failed';
      /** Why, for the activation log. Never contains the API key. */
      why: string;
      /** Sentences already handed to `onSentence` before the failure. Non-zero means the room may have heard part of an answer — different from saying nothing at all. */
      handedOver: number;
    };

/**
 * Whether the bot was addressed. Cheap gate, biases hard to false.
 *
 * The prompt decides; this guarantees the bias: only an explicit boolean `true` in a parseable reply returns true — a garbled answer, a refusal, a timeout, or an outage are all "no".
 */
export async function wasAddressed(
  cfg: VoiceConfig,
  opts: { transcript: string; utterance: string }
): Promise<boolean> {
  const utterance = opts.utterance.trim();
  if (utterance.length === 0) {
    return false; // Nothing to judge; not worth a round trip.
  }

  const startedAt = Date.now();
  let system: string;
  try {
    system = await loadPrompt('voice-addressing', { BOT_NAME: cfg.botName });
  } catch (error) {
    logger.error(LOG, 'Could not load prompts/voice-addressing.md', error);
    return false;
  }

  // Transcript and utterance are untrusted meeting speech on a path ending in the bot talking aloud. Tagging keeps that boundary structural, not just prose.
  const user = [
    'Conversation so far, one utterance per line:',
    '',
    '<transcript>',
    opts.transcript.trim().length > 0 ? opts.transcript.trim() : '(nothing transcribed yet)',
    '</transcript>',
    '',
    'The utterance to judge:',
    '',
    '<utterance>',
    utterance,
    '</utterance>',
  ].join('\n');

  const raw = await callModel({
    cfg,
    label: 'addressing',
    system,
    user,
    maxTokens: ADDRESSING_MAX_TOKENS,
    timeoutMs: ADDRESSING_TIMEOUT_MS,
  });

  const elapsed = Date.now() - startedAt;
  if (raw === null) {
    return false; // callModel has already logged why.
  }

  const addressed = parseAddressed(raw);
  logger.debug(
    LOG,
    `Addressing gate: ${addressed ? 'ADDRESSED' : 'not addressed'} in ${elapsed}ms`
  );
  return addressed;
}

/**
 * The four places an answer can come from, per `voice-triage.md` — the whole of what {@link parseTriage} accepts. One array, not a hand-repeated union, same reason as {@link TAIL_MARKERS}: a fifth verdict must fail to compile, not get forgotten in the parser or in {@link SITUATION}.
 */
const TRIAGE_WHERE = ['room', 'outside', 'pending', 'elsewhere'] as const;

/**
 * Where the answer to what was just asked has to come from — never the answer itself.
 *
 * `preamble` rides only on `outside` — one sentence Archie says aloud *now* while it looks. Already sanitised ({@link toSpeech}), never empty when present.
 */
export interface TriageVerdict {
  where: (typeof TRIAGE_WHERE)[number];
  /** One short sentence to say aloud while the answer is fetched. Absent on every other verdict, and on an `outside` reply that carried none. */
  preamble?: string;
}

/**
 * Decides where the answer has to come from — never what it is. A third call, between the addressing gate and the speaking call.
 *
 * `null` is the fail-safe: call failed, timed out, or came back unreadable — the caller does exactly what it did before this gate existed. Not a fifth verdict — a bug here must never mute Archie or skip a consult — logged as degraded-but-recovered.
 */
export async function runTriageGate(
  cfg: VoiceConfig,
  opts: {
    transcript: string;
    /** The consult exchange so far, rendered exactly as the speaking call renders it — tells `pending` from `outside`. See {@link decideResponse}. */
    consults?: { id: string; question: string; answer?: string }[];
    /** The rest of the turn's context, rendered exactly as the speaking call renders it — see {@link SpeakingContext}. `meeting.ts` hands both calls the same snapshot. */
    context?: SpeakingContext;
  },
): Promise<TriageVerdict | null> {
  const transcript = opts.transcript.trim();
  if (transcript.length === 0) {
    return null; // Nothing to place; not worth a round trip.
  }

  const startedAt = Date.now();
  let system: string;
  try {
    system = await loadPrompt('voice-triage', { BOT_NAME: cfg.botName });
  } catch (error) {
    logger.error(LOG, 'Could not load prompts/voice-triage.md', error);
    return null;
  }

  const raw = await callModel({
    cfg,
    label: 'triage',
    system,
    user: buildSpeakingUserMessage(transcript, opts.consults, opts.context),
    maxTokens: TRIAGE_MAX_TOKENS,
    timeoutMs: TRIAGE_TIMEOUT_MS,
  });

  const elapsed = Date.now() - startedAt;
  if (raw === null) {
    // callModel already logged the cause; this is the consequence.
    logger.warn(
      LOG,
      `Triage gate: no verdict in ${elapsed}ms — this turn runs exactly as it would with no triage at all`
    );
    return null;
  }

  const verdict = parseTriage(raw);
  if (verdict === null) {
    logger.warn(
      LOG,
      `Triage gate: unusable reply in ${elapsed}ms, so this turn runs exactly as it would with no triage at all: ${raw.slice(0, 120)}`
    );
    return null;
  }

  const withPreamble = verdict.preamble === undefined ? '' : ' with a preamble';
  logger.debug(
    LOG,
    `Triage gate: ${verdict.where}${withPreamble} in ${elapsed}ms`
  );
  return verdict;
}

/**
 * The window → what to say. See {@link Decision}: `silence` and `failed` are deliberately not the same answer.
 *
 * Called when the room has gone quiet and the bot owes it a response — the whole conversation since being addressed goes in, and the model decides what the room settled on, which can come back as `silence`.
 *
 * A reply may carry trailing `CHAT:`, `PM:`, `LEAVE:` lines and `<think>...</think>` blocks — see {@link Response}, {@link parseReply}. `onSentence` fires per complete sentence, sanitised spoken text only, before the rest is written.
 *
 * `triage` is this turn's verdict from the gate ahead, passed in rather than recomputed. Only one sentence of fact reaches the model, not the verdict name — see {@link SITUATION}.
 */
export async function decideResponse(
  cfg: VoiceConfig,
  opts: {
    transcript: string;
    /** Called with each complete sentence as it is generated. */
    onSentence?: (text: string) => void;
    /** Questions asked of the PM and answers back, kept whole so a follow-up still has the trail. Absent or empty omits the block — a byte-for-byte no-op until a meeting can consult the PM. */
    consults?: { id: string; question: string; answer?: string }[];
    /** The rest of the turn's context — see {@link SpeakingContext}. Every field omits its block entirely rather than rendering it empty, same as `consults`. */
    context?: SpeakingContext;
    /** What {@link runTriageGate} said about this turn, passed straight through. Null (the gate's fail-safe) and absent render nothing — a turn with no verdict sends exactly what it sent before the gate existed. */
    triage?: TriageVerdict | null;
    /**
     * True when a question of this meeting's is already out and unanswered, so any `PM:` line this reply writes is refused — `routeConsult` in `meeting.ts` owns that cap.
     *
     * Not on {@link SpeakingContext}: that bag goes to the triage gate unchanged. Absent is false. See {@link CONSULT_BLOCKED_SITUATION}.
     */
    consultBlocked?: boolean;
  }
): Promise<Decision> {
  const transcript = opts.transcript.trim();
  if (transcript.length === 0) {
    // Nothing to reason about — a decision, not a fault: no conversation means nothing owed.
    return { outcome: 'silence' };
  }

  const startedAt = Date.now();
  let prompt: string;
  try {
    prompt = await loadPrompt('voice-speaking', { BOT_NAME: cfg.botName });
  } catch (error) {
    logger.error(LOG, 'Could not load prompts/voice-speaking.md', error);
    return { outcome: 'failed', why: 'the speaking prompt could not be loaded', handedOver: 0 };
  }

  // Which half carries the guidance is a live experiment arm, defaulting to what production has always sent — see {@link SpeakingPlacement}.
  const { system, user } = assembleSpeakingRequest({
    prompt,
    transcript,
    consults: opts.consults,
    context: opts.context,
    triage: opts.triage,
    consultBlocked: opts.consultBlocked,
  });

  const emitter = opts.onSentence === undefined ? null : new SentenceEmitter(opts.onSentence);
  let firstSentenceAt: number | null = null;
  const streamed = await streamModel(
    {
      cfg,
      label: 'speaking',
      system,
      user,
      maxTokens: SPEAKING_MAX_TOKENS,
      timeoutMs: SPEAKING_TIMEOUT_MS,
    },
    (delta) => {
      const before = emitter?.emitted ?? 0;
      emitter?.push(delta);
      if (firstSentenceAt === null && (emitter?.emitted ?? 0) > before) {
        firstSentenceAt = Date.now() - startedAt;
      }
    }
  );

  const elapsed = Date.now() - startedAt;
  if (!streamed.ok) {
    // streamModel already logged why. A stream dying mid-reply may have already handed sentences over — audible in the room, not "decided to say nothing".
    const handedOver = emitter?.emitted ?? 0;
    logger.debug(
      LOG,
      `The speaking decision failed after ${elapsed}ms with ${handedOver} sentence(s) already handed over — ${streamed.why}`
    );
    return { outcome: 'failed', why: streamed.why, handedOver };
  }

  // Parsed before the emitter flushes, so a reply that's nothing can never have its tail spoken — gating already prevents it; this ordering makes it impossible, not just unlikely.
  const decided = parseReply(streamed.text);
  if (decided.outcome === 'silence') {
    if ((emitter?.emitted ?? 0) > 0) {
      // Gating bug: something was spoken for a reply that resolves to silence.
      logger.error(
        LOG,
        `Emitted ${emitter?.emitted} sentence(s) for a reply that parsed as nothing — check the emitter gating`
      );
    }
    const pmNote = decided.pm === undefined ? '' : ', routing a PM question';
    logger.debug(LOG, `Decided to say nothing in ${elapsed}ms${pmNote}`);
    return decided;
  } else {
    emitter?.finish();
    const detail = decided.response.chat === undefined ? '' : ` plus ${decided.response.chat.length} chars of chat`;
    const first = firstSentenceAt === null ? '' : `, first sentence at ${firstSentenceAt}ms`;
    logger.debug(
      LOG,
      `Decided to speak ${decided.response.speech.length} chars${detail} in ${elapsed}ms${first}`
    );
    return decided;
  }
}

/**
 * Everything about the meeting that isn't the transcript or consult exchange — standing facts a turn is decided against, not the moment it's decided in. Snapshotted once per turn by `meeting.ts`, handed identically to both calls.
 *
 * Every field is optional and renders nothing when empty — never an empty block. See {@link consultsBlock}: an empty `<participants></participants>` claims nobody is in the room; an absent block is silence.
 *
 * The triage verdict isn't a field here: this object goes to both calls unchanged — the wrong home for the one thing only the speaking call may see. See {@link situationBlock}.
 */
export interface SpeakingContext {
  /**
   * Who is in the room, muted and silent ones included — see {@link RosterEntry} for why the medium can't work this out itself.
   *
   * Names arrive already sanitised: `meeting.ts` cleans them at the inbound boundary, same funnel a speaking participant's name goes through.
   */
  participants?: readonly RosterEntry[];
  /**
   * What reached Archie or the room in writing — see {@link WrittenLine}.
   *
   * Its own block, never folded into `<transcript>` — load-bearing: `parseReply` keeps `CHAT:` text out of the spoken transcript so Archie can't believe it said what it only wrote.
   */
  written?: readonly WrittenLine[];
  /**
   * What Archie can go find out, in plain language, summarised once at the start of the meeting (see `capabilities.ts`).
   *
   * A single opaque string, not a list — the summarising call, not this file or the prompt, owns its shape. Empty means the summary failed or hasn't landed, rendering no block.
   */
  capabilities?: string;
}

/**
 * Every field of {@link SpeakingContext} as a value, not just a type — lets the case harness (`tools/voice-cases/`) pin fixed values and assert full coverage, so an unpinned field fails a test.
 *
 * The `Unpinned` assertion below is the other half: `tsc` fails if {@link SpeakingContext} grows a field this array doesn't name — a fourth block can't be added on one side only. Do not "tidy" either away.
 */
export const SPEAKING_CONTEXT_FIELDS = ['participants', 'written', 'capabilities'] as const;
type UnlistedContextField = Exclude<keyof Required<SpeakingContext>, (typeof SPEAKING_CONTEXT_FIELDS)[number]>;
// Type-level assertion, no runtime effect: `never` on the left means every field is listed.
const _everyContextFieldIsListed: [UnlistedContextField] extends [never] ? true : never = true;
void _everyContextFieldIsListed;

/**
 * Where the guidance sits relative to the data it reasons over — an arm to measure, not a setting to tune.
 *
 * `guidance-first` (production's default): all of `voice-speaking.md` as system, then transcript and standing blocks as user. `data-first`: only the opening statement of role as system; everything from the first `## ` heading moved to the end of the user message.
 *
 * The guidance's own words must not change while measuring — moved, never rewritten. {@link splitSpeakingPrompt} cuts at a heading for the same reason: no second copy of the prose to keep in step.
 *
 * `data-first`'s system message is one sentence, so no cacheable prefix exists under it. The triage gate is untouched by either arm: {@link buildSpeakingUserMessage}, shared by both calls, never carries speaking guidance.
 */
export type SpeakingPlacement = 'guidance-first' | 'data-first';

/** Environment variable selecting the arm, read per request — the harness runs both arms as separate processes, so a deployment sets one variable rather than changing code. */
const PLACEMENT_ENV = 'ARCHIE_VOICE_PROMPT_PLACEMENT';

/**
 * Which arm is selected. An unrecognised value is a typo, not an instruction — reported and ignored: silently reading `data_first` as "default" would look like the switch working while a run collected against the wrong arm.
 *
 * Pure in its argument; only its caller, {@link assembleSpeakingRequest}, reads the environment.
 */
export function resolveSpeakingPlacement(raw: string | undefined): SpeakingPlacement {
  const value = (raw ?? '').trim().toLowerCase();
  if (value.length === 0 || value === 'guidance-first') {
    return 'guidance-first';
  } else if (value === 'data-first') {
    return 'data-first';
  } else {
    logger.warn(
      LOG,
      `${PLACEMENT_ENV}="${raw}" is not a known placement — using guidance-first, which is what production sends`
    );
    return 'guidance-first';
  }
}

/**
 * Cut the speaking prompt into its opening statement of role and everything after, at the first `## ` heading.
 *
 * A structural seam, not a delimiter added to the file — neither arm can drift from the other via an edit to one copy of the prose.
 *
 * No heading means no seam: `guidance` comes back empty, and {@link assembleSpeakingRequest} sends both arms identically instead of an empty guidance block — a measurement of nothing, so it's logged.
 */
export function splitSpeakingPrompt(prompt: string): { role: string; guidance: string } {
  const lines = prompt.split(/\r?\n/);
  const firstHeading = lines.findIndex((line) => line.startsWith('## '));
  if (firstHeading === -1) {
    return { role: prompt.trim(), guidance: '' };
  }
  return {
    role: lines.slice(0, firstHeading).join('\n').trim(),
    guidance: lines.slice(firstHeading).join('\n').trim(),
  };
}

/**
 * What each triage verdict means, as one statement of fact about this turn, in the second person — sentences, not verdict names (the model was never taught the names), and none an instruction: each states what's true and stops.
 *
 * Worded to stay true even when the verdict is wrong — only two claim shapes are safe: "you do not have X" (the transcript can refute it) and "you need not do X" (not doing something always satisfies it).
 *
 * A `Record` over {@link TRIAGE_WHERE}'s union, not a lookup with a fallback, so a fifth verdict fails to compile rather than silently rendering nothing.
 *
 * **Every string is pinned byte-for-byte in `situation-block.test.ts`.** Editing one is a prompt edit; re-run the case suite, don't trust a single case that moves.
 */
const SITUATION: Record<TriageVerdict['where'], string> = {
  room: 'Whatever there is to go on is already in front of you, and what you have just been asked does not have to be looked up anywhere.',
  outside: 'Nobody here has supplied what you have just been asked, and it is something you can go and find out.',
  pending:
    'What you have just been asked is already one of the questions you have out, and nothing has come back yet.',
  elsewhere:
    'Nobody here has supplied what you have just been asked, and nothing you could go and find out would settle it.',
};

/**
 * The one situation that is not a verdict: a question of this meeting's is already out and unanswered, so `meeting.ts` refuses whatever `PM:` line this turn writes — see `routeConsult` for the cap.
 *
 * Not a fifth row of {@link SITUATION} — true or false independent of where the gate placed the answer: a modifier on one of the four, not a verdict {@link parseTriage} would accept.
 *
 * Replaces the `outside` line specifically: `outside` ends "it is something you can go and find out", false when no question can leave the room. `pending`/`room`/`elsewhere` are untouched: already true, or nothing was going out anyway.
 *
 * Pinned byte-for-byte in `situation-block.test.ts` beside the four SITUATION strings.
 */
const CONSULT_BLOCKED_SITUATION =
  'A question is already out and has not come back, so a second one cannot leave this room yet — answer from what is already here, or say plainly that you are still waiting on the first.';

/**
 * Render the turn's triage verdict as its own block, or nothing. Absent for a null or missing verdict — the absence, not an empty block, is the fail-safe.
 *
 * Called only from {@link assembleSpeakingRequest}: the gate frames its own request with {@link buildSpeakingUserMessage} directly (no verdict parameter), so a verdict block there is structurally impossible.
 *
 * `consultBlocked` picks which line renders, never whether the block does — can't resurrect a block a null verdict suppressed. See {@link CONSULT_BLOCKED_SITUATION}.
 */
function situationBlock(triage: TriageVerdict | null | undefined, consultBlocked: boolean): string[] {
  if (triage === undefined || triage === null) {
    return [];
  }
  // Only `outside` claims something can be gone and found out, so only `outside` is the line to replace.
  const line =
    consultBlocked && triage.where === 'outside' ? CONSULT_BLOCKED_SITUATION : SITUATION[triage.where];
  return ['', '<situation>', line, '</situation>'];
}

/**
 * The two halves of one speaking request, assembled for the selected arm. See {@link SpeakingPlacement}.
 *
 * `prompt` arrives already loaded and substituted — the caller's job (production via `loadPrompt`; `tools/voice-cases/promptio.mjs` hard-fails on an unsubstituted variable) — so both arms can be pinned byte-for-byte in a test.
 *
 * `<situation>` is appended here, not in the shared builder: it keeps a verdict off the gate's own message ({@link situationBlock}) and is a fact about this turn, not the meeting. Lands after every standing block, before the guidance under `data-first` — nearest the answer, where a short sentence is worth most.
 */
export function assembleSpeakingRequest(args: {
  prompt: string;
  transcript: string;
  consults?: { id: string; question: string; answer?: string }[];
  context?: SpeakingContext;
  /** This turn's triage verdict, or null/absent when the gate produced none. Renders {@link SITUATION}'s one line for the verdict, nothing at all when there isn't one. */
  triage?: TriageVerdict | null;
  /** Whether a question of this meeting's is already out and unanswered, so a `PM:` line this reply writes can't leave the room. Renders {@link CONSULT_BLOCKED_SITUATION} in place of `outside`; absent is false, byte-for-byte identical to before this existed. */
  consultBlocked?: boolean;
  /** Overrides the environment. For tests and for a harness that runs both arms in one process. */
  placement?: SpeakingPlacement;
}): { system: string; user: string } {
  const placement = args.placement ?? resolveSpeakingPlacement(process.env[PLACEMENT_ENV]);
  const user = [
    buildSpeakingUserMessage(args.transcript, args.consults, args.context),
    ...situationBlock(args.triage, args.consultBlocked === true),
  ].join('\n');
  if (placement === 'guidance-first') {
    return { system: args.prompt, user };
  } else {
    const { role, guidance } = splitSpeakingPrompt(args.prompt);
    if (guidance.length === 0) {
      logger.warn(
        LOG,
        'The data-first arm found no `## ` heading in the speaking prompt, so there is no guidance to move — this request is byte-identical to guidance-first'
      );
      return { system: args.prompt, user };
    }
    return { system: role, user: `${user}\n\n${guidance}` };
  }
}

/**
 * Assembles the shared user half: the room's transcript, then every standing block with content. Everything both calls send, nothing either sends alone.
 *
 * Placement-independent: under `data-first`, {@link assembleSpeakingRequest} appends the guidance after this returns, never here — the triage gate sends the same bytes under both arms.
 *
 * Never grows a triage-verdict parameter — a verdict block here would be the gate reading its own answer back. `<situation>` is rendered by {@link assembleSpeakingRequest} instead, which the gate can't call.
 *
 * Block order runs moment-outward: `<transcript>`/`<consults>` (now), `<written>` (may predate the meeting), `<participants>` (current), `<capabilities>` (fixed) — an older meeting renders byte-for-byte as before.
 *
 * Exported so `tools/voice-cases/` shares this instead of hand-porting it — multi-turn fixtures rebuild it every turn.
 */
export function buildSpeakingUserMessage(
  transcript: string,
  consults?: { id: string; question: string; answer?: string }[],
  context?: SpeakingContext,
): string {
  return [
    'Meeting transcript, one utterance per line, most recent last:',
    '',
    '<transcript>',
    transcript,
    '</transcript>',
    ...consultsBlock(consults),
    ...writtenBlock(context?.written),
    ...participantsBlock(context?.participants),
    ...capabilitiesBlock(context?.capabilities),
  ].join('\n');
}

/**
 * Render the consult exchange as its own block, or nothing.
 *
 * Kept apart from `<transcript>`: that tag marks the room's speech as untrusted; the consult exchange is a trusted internal source.
 *
 * The pattern every block below copies: absent entirely rather than emitted empty — different claims, and only one is true when there's nothing to say.
 */
function consultsBlock(consults?: { id: string; question: string; answer?: string }[]): string[] {
  if (consults === undefined || consults.length === 0) {
    return [];
  }
  const lines = consults.map(
    (c) => `${c.id}. Q: ${c.question}\n   A: ${c.answer ?? '(no answer yet)'}`,
  );
  return ['', '<consults>', ...lines, '</consults>'];
}

/**
 * Render the written channel, or nothing.
 *
 * `Speaker: text`, one line each — same shape `transcriptSince` gives the room's speech. The tag alone tells them apart, so it must never be dropped.
 */
function writtenBlock(written?: readonly WrittenLine[]): string[] {
  if (written === undefined || written.length === 0) {
    return [];
  }
  return ['', '<written>', ...written.map((line) => `${line.speaker}: ${line.text}`), '</written>'];
}

/**
 * Render the room's roster, or nothing. Three facts per person, no more: name, host or not, still in the meeting or not. No timestamps — decided in the present tense.
 *
 * A departed participant keeps their line, marked — unmarked, Archie would address an empty chair.
 *
 * `null` renders as explicit "not reported" — a nameless row is still a person, and the count matters even when the name doesn't.
 */
function participantsBlock(participants?: readonly RosterEntry[]): string[] {
  if (participants === undefined || participants.length === 0) {
    return [];
  }
  const lines = participants.map((p) => {
    const name = (p.name ?? '').trim();
    const host = p.is_host === true ? ' (host)' : '';
    const left = p.left_at === null ? '' : ' (has left)';
    return `${name.length > 0 ? name : '(name not reported)'}${host}${left}`;
  });
  return ['', '<participants>', ...lines, '</participants>'];
}

/**
 * Render the capability summary, or nothing.
 *
 * Passed through verbatim — `capabilities.ts`'s summarising call already produced the lines meant to be read. Trimmed only, so whitespace-only counts as no summary.
 */
function capabilitiesBlock(capabilities?: string): string[] {
  const summary = (capabilities ?? '').trim();
  if (summary.length === 0) {
    return [];
  }
  return ['', '<capabilities>', summary, '</capabilities>'];
}

/**
 * Turn a deployment's internal self-description into plain language a voice agent can judge "can I find this out?" against. The one call here not part of a turn: runs once at join, filling {@link SpeakingContext.capabilities} for the meeting.
 *
 * `inputs` arrives already gathered by `capabilities.ts`, framed as data like the transcript. Trusted (this deployment's own plugin repo, not a room), but bound for a live microphone — most descriptions name agents, skills and trigger phrases; a roster string is machinery, so summarising is necessary.
 *
 * Returns empty string on every failure, never throws: a loud failure would let a bad deployment, a rate limit, or a lapsed key stop Archie joining the meeting.
 */
export async function summariseCapabilities(
  cfg: VoiceConfig,
  inputs: {
    /** One `description` per skill, in whatever order they were read. */
    skills: readonly string[];
    /** The PM's own `teamExpertise` — a roster of agent ids and what each knows. */
    teamExpertise: string;
    /** The PM's own `pmIntegrations` — one sentence naming the external systems it can query directly. */
    pmIntegrations: string;
  },
): Promise<string> {
  const skills = inputs.skills.map((s) => s.trim()).filter((s) => s.length > 0);
  const expertise = inputs.teamExpertise.trim();
  const integrations = inputs.pmIntegrations.trim();
  if (skills.length === 0 && expertise.length === 0 && integrations.length === 0) {
    // Nothing to summarise. No plugins is a real configuration, not a fault — silent, not degraded.
    return '';
  }

  const startedAt = Date.now();
  let system: string;
  try {
    system = await loadPrompt('voice-capabilities', { BOT_NAME: cfg.botName });
  } catch (error) {
    logger.error(LOG, 'Could not load prompts/voice-capabilities.md — the meeting runs with no capability block', error);
    return '';
  }

  // Tagged like the transcript, for a different reason: not untrusted, but the summariser needs to tell the three sources apart.
  const user = [
    '<skills>',
    ...skills.map((s) => `- ${s}`),
    '</skills>',
    '',
    '<team>',
    expertise.length > 0 ? expertise : '(none)',
    '</team>',
    '',
    '<integrations>',
    integrations.length > 0 ? integrations : '(none)',
    '</integrations>',
  ].join('\n');

  const raw = await callModel({
    cfg,
    label: 'capabilities',
    system,
    user,
    maxTokens: CAPABILITY_MAX_TOKENS,
    timeoutMs: CAPABILITY_TIMEOUT_MS,
  });

  const elapsed = Date.now() - startedAt;
  if (raw === null) {
    // callModel already logged the cause; this line is the consequence.
    logger.warn(
      LOG,
      `No capability summary after ${elapsed}ms — this meeting runs with no capability block, exactly as it would before this call existed`,
    );
    return '';
  }

  const summary = raw.trim();
  logger.debug(
    LOG,
    `Capability summary: ${summary.length} chars from ${skills.length} skill description(s) in ${elapsed}ms`,
  );
  return summary;
}

/** What {@link parseReply} decided — the same two arms as {@link Decision}, minus `failed`, which belongs to the wire in {@link decideResponse}, never to a reply's *text*. */
type ParsedReply = Extract<Decision, { outcome: 'speak' | 'silence' }>;

/**
 * Splits a speaking reply into what's said, posted, and asked of the PM.
 *
 * Wire format: trailing `CHAT:`/`PM:` lines, not JSON — a stray brace in spoken prose would cost a whole turn.
 *
 * `{ outcome: 'silence' }` when spoken text is empty or the silence token, still carrying a `pm` question if present:
 *
 *  - `PM:` survives — fire-and-forget, never reaches the room.
 *  - `CHAT:`/`LEAVE:` don't — nothing to attach to with no speech (`LEAVE:` via `routeLeave`). Discarded, `CHAT:` with a warning.
 *
 * `<think>...</think>` blocks strip first ({@link stripThinkBlocks}) so a marker inside one isn't mistaken for real.
 *
 * Exported with {@link stripThinkBlocks}, {@link SentenceEmitter} so `tools/voice-cases/` shares this parser.
 */
export function parseReply(raw: string): ParsedReply {
  const { visible, thought, unclosed } = stripThinkBlocks(raw, true);
  if (unclosed) {
    logger.warn(LOG, 'Speaking reply carried an unclosed <think> block — discarding the remainder');
  }

  const lines = visible.split(/\r?\n/);
  // The first line starting with a known marker ends the spoken region; everything from there splits into one section per marker.
  const tailStart = lines.findIndex((line) => markerOf(line) !== null);

  const spokenSource = tailStart === -1 ? visible : lines.slice(0, tailStart).join('\n');
  const sections = tailStart === -1 ? new Map<TailMarker, string>() : splitMarkerSections(lines.slice(tailStart));

  const speech = toSpeech(spokenSource);
  // Not sanitised, only trimmed: read, not spoken — stripping markup would mangle what it carries (paths, hashes, figures, URLs, a PM's question).
  const pm = (sections.get(PM_MARKER) ?? '').trim();
  // Presence alone is the signal: unlike CHAT: and PM:, nothing meaningful follows the colon — an empty section still counts.
  const leave = sections.has(LEAVE_MARKER);

  if (speech.length === 0 || isSilenceToken(speech)) {
    const chat = (sections.get(CHAT_MARKER) ?? '').trim();
    if (chat.length > 0) {
      logger.warn(LOG, 'Speaking reply carried a CHAT: section with nothing spoken — discarding it');
    }
    if (leave) {
      logger.warn(LOG, 'Speaking reply carried a LEAVE: marker with nothing spoken — discarding it');
    }
    const silence: Extract<Decision, { outcome: 'silence' }> = { outcome: 'silence' };
    if (pm.length > 0) {
      silence.pm = pm;
    }
    if (thought.length > 0) {
      silence.thought = thought;
    }
    return silence;
  }

  const response: Response = { speech };
  const chat = (sections.get(CHAT_MARKER) ?? '').trim();
  if (chat.length > 0) {
    response.chat = chat;
  }
  if (pm.length > 0) {
    response.pm = pm;
  }
  if (leave) {
    response.leave = true;
  }
  if (thought.length > 0) {
    response.thought = thought;
  }
  return { outcome: 'speak', response };
}

/**
 * Split the tail — everything from the first marker line onward — into one section per marker, each running to the next marker or the end, marker stripped from its opening line.
 *
 * Captures everything after the marker, not just that line, so wrapped detail isn't lost. First occurrence of a marker wins.
 */
function splitMarkerSections(tailLines: string[]): Map<TailMarker, string> {
  const sections = new Map<TailMarker, string>();
  let current: TailMarker | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (current !== null && !sections.has(current)) {
      sections.set(current, buffer.join('\n'));
    }
  };

  for (const line of tailLines) {
    const marker = markerOf(line);
    if (marker !== null) {
      flush();
      current = marker;
      buffer = [line.trimStart().slice(marker.length)];
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Removes every `<think>...</think>` block from `text` — returns what's left as speech, the removed content concatenated (for {@link Response.thought}), and whether an opening tag was left dangling.
 *
 * Pure, side-effect free: logging is the caller's, so {@link parseReply} warns once despite `SentenceEmitter` rerunning this on the same text as the stream closes.
 *
 * `final` (more text possible or not) flips two verdicts:
 *
 *  - Mid-stream: a trailing partial opening tag (`<thi`, one char from `<think>`) is held out of `visible`; same for a block opened but not yet closed.
 *  - Final: a partial tag was never completing — kept as text. An unclosed block is discarded, with everything after it.
 *
 * Blocks don't nest — the first `</think>` closes the opening tag.
 *
 * Exported for the case harness — see {@link parseReply}'s doc.
 */
export function stripThinkBlocks(
  text: string,
  final: boolean,
): { visible: string; thought: string; unclosed: boolean } {
  let visible = '';
  const thoughts: string[] = [];
  let cursor = 0;
  let unclosed = false;

  for (;;) {
    const openAt = text.indexOf(THINK_OPEN, cursor);
    if (openAt === -1) {
      // No more complete opening tags. What's left might still end in a partial one a later delta could complete.
      const rest = text.slice(cursor);
      const risky = final ? 0 : partialOpenTagAtEnd(rest);
      visible += risky > 0 ? rest.slice(0, rest.length - risky) : rest;
      break;
    }
    visible += text.slice(cursor, openAt);
    const closeAt = text.indexOf(THINK_CLOSE, openAt + THINK_OPEN.length);
    if (closeAt === -1) {
      unclosed = final;
      break;
    }
    thoughts.push(text.slice(openAt + THINK_OPEN.length, closeAt));
    cursor = closeAt + THINK_CLOSE.length;
  }

  return { visible, thought: thoughts.join('\n\n'), unclosed };
}

/**
 * Length of a trailing run of `text` that's a genuine prefix of `<think>` — zero if not. `<thi` may be one delta from a real opening tag, unsafe to hand over as speech; `<xyz` is safe. Longest match wins — a complete `<think>` is found by {@link stripThinkBlocks}'s own `indexOf` first.
 */
function partialOpenTagAtEnd(text: string): number {
  for (let len = Math.min(text.length, THINK_OPEN.length - 1); len > 0; len--) {
    if (text.endsWith(THINK_OPEN.slice(0, len))) {
      return len;
    }
  }
  return 0;
}

/**
 * True when the whole reply is the silence token and nothing else.
 *
 * Tolerant of quoting, lowercasing, a trailing full stop, since mistaking one of those for speech would announce "silence" to the meeting. Matched against the entire reply, never a substring, so an answer that merely mentions silence survives.
 */
function isSilenceToken(text: string): boolean {
  return normaliseForSilence(text) === SILENCE_TOKEN;
}

function normaliseForSilence(text: string): string {
  return text.replace(/[\s."'`*]/g, '').toUpperCase();
}

/**
 * A sentence ends at `!`/`?`, or at a single `.` followed by whitespace or the end of the text.
 *
 * The `$` half is what makes streaming worth anything: the API streams in quanta of ~90 characters, and requiring a following space would mean waiting a further quantum (~315ms measured) — with `(?=\s)` alone, a one-sentence answer reaches the synthesizer only at `finish()`.
 *
 * Two shapes are excluded: an ellipsis (two-plus dots trailing off mid-thought — breaking there hands the synthesizer two utterances where the model wanted a pause), and a `.` before a non-space (the `.` in `3.5` isn't a boundary; `$` can't enforce that at a buffer edge, so `drain` holds it back — see {@link looksUnfinished}). Abbreviations ("Mr. Smith") are a known limitation: one unnatural pause, not a wrong word.
 *
 * Not `/g`: shared by every emitter; a global regex's `lastIndex` persists between calls, corrupting concurrent streams.
 */
const SENTENCE_END = /(?:[!?]+|(?<!\.)\.)(?=\s|$)/;

/**
 * True when the terminator at the very end of `text` might not actually end a sentence.
 *
 * Only asked at a stream buffer's edge, where the character after the terminator ({@link SENTENCE_END}'s check) hasn't arrived. A trailing `.` after a digit is the front half of a number: emitting there would have the room hear "it took three" then "five seconds" — a wrong figure. Holding back costs one delta; `finish()` emits it later if the reply really ended there.
 *
 * `!`/`?` have no such continuation, and an abbreviation at a buffer edge costs the same pause as mid-buffer, so neither is held.
 */
function looksUnfinished(text: string): boolean {
  return /\d\.$/.test(text);
}

/**
 * Turns a reply arriving token by token into complete sentences, handing each out the moment it's whole so speech can start before generation ends.
 *
 * Three things never escape through here, held back structurally, not filtered afterward:
 *
 *  - **The `SILENCE` token** ({@link isSilenceToken}) — unrecognisable from a prefix, so nothing emits while the text so far could still become it.
 *  - **A tail marker's payload** (`CHAT:`, `PM:`, `LEAVE:` — {@link TAIL_MARKERS}) — a line is withheld while it could still open one: a partial marker (`CHA`) or a complete one whose line hasn't ended.
 *  - **A `<think>...</think>` block** ({@link stripThinkBlocks}, called every drain) — can open/close anywhere, so a partial opening tag and an unclosed block's inside are held back until resolved.
 *
 * Exported for the case harness — see {@link parseReply}'s doc.
 */
export class SentenceEmitter {
  private raw = '';
  /** How far into the speech region has already been handed out. */
  private cursor = 0;
  /** True once any tail marker line is seen: no further speech can arrive. */
  private closed = false;
  private count = 0;

  constructor(private readonly onSentence: (text: string) => void) {}

  /** Sentences handed out so far. Used to assert the emitted/returned invariant. */
  get emitted(): number {
    return this.count;
  }

  push(delta: string): void {
    this.raw += delta;
    this.drain(false);
  }

  finish(): void {
    this.drain(true);
  }

  private drain(final: boolean): void {
    // Removed first, same reason `parseReply` does: a marker-looking line inside one must never be mistaken for real, and nothing inside counts toward the silence check below.
    const { visible } = stripThinkBlocks(this.raw, final);

    // Order matters: the region must be computed first — the marker is what tells us speech is complete ahead of the stream ending.
    const region = this.speechRegion(visible, final);
    const settled = final || this.closed;

    if (settled) {
      if (isSilenceToken(region)) {
        return;
      }
    } else if (SILENCE_TOKEN.startsWith(normaliseForSilence(visible))) {
      return; // Still capable of turning out to be the silence token.
    }

    if (region.length < this.cursor) {
      // The region only grows as a prefix; shrinking would mean spoken text was actually chat — impossible given the withholding above.
      logger.error(LOG, 'Speech region shrank below the emitted cursor — refusing to emit further');
      this.cursor = region.length;
      return;
    }

    const pending = region.slice(this.cursor);
    let consumed = 0;
    for (;;) {
      // Searched over the unconsumed tail each time, not by advancing `lastIndex`, so the pattern holds no state between calls.
      const match = SENTENCE_END.exec(pending.slice(consumed));
      if (match === null) {
        break;
      }
      const end = consumed + match.index + match[0].length;
      // A match reaching the very end of what we hold can only be the `$` arm — `\s` needs a following character. Mid-stream that's a buffer edge, not the reply's end, and the regex can't tell — this has to.
      if (end === pending.length && !settled && looksUnfinished(pending)) {
        break;
      }
      this.emit(pending.slice(consumed, end));
      consumed = end;
    }
    if (settled) {
      this.emit(pending.slice(consumed));
      consumed = pending.length;
    }
    this.cursor += consumed;
  }

  /**
   * The part of the reply that is definitely speech and won't be revised. Takes `visible`, already stripped of `<think>` blocks.
   *
   * Sets {@link closed} when a marker turns up, so the last spoken sentence goes out on the marker rather than waiting for the stream to finish. The first line with *any* known marker ends the region; `parseReply` splits the tail by marker once whole.
   */
  private speechRegion(visible: string, final: boolean): string {
    const lines = visible.split('\n');
    // Mid-stream the final element is still being written, so it is not settled.
    const settledCount = final ? lines.length : lines.length - 1;

    for (let i = 0; i < settledCount; i++) {
      if (markerOf(lines[i] ?? '') !== null) {
        this.closed = true;
        return lines.slice(0, i).join('\n');
      }
    }

    if (final) {
      return lines.join('\n');
    } else {
      const partial = (lines[lines.length - 1] ?? '').trimStart();
      // Unsafe both ways for every marker: a prefix may still grow into one, and a complete one may have no newline yet to settle it.
      const risky =
        partial.length > 0 &&
        TAIL_MARKERS.some((marker) => marker.startsWith(partial) || partial.startsWith(marker));
      return (risky ? lines.slice(0, -1) : lines).join('\n');
    }
  }

  private emit(chunk: string): void {
    const spoken = toSpeech(chunk);
    // Punctuation alone is not a sentence — matters since a buffer-edge terminator counts as a boundary: a stream can cut mid-ellipsis, and the trailing dots are the tail of a sentence already emitted.
    if (/[\p{L}\p{N}]/u.test(spoken)) {
      this.count += 1;
      this.onSentence(spoken);
    }
  }
}

/**
 * Extract the verdict from the addressing reply.
 *
 * Only `addressed === true` yields true; everything else is "no". Braces are located rather than the whole string parsed because bare JSON can still arrive wrapped in a code fence, and a fenced `{"addressed": true}` unambiguously means yes.
 */
function parseAddressed(raw: string): boolean {
  const open = raw.indexOf('{');
  const close = raw.lastIndexOf('}');
  if (open === -1 || close <= open) {
    logger.warn(LOG, `Addressing reply carried no JSON object: ${raw.slice(0, 120)}`);
    return false;
  }

  try {
    const parsed = JSON.parse(raw.slice(open, close + 1)) as { addressed?: unknown };
    return parsed.addressed === true;
  } catch {
    logger.warn(LOG, `Addressing reply was not valid JSON: ${raw.slice(0, 120)}`);
    return false;
  }
}

/**
 * Extract the verdict from the triage reply, or null if there isn't one.
 *
 * Braces are located rather than the whole string parsed, same reason as {@link parseAddressed}: bare JSON can arrive wrapped in a code fence. A `where` outside {@link TRIAGE_WHERE} is rejected, not coerced — rounding to the nearest verdict would put a guess where a fail-safe belongs.
 *
 * Logging is the caller's — it has the elapsed time.
 */
function parseTriage(raw: string): TriageVerdict | null {
  const open = raw.indexOf('{');
  const close = raw.lastIndexOf('}');
  if (open === -1 || close <= open) {
    return null;
  }

  let parsed: { where?: unknown; preamble?: unknown };
  try {
    parsed = JSON.parse(raw.slice(open, close + 1)) as typeof parsed;
  } catch {
    return null;
  }

  const where = TRIAGE_WHERE.find((known) => known === parsed.where);
  if (where === undefined) {
    return null;
  }

  const verdict: TriageVerdict = { where };
  if (typeof parsed.preamble === 'string') {
    // Sanitised here, not at the call site — the one place that knows this is bound for speech: an asterisk reads aloud as "star". Absent, not empty, when nothing's left, so `preamble !== undefined` means "there's something to say".
    const preamble = toSpeech(parsed.preamble);
    if (preamble.length > 0) {
      verdict.preamble = preamble;
    }
  }
  return verdict;
}

/**
 * Make text safe to hand to a speech engine.
 *
 * `voice-speaking.md` forbids markdown, but a stray asterisk still reads aloud as "star". Removes formatting, flattens to one spoken line; never shortens — length is the prompt's decision.
 *
 * **Applied to `speech` only, never `chat`.** Chat is read, not spoken, and carries what this would destroy — `retention_policy.expires_at` loses its underscores, a path its slashes, a fenced snippet its backticks.
 */
function toSpeech(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        // Bullets and list numbering, at line start only, so a mid-sentence hyphen in "well-known" is left alone.
        .replace(/^\s*[-+•>]+\s*/, '')
        .replace(/^\s*\d+[.)]\s+/, '')
        // Emphasis, code ticks, headings, table pipes: silent on a page, spoken as words by a speech engine.
        .replace(/[*_`#|~]/g, '')
        .trim()
    )
    .filter((line) => line.length > 0)
    // Speech has no lines. Whatever the layout was, it becomes one utterance.
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Common request arguments for every model call. */
interface ModelCall {
  cfg: VoiceConfig;
  label: string;
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
}

/**
 * Cerebras `gemma-4-31b` over their OpenAI-compatible endpoint.
 *
 * Measured on the wire:
 *
 *  - Errors are a real HTTP status, never in-band — `response.ok` catches every shape; the in-band branch in {@link deltaFrom} exists because an OpenAI-compatible stream may carry one, unfired.
 *  - Error body is flat: `{message, type, param, code}`.
 *  - `stream: true` sends an empty role frame, a final `delta: {}` with `finish_reason`, a usage-only frame, then `data: [DONE]` — all four fall through to null.
 *  - Server time is ~5ms of a 190ms call; latency is network, not the request body.
 */
const MODEL = 'gemma-4-31b';
const MODEL_URL = 'https://api.cerebras.ai/v1/chat/completions';

/** Named in the log lines and in {@link StreamOutcome}'s `why`, so a run of failures reads as a vendor problem rather than a prompt one. */
const VENDOR = 'cerebras';

function requestHeaders(cfg: VoiceConfig): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${cfg.cerebrasApiKey}`,
  };
}

function requestBody(args: ModelCall, stream: boolean): Record<string, unknown> {
  return {
    model: MODEL,
    // Both names accepted, behave identically (verified); this is current, `max_tokens` is the deprecated alias.
    max_completion_tokens: args.maxTokens,
    // Both calls judge a fixed transcript, not write creatively — a reproducible answer is easier to debug from the activation log.
    temperature: 0,
    stream,
    // A message with the system role, not a top-level field.
    messages: [
      { role: 'system', content: args.system },
      { role: 'user', content: args.user },
    ],
  };
}

/** Text out of a non-streaming reply. Empty when the reply carried none. */
function textFrom(payload: unknown): string {
  const reply = payload as { choices?: Array<{ message?: { content?: string } }> };
  return (reply.choices ?? [])
    .map((choice) => choice?.message?.content ?? '')
    .join('')
    .trim();
}

/** Text out of one SSE `data:` payload, prefix stripped. Null for every non-text frame (keep-alives, role/usage frames, the end-of-stream sentinel, any later frame type) — Cerebras's versioning policy requires these be ignored, not treated as a failure. */
function deltaFrom(payload: string): string | null {
  // The documented end-of-stream sentinel, not JSON. Checked before the parse so it's a known frame, not an unreadable one.
  if (payload === '[DONE]') {
    return null;
  }

  let event: {
    choices?: Array<{ delta?: { content?: string } }>;
    message?: string;
    code?: string;
  };
  try {
    event = JSON.parse(payload) as typeof event;
  } catch {
    return null; // One unreadable frame is not worth losing the answer over.
  }

  if (event.choices === undefined && typeof event.message === 'string') {
    // Never observed — every provoked error came back as an HTTP status — but an OpenAI-compatible stream may carry one; noticing costs one branch. Null means no text, read as a failure.
    logger.error(LOG, `Cerebras stream error: ${event.code ?? 'unknown'} ${event.message}`.trim());
    return null;
  }
  return event.choices?.[0]?.delta?.content ?? null;
}

function modelRequest(args: ModelCall, stream: boolean): RequestInit {
  return {
    method: 'POST',
    headers: requestHeaders(args.cfg),
    body: JSON.stringify(requestBody(args, stream)),
    signal: AbortSignal.timeout(args.timeoutMs),
  };
}

/**
 * Either the whole reply, or why it never arrived.
 *
 * The reason travels rather than being logged and dropped: it ends up in the activation-log row. "The decision failed" and "cerebras returned 529" are the same event to the room but very different ones to the corpus — naming the vendor lets a run of failures read as a vendor problem, not a prompt one.
 */
type StreamOutcome =
  | { ok: true; text: string }
  | { ok: false; why: string };

/** A failure worth putting in a log row: the class, then the detail. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    // The name is the load-bearing half — `TimeoutError` is our own deadline expiring, which reads very differently from a socket dropping.
    return `${error.name}: ${error.message}`;
  } else {
    return String(error);
  }
}

/**
 * Stream a reply, handing each delta to `onDelta` as it lands. Returns the complete text, or why it failed.
 *
 * A sentence handed over the moment it's complete moves first-sound off the tail of full generation and onto the tail of the first sentence.
 *
 * On Cerebras that overlap nearly vanishes — the whole reply lands ~55ms after the first token — but this stays streaming regardless: {@link SentenceEmitter} is a correctness mechanism, not a latency one, withholding the silence token and chat payload from speech structurally. A non-streaming path would bypass that reasoning.
 *
 * Never throws and never logs the API key.
 */
async function streamModel(
  args: ModelCall,
  onDelta: (text: string) => void,
): Promise<StreamOutcome> {
  const who = VENDOR;
  try {
    const response = await fetch(MODEL_URL, modelRequest(args, true));
    // Where every failure shape lands; see the in-band branch in {@link deltaFrom} for the one an OpenAI-compatible stream could carry instead.
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, MAX_ERROR_BODY);
      logger.error(LOG, `${args.label}: ${who} returned ${response.status} — ${body}`);
      return { ok: false, why: `${who} returned ${response.status}` };
    }
    if (response.body === null) {
      logger.error(LOG, `${args.label}: ${who} returned no response body`);
      return { ok: false, why: `${who} returned no response body` };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let cut = buffer.indexOf('\n');
        while (cut !== -1) {
          const delta = dataFrameFrom(buffer.slice(0, cut));
          buffer = buffer.slice(cut + 1);
          if (delta !== null) {
            text += delta;
            onDelta(delta);
          }
          cut = buffer.indexOf('\n');
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    if (text.trim().length === 0) {
      logger.warn(LOG, `${args.label}: the ${who} stream carried no text`);
      return { ok: false, why: `${who} streamed no text` };
    } else {
      return { ok: true, text };
    }
  } catch (error) {
    // The one failure that can land *after* deltas were handed on: a timeout or dropped connection mid-reply. See {@link Decision}.
    logger.error(LOG, `${args.label}: the ${who} stream failed`, error);
    return { ok: false, why: `the ${who} stream failed — ${describeError(error)}` };
  }
}

/** Unwrap one SSE line to its `data:` payload and ask {@link deltaFrom} what text is in it, if any. */
function dataFrameFrom(line: string): string | null {
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith('data:')) {
    return null;
  }
  const payload = trimmed.slice('data:'.length).trim();
  if (payload.length === 0) {
    return null;
  }
  return deltaFrom(payload);
}

/**
 * One non-streaming call. Returns the reply text, or null on any failure.
 *
 * Used where the whole reply is short and nothing can act on it until complete — streaming would add a parser and save nothing.
 *
 * Never throws and never logs the API key.
 */
async function callModel(args: ModelCall): Promise<string | null> {
  const who = VENDOR;
  try {
    const response = await fetch(MODEL_URL, modelRequest(args, false));

    if (response.ok) {
      // Parsing the body can throw on a truncated or non-JSON 200; the catch below turns that into the same "no" as everything else — the bias this whole module is built around.
      const text = textFrom(await response.json());
      if (text.length === 0) {
        logger.warn(LOG, `${args.label}: ${who} returned no text content`);
        return null;
      } else {
        return text;
      }
    } else {
      const body = (await response.text().catch(() => '')).slice(0, MAX_ERROR_BODY);
      logger.error(LOG, `${args.label}: ${who} returned ${response.status} — ${body}`);
      return null;
    }
  } catch (error) {
    logger.error(LOG, `${args.label}: the ${who} call failed`, error);
    return null;
  }
}
