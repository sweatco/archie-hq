/**
 * Task Manager
 *
 * Handles task persistence: creating task folders, reading/writing metadata,
 * appending to knowledge.log
 */

import { mkdir, readFile, writeFile, appendFile, readdir, symlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { TaskMetadata, LogEntry, FindingType, SlackThread, AgentName, SlackFile } from '../types/index.js';
import { getAllRepoConfigs } from '../agents/repo-configs.js';
import { getPluginsWithPmSkills } from './plugin-loader.js';

const SESSIONS_DIR = join(process.cwd(), 'sessions');

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

  const { downloadSlackFile } = await import('../slack/client.js');
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
      const { logger } = await import('./logger.js');
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

/**
 * Create a new task with initial metadata
 */
export async function createTask(
  slackThread: SlackThread
): Promise<TaskMetadata> {
  await ensureSessionsDir();

  const taskId = generateTaskId();
  const sharedPath = getSharedPath(taskId);

  // Create task directory structure
  await mkdir(sharedPath, { recursive: true });
  await mkdir(getMemoryPath(taskId), { recursive: true });

  // Symlink PM skills from all loaded plugins into task shared folder
  const skillsTarget = join(sharedPath, '.claude', 'skills');
  await mkdir(join(sharedPath, '.claude'), { recursive: true });

  for (const plugin of getPluginsWithPmSkills()) {
    for (const skill of plugin.pmSkills) {
      const target = join(skillsTarget, skill.namespacedName);
      if (!existsSync(target)) {
        await mkdir(skillsTarget, { recursive: true });
        await symlink(skill.sourcePath, target);
      }
    }
  }

  // Build repositories map dynamically from loaded repo configs
  const repositories: Record<string, { path: string }> = {};
  for (const config of getAllRepoConfigs()) {
    repositories[config.repoKey] = { path: config.defaultRepoPath };
  }

  // Create initial metadata
  const metadata: TaskMetadata = {
    task_id: taskId,
    task_owner: null,
    participants: [],
    slack_threads: [slackThread],
    agent_sessions: {},
    repositories,
    status: 'in_progress',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  await saveMetadata(taskId, metadata);

  // Create empty knowledge log
  await writeFile(getKnowledgeLogPath(taskId), '');

  return metadata;
}

/**
 * Save task metadata to disk
 */
export async function saveMetadata(taskId: string, metadata: TaskMetadata): Promise<void> {
  metadata.updated_at = new Date().toISOString();
  await writeFile(getMetadataPath(taskId), JSON.stringify(metadata, null, 2));
}

/**
 * Load task metadata from disk
 */
export async function loadMetadata(taskId: string): Promise<TaskMetadata | null> {
  const metadataPath = getMetadataPath(taskId);

  if (!existsSync(metadataPath)) {
    return null;
  }

  const content = await readFile(metadataPath, 'utf-8');
  return JSON.parse(content) as TaskMetadata;
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
  let fullMessage = `[@<${userInfo.id}:${userInfo.realName}>] ${message}`;

  if (files && files.length > 0) {
    const fileInfo = files.map(f => {
      const pathInfo = f.localPath ? ` (${f.localPath})` : '';
      return `${f.name}${pathInfo}`;
    }).join(', ');
    fullMessage += `\n  [Attachments: ${fileInfo}]`;
  }

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    source: `slack:#<${channelInfo.id}:${channelInfo.name}>:${threadId}`,
    message: fullMessage,
  };

  await appendFile(getKnowledgeLogPath(taskId), formatLogEntry(entry));
}

/**
 * Append an agent finding to the knowledge log
 */
export async function appendAgentFinding(
  taskId: string,
  agentName: string,
  finding: string,
  type: FindingType
): Promise<void> {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    source: agentName,
    type,
    message: finding,
  };

  await appendFile(getKnowledgeLogPath(taskId), formatLogEntry(entry));
}

/**
 * Append a GitHub event to the knowledge log
 * @param repoKey - Repository identifier (e.g., 'backend', 'mobile') for multi-repo tasks
 */
export async function appendGitHubEvent(
  taskId: string,
  repoKey: string,
  message: string
): Promise<void> {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    source: `github:${repoKey}`,
    message,
  };

  await appendFile(getKnowledgeLogPath(taskId), formatLogEntry(entry));
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
 * Find a task by Slack thread ID
 */
