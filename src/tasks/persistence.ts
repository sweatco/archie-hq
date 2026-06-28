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
import type { TaskMetadata, LogEntry, FindingType, SlackFile, SlackAttachment, SlackAuthor, SlackReaction } from '../types/index.js';
import { isExternalUser } from '../connectors/slack/client.js';
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
 * Get the path to a task's agents directory.
 * Each agent's per-task workspace (cwd, RW scratch space) lives under
 * `agents/<agentId>/`. Agent workspaces never contain repo clones — clones
 * live under the task's `repos/` tree (see `getAgentClonesDir`).
 */
export function getAgentsPath(taskId: string): string {
  return join(getTaskPath(taskId), 'agents');
}

/**
 * Get the directory where a given agent's repo clones live for this task.
 *
 * Layout: `sessions/<taskId>/repos/<agentId>/`. Each clone is then nested at
 * `<github>` (e.g., `org/repo/`). This is a sibling of `agents/<agentId>/`
 * (the agent's cwd) — clones are deliberately kept out of the workspace tree
 * so the workspace stays a clean RW scratch space and clone permissions are
 * controlled solely via the sandbox's allow/deny mounts.
 */
export function getAgentClonesDir(taskId: string, agentId: string): string {
  return join(getTaskPath(taskId), 'repos', agentId);
}

/**
 * Get the clone path for a specific repo attached to a specific agent.
 * Returns `sessions/<taskId>/repos/<agentId>/<github>/`.
 */
export function getAgentClonePath(taskId: string, agentId: string, github: string): string {
  return join(getAgentClonesDir(taskId, agentId), github);
}

/**
 * Get the legacy per-task repos directory (pre-v30).
 * Used only by the migration path; new code should use `getAgentClonesDir`.
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
 * Get the path to a task's artifacts directory (for cross-agent file sharing)
 */
export function getArtifactsPath(taskId: string): string {
  return join(getSharedPath(taskId), 'artifacts');
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
 * Build the `[Attachments: …]` suffix for a list of artifact paths.
 * Mirrors the inbound rendering at the bottom of `renderMessageForContext` so
 * outgoing messages with attachments look symmetric in the knowledge log.
 * Returns an empty string when there are no paths.
 */
export function renderAttachmentsSuffix(artifactPaths: readonly string[]): string {
  if (!artifactPaths.length) return '';
  const fileInfo = artifactPaths
    .map((p) => {
      const slash = p.lastIndexOf('/');
      const name = slash === -1 ? p : p.slice(slash + 1);
      return `${name} (${p})`;
    })
    .join(', ');
  return `\n  [Attachments: ${fileInfo}]`;
}

/**
 * Render the body of a Slack message for context (knowledge log, title generator, etc.).
 *
 * Single source of truth for redaction + forwarded-attachment rendering.
 * - Redacted: fixed placeholder.
 * - With externally-authored attachment: forwarder's text first, then a
 *   provenance label, then the forwarded content. Other (non-external)
 *   attachments fold into the inline body.
 * - Normal: author's text plus inline attachments and file list.
 */
export function renderMessageForContext(
  msg: { text: string; files?: SlackFile[]; attachments?: SlackAttachment[]; reactions?: SlackReaction[] },
  options: { redacted: boolean }
): string {
  if (options.redacted) {
    return '[redacted: external participant in shared channel]';
  }

  const inlineParts: string[] = [];
  if (msg.text) inlineParts.push(msg.text);

  let forwardedBlock = '';
  for (const att of msg.attachments ?? []) {
    if (att.author && isExternalUser(att.author)) {
      // Render the externally-authored attachment under a provenance label.
      // Only the first one gets the label block; subsequent ones (rare)
      // fold inline so the agent still sees them.
      if (!forwardedBlock) {
        const teamSuffix = att.author.teamId ? `, team ${att.author.teamId}` : '';
        const label = `[forwarded from @<${att.author.id}:${att.author.realName}> — external${teamSuffix}]`;
        forwardedBlock = `${label}\n${att.text}`;
        continue;
      }
    }
    if (att.text) inlineParts.push(att.text);
  }
  if (forwardedBlock) inlineParts.push(forwardedBlock);

  let fullMessage = inlineParts.join('\n');

  if (msg.files && msg.files.length > 0) {
    const fileInfo = msg.files.map(f => {
      const pathInfo = f.localPath ? ` (${f.localPath})` : '';
      return `${f.name}${pathInfo}`;
    }).join(', ');
    fullMessage += `\n  [Attachments: ${fileInfo}]`;
  }

  if (msg.reactions && msg.reactions.length > 0) {
    const reactionInfo = msg.reactions
      .map((r) => `:${r.name}:${r.count > 1 ? ` ×${r.count}` : ''}`)
      .join(', ');
    fullMessage += `\n  [Reactions: ${reactionInfo}]`;
  }

  return fullMessage;
}

/**
 * Append a Slack message to the knowledge log.
 */
export async function appendSlackMessage(
  taskId: string,
  channelInfo: { id: string; name: string },
  threadId: string,
  userInfo: SlackAuthor,
  message: string,
  files?: SlackFile[],
  attachments?: SlackAttachment[],
  options?: { redacted?: boolean; ts?: string; reactions?: SlackReaction[] }
): Promise<void> {
  const redacted = options?.redacted === true;
  const fullMessage = renderMessageForContext(
    { text: message, files, attachments, reactions: options?.reactions },
    { redacted },
  );

  // Mask the author name in the source line when the body is redacted, so the
  // log doesn't leak the external user's display name even though we keep it
  // in memory for classification purposes.
  const displayName = redacted ? 'external' : userInfo.realName;
  // Stamp the Slack message timestamp (`ts`) into the source line as a stable
  // message id, so agents can target ANY message in the thread when reacting
  // (e.g. via `react_to_message`), not just the most recent one.
  const msgIdSuffix = options?.ts ? ` | msg:${options.ts}` : '';
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    source: `@<${userInfo.id}:${displayName}> in ${formatSlackChannelRef(channelInfo.id, channelInfo.name, threadId)}${msgIdSuffix}`,
    message: fullMessage,
  };

  await appendFile(getKnowledgeLogPath(taskId), formatLogEntry(entry));
  // Emit the original message body in events so live observers (CLI/UI) still
  // see redacted vs internal as a clear category — pass the same string we
  // wrote to the log.
  emitEvent('message', taskId, {
    from: displayName,
    to: 'pm-agent',
    destination: formatSlackChannelDisplay(channelInfo.name),
    message: fullMessage,
  });
}

