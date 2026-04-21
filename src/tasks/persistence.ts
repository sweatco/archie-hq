/**
 * Task Manager
 *
 * Handles task persistence: creating task folders, reading/writing metadata,
 * appending to knowledge.log
 */

import { mkdir, readFile, writeFile, appendFile } from 'fs/promises';
import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';
import type { TaskMetadata, LogEntry, FindingType, SlackFile } from '../types/index.js';
import type { SystemEvent } from '../system/event-bus.js';
import { activeTasks } from './task.js';
import { SESSIONS_DIR } from '../system/workdir.js';
import { emitEvent, onEvent } from '../system/event-bus.js';
import { logger } from '../system/logger.js';
import { formatSlackChannelRef, formatSlackChannelDisplay } from '../connectors/slack/client.js';

/**
 * Generate a unique task ID with human-readable date format
 * Format: task-YYYYMMDD-HHMM-xxxxxx
 * Example: task-20251223-1712-a3f9k2
 */
export function generateTaskId(): string {
  const now = new Date();

  // Format: YYYYMMDD (ISO-style for natural sorting)
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const date = `${year}${month}${day}`;

  // Format: HHMM
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const time = `${hours}${minutes}`;

  // Random suffix for uniqueness
  const random = Math.random().toString(36).substring(2, 8);

  return `task-${date}-${time}-${random}`;
}

/**
 * Get the path to a task's directory
 */
export function getTaskPath(taskId: string): string {
  return join(SESSIONS_DIR, taskId);
}

/**
 * Get the path to a task's shared directory (PM agent's working directory)
 */
export function getSharedPath(taskId: string): string {
  return join(getTaskPath(taskId), 'shared');
}

/**
 * Get the path to a task's repos directory (for worktrees in MVP-v2)
 */
export function getReposPath(taskId: string): string {
  return join(getTaskPath(taskId), 'repos');
}

/**
 * Get the path to a task's metadata file
 */
export function getMetadataPath(taskId: string): string {
  return join(getSharedPath(taskId), 'metadata.json');
}

/**
 * Get the path to a task's knowledge log
 */
export function getKnowledgeLogPath(taskId: string): string {
  return join(getSharedPath(taskId), 'knowledge.log');
}

/**
 * Get the path to a task's memory directory
 */
export function getMemoryPath(taskId: string): string {
  return join(getSharedPath(taskId), 'memory');
}

/**
 * Get the path to a task's attachments directory (for Slack files)
 */
export function getAttachmentsPath(taskId: string): string {
  return join(getSharedPath(taskId), 'attachments');
}

/**
 * Download Slack files to task's attachments folder
 * Returns files with localPath populated
 */
export async function downloadMessageFiles(
  taskId: string,
  files: SlackFile[]
): Promise<SlackFile[]> {
  if (!files || files.length === 0) {
    return [];
  }

  const { downloadSlackFile } = await import('../connectors/slack/client.js');
  const attachmentsDir = getAttachmentsPath(taskId);

  // Ensure attachments directory exists
  await mkdir(attachmentsDir, { recursive: true });

  const downloadedFiles: SlackFile[] = [];

  for (const file of files) {
    try {
      // Use file ID + original name for uniqueness
      const localPath = join(attachmentsDir, `${file.id}-${file.name}`);
      // Prefer url_private_download (works with Bearer token) over url_private (requires browser session)
      const downloadUrl = file.url_private_download || file.url_private;
      await downloadSlackFile(downloadUrl, localPath);

      downloadedFiles.push({
        ...file,
        localPath,
      });
    } catch (error) {
      // Log error but continue with other files
      const { logger } = await import('../system/logger.js');
      logger.warn('task-manager', `Failed to download file ${file.name}: ${error}`);
    }
  }

  return downloadedFiles;
}

/**
 * Ensure the sessions directory exists
 */
export async function ensureSessionsDir(): Promise<void> {
  if (!existsSync(SESSIONS_DIR)) {
    await mkdir(SESSIONS_DIR, { recursive: true });
  }
}

// createTask has moved to task-runtime.ts (returns TaskRuntimeState directly)

/**
 * Load task metadata from disk
 */
export async function loadMetadata(taskId: string): Promise<TaskMetadata | null> {
  const metadataPath = getMetadataPath(taskId);

  if (!existsSync(metadataPath)) {
    return null;
  }

  try {
    const content = await readFile(metadataPath, 'utf-8');
    return JSON.parse(content) as TaskMetadata;
  } catch (err) {
    logger.warn('persistence', `Failed to parse metadata for ${taskId}: ${err}`);
    return null;
  }
}

/**
 * Format a log entry for the shared knowledge log
 */
function formatLogEntry(entry: LogEntry): string {
  const typeStr = entry.type ? ` [${entry.type}]` : '';
  return `[${entry.timestamp}] [${entry.source}]${typeStr} ${entry.message}\n`;
}

/**
 * Append a Slack message to the knowledge log
 * @param files - Optional array of downloaded files with localPath set
 */
