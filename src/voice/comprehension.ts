/**
 * comprehension.ts — decides whether Archie speaks, what it says aloud, and what it posts to chat instead.
 *
 * *When* to speak lives in `meeting.ts`; *what the conversation means* lives here, in the model.
 *
 * {@link decideResponse} frames its request with {@link buildSpeakingUserMessage}. {@link summariseCapabilities} runs once at join, not part of a turn.
 *
 * Two rules:
 *
 *  1. **Every failure biases to silence.** Timeout, bad status, unparseable reply, missing prompt file all resolve to `false` / `null` / `''`; none throws.
 *  2. **The prompts are the contract, not this file.** Reasoning lives in `prompts/voice-addressing.md`, `prompts/voice-speaking.md`, `prompts/voice-capabilities.md`; this module only loads, frames, and parses. No prompt prose in TypeScript.
 */

import { logger } from '../system/logger.js';
import { loadPrompt } from '../utils/prompt-loader.js';
import { BOT_NAME } from './types.js';
import type { RosterEntry, VoiceConfig, WrittenLine } from './types.js';

const LOG = 'voice-comprehension';

/** How much of a failing response body reaches the log. */
const MAX_ERROR_BODY = 500;

/** Runs on every candidate turn: a verdict not back in five seconds has lost its turn. */
const ADDRESSING_TIMEOUT_MS = 5_000;
const ADDRESSING_MAX_TOKENS = 64;

/**
 * Speaking has no deadline — if the room never goes quiet, Archie never speaks. Only stops a hung connection holding the owe flag open.
 *
 * `SPEAKING_MAX_TOKENS` is headroom, not a target: `voice-speaking.md` sets no length cap. It has to cover a reasoning pass *and* the answer behind it, since native reasoning tokens are billed and capped as completion tokens — a cap the reasoning alone can reach truncates the spoken answer.
 */
