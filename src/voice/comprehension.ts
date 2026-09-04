// Decides whether Archie speaks, what it says aloud, and what it posts to chat instead. Every failure biases to silence (`false` / `null` / `''`, never a throw), and the prompts are the contract -- this module only loads, frames and parses them.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
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

/** Bounds generating the reply — admission, native reasoning, the full text — not saying it: how long the words then take is the prompt's and the room's business. The call's only bound: it sends no token cap, because reasoning is billed as completion tokens and a cap the reasoning could reach truncates the answer; a hung connection or a runaway is cut here instead. */
const GENERATION_TIMEOUT_MS = 15_000;

/** Runs once at join with nobody waiting, so this is generous — it only stops a hung connection leaving the promise pending. */
const CAPABILITY_TIMEOUT_MS = 20_000;
/** One short line per capability plus a Russian rendering. Running out truncates the last line, not the summary: it is prose, not JSON. */
const CAPABILITY_MAX_TOKENS = 900;

/** The literal token `voice-speaking.md` returns for "say nothing". */
const SILENCE_TOKEN = 'SILENCE';

// Markers opening a trailing section: everything before the first line carrying one is spoken, and each section runs to the next marker or the reply's end. `CHAT:` carries detail not spoken, `PM:` a question for the PM, and `LEAVE:` nothing at all — its presence alone marks Archie's last turn.
const CHAT_MARKER = 'CHAT:';
const PM_MARKER = 'PM:';
const LEAVE_MARKER = 'LEAVE:';
export const TAIL_MARKERS = [CHAT_MARKER, PM_MARKER, LEAVE_MARKER] as const;
type TailMarker = (typeof TAIL_MARKERS)[number];

function markerOf(line: string): TailMarker | null {
  const trimmed = line.trimStart();
  for (const marker of TAIL_MARKERS) {
    if (trimmed.startsWith(marker)) {
      return marker;
    }
  }
  return null;
}

/** What to say, and optionally what to post. Shadows the global `Response` — a future annotated fetch result should use `globalThis.Response`. */
export interface Response {
  /** Spoken aloud. Never empty when a Response is returned. */
  speech: string;
  /** Posted to the meeting chat, never spoken. */
  chat?: string;
  /** Fire-and-forget: `meeting.ts` routes it through `MeetingHost.consult`, and the answer arrives later via `deliverConsultAnswer`. */
  pm?: string;
  /** Not permission to leave: `routeLeave` acts on it only once the answer above has reached the room in full — aloud when speech works, and through the meeting chat when it does not, since a farewell nobody can hear must not hold the departure. */
  leave?: boolean;
  /** The model's own reasoning, on its own channel rather than in the reply text. Never spoken or posted — it is for the meeting record's `turn` row. */
  thought?: string;
}

/** One speaking decision. A union rather than `Response | null`, which would conflate chose-silence, call-failed and call-abandoned: a stream dying after sentences already reached the room is not "decided to say nothing", and the transcript still needs those words. */
export type Decision =
  | { outcome: 'speak'; response: Response }
  | {
      outcome: 'silence';
      /** A `PM:` question riding on a reply with nothing spoken — survives where `CHAT:` and `LEAVE:` don't, see {@link parseReply}. */
      pm?: string;
      thought?: string;
    }
  | {
      outcome: 'failed';
      /** Names the vendor, so a run of failures reads as a vendor problem rather than a prompt one. Never contains the API key. */
      why: string;
      /** Sentences already handed to `onSentence`. Non-zero means the room may have heard part of an answer. */
      handedOver: number;
    };

/** Whether the bot was addressed. Biases hard to false: only an explicit boolean `true` in a parseable reply returns true — a garbled answer, a refusal, a timeout and an outage are all "no". */
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
  logger.debug(LOG, `Addressing gate: ${addressed ? 'ADDRESSED' : 'not addressed'} in ${elapsed}ms`);
  return addressed;
}