export async function appendSlackMessage(
  taskId: string,
  channelInfo: { id: string; name: string },
  threadId: string,
  userInfo: { id: string; username: string; realName: string },
  message: string,
  files?: SlackFile[]
): Promise<void> {
  // Build message with optional file attachments
  let fullMessage = message;

  if (files && files.length > 0) {
    const fileInfo = files.map(f => {
      const pathInfo = f.localPath ? ` (${f.localPath})` : '';
      return `${f.name}${pathInfo}`;
    }).join(', ');
    fullMessage += `\n  [Attachments: ${fileInfo}]`;
  }

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    source: `@<${userInfo.id}:${userInfo.realName}> in ${formatSlackChannelRef(channelInfo.id, channelInfo.name, threadId)}`,
    message: fullMessage,
  };

  await appendFile(getKnowledgeLogPath(taskId), formatLogEntry(entry));
  emitEvent('message', taskId, { from: userInfo.realName, to: 'pm-agent', destination: formatSlackChannelDisplay(channelInfo.name), message });
}

/**
 * Append an agent finding to the knowledge log
 */
export async function appendAgentFinding(
  taskId: string,
  agentName: string,
  finding: string,
  type?: FindingType
): Promise<void> {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    source: agentName,
    type,
    message: finding,
  };

  await appendFile(getKnowledgeLogPath(taskId), formatLogEntry(entry));
  emitEvent('agent:log', taskId, { finding, type }, agentName);
}

/**
 * Append a user-facing message to the knowledge log (no event — caller emits)
 */
export async function appendMessageToUser(
  taskId: string,
  agentName: string,
  message: string,
  destination?: string,
): Promise<void> {
  const source = destination ? `${agentName} in ${destination}` : agentName;
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    source,
    message,
  };
  await appendFile(getKnowledgeLogPath(taskId), formatLogEntry(entry));
}

/**
 * Append an inter-agent message to the knowledge log
 */
export async function appendAgentMessage(
  taskId: string,
  fromAgent: string,
  toAgent: string,
  message: string,
): Promise<void> {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    source: fromAgent,
    message: `→ ${toAgent}: ${message}`,
  };

  await appendFile(getKnowledgeLogPath(taskId), formatLogEntry(entry));
  emitEvent('message', taskId, { from: fromAgent, to: toAgent, message });
}

/**
 * Append a GitHub event to the knowledge log.
 *
 * Accepts a structured payload matching the Slack/CLI shape so the CLI can
 * render GitHub events uniformly: `[from in destination] @pm-agent message`.
 *
 * @param repoKey - Repository identifier (e.g., 'backend', 'mobile') for multi-repo tasks
 * @param event - Structured event with author, destination (e.g. "PR #42"), and clean message body
 */
export async function appendGitHubEvent(
  taskId: string,
  repoKey: string,
  event: { from: string; destination: string; message: string }
): Promise<void> {
  const destination = `${repoKey}/${event.destination}`;
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    source: `@<${event.from}> in github:${destination}`,
    message: event.message,
  };

  await appendFile(getKnowledgeLogPath(taskId), formatLogEntry(entry));
  emitEvent('message', taskId, {
    from: event.from,
    to: 'pm-agent',
    destination: `github:${destination}`,
    message: event.message,
  });
}

/**
 * Append a CLI user message to the knowledge log
 */
export async function appendCliMessage(
  taskId: string,
  message: string,
): Promise<void> {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    source: 'cli',
    message,
  };

  await appendFile(getKnowledgeLogPath(taskId), formatLogEntry(entry));
  emitEvent('message', taskId, { from: 'cli', to: 'pm-agent', message });
}

/**
 * Read the knowledge log
 */
export async function readKnowledgeLog(taskId: string): Promise<string> {
  const logPath = getKnowledgeLogPath(taskId);

  if (!existsSync(logPath)) {
    return '';
  }

  return readFile(logPath, 'utf-8');
}

/**
 * Find a task by Slack thread ID.
 * Checks in-memory active tasks first (instant), then scans disk.
 */
export async function findTaskByThread(threadId: string): Promise<string | null> {
  // Fast: check in-memory active tasks (channels keyed by channel ID containing thread_id)
  for (const [taskId, runtime] of activeTasks.entries()) {
    const found = Object.values(runtime.metadata.channels).some(
      (ch) => ch.type === 'slack' && ch.thread_id === threadId
    );
    if (found) return taskId;
  }

  // Disk: grep metadata files not loaded in memory
  await ensureSessionsDir();

  try {
    const { execSync } = await import('child_process');
    const grepResult = execSync(
      `grep -l '"thread_id": "${threadId}"' ${SESSIONS_DIR}/task-*/shared/metadata.json 2>/dev/null || true`,
      { encoding: 'utf-8' }
    ).trim();

    if (grepResult) {
      const taskIdMatch = grepResult.split('\n')[0].match(/task-[a-z0-9-]+/i);
      if (taskIdMatch) return taskIdMatch[0];
    }
  } catch {
    // Fallback silently if grep fails
  }

  return null;
}

/**
 * Find a task by PR number and repo
 * Uses grep to find candidates, then verifies repo matches
 */
