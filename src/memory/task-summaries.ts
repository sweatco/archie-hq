import { mkdir, lstat, readFile, readdir, rename, unlink, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import matter from 'gray-matter';
import { logger } from '../system/logger.js';
import {
  getPublicMemoryDir,
  getTaskChannelDir,
  getTaskOverviewPath,
  getTaskSummaryPath,
  isAllowedTaskId,
  isSlackConversationId,
  type MemoryVisibility,
} from './paths.js';
import type { TaskStatus } from '../types/task.js';

export interface TaskSummaryRecord {
  visibility: MemoryVisibility;
  channelId: string;
  taskId: string;
  status: TaskStatus;
  createdAt: string;
  extractionAt: string;
  summary: string;
  markdown: string;
}

const OVERVIEW_NAME = 'rolling-summary.md';
const OVERVIEW_LIMIT = 50;
const VALID_STATUSES = new Set<TaskStatus>(['in_progress', 'stopped', 'completed']);

export async function writeTaskSummary(
  visibility: MemoryVisibility,
  channelId: string,
  taskId: string,
  markdown: string,
): Promise<void> {
  if (!parseTaskSummary(markdown, visibility, channelId, taskId)) {
    throw new Error(`writeTaskSummary: invalid canonical task file for ${taskId}`);
  }
  const directory = getTaskChannelDir(visibility, channelId);
  await ensureChannelDirectory(directory);
  await atomicWrite(getTaskSummaryPath(visibility, channelId, taskId), markdown);
  await rebuildTaskOverview(visibility, channelId);
}

export async function rebuildTaskOverview(
  visibility: MemoryVisibility,
  channelId: string,
): Promise<string> {
  await ensureChannelDirectory(getTaskChannelDir(visibility, channelId));
  const records = await readTaskSummariesFromChannel(visibility, channelId);
  records.sort((a, b) =>
    b.extractionAt.localeCompare(a.extractionAt) || a.taskId.localeCompare(b.taskId)
  );
  const rows = records.slice(0, OVERVIEW_LIMIT).map((record) => {
    const excerpt = normalizeExcerpt(record.summary, 200).replace(/\|/g, '\\|');
    return `| ${record.extractionAt.slice(0, 10)} | [${record.taskId}](./${record.taskId}.md) | ${excerpt} |`;
  });
  const markdown = [
    '# Rolling Task Summary',
    '',
    '| Extracted | Task | Summary |',
    '|-----------|------|---------|',
    ...rows,
    '',
  ].join('\n');
  await atomicWrite(getTaskOverviewPath(visibility, channelId), markdown);
  return markdown;
}

export async function readPublicTaskSummaries(taskId?: string): Promise<TaskSummaryRecord[]> {
  if (taskId !== undefined && !isAllowedTaskId(taskId)) return [];
  let entries;
  try {
    entries = await readdir(getPublicMemoryDir(), { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const channelIds = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && isSlackConversationId(entry.name))
    .map((entry) => entry.name)
    .sort();
  const records: TaskSummaryRecord[] = [];
  for (const channelId of channelIds) {
    records.push(...await readTaskSummariesFromChannel('public', channelId, taskId));
  }
  return records;
}

export async function readTaskSummariesFromChannel(
  visibility: MemoryVisibility,
  channelId: string,
  taskId?: string,
): Promise<TaskSummaryRecord[]> {
  if (!isSlackConversationId(channelId)) return [];
  if (taskId !== undefined && !isAllowedTaskId(taskId)) return [];
  const directory = getTaskChannelDir(visibility, channelId);
  let directoryInfo;
  try {
    directoryInfo = await lstat(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return [];
  let names: string[];
  try {
    names = taskId === undefined ? await readdir(directory) : [`${taskId}.md`];
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const records: TaskSummaryRecord[] = [];
  for (const name of names.sort()) {
    if (name === OVERVIEW_NAME || !name.endsWith('.md') || name.endsWith('.tmp')) continue;
    const stem = name.slice(0, -3);
    if (!isAllowedTaskId(stem) || (taskId !== undefined && stem !== taskId)) continue;
    const path = getTaskSummaryPath(visibility, channelId, stem);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) continue;
    const markdown = await readFile(path, 'utf-8');
    const record = parseTaskSummary(markdown, visibility, channelId, stem);
    if (record) records.push(record);
    else logger.warn('memory', `skipping malformed task summary ${visibility}/${channelId}/${name}`);
  }
  return records;
}

function parseTaskSummary(
  markdown: string,
  visibility: MemoryVisibility,
  channelId: string,
  taskId: string,
): TaskSummaryRecord | null {
  if (!markdown.startsWith('---\n') && !markdown.startsWith('---\r\n')) return null;
  let parsed;
  try {
    parsed = matter(markdown, {});
  } catch {
    return null;
  }
  const data = parsed.data as Record<string, unknown>;
  if (
    data.task_id !== taskId
    || data.channel_id !== channelId
    || typeof data.status !== 'string'
    || !VALID_STATUSES.has(data.status as TaskStatus)
    || !validTimestamp(data.created_at)
    || !validTimestamp(data.extraction_at)
  ) return null;
  const summary = extractSummary(parsed.content);
  if (!summary) return null;
  return {
    visibility,
    channelId,
    taskId,
    status: data.status as TaskStatus,
    createdAt: data.created_at as string,
    extractionAt: data.extraction_at as string,
    summary,
    markdown,
  };
}

function extractSummary(body: string): string | null {
  const match = body.match(/(?:^|\n)# Summary[ \t]*\n+([\s\S]*?)(?=\n##[ \t]|\s*$)/);
  return match?.[1]?.trim() || null;
}

function normalizeExcerpt(value: string, limit: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, content, { encoding: 'utf-8', flag: 'wx' });
    await rename(tempPath, path);
  } finally {
    await unlink(tempPath).catch((error) => {
      if (!isMissing(error)) throw error;
    });
  }
}

async function ensureChannelDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`task summary channel path is not a real directory: ${path}`);
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