/** The window → what to say, once the room has gone quiet and the bot owes it a response. `onSentence` fires per complete sentence, sanitised spoken text only, before the rest is written; the model's reasoning arrives on its own channel and lands on the decision as `thought`. */
export async function decideResponse(
  cfg: VoiceConfig,
  opts: {
    transcript: string;
    onSentence?: (text: string) => void;
    /** Questions asked of the PM and answers back, kept whole so a follow-up still has the trail. */
    consults?: { id: string; question: string; answer?: string }[];
    context?: SpeakingContext;
  }
): Promise<Decision> {
  const transcript = opts.transcript.trim();
  if (transcript.length === 0) {
    // A decision, not a fault: no conversation means nothing owed.
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

  // Both halves of the request come off disk, so both are guarded the same way: a missing or unfillable template is a failed turn with a reason, never a throw out of a module whose whole contract is to bias to silence.
  let user: string;
  try {
    user = buildSpeakingUserMessage(transcript, opts.consults, opts.context);
  } catch (error) {
    logger.error(LOG, 'Could not assemble the request from prompts/voice-speaking-context.md', error);
    return { outcome: 'failed', why: 'the speaking context could not be assembled', handedOver: 0 };
  }

  const emitter = opts.onSentence === undefined ? null : new SentenceEmitter(opts.onSentence);
  let firstSentenceAt: number | null = null;
  const streamed = await streamModel(
    {
      cfg,
      label: 'speaking',
      system: prompt,
      user,
      timeoutMs: GENERATION_TIMEOUT_MS,
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
    // A stream dying mid-reply may have already handed sentences over — audible in the room, not "decided to say nothing".
    const handedOver = emitter?.emitted ?? 0;
    logger.debug(
      LOG,
      `The speaking decision failed after ${elapsed}ms with ${handedOver} sentence(s) already handed over — ${streamed.why}`
    );
    return { outcome: 'failed', why: streamed.why, handedOver };
  }

  // Parsed before the emitter flushes, so a reply that resolves to nothing can never have its tail spoken -- gating already prevents it; this ordering makes it impossible.
  const decided = parseReply(streamed.text);
  const thought = streamed.reasoning.trim();
  if (decided.outcome === 'silence') {
    if (thought.length > 0) {
      decided.thought = thought;
    }
    if ((emitter?.emitted ?? 0) > 0) {
      // Gating bug: something was spoken for a reply that parsed as nothing.
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
    logger.debug(LOG, `Decided to speak ${decided.response.speech.length} chars${detail} in ${elapsed}ms${first}`);
    return decided;
  }
}

/** Standing facts a turn is decided against, snapshotted once per turn by `meeting.ts`. */
export interface SpeakingContext {
  /** Who is in the room, muted and silent ones included. Names arrive already sanitised, at `meeting.ts`'s inbound boundary. */
  participants?: readonly RosterEntry[];
  /** What reached Archie or the room in writing. Its own block, never folded into `<transcript>` — load-bearing, so Archie can't come to believe it said what it only wrote. */
  written?: readonly WrittenLine[];
  /** What Archie can go find out, in plain language. One opaque string: the summarising call owns its shape, not this file. */
  capabilities?: string;
  /** True while Archie's own speech is failing: a turn in this meeting could not be synthesised and went to the meeting chat instead. Absent rather than `false` when speech works — including in a meeting where it has never failed, which must render exactly as it did before this field existed. `meeting.ts` clears it the moment audio reaches the room again. */
  voiceFailed?: boolean;
}

/** Where the user half of the speaking request lives: its intro line, every block's tags and the order they appear in are readable there as text, rather than only as concatenation here. Resolved the way `loadPrompt` resolves the system half — this module sits at `src/voice/` and compiles to `dist/voice/`, so `'../..'` is the repo root either way. */
const SPEAKING_CONTEXT_TEMPLATE = fileURLToPath(new URL('../../prompts/voice-speaking-context.md', import.meta.url));

// The whole body of the `<voice>` block. The one block whose content is fixed and whose only variable is whether it is there at all, which is why it stays here while the rest of the message is in the template: a placeholder is how a block is made to disappear, so this text is what fills the placeholder rather than something the file could state on its own.
// The defect it exists for: a fallback to chat was announced outward and never inward, so the next turn read its own words in `<transcript>` as though they had been spoken and invented a reason for the text — live, with Soniox returning 503 on every turn, "I'm answering you out loud right now" while nothing was audible.
// Stated as a fact with nothing said about what to do with it — the same shape as an outstanding consult.
const VOICE_FAILED_NOTE =
  'Your voice is not working: synthesis has been failing, so the last answer you gave went to the meeting chat as text and nobody in the room heard it.';

/** Assembles the user half of the speaking request by filling `prompts/voice-speaking-context.md`: the transcript, then every standing block with content. Each block is absent rather than emitted empty — an empty `<participants>` claims there is nobody in the room, which an absent block does not — so a meeting told nothing renders byte-for-byte as it did before the blocks existed. Order is the template's, and it runs moment-outward: now, then what may predate the meeting, then the room, then what is fixed — and last, on the rare turn that has one, the state of Archie's own voice, nearest the reply it has to bear on. */
export function buildSpeakingUserMessage(
  transcript: string,
  consults?: { id: string; question: string; answer?: string }[],
  context?: SpeakingContext,
): string {
  // Kept apart from `<transcript>`, which marks the room's speech as untrusted; the consult exchange is a trusted internal source.
  const consultLines = (consults ?? []).map((c) => `${c.id}. Q: ${c.question}\n   A: ${c.answer ?? '(no answer yet)'}`);
  // `Speaker: text`, the same shape the transcript uses -- the tag alone tells the two apart, so it must never be dropped.
  const writtenLines = (context?.written ?? []).map((line) => `${line.speaker}: ${line.text}`);
  // A departed participant keeps their line, marked -- unmarked, Archie would address an empty chair; a nameless row says so rather than disappearing, since the count matters even when the name doesn't.
  const participantLines = (context?.participants ?? []).map((p) => {
    const name = (p.name ?? '').trim();
    const host = p.is_host === true ? ' (host)' : '';
    const left = p.left_at === null ? '' : ' (has left)';
    return `${name.length > 0 ? name : '(name not reported)'}${host}${left}`;
  });
  // Verbatim: the summarising call already produced the lines meant to be read. Trimmed only, so whitespace-only counts as no summary.
  const capabilities = (context?.capabilities ?? '').trim();

  // One row per block in the template, and `null` is what makes a block disappear. Not the same as an empty string: `<transcript>` renders whatever it is handed, empty included, since a first turn with nothing transcribed yet still says so with the tags.
  const values: Record<string, string | null> = {
    TRANSCRIPT: transcript,
    CONSULTS: consultLines.length === 0 ? null : consultLines.join('\n'),
    WRITTEN: writtenLines.length === 0 ? null : writtenLines.join('\n'),
    PARTICIPANTS: participantLines.length === 0 ? null : participantLines.join('\n'),
    CAPABILITIES: capabilities.length === 0 ? null : capabilities,
    VOICE: context?.voiceFailed === true ? VOICE_FAILED_NOTE : null,
  };
  // Read on every turn rather than cached, exactly as `loadPrompt` reads the system half: an edit to either file takes effect on the next turn, and the two must not fall out of step.
  return fillSpeakingTemplate(readFileSync(SPEAKING_CONTEXT_TEMPLATE, 'utf-8'), values);
}

/**
 * Fills the speaking context template. Its blocks are the blank-line-separated segments of the file, each carrying at most one `{{PLACEHOLDER}}`: a segment whose value is `null` disappears whole — tags, content and the blank line that separated it — and a segment with no placeholder at all, the intro line, always stays.
 *
 * Substitution happens per segment and only after the drop decision, which is what lets a value carry a blank line of its own without splitting its block in two, and what stops a `{{WRITTEN}}` said out loud in the room from being read as another block's substitution site — the transcript is untrusted speech on a path ending in the bot talking aloud.
 *
 * Throws on any disagreement between the file and the table above, rather than sending what it managed to assemble: a literal `{{WRITTEN}}` in front of the model, or a silently missing block of the room's own writing, is worse than the turn failing and saying so — which is what `decideResponse` does with it.
 */
function fillSpeakingTemplate(template: string, values: Record<string, string | null>): string {
  const filled: string[] = [];
  const seen = new Set<string>();
  // A no-op on the file as committed, and the difference between a checkout with CRLF endings sending the message it always did and one where the blank lines stop separating anything, leaving a single unsplittable block.
  for (const segment of template.replace(/\r\n/g, '\n').trim().split('\n\n')) {
    const names = [...segment.matchAll(/{{([A-Z0-9_]+)}}/g)].map((match) => match[1]);
    if (names.length === 0) {
      filled.push(segment); // The intro line: nothing to fill, and nothing about it that could be absent.
    } else if (names.length > 1) {
      throw new Error(
        `voice-speaking-context.md has a block carrying ${names.length} placeholders (${names.join(', ')}); a block is kept or dropped whole, so it can carry at most one`,
      );
    } else {
      const name = names[0];
      if (!Object.hasOwn(values, name)) {
        throw new Error(`voice-speaking-context.md carries {{${name}}}, which nothing fills — it would reach the model as that literal text`);
      }
      if (seen.has(name)) {
        throw new Error(`voice-speaking-context.md carries {{${name}}} more than once, and one value cannot fill two blocks`);
      }
      seen.add(name);
      const value = values[name];
      if (value !== null) {
        // A function replacement, so `$&` and friends in meeting speech stay literal; the name matched above, so there is exactly one site.
        filled.push(segment.replace(`{{${name}}}`, () => value));
      }
    }
  }

  const unplaced = Object.keys(values).filter((name) => !seen.has(name));
  if (unplaced.length > 0) {
    throw new Error(
      `voice-speaking-context.md has no placeholder for ${unplaced.join(', ')}; that context would be assembled here and then silently dropped on the way to the model`,
    );
  }
  return filled.join('\n\n');
}

/** Turns a deployment's internal self-description into plain language a voice agent can judge "can I find this out?" against — the one call here that isn't part of a turn, run once at join. The summarising step is the point rather than an optimisation: most descriptions name agent ids, skill names and trigger phrases, all unusable in a room. Returns `''` on every failure and never throws, since a loud one would let a lapsed key stop Archie joining at all. */
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
    // No plugins is a real configuration, not a fault — silent, not degraded.
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

  // Tagged like the transcript, for a different reason: not untrusted, but the summariser has to tell the three sources apart. `(none)` flags an empty source as intentional, which omitting the tag would not.
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
    // callModel logged the cause; this line is the consequence, and without it a silently-missing capability block goes unnoticed.
    logger.warn(
      LOG,
      `No capability summary after ${elapsed}ms — this meeting runs with no capability block, exactly as it would before this call existed`,
    );
    return '';
  }

  const summary = raw.trim();
  logger.debug(LOG, `Capability summary: ${summary.length} chars from ${skills.length} skill description(s) in ${elapsed}ms`);
  return summary;
}

/** The same two arms as {@link Decision}, minus `failed`, which belongs to the wire and never to a reply's *text*. */
type ParsedReply = Extract<Decision, { outcome: 'speak' | 'silence' }>;

/** Splits a speaking reply into what's said, posted, and asked of the PM. Trailing marker lines rather than JSON: a stray brace in spoken prose would cost a whole turn. With nothing spoken, `PM:` survives — fire-and-forget, it never had the room as its destination — while `CHAT:` and `LEAVE:` have nothing to attach to and are dropped. */
export function parseReply(raw: string): ParsedReply {
  const lines = raw.split(/\r?\n/);
  // The first line starting with a known marker ends the spoken region; everything from there splits into one section per marker.
  const tailStart = lines.findIndex((line) => markerOf(line) !== null);
  const spokenSource = tailStart === -1 ? raw : lines.slice(0, tailStart).join('\n');
  const sections = tailStart === -1 ? new Map<TailMarker, string>() : splitMarkerSections(lines.slice(tailStart));

  const speech = toSpeech(spokenSource);
  // Not sanitised, only trimmed: read, not spoken — stripping markup would mangle what these carry (paths, hashes, figures, URLs).
  const pm = (sections.get(PM_MARKER) ?? '').trim();
  const chat = (sections.get(CHAT_MARKER) ?? '').trim();
  // Presence alone is the signal: nothing meaningful follows this colon, so an empty section still counts.
  const leave = sections.has(LEAVE_MARKER);

  if (speech.length === 0 || isSilenceToken(speech)) {
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

/** One section per marker, each running to the next marker or the end. Captures everything after the marker, not just its own line, so wrapped detail isn't lost; first occurrence wins. */
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

/** Tolerant of quoting, case and a trailing full stop, since mistaking one of those for speech would announce "silence" to the meeting. Matched against the entire reply, so an answer that merely mentions silence survives. */
function isSilenceToken(text: string): boolean {
  return normaliseForSilence(text) === SILENCE_TOKEN;
}

function normaliseForSilence(text: string): string {
  return text.replace(/[\s."'`*]/g, '').toUpperCase();
}

// A sentence ends at `!`/`?`, or at a single `.` followed by whitespace or the end of the text. The `$` half is what makes streaming worth anything: the API streams in ~90-character quanta, so requiring a following space would cost a further quantum (~315ms measured) and a one-sentence answer would reach the synthesizer only at `finish()`.
// Two shapes are excluded: an ellipsis (breaking there hands the synthesizer two utterances where the model wanted a pause) and a `.` before a non-space (the `.` in `3.5` is not a boundary). Not `/g`: the pattern is shared by every emitter, and a global regex's `lastIndex` persists between calls, corrupting concurrent streams.
const SENTENCE_END = /(?:[!?]+|(?<!\.)\.)(?=\s|$)/;

/** Only asked at a buffer's edge, where the character after the terminator hasn't arrived: a trailing `.` after a digit is the front half of a number, and emitting there would have the room hear "it took three" then "five seconds". */
function looksUnfinished(text: string): boolean {
  return /\d\.$/.test(text);
}

/** Turns a reply arriving token by token into complete sentences, handing each out the moment it is whole so speech can start before generation ends. Two things never escape, held back structurally rather than filtered afterwards: the `SILENCE` token (nothing emits while the text so far could still become it) and a tail marker's payload (a line is withheld while it could still open one, whether as a partial marker like `CHA` or a complete one whose line hasn't ended). */
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
      // A match reaching the very end of what we hold can only be the `$` arm. Mid-stream that's a buffer edge, not the reply's end, and the regex can't tell — this has to.
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

  /** The part of the reply that is definitely speech and won't be revised. Sets {@link closed} when a marker turns up, so the last spoken sentence goes out on the marker rather than waiting for the stream to finish. */
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
    // Punctuation alone is not a sentence — a stream can cut mid-ellipsis, leaving trailing dots that belong to a sentence already emitted.
    if (/[\p{L}\p{N}]/u.test(spoken)) {
      this.count += 1;
      this.onSentence(spoken);
    }
  }
}

/** Only `addressed === true` yields true; everything else is "no". Braces are located rather than the whole string parsed, because bare JSON can still arrive wrapped in a code fence. */
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

// Makes text safe to hand to a speech engine: `voice-speaking.md` forbids markdown, but a stray asterisk still reads aloud as "star". Removes formatting and flattens to one spoken line; never shortens, since length is the prompt's decision.
// Applied to `speech` only, never `chat` — chat is read rather than spoken, and carries exactly what this would destroy: `retention_policy.expires_at` loses its underscores, a path its slashes, a fenced snippet its backticks.
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

interface ModelCall {
  cfg: VoiceConfig;
  label: string;
  system: string;
  user: string;
  /** Absent on the speaking call — see GENERATION_TIMEOUT_MS. */
  maxTokens?: number;
  timeoutMs: number;
  /** Ask for the model's native reasoning, which comes back on its own channel. Only the speaking call does; the others send no such field at all. */
  reasoning?: boolean;
}

// Cerebras `gemma-4-31b` over their OpenAI-compatible endpoint, measured on the wire: errors are a real HTTP status rather than in-band, the error body is flat `{message, type, param, code}`, and a `stream: true` reply sends an empty role frame, a final `delta: {}` with `finish_reason`, a usage-only frame, then `data: [DONE]`. Server time is ~5ms of a 190ms call; the latency is network, not the request body.
const MODEL = 'gemma-4-31b';
const MODEL_URL = 'https://api.cerebras.ai/v1/chat/completions';
/** Named in the log lines and in a failure's `why`, so a run of failures reads as a vendor problem rather than a prompt one. */
const VENDOR = 'cerebras';

function modelRequest(args: ModelCall, stream: boolean): RequestInit {
  const body: Record<string, unknown> = {
    model: MODEL,
    // `max_tokens` is the deprecated alias of `max_completion_tokens`.
    ...(args.maxTokens === undefined ? {} : { max_completion_tokens: args.maxTokens }),
    // Both calls judge a fixed transcript rather than write creatively — a reproducible answer is easier to debug from the meeting record.
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
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${args.cfg.cerebrasApiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(args.timeoutMs),
  };
}

/** What one streamed frame carries: `text` is what the room hears, `reasoning` is what it never does. Either, or both. */
interface StreamDelta {
  text?: string;
  reasoning?: string;
}

/** One SSE line down to what it carries, or null for every frame carrying neither text nor reasoning — keep-alives, role and usage frames, the end-of-stream sentinel, any later frame type. Cerebras's versioning policy requires those be ignored rather than treated as a failure. */
function frameFrom(line: string): StreamDelta | null {
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith('data:')) {
    return null;
  }
  const payload = trimmed.slice('data:'.length).trim();
  // The documented end-of-stream sentinel is not JSON, and is checked before the parse so it reads as a known frame rather than an unreadable one.
  if (payload.length === 0 || payload === '[DONE]') {
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
    // Never observed — every provoked error came back as an HTTP status — but an OpenAI-compatible stream may carry one, and noticing costs one branch. Null means no text, read as a failure.
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

/** Either the whole reply, or why it never arrived. The reason travels rather than being logged and dropped: it ends up on the meeting record's `turn` row. */
type StreamOutcome = { ok: true; text: string; reasoning: string } | { ok: false; why: string };

// Streams a reply, handing each content delta to `onText` as it lands. Reasoning deltas are accumulated here and never handed on: nothing downstream may speak them, and the whole of it arrives before the first content token anyway.
// On Cerebras the streaming overlap nearly vanishes — the whole reply lands ~55ms after the first token — but this stays streaming regardless: `SentenceEmitter` is a correctness mechanism, withholding the silence token and the chat payload from speech structurally, and a non-streaming path would bypass that reasoning. Never throws and never logs the API key.
async function streamModel(args: ModelCall, onText: (text: string) => void): Promise<StreamOutcome> {
  try {
    const response = await fetch(MODEL_URL, modelRequest(args, true));
    // Where every failure shape lands; see the in-band branch in `frameFrom` for the one an OpenAI-compatible stream could carry instead.
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, MAX_ERROR_BODY);
      logger.error(LOG, `${args.label}: ${VENDOR} returned ${response.status} — ${body}`);
      return { ok: false, why: `${VENDOR} returned ${response.status}` };
    }
    if (response.body === null) {
      logger.error(LOG, `${args.label}: ${VENDOR} returned no response body`);
      return { ok: false, why: `${VENDOR} returned no response body` };
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
          const frame = frameFrom(buffer.slice(0, cut));
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
      logger.warn(LOG, `${args.label}: the ${VENDOR} stream carried no text`);
      return { ok: false, why: `${VENDOR} streamed no text` };
    } else {
      return { ok: true, text, reasoning };
    }
  } catch (error) {
    // The one failure that can land *after* deltas were handed on. The error's name is the load-bearing half — `TimeoutError` is our own deadline expiring, which reads very differently from a socket dropping.
    logger.error(LOG, `${args.label}: the ${VENDOR} stream failed`, error);
    const why = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { ok: false, why: `the ${VENDOR} stream failed — ${why}` };
  }
}

/** One non-streaming call, for the two places the whole reply is short and nothing can act on it until complete — streaming would add a parser and save nothing. Returns the reply text, or null on any failure. Never throws and never logs the API key. */
async function callModel(args: ModelCall): Promise<string | null> {
  try {
    const response = await fetch(MODEL_URL, modelRequest(args, false));
    if (response.ok) {
      // Parsing can throw on a truncated or non-JSON 200; the catch below turns that into the same "no" as everything else — the bias this whole module is built around.
      const reply = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = (reply.choices ?? []).map((choice) => choice?.message?.content ?? '').join('').trim();
      if (text.length === 0) {
        logger.warn(LOG, `${args.label}: ${VENDOR} returned no text content`);
        return null;
      } else {
        return text;
      }
    } else {
      const body = (await response.text().catch(() => '')).slice(0, MAX_ERROR_BODY);
      logger.error(LOG, `${args.label}: ${VENDOR} returned ${response.status} — ${body}`);
      return null;
    }
  } catch (error) {
    logger.error(LOG, `${args.label}: the ${VENDOR} call failed`, error);
    return null;
  }
}