/**
 * Render the body of a message-edit log entry: the new text, tagged as an edit.
 * The previous text is intentionally not included — the original message is
 * already in the log under the same `msg:<ts>` id, so an agent correlates the
 * two by id rather than us duplicating now-stale text. Pure — no I/O — so it can
 * be unit tested directly (see persistence.test.ts).
 */
export function renderEditForContext(newText: string): string {
  return `[edited] ${newText}`;
}

/**
 * Append a message-edit notice to the knowledge log.
 *
 * Records that a Slack message previously ingested into this task (identified by
 * `editedTs`) was edited, capturing the new text. Written as a fresh entry
 * rather than mutating the original line — the log stays append-only and the
 * edit auditable. The `msg:<ts>` suffix matches the id stamped by
 * `appendSlackMessage`, so the edit correlates to the original message (whose
 * pre-edit text remains in the log under the same id).
 */
export async function appendSlackEdit(
  taskId: string,
  channelInfo: { id: string; name: string },
  threadId: string,
  userInfo: SlackAuthor,
  editedTs: string,
  newText: string,
): Promise<void> {
  const body = renderEditForContext(newText);
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    source: `@<${userInfo.id}:${userInfo.realName}> in ${formatSlackChannelRef(channelInfo.id, channelInfo.name, threadId)} | msg:${editedTs}`,
    message: body,
  };

  await appendFile(getKnowledgeLogPath(taskId), formatLogEntry(entry));
  emitEvent('message', taskId, {
    from: userInfo.realName,
    to: 'pm-agent',
    destination: formatSlackChannelDisplay(channelInfo.name),
    message: body,
  });
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
 * Append an artifact share to the knowledge log.
 *
 * Records that an agent published a file to `shared/artifacts/`. Other agents can
 * read the artifact via the absolute path. Reuses the `agent:log` event channel so
 * existing CLI/SSE rendering picks it up without changes.
 */
export async function appendArtifactShared(
  taskId: string,
  agentName: string,
  artifactPath: string,
  description: string,
): Promise<void> {
  const finding = `shared artifact: ${artifactPath} — ${description}`;
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    source: agentName,
    type: 'artifact',
    message: finding,
  };

  await appendFile(getKnowledgeLogPath(taskId), formatLogEntry(entry));
  emitEvent('agent:log', taskId, { finding, type: 'artifact' }, agentName);
}

/**
 * Append a user-facing message to the knowledge log (no event — caller emits).
 *
 * When `artifactPaths` is non-empty, the rendered message includes a trailing
 * `[Attachments: …]` line (same shape used for inbound Slack files) so the log
 * shows what was attached.
 */