export async function findTaskByPRNumber(
  githubRepo: string,
  prNumber: number
): Promise<string | null> {
  await ensureSessionsDir();

  // Import registry to map githubRepo -> repoKey
  const { getAgentDefByGithubRepo } = await import('../agents/registry.js');
  const repoDef = getAgentDefByGithubRepo(githubRepo);
  const repoKey = repoDef?.repo?.repoKey;

  if (!repoKey) {
    // Unknown repo - can't match
    return null;
  }

  try {
    // Use grep to find metadata files containing the PR number
    const { execSync } = await import('child_process');
    const grepResult = execSync(
      `grep -l '"pr_number": ${prNumber}' ${SESSIONS_DIR}/task-*/shared/metadata.json 2>/dev/null || true`,
      { encoding: 'utf-8' }
    ).trim();

    if (!grepResult) return null;

    // Check each candidate to verify repo matches
    for (const filePath of grepResult.split('\n')) {
      const taskIdMatch = filePath.match(/task-[a-z0-9-]+/i);
      if (!taskIdMatch) continue;

      const taskId = taskIdMatch[0];
      const metadata = await loadMetadata(taskId);
      if (!metadata) continue;

      // Verify this task has the PR in the correct repo
      const repoInfo = metadata.repositories[repoKey];
      // Check branch_states first, then legacy top-level field
      if (repoInfo?.branch_states) {
        for (const state of Object.values(repoInfo.branch_states)) {
          if (state.pr_number === prNumber) return taskId;
        }
      }
      if (repoInfo?.pr_number === prNumber) {
        return taskId;
      }
    }
  } catch {
    // Fallback silently if grep fails
  }

  return null;
}

/**
 * Find all tasks with a given status.
 * Uses grep to find matching files in one pass (faster than reading every metadata.json).
 */
export async function findTasksByStatus(
  status: 'in_progress' | 'stopped' | 'completed'
): Promise<TaskMetadata[]> {
  await ensureSessionsDir();

  const { execSync } = await import('child_process');
  const grepResult = execSync(
    `grep -l '"status": "${status}"' ${SESSIONS_DIR}/task-*/shared/metadata.json 2>/dev/null || true`,
    { encoding: 'utf-8' }
  ).trim();

  if (!grepResult) return [];

  const tasks: TaskMetadata[] = [];
  for (const filePath of grepResult.split('\n')) {
    const taskIdMatch = filePath.match(/task-[a-z0-9-]+/i);
    if (!taskIdMatch) continue;

    const metadata = await loadMetadata(taskIdMatch[0]);
    if (metadata) tasks.push(metadata);
  }

  return tasks;
}

/**
 * Find all tasks on disk (any status). Reads every metadata.json in sessions dir.
 */
export async function findAllTasks(): Promise<TaskMetadata[]> {
  await ensureSessionsDir();

  const { readdirSync } = await import('fs');
  const dirs = readdirSync(SESSIONS_DIR, { withFileTypes: true });
  const tasks: TaskMetadata[] = [];

  for (const dir of dirs) {
    if (!dir.isDirectory() || !dir.name.startsWith('task-')) continue;
    const metadata = await loadMetadata(dir.name);
    if (metadata) tasks.push(metadata);
  }

  return tasks;
}

// ---- Event JSONL persistence ----

/**
 * Get the path to a task's events log (JSONL)
 */
export function getEventsLogPath(taskId: string): string {
  return join(getSharedPath(taskId), 'events.jsonl');
}

/**
 * Serialized write queues per task — ensures event ordering.
 */
const writeQueues = new Map<string, Promise<void>>();

/**
 * Append a system event to the task's events.jsonl (fire-and-forget).
 */
export async function appendEvent(event: SystemEvent): Promise<void> {
  const prev = writeQueues.get(event.taskId) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      const dir = getSharedPath(event.taskId);
      if (!existsSync(dir)) return;
      await appendFile(getEventsLogPath(event.taskId), JSON.stringify(event) + '\n');
    } catch (err) {
      logger.warn('events', `Failed to persist event for ${event.taskId}: ${err}`);
    }
  });
  writeQueues.set(event.taskId, next);
}

/**
 * Read events from a task's events.jsonl, streaming line-by-line.
 * Skips `after` lines so the caller only gets new events.
 */
export async function readEvents(
  taskId: string,
  after?: number,
): Promise<{ events: SystemEvent[]; total: number }> {
  const eventsPath = getEventsLogPath(taskId);
  if (!existsSync(eventsPath)) return { events: [], total: 0 };

  const events: SystemEvent[] = [];
  let lineNum = 0;
  const start = after ?? 0;

  const rl = createInterface({ input: createReadStream(eventsPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (lineNum++ < start) continue;
    try { events.push(JSON.parse(line)); }
    catch { /* skip malformed */ }
  }

  return { events, total: lineNum };
}

/**
 * Subscribe to all system events and persist them to JSONL.
 * Call once at startup after initRegistry().
 */
export function initEventPersistence(): void {
  onEvent((event: SystemEvent) => { void appendEvent(event); });
}