const SPEAKING_TIMEOUT_MS = 15_000;
const SPEAKING_MAX_TOKENS = 2000;

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
   * The model's own reasoning for this turn, returned on its own channel rather than in the reply text, trimmed. Absent when it reasoned about nothing. Never spoken or posted — for the meeting record's `turn` row (`recordAnswer` in `meeting.ts`).
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
      /** Reasoning behind the silence, when the model produced any — same shape as {@link Response.thought}. Absent when it reasoned about nothing. */
      thought?: string;
    }
  | {
      outcome: 'failed';
      /** Why, for the meeting record's `turn` row. Never contains the API key. */
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
    system = await loadPrompt('voice-addressing', { BOT_NAME });
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
 * The window → what to say. See {@link Decision}: `silence` and `failed` are deliberately not the same answer.
 *
 * Called when the room has gone quiet and the bot owes it a response — the whole conversation since being addressed goes in, and the model decides what the room settled on, which can come back as `silence`.
 *
 * A reply may carry trailing `CHAT:`, `PM:`, `LEAVE:` lines — see {@link Response}, {@link parseReply}. The model's reasoning arrives on its own channel, never in the reply text, and lands on the decision as `thought`. `onSentence` fires per complete sentence, sanitised spoken text only, before the rest is written.
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
    prompt = await loadPrompt('voice-speaking', { BOT_NAME });
  } catch (error) {
    logger.error(LOG, 'Could not load prompts/voice-speaking.md', error);
    return { outcome: 'failed', why: 'the speaking prompt could not be loaded', handedOver: 0 };
  }

  const emitter = opts.onSentence === undefined ? null : new SentenceEmitter(opts.onSentence);
  let firstSentenceAt: number | null = null;
  const streamed = await streamModel(
    {
      cfg,
      label: 'speaking',
      system: prompt,
      user: buildSpeakingUserMessage(transcript, opts.consults, opts.context),
      maxTokens: SPEAKING_MAX_TOKENS,
      timeoutMs: SPEAKING_TIMEOUT_MS,
      reasoning: true,
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
  const thought = streamed.reasoning.trim();
  if (decided.outcome === 'silence') {
    if (thought.length > 0) {
      decided.thought = thought;
    }
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
    if (thought.length > 0) {
      decided.response.thought = thought;
    }
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
 * Everything about the meeting that isn't the transcript or consult exchange — standing facts a turn is decided against, not the moment it's decided in. Snapshotted once per turn by `meeting.ts`.
 *
 * Every field is optional and renders nothing when empty — never an empty block. See {@link consultsBlock}: an empty `<participants></participants>` claims nobody is in the room; an absent block is silence.
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
 * Assembles the user half of the speaking request: the room's transcript, then every standing block with content.
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
    system = await loadPrompt('voice-capabilities', { BOT_NAME });
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
 * Reasoning never reaches here: it arrives on its own channel and {@link decideResponse} attaches it to whichever arm this returns.
 *
 * Exported with {@link SentenceEmitter} so `tools/voice-cases/` shares this parser.
 */
export function parseReply(raw: string): ParsedReply {
  const lines = raw.split(/\r?\n/);
  // The first line starting with a known marker ends the spoken region; everything from there splits into one section per marker.
  const tailStart = lines.findIndex((line) => markerOf(line) !== null);

  const spokenSource = tailStart === -1 ? raw : lines.slice(0, tailStart).join('\n');
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
 * Two things never escape through here, held back structurally, not filtered afterward:
 *
 *  - **The `SILENCE` token** ({@link isSilenceToken}) — unrecognisable from a prefix, so nothing emits while the text so far could still become it.
 *  - **A tail marker's payload** (`CHAT:`, `PM:`, `LEAVE:` — {@link TAIL_MARKERS}) — a line is withheld while it could still open one: a partial marker (`CHA`) or a complete one whose line hasn't ended.
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
    // Order matters: the region must be computed first — the marker is what tells us speech is complete ahead of the stream ending.
    const region = this.speechRegion(this.raw, final);
    const settled = final || this.closed;

    if (settled) {
      if (isSilenceToken(region)) {
        return;
      }
    } else if (SILENCE_TOKEN.startsWith(normaliseForSilence(this.raw))) {
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
   * The part of the reply that is definitely speech and won't be revised.
   *
   * Sets {@link closed} when a marker turns up, so the last spoken sentence goes out on the marker rather than waiting for the stream to finish. The first line with *any* known marker ends the region; `parseReply` splits the tail by marker once whole.
   */
  private speechRegion(text: string, final: boolean): string {
    const lines = text.split('\n');
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
  /** Ask for the model's native reasoning, which comes back on its own channel. Only the speaking call does; the others send no such field at all. */
  reasoning?: boolean;
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
  const body: Record<string, unknown> = {
    model: MODEL,
    // Both names accepted, behave identically (verified); this is current, `max_tokens` is the deprecated alias.
    max_completion_tokens: args.maxTokens,
    // Both calls judge a fixed transcript, not write creatively — a reproducible answer is easier to debug from the meeting record.
    temperature: 0,
    stream,
    // A message with the system role, not a top-level field.
    messages: [
      { role: 'system', content: args.system },
      { role: 'user', content: args.user },
    ],
  };
  if (args.reasoning === true) {
    // An on switch, not a dial: gemma defaults to `none`, and `low`/`medium`/`high` are currently equivalent once enabled.
    body.reasoning_effort = 'medium';
  }
  return body;
}

/** Text out of a non-streaming reply. Empty when the reply carried none. */
function textFrom(payload: unknown): string {
  const reply = payload as { choices?: Array<{ message?: { content?: string } }> };
  return (reply.choices ?? [])
    .map((choice) => choice?.message?.content ?? '')
    .join('')
    .trim();
}

/** What one streamed frame carries: `text` is what the room hears, `reasoning` is what it never does. Either, or both. */
interface StreamDelta {
  text?: string;
  reasoning?: string;
}

/** The content and reasoning out of one SSE `data:` payload, prefix stripped. Null for every frame carrying neither (keep-alives, role/usage frames, the end-of-stream sentinel, any later frame type) — Cerebras's versioning policy requires these be ignored, not treated as a failure. */
function deltaFrom(payload: string): StreamDelta | null {
  // The documented end-of-stream sentinel, not JSON. Checked before the parse so it's a known frame, not an unreadable one.
  if (payload === '[DONE]') {
    return null;
  }

  let event: {
    choices?: Array<{ delta?: { content?: string; reasoning?: string } }>;
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

  const delta = event.choices?.[0]?.delta;
  const frame: StreamDelta = {};
  if (typeof delta?.content === 'string') {
    frame.text = delta.content;
  }
  if (typeof delta?.reasoning === 'string') {
    frame.reasoning = delta.reasoning;
  }
  if (frame.text === undefined && frame.reasoning === undefined) {
    return null;
  } else {
    return frame;
  }
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
 * The reason travels rather than being logged and dropped: it ends up on the meeting record's `turn` row. "The decision failed" and "cerebras returned 529" are the same event to the room but very different ones to the corpus — naming the vendor lets a run of failures read as a vendor problem, not a prompt one.
 */
type StreamOutcome =
  | { ok: true; text: string; reasoning: string }
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
 * Stream a reply, handing each content delta to `onText` as it lands. Returns the complete text and whatever reasoning came alongside it, or why it failed.
 *
 * Reasoning deltas are accumulated here and never handed on: nothing downstream may speak them, and the whole of it arrives before the first content token anyway.
 *
 * A sentence handed over the moment it's complete moves first-sound off the tail of full generation and onto the tail of the first sentence.
 *
 * On Cerebras that overlap nearly vanishes — the whole reply lands ~55ms after the first token — but this stays streaming regardless: {@link SentenceEmitter} is a correctness mechanism, not a latency one, withholding the silence token and chat payload from speech structurally. A non-streaming path would bypass that reasoning.
 *
 * Never throws and never logs the API key.
 */
async function streamModel(
  args: ModelCall,
  onText: (text: string) => void,
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
    let reasoning = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let cut = buffer.indexOf('\n');
        while (cut !== -1) {
          const frame = dataFrameFrom(buffer.slice(0, cut));
          buffer = buffer.slice(cut + 1);
          if (frame !== null) {
            if (frame.reasoning !== undefined) {
              reasoning += frame.reasoning;
            }
            if (frame.text !== undefined) {
              text += frame.text;
              onText(frame.text);
            }
          }
          cut = buffer.indexOf('\n');
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    if (text.trim().length === 0) {
      // Reasoning with no answer behind it is the same failure as an empty stream: there is nothing to say.
      logger.warn(LOG, `${args.label}: the ${who} stream carried no text`);
      return { ok: false, why: `${who} streamed no text` };
    } else {
      return { ok: true, text, reasoning };
    }
  } catch (error) {
    // The one failure that can land *after* deltas were handed on: a timeout or dropped connection mid-reply. See {@link Decision}.
    logger.error(LOG, `${args.label}: the ${who} stream failed`, error);
    return { ok: false, why: `the ${who} stream failed — ${describeError(error)}` };
  }
}

/** Unwrap one SSE line to its `data:` payload and ask {@link deltaFrom} what is in it, if anything. */
function dataFrameFrom(line: string): StreamDelta | null {
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