export async function appendMessageToUser(
  taskId: string,
  agentName: string,
  message: string,
  destination?: string,
  artifactPaths?: readonly string[],
): Promise<void> {
  const source = destination ? `${agentName} in ${destination}` : agentName;
  const renderedMessage = message + renderAttachmentsSuffix(artifactPaths ?? []);
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    source,
    message: renderedMessage,
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
 * @param githubRepo - Full "owner/repo" identifier (e.g., 'acme/mobile')
 * @param event - Structured event with author, destination (e.g. "PR #42"), and clean message body
 */
export async function appendGitHubEvent(
  taskId: string,
  githubRepo: string,
  event: { from: string; destination: string; message: string }
): Promise<void> {
  const destination = `github:${githubRepo}/${event.destination}`;
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    source: `@<${event.from}> in ${destination}`,
    message: event.message,
  };

  await appendFile(getKnowledgeLogPath(taskId), formatLogEntry(entry));
  emitEvent('message', taskId, {
    from: event.from,
    to: 'pm-agent',
    destination,
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
 * Append a launch prompt to the knowledge log of a freshly-launched task.
 * The entry preserves the exact prompt and the originating task/reason so the
 * PM can see what triggered it.
 */
export async function appendLaunchMessage(
  taskId: string,
  originatingTaskId: string,
  reason: string,
  prompt: string,
): Promise<void> {
  const body = `Reason: ${reason}

${prompt}

Note: this task was launched in the background and has no channel yet. Open a destination via post_to_user(target.new_dm <userId>) or post_to_user(target.new_thread <channelId>) before posting, or call report_completion() with no message to finish silently.`;
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    source: `task:${originatingTaskId}`,
    message: body,
  };

  await appendFile(getKnowledgeLogPath(taskId), formatLogEntry(entry));
  emitEvent('message', taskId, { from: originatingTaskId, to: 'pm-agent', message: body });
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
 * Find a task by PR number and repo.
 *
 * Uses grep to find candidates, then verifies that some agent on the task has
 * an AttachedRepo for the matching github with a branch state pointing at the
 * given PR number.
 */
export async function findTaskByPRNumber(
  githubRepo: string,
  prNumber: number
): Promise<string | null> {
  await ensureSessionsDir();

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

      // Normalize legacy (pre-v30) `repositories` shape in memory before
      // walking. This routes webhook events for in-flight PRs on tasks that
      // haven't been re-saved since deploy (their on-disk metadata is still the
      // old Record<repoKey, RepositoryInfo>). Mutates the loaded copy only — we
      // never persist from here. Dynamic import avoids a static persistence↔task
      // cycle; the call is runtime-only so the cycle is harmless either way.
      const { migrateRepositoriesShape } = await import('./task.js');
      migrateRepositoriesShape(metadata);

      // Walk every agent's attached repos and look for the github + pr_number.
      for (const attachments of Object.values(metadata.repositories || {})) {
        if (!Array.isArray(attachments)) continue;
        for (const attached of attachments) {
          if (attached.github !== githubRepo) continue;
          if (!attached.branch_states) continue;
          for (const state of Object.values(attached.branch_states)) {
            if (state.pr_number === prNumber) return taskId;
          }
        }
      }
    }
  } catch {
    // Fallback silently if grep fails
  }

  return null;
}

/**
 * Find the task that owns a given head branch in a repo. Branch names key the
 * per-branch state, so this resolves a task from a CI/webhook event even when
 * the branch isn't the `archie/{taskId}` pattern and no PR number is in the
 * payload (e.g. `workflow_run`). Returns null if none match.
 */
export async function findTaskByBranch(
  githubRepo: string,
  branch: string
): Promise<string | null> {
  await ensureSessionsDir();
  if (!branch) return null;

  try {
    const { execSync } = await import('child_process');
    // Candidate-narrowing grep: the branch string appears as a branch_states
    // key (it may also match a current_branch/base_branch value — harmless, the
    // `branch in branch_states` check below filters those out). Fixed-string
    // (-F) because branch names contain regex-special chars like '/'.
    const grepResult = execSync(
      `grep -lF '"${branch}"' ${SESSIONS_DIR}/task-*/shared/metadata.json 2>/dev/null || true`,
      { encoding: 'utf-8' }
    ).trim();

    if (!grepResult) return null;

    for (const filePath of grepResult.split('\n')) {
      const taskIdMatch = filePath.match(/task-[a-z0-9-]+/i);
      if (!taskIdMatch) continue;

      const taskId = taskIdMatch[0];
      const metadata = await loadMetadata(taskId);
      if (!metadata) continue;

      const { migrateRepositoriesShape } = await import('./task.js');
      migrateRepositoriesShape(metadata);

      for (const attachments of Object.values(metadata.repositories || {})) {
        if (!Array.isArray(attachments)) continue;
        for (const attached of attachments) {
          if (attached.github !== githubRepo) continue;
          if (attached.branch_states && branch in attached.branch_states) return taskId;
        }
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
