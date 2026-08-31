/**
 * sources.ts — the only part of the suite that touches a filesystem.
 *
 * Turns a task folder on disk into the plain records {@link extractSample}
 * consumes. Kept apart from `metrics.ts` so every measurement rule stays a pure
 * function testable on a literal, and so the layout below — which belongs to
 * Archie's persistence, not to the measurement — is the one thing that has to
 * change when that layout does.
 *
 *   <sessions>/<taskId>/
 *     shared/events.jsonl                                  the felt timeline
 *     shared/usage.jsonl                                   tokens, model, tier
 *     claude/<agentKey>/session/projects/<slug>/<id>.jsonl  the agent's transcript
 *
 * Only the first is required. A folder pulled from a server with just metadata
 * and usage still yields a usable, thinner sample.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentTranscript, SpeedEvent, TaskSources, TranscriptEntry, UsageRecord } from './metrics.js';

/**
 * Parse JSONL, skipping unparseable lines.
 *
 * A transcript being written while we read it can end mid-line, and one torn
 * tail is not a reason to throw away a whole run's evidence. The count of what
 * was skipped is returned so a caller can report it rather than quietly
 * measuring a partial file as if it were whole.
 */
export function parseJsonl<T>(text: string): { rows: T[]; skipped: number } {
  const rows: T[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      skipped++;
    }
  }
  return { rows, skipped };
}

const readIfPresent = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
};

const listDir = async (path: string): Promise<string[]> => {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
};

/**
 * Every session `.jsonl` an agent wrote, newest content last.
 *
 * An agent that was respawned mid-task has more than one session file. They are
 * concatenated into a single transcript ordered by timestamp, because round
 * trips are measured within one agent's work regardless of how many SDK
 * sessions it took. The seam between two sessions shows up as one long gap,
 * which the round-trip cap already excludes and counts.
 */
async function readAgentTranscript(agentDir: string, agentKey: string): Promise<AgentTranscript | null> {
  const projects = join(agentDir, 'session', 'projects');
  const entries: TranscriptEntry[] = [];

  for (const project of await listDir(projects)) {
    const dir = join(projects, project);
    for (const file of await listDir(dir)) {
      if (!file.endsWith('.jsonl')) continue;
      const text = await readIfPresent(join(dir, file));
      if (text === null) continue;
      entries.push(...parseJsonl<TranscriptEntry>(text).rows);
    }
  }
  if (entries.length === 0) return null;

  entries.sort((a, b) => {
    const at = a.timestamp ? Date.parse(a.timestamp) : 0;
    const bt = b.timestamp ? Date.parse(b.timestamp) : 0;
    return at - bt;
  });
  return { agentKey, entries };
}

export interface LoadResult {
  sources: TaskSources;
  /** What was present. A report should say which tier of detail it is showing. */
  found: { events: boolean; usage: boolean; transcripts: string[] };
  /** Malformed JSONL lines skipped, summed across every file read. */
  skippedLines: number;
}

/** Load one task folder. Missing pieces are absent, never invented. */
export async function loadTask(taskDir: string, taskId: string): Promise<LoadResult> {
  let skippedLines = 0;

  const eventsText = await readIfPresent(join(taskDir, 'shared', 'events.jsonl'));
  const events = eventsText === null ? { rows: [] as SpeedEvent[], skipped: 0 } : parseJsonl<SpeedEvent>(eventsText);
  skippedLines += events.skipped;

  const usageText = await readIfPresent(join(taskDir, 'shared', 'usage.jsonl'));
  const usage = usageText === null ? null : parseJsonl<UsageRecord>(usageText);
  if (usage) skippedLines += usage.skipped;

  const transcripts: AgentTranscript[] = [];
  for (const agentKey of await listDir(join(taskDir, 'claude'))) {
    const t = await readAgentTranscript(join(taskDir, 'claude', agentKey), agentKey);
    if (t) transcripts.push(t);
  }

  return {
    sources: {
      taskId,
      events: events.rows,
      transcripts: transcripts.length > 0 ? transcripts : undefined,
      usage: usage ? usage.rows : undefined,
    },
    found: {
      events: eventsText !== null,
      usage: usageText !== null,
      transcripts: transcripts.map((t) => t.agentKey).sort(),
    },
    skippedLines,
  };
}

/**
 * Task folder names under a sessions directory, oldest first.
 *
 * Ordered by the timestamp in the id (`task-YYYYMMDD-HHMM-xxxxxx`) rather than
 * by mtime: a folder rewritten later — by a recovery pass, or by copying it off
 * a server — would otherwise reorder a campaign's arms and make an interleaved
 * comparison look sequential.
 */
export async function listTaskDirs(sessionsDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await listDir(sessionsDir)) {
    if (!name.startsWith('task-')) continue;
    try {
      if ((await stat(join(sessionsDir, name))).isDirectory()) out.push(name);
    } catch {
      // Vanished between listing and stat — a concurrent teardown. Skip it.
    }
  }
  return out.sort();
}