export async function findTaskByThreadId(threadId: string): Promise<string | null> {
  await ensureSessionsDir();

  const sessions = await readdir(SESSIONS_DIR);

  for (const session of sessions) {
    if (!session.startsWith('task-')) continue;

    const metadata = await loadMetadata(session);
    if (!metadata) continue;

    const hasThread = metadata.slack_threads.some((t) => t.thread_id === threadId);
    if (hasThread) {
      return session;
    }
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

  // Import repo config to map githubRepo -> repoKey
  const { getAllRepoConfigs } = await import('../agents/repo-configs.js');
  const repoConfigs = getAllRepoConfigs();
  const repoKey = repoConfigs.find((c) => c.githubRepo === githubRepo)?.agentId.replace('-agent', '');

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
 * Find all tasks with a given status
 */
export async function findTasksByStatus(
  status: 'in_progress' | 'stopped' | 'completed'
): Promise<TaskMetadata[]> {
  await ensureSessionsDir();

  const sessions = await readdir(SESSIONS_DIR);
  const tasks: TaskMetadata[] = [];

  for (const session of sessions) {
    if (!session.startsWith('task-')) continue;

    const metadata = await loadMetadata(session);
    if (metadata && metadata.status === status) {
      tasks.push(metadata);
    }
  }

  return tasks;
}

/**
 * Update task status
 */
export async function updateTaskStatus(
  taskId: string,
  status: 'in_progress' | 'stopped' | 'completed'
): Promise<void> {
  const metadata = await loadMetadata(taskId);
  if (!metadata) {
    throw new Error(`Task ${taskId} not found`);
  }

  metadata.status = status;
  await saveMetadata(taskId, metadata);
}

/**
 * Add a Slack thread to an existing task
 */
export async function addThreadToTask(taskId: string, thread: SlackThread): Promise<void> {
  const metadata = await loadMetadata(taskId);
  if (!metadata) {
    throw new Error(`Task ${taskId} not found`);
  }

  // Check if thread already exists
  const exists = metadata.slack_threads.some((t) => t.thread_id === thread.thread_id);
  if (!exists) {
    metadata.slack_threads.push(thread);
    await saveMetadata(taskId, metadata);
  }
}

/**
 * Update the last processed timestamp for a thread
 */
export async function updateThreadTimestamp(
  taskId: string,
  threadId: string,
  timestamp: string
): Promise<void> {
  const metadata = await loadMetadata(taskId);
  if (!metadata) {
    throw new Error(`Task ${taskId} not found`);
  }

  const thread = metadata.slack_threads.find((t) => t.thread_id === threadId);
  if (thread) {
    thread.last_processed_ts = timestamp;
    await saveMetadata(taskId, metadata);
  }
}

/**
 * Update the last processed PR comment ID for a repository
 */
export async function updatePRCommentTimestamp(
  taskId: string,
  repoKey: string,
  commentId: number
): Promise<void> {
  const metadata = await loadMetadata(taskId);
  if (!metadata) {
    throw new Error(`Task ${taskId} not found`);
  }

  const repoInfo = metadata.repositories[repoKey];
  if (repoInfo) {
    repoInfo.last_processed_comment_id = commentId;
    await saveMetadata(taskId, metadata);
  }
}

/**
 * Set the task owner
 */
export async function setTaskOwner(
  taskId: string,
  owner: AgentName
): Promise<void> {
  const metadata = await loadMetadata(taskId);
  if (!metadata) {
    throw new Error(`Task ${taskId} not found`);
  }

  metadata.task_owner = owner;
  if (!metadata.participants.includes(owner)) {
    metadata.participants.push(owner);
  }
  await saveMetadata(taskId, metadata);
}

/**
 * Add a participant to the task
 */
export async function addParticipant(
  taskId: string,
  participant: AgentName
): Promise<void> {
  const metadata = await loadMetadata(taskId);
  if (!metadata) {
    throw new Error(`Task ${taskId} not found`);
  }

  if (!metadata.participants.includes(participant)) {
    metadata.participants.push(participant);
    await saveMetadata(taskId, metadata);
  }
}

/**
 * Store an agent's session ID
 */
export async function storeAgentSession(
  taskId: string,
  agentName: string,
  sessionId: string
): Promise<void> {
  const metadata = await loadMetadata(taskId);
  if (!metadata) {
    throw new Error(`Task ${taskId} not found`);
  }

  metadata.agent_sessions[agentName] = sessionId;
  await saveMetadata(taskId, metadata);
}
