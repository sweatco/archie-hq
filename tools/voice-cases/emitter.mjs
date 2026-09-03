// Harness shim over comprehension.ts's reply-parsing logic.
// Content only, with no think-stripping anywhere in it: production's reasoning arrives on its own channel now, so a `<think>` tag reaching the content channel is text the room would hear
// and must be graded as such, not quietly removed. The one arm that still needs a strip (a prompt that asks for the tags) does it on the wire, in providers.mjs, before anything here sees the text.
import {
  parseReply as decide,
  SentenceEmitter as RealSentenceEmitter,
  TAIL_MARKERS,
} from '../../src/voice/comprehension.ts';

export { TAIL_MARKERS };

// Flattens decide()'s Decision; `thought`/`leave` dropped, unused.
export function parseReply(raw) {
  const decision = decide(raw);
  if (decision.outcome === 'speak') {
    const { speech, chat, pm } = decision.response;
    const result = { silent: false, speech };
    if (chat) result.chat = chat;
    if (pm) result.pm = pm;
    return result;
  }
  const result = { silent: true, chatOnly: hadUnspokenChat(raw) };
  if (decision.pm) result.pm = decision.pm;
  return result;
}

// True if CHAT: had content, speech didn't (parseReply won't say).
// Checks spokenSource.trim().length === 0, not toSpeech() — they disagree only on markdown noise.
function hadUnspokenChat(raw) {
  const lines = raw.split(/\r?\n/);
  const tailStart = lines.findIndex((l) => TAIL_MARKERS.some((mk) => l.trimStart().startsWith(mk)));
  if (tailStart === -1) return false;
  if (lines.slice(0, tailStart).join('\n').trim().length > 0) return false;

  let inChat = false;
  let chatContent = '';
  for (const line of lines.slice(tailStart)) {
    const marker = TAIL_MARKERS.find((mk) => line.trimStart().startsWith(mk));
    if (marker !== undefined) {
      if (inChat) break;
      inChat = marker === 'CHAT:';
      if (inChat) chatContent = line.trimStart().slice(marker.length);
      continue;
    }
    if (inChat) chatContent += '\n' + line;
  }
  return chatContent.trim().length > 0;
}

// Adds `regionShrank`; parent logs a shrink, never exposes it.
// Hardcoded false is deliberate, not a stub: the append-only interface can't reach the parent's withholding logic, so a shrink is unreachable.
export class SentenceEmitter extends RealSentenceEmitter {
  regionShrank = false;
}
