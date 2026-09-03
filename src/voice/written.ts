/**
 * written.ts — the task's written exchange (Slack thread, GitHub, CLI), rendered for a voice meeting's prompt.
 *
 * Reads `shared/events.jsonl` fresh every turn via {@link readEvents}, no cache: microseconds against the ~620ms call it precedes; a cache could miss a mid-meeting message.
 *
 * Not a Slack API call — CLI tasks have no Slack thread, so the event log covers both. Doesn't cover in-call chat: that's `MeetingHost.recordChat` into `chat.log`, not `events.jsonl`; `meeting.ts` combines both.
 */

import { readEvents } from '../tasks/persistence.js';
import { activeTasks } from '../tasks/task.js';
import { logger } from '../system/logger.js';
import { BOT_NAME } from './types.js';
import type { WrittenLine } from './types.js';

const LOG = 'voice-written';

// Chars kept, most recent first, oldest dropped. 24,000 ≈ 6.1k tokens ≈ SPEAKING_WINDOW_MS's ~1hr; meeting.ts's TRANSCRIPT_WINDOW_MS counts this into its budget — keep both in sync.
const MAX_EXCHANGE_CHARS = 24_000;

// = every inbound appender's `to` in persistence.ts (appendSlackMessage, appendSlackEdit, appendGitHubEvent, appendCliMessage, appendMeetingEvent).
const INBOUND_TO = 'pm-agent';

// = the `to` logOutgoingMessage/logFilesUpload in task.ts write for a message to a person.
const OUTBOUND_TO = 'user';

// = appendMeetingEvent's fixed sender in persistence.ts.
const VOICE_SENDER = 'voice';

// `footer` is omitted — task/model metadata, not something anyone said.
export interface WrittenEventData {
  from?: unknown;
  to?: unknown;
  destination?: unknown;
  message?: unknown;
}

// Regex order matters: the bare-mention catch-all below would eat a named mention (`<@id:name>`) first. Also used on `from`, not just message bodies.
function renderBody(message: string): string {
  return (
    message
      .replace(/<@[^:>]*:([^>]*)>/g, '$1')
      .replace(/<@[^>]*>/g, '')
      .replace(/#<[^:>]*:([^>]*)>/g, '#$1')
      // Collapses newlines/control chars — the one way a message could forge a fake line break. Same class as persistence.ts's sanitizeTranscriptField: apostrophes, scripts, emoji untouched.
      .replace(/[\p{Cc}\u2028\u2029]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

// agentIds (live team) is canonical; `-agent` is a fallback for a failed-to-load team or unlisted id — registry.ts mints ids as `<key>-agent`, but a deployment could break that.
function isInternalSender(from: string, agentIds: ReadonlySet<string>): boolean {
  return from === VOICE_SENDER || agentIds.has(from) || from.endsWith('-agent');
}

// `destination: recall:<sessionId>` on the outbound case is the PM answering a consult, already rendered by meeting.ts — skip it or the text appears twice.
export function renderWrittenLine(
  data: WrittenEventData,
  agentIds: ReadonlySet<string> = new Set(),
): WrittenLine | null {
  const from = typeof data.from === 'string' ? data.from.trim() : '';
  const to = typeof data.to === 'string' ? data.to : '';
  const destination = typeof data.destination === 'string' ? data.destination : '';
  const text = renderBody(typeof data.message === 'string' ? data.message : '');
  if (text.length === 0) {
    return null;
  }

  if (to === OUTBOUND_TO) {
    if (destination.startsWith('recall:')) {
      return null;
    }
    return { speaker: BOT_NAME, text };
  } else if (to === INBOUND_TO && from.length > 0 && !isInternalSender(from, agentIds)) {
    // 'cli' has no real operator identity to show — a made-up name would be worse than a plain label.
    return { speaker: from === 'cli' ? 'a teammate' : renderBody(from), text };
  } else {
    return null;
  }
}

// The task's own team, not the process registry — includes agents the PM spawned onto this task. `activeTasks`' live map, not `Task.get()` (disk load plus git-fetch, too slow here).
function agentIdsFor(taskId: string): ReadonlySet<string> {
  const team = activeTasks.get(taskId)?.team;
  if (team === undefined) {
    return new Set();
  }
  return new Set(team.map((def) => def.id));
}

// Never rejects — MeetingHost.readWrittenExchange (types.ts) requires it. Every failure resolves to [].
export async function readWrittenExchange(taskId: string): Promise<WrittenLine[]> {
  try {
    const { events } = await readEvents(taskId);
    const agentIds = agentIdsFor(taskId);
    const rendered: WrittenLine[] = [];
    for (const event of events) {
      if (event.type !== 'message') {
        continue;
      }
      const line = renderWrittenLine(event.data as WrittenEventData, agentIds);
      if (line !== null) {
        rendered.push(line);
      }
    }
    const kept: WrittenLine[] = [];
    let chars = 0;
    for (let i = rendered.length - 1; i >= 0; i--) {
      chars += rendered[i].speaker.length + rendered[i].text.length;
      if (chars > MAX_EXCHANGE_CHARS) {
        break;
      }
      kept.unshift(rendered[i]);
    }
    if (kept.length < rendered.length) {
      logger.debug(
        LOG,
        `Rendered the ${kept.length} most recent written line(s) of ${rendered.length} for task ${taskId} — the rest is older than the context budget allows`,
      );
    }
    return kept;
  } catch (err) {
    logger.warn(LOG, `Could not read the written exchange for task ${taskId} — this turn runs without one`, err);
    return [];
  }
}
