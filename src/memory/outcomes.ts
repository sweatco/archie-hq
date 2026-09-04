import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { getChannelPrivatePath, getUserPrivatePath, isAllowedTaskId } from './paths.js';
import { sanitizeOutcomeSummary } from './sanitize.js';

export interface PrivateOutcome {
  task_id: string;
  created_at: string;
  recorded_at?: string;
  summary: string;
  thread_url?: string;
}

const HEADER = '# Private Outcomes\n\n';
const MAX_OUTCOMES = 50;

export async function readPrivateOutcomes(path: string): Promise<PrivateOutcome[]> {
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const outcomes: PrivateOutcome[] = [];
  for (const line of content.split('\n')) {
    if (!line.startsWith('- {')) continue;
    try {
      const parsed = JSON.parse(line.slice(2)) as Partial<PrivateOutcome>;
      const summary = typeof parsed.summary === 'string' ? sanitizeOutcomeSummary(parsed.summary) : null;
      if (
        typeof parsed.task_id !== 'string'
        || !isAllowedTaskId(parsed.task_id)
        || typeof parsed.created_at !== 'string'
        || !Number.isFinite(Date.parse(parsed.created_at))
        || !summary
      ) continue;
      const recordedAt = typeof parsed.recorded_at === 'string' && Number.isFinite(Date.parse(parsed.recorded_at))
        ? parsed.recorded_at
        : parsed.created_at;
      outcomes.push({
        task_id: parsed.task_id,
        created_at: new Date(parsed.created_at).toISOString(),
        recorded_at: new Date(recordedAt).toISOString(),
        summary,
        ...(typeof parsed.thread_url === 'string' ? { thread_url: parsed.thread_url } : {}),
      });
    } catch {
      continue;
    }
  }
  return outcomes;
}

export async function writePrivateOutcome(
  scope: { kind: 'private_channel'; channel_id: string } | { kind: 'user'; user_id: string },
  outcome: PrivateOutcome,
): Promise<boolean> {
  if (!isAllowedTaskId(outcome.task_id)) return false;
  const createdAtMs = Date.parse(outcome.created_at);
  const recordedAtMs = Date.parse(outcome.recorded_at ?? outcome.created_at);
  const summary = sanitizeOutcomeSummary(outcome.summary);
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(recordedAtMs) || !summary) return false;

  const path = scope.kind === 'private_channel'
    ? getChannelPrivatePath(scope.channel_id)
    : getUserPrivatePath(scope.user_id);
  const existing = await readPrivateOutcomes(path);
  const next = [
    {
      task_id: outcome.task_id,
      created_at: new Date(createdAtMs).toISOString(),
      recorded_at: new Date(recordedAtMs).toISOString(),
      summary,
      ...(outcome.thread_url ? { thread_url: outcome.thread_url } : {}),
    },
    ...existing.filter((entry) => entry.task_id !== outcome.task_id),
  ]
    .sort((a, b) => (b.recorded_at ?? b.created_at).localeCompare(a.recorded_at ?? a.created_at) || a.task_id.localeCompare(b.task_id))
    .slice(0, MAX_OUTCOMES);

  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${HEADER}${next.map((entry) => `- ${JSON.stringify(entry)}`).join('\n')}\n`, 'utf-8');
  await rename(tempPath, path);
  return true;
}
