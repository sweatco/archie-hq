/**
 * meeting-record.ts — where a meeting's own record lives on disk, and the one writer into it.
 *
 * A meeting's record is this connector's shape, not a task-level one: the folder name mirrors the `recall:<sessionId>` channel key, the rows are `MeetingRow`s, and nothing outside `src/connectors/recall/` reads or writes the file. So the helpers that build the path and the appender that writes it live here, beside the connector that owns them, rather than in `src/tasks/persistence.ts` beside the task-level appenders.
 *
 * What stays task-level is `appendMeetingEvent` (`src/tasks/persistence.ts`): it writes to `knowledge.log`, the file every agent reads at the start of a turn, in the same format and through the same event bus as every other inbound appender there. Only three facts go that way — a meeting started, a question was put to the PM, a meeting ended. The room's speech goes here.
 *
 * Only `getSharedPath` is borrowed from task-level persistence, so a meeting's folder sits under the same `shared/` tree as `memory/`, `attachments/` and `artifacts/`.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getSharedPath } from '../../tasks/persistence.js';
import type { MeetingRow } from '../../voice/types.js';

/**
 * Get the path to a voice meeting's own folder.
 *
 * One folder per MEETING, not one per task: `sessionId` is the same id that
 * keys the meeting's `recall:<sessionId>` channel key (see `recallChannelKey`
 * in `src/voice/task-binding.ts`), so the folder and the channel key are
 * built from the same value and can never drift apart — no separate lookup
 * table maps one to the other. A task that hosts several meetings over its
 * life gets one sibling folder per meeting here, rather than every meeting's
 * speech landing in one shared file behind an artificial boundary line.
 */
export function getMeetingPath(taskId: string, sessionId: string): string {
  // `sessionId` reaches us from the Recall API, so it must not escape the meeting folder. The substitution is the one `unboundRecordPath` in `./index.ts` applies to the same value for an unbound meeting's filename, so a dotted id maps identically in both places; a real bot id is a UUID and passes through unchanged. `taskId` needs no guard — `isSafeTaskId` already enforces a single path segment.
  // The all-dots case needs its own arm: `.` survives the character class, and `join` then RESOLVES a `..` segment rather than treating it as a name, collapsing the `recall` directory instead of nesting under it.
  const segment = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(getSharedPath(taskId), 'recall', /^\.+$/.test(segment) ? '_' : segment);
}

/**
 * Get the path to a meeting's record — the one append-only `meeting.jsonl`
 * inside that meeting's own folder (see `getMeetingPath`), one JSON row per
 * line. `MeetingRow` in `src/voice/types.ts` is the shape of a line and the
 * list of what a meeting records.
 *
 * Deliberately its own file, NOT `knowledge.log`: the PM reads knowledge.log
 * whole at the start of every turn, and room speech from a live voice
 * meeting is both high-volume and untrusted (it is a transcript of whatever
 * the room's open microphone picked up, unattributed and unverified).
 * Putting it there would mean every PM turn scans it unconditionally;
 * keeping it here means an agent greps it on demand instead, the same way it
 * would open any other file in its workspace.
 */
export function getMeetingRecordPath(taskId: string, sessionId: string): string {
  return join(getMeetingPath(taskId, sessionId), 'meeting.jsonl');
}

/**
 * Append one row to this meeting's record (see `getMeetingRecordPath`) — the
 * one writer, for every kind of row a meeting produces. `MeetingRow`
 * (`src/voice/types.ts`) is the union of those kinds.
 *
 * One line of JSON rather than the `[ISO] [source] message` shape the
 * knowledge-log appenders use, because the rows carry structure a line format
 * cannot: nested fields, an absent field meaning something different from an
 * empty one, and multi-line prose (a capability block) whose own line shape
 * has to survive. Nothing needs sanitising for the same reason —
 * `JSON.stringify` escapes a newline rather than letting it forge a second
 * row.
 *
 * A meeting's folder does not exist until its first row does, so this creates
 * it (recursively, so every later call is harmless) before appending.
 *
 * Deliberately plain: this can reject, and the caller decides what a failure
 * means. Appends are serialised by the caller — the connector keeps one chain
 * per meeting (`./index.ts`), so two rows cannot interleave.
 */
export async function appendMeetingRow(
  taskId: string,
  sessionId: string,
  row: MeetingRow,
): Promise<void> {
  await mkdir(getMeetingPath(taskId, sessionId), { recursive: true });
  await appendFile(getMeetingRecordPath(taskId, sessionId), `${JSON.stringify(row)}\n`);
}
