/**
 * Task Manager
 *
 * Handles task persistence: creating task folders, reading/writing metadata,
 * appending to knowledge.log
 */

import { mkdir, readdir, readFile, writeFile, appendFile } from 'fs/promises';
import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join, resolve, relative, isAbsolute, sep } from 'path';
import type { TaskMetadata, LogEntry, FindingType, SlackFile, SlackAuthor } from '../types/index.js';
import type { SystemEvent } from '../system/event-bus.js';
import { activeTasks } from './task.js';
import { SESSIONS_DIR } from '../system/workdir.js';
import { emitEvent, onEvent } from '../system/event-bus.js';
import { logger } from '../system/logger.js';
import { formatSlackChannelRef, formatSlackChannelDisplay } from '../connectors/slack/client.js';

const execFileAsync = promisify(execFile);

/**
 * Ceiling on a scan's stdout. Only matching paths are printed, so this is ~150
 * bytes per hit — far more headroom than a needle broad enough to match the
 * whole fleet would need, while still bounding a runaway.
 */
const MAX_SCAN_OUTPUT_BYTES = 32 * 1024 * 1024;

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
 * Validate a taskId against the canonical shape produced by `generateTaskId`
 * (`task-YYYYMMDD-HHMM-<base36 suffix>`). A safe taskId is exactly one path
 * segment — no slashes, no `..` — so callers may build filesystem paths from it
 * without a traversal escaping the sessions/ root.
 *
 * taskId can arrive from the HTTP API (`/api/tasks/:id/...`) and is therefore
 * untrusted; any value used to construct a path must pass this guard before it
 * reaches a filesystem sink.
 */
export function isSafeTaskId(id: string): boolean {
  return /^task-\d{8}-\d{4}-[a-z0-9]+$/.test(id);
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
 * Does this task still exist on disk?
 *
 * Distinct from `loadMetadata() !== null`, which also returns null for a file
 * that exists but failed to parse — a torn read is possible because metadata
 * writes are non-atomic. Callers that must tell "gone for good" from "temporarily
 * unreadable" need this, not that.
 */
export function taskExistsOnDisk(taskId: string): boolean {
  return existsSync(getMetadataPath(taskId));
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
 * Mirrors the inbound rendering at the bottom of `renderMessageBody` (`src/connectors/slack/message-body.ts`) so
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
 * Append a Slack message to the knowledge log.
 *
 * The body arrives already rendered: rendering is owned by `renderMessageBody` in `src/connectors/slack/message-body.ts`, and the caller is the one that knows the message's parts (in particular the *downloaded* files, whose `localPath` only exists after the download await). Keeping this function to persistence-only concerns is what stops a second renderer growing here.
 */
export async function appendSlackMessage(
  taskId: string,
  channelInfo: { id: string; name: string },
  threadId: string,
  userInfo: SlackAuthor,
  renderedBody: string,
  options?: { redacted?: boolean; ts?: string }
): Promise<void> {
  const redacted = options?.redacted === true;

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
    source: `<@${userInfo.id}:${displayName}> in ${formatSlackChannelRef(channelInfo.id, channelInfo.name, threadId)}${msgIdSuffix}`,
    message: renderedBody,
  };

  await appendFile(getKnowledgeLogPath(taskId), formatLogEntry(entry));
  // Emit the original message body in events so live observers (CLI/UI) still
  // see redacted vs internal as a clear category — pass the same string we
  // wrote to the log.
  emitEvent('message', taskId, {
    from: displayName,
    to: 'pm-agent',
    destination: formatSlackChannelDisplay(channelInfo.name),
    message: renderedBody,
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
    source: `<@${userInfo.id}:${userInfo.realName}> in ${formatSlackChannelRef(channelInfo.id, channelInfo.name, threadId)} | msg:${editedTs}`,
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
 * Candidate scan: task IDs whose shared/metadata.json contains `needle` as a
 * plain substring, in directory order. A substring hit only narrows candidates;
 * callers verify matches structurally against the parsed metadata.
 *
 * grep does the reading — one process over the fleet rather than one sequential
 * readFile per task, which is a cost that grows with every task ever created.
 * The shell expands the glob (the shape rebuildFromDisk in reminder-scheduler.ts
 * already uses), which also keeps the file list out of argv and away from
 * ARG_MAX. Recursion is deliberately avoided: a session directory also holds
 * repo clones and SDK transcripts, so `grep -r` would walk gigabytes to answer a
 * question about one small file per task.
 *
 * The needle is safe on two independent grounds: its form is checked first (see
 * assertNeedleForm), and it is passed as a POSITIONAL ARGUMENT rather than
 * interpolated into the script, so `sh` expands the glob but never parses the
 * data. That is the whole reason the previous grep was removed in 3190d00 —
 * needles carry external input, git ref rules allow quotes, semicolons and
 * `$()`, and a crafted branch name reaching an execSync string could execute
 * shell commands. `-F` keeps the needle a fixed string rather than a regex, and
 * `--` stops one starting with `-` being read as a flag.
 *
 * `|| [ $? -le 2 ]` absorbs grep's "no match" (1) and "a file was unreadable"
 * (2, which is what an empty sessions dir looks like once the glob fails to
 * expand) while still failing on anything else. A failed scan must not read as
 * "no task matches": that would route a webhook to a new task instead of the one
 * that owns the branch.
 */
async function scanMetadataFiles(needle: string): Promise<string[]> {
  assertNeedleForm(needle);

  const { stdout } = await execFileAsync(
    'sh',
    [
      '-c',
      'grep -lF -- "$1" "$2"/task-*/shared/metadata.json 2>/dev/null || [ $? -le 2 ]',
      'sh',
      needle,
      SESSIONS_DIR,
    ],
    { encoding: 'utf-8', maxBuffer: MAX_SCAN_OUTPUT_BYTES },
  );

  const hits: string[] = [];
  for (const line of stdout.split('\n')) {
    // …/sessions/<taskId>/shared/metadata.json
    const taskId = line.trim().split(sep).at(-3);
    if (taskId?.startsWith('task-')) hits.push(taskId);
  }
  return hits;
}

/**
 * Every needle is a JSON-encoded fragment of the serialized metadata — a quoted
 * string, or a `"key": value` pair — so its form is known before it is built:
 * one line, no control characters, because JSON.stringify escapes them all.
 *
 * Checking that form is the first of the two guarantees that make the pattern
 * safe to hand to grep, and the one that survives a future refactor of how the
 * command gets assembled. Anything malformed is a construction bug at the call
 * site, so it throws rather than being trimmed into something plausible.
 */
function assertNeedleForm(needle: string): void {
  if (needle.length === 0) throw new Error('scanMetadataFiles: needle must not be empty');
  const control = /[\u0000-\u001f\u007f]/.exec(needle);
  if (control) {
    const at = control.index;
    throw new Error(
      `scanMetadataFiles: needle must be a single line of printable text — ` +
      `found control character 0x${needle.charCodeAt(at).toString(16).padStart(2, '0')} at index ${at}. ` +
      `Needles are JSON-encoded fragments; encode the value before scanning.`,
    );
  }
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

  // Disk: scan metadata files not loaded in memory. JSON.stringify matches the
  // serialized form exactly (saveMetadata writes JSON.stringify(…, 2)).
  await ensureSessionsDir();
  const hits = await scanMetadataFiles(`"thread_id": ${JSON.stringify(threadId)}`);
  return hits[0] ?? null;
}

/**
 * Find a task by PR number and repo.
 *
 * Scans metadata files for candidates, then verifies that some agent on the
 * task has an AttachedRepo for the matching github with a branch state
 * pointing at the given PR number.
 */
export async function findTaskByPRNumber(
  githubRepo: string,
  prNumber: number
): Promise<string | null> {
  await ensureSessionsDir();

  try {
    for (const taskId of await scanMetadataFiles(`"pr_number": ${prNumber}`)) {
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
    // Fallback silently if the scan or metadata walk fails
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
    // Candidate-narrowing scan: the branch appears as a branch_states key (it
    // may also match a current_branch/base_branch value — harmless, the
    // `branch in branch_states` check below filters those out). The branch is
    // webhook-controlled and may contain quotes and shell metacharacters, so
    // it must never reach a shell; JSON.stringify also matches the serialized
    // (escaped) form exactly.
    for (const taskId of await scanMetadataFiles(JSON.stringify(branch))) {
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
    // Fallback silently if the scan or metadata walk fails
  }

  return null;
}

/**
 * Has any task muted this exact Slack thread? A mute is stored on the task that
 * took it, so a per-task check can't see one taken elsewhere: on 2026-08-05 one
 * task was told to leave a #backend-dev thread while a second task went on
 * posting into it.
 *
 * Matched on the thread, not the channel. Muting is routine — ~100 of 2575 prod
 * tasks have muted something, across 29 channels, #bugs 16 times — so treating
 * a mute as closing its whole channel would lock Archie out of the channels bug
 * reports arrive in.
 */
export async function isThreadMuted(channelId: string, threadTs: string): Promise<boolean> {
  try {
    // A Slack thread belongs to at most one task — that's the routing model, and
    // findTaskByThread is how the Slack router already resolves it. No second
    // scan of its own.
    const taskId = await findTaskByThread(threadTs);
    if (!taskId) return false;

    // Prefer the live instance: a mute taken this turn may not be flushed yet.
    const metadata = activeTasks.get(taskId)?.metadata ?? (await loadMetadata(taskId));
    const channel = metadata?.channels[`slack:${channelId}:${threadTs}`];
    return channel?.type === 'slack' && !!channel.muted;
  } catch {
    // Best-effort: a failed lookup must not block posting outright.
    return false;
  }
}

/**
 * Find all tasks with a given status.
 * Substring scan narrows candidates without parsing every metadata.json.
 */
export async function findTasksByStatus(
  status: 'in_progress' | 'stopped' | 'completed'
): Promise<TaskMetadata[]> {
  await ensureSessionsDir();

  const tasks: TaskMetadata[] = [];
  for (const taskId of await scanMetadataFiles(`"status": ${JSON.stringify(status)}`)) {
    const metadata = await loadMetadata(taskId);
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

// ---- Usage JSONL persistence ----

/**
 * Get the path to a task's usage log (JSONL)
 */
export function getUsageLogPath(taskId: string): string {
  return join(getSharedPath(taskId), 'usage.jsonl');
}

/**
 * One append-only usage record, written on each SDK `result` event.
 *
 * `query_nonce` is the per-query()-call identity used for cost aggregation;
 * `session_id` is retained for traceability/debugging only and is NOT used in
 * cost math (a single session_id resumes across many query() calls).
 */
export interface TaskUsageRecord {
  ts: string;
  taskId: string;
  agentId: string;
  agentKey: string;
  query_nonce: string;
  session_id?: string;
  subtype: string;
  num_turns: number;
  total_cost_usd: number;
  modelUsage: Record<string, unknown>;
  usage: unknown;
}

/**
 * Serialized write queues per task for usage records — dedicated so usage
 * writes never contend with the events queue.
 */
const usageWriteQueues = new Map<string, Promise<void>>();

/**
 * Append a usage record to the task's usage.jsonl (fire-and-forget).
 * No-ops if the shared/ dir is missing; never throws.
 */
export async function appendUsageRecord(record: TaskUsageRecord): Promise<void> {
  // taskId flows into filesystem path construction below (getSharedPath /
  // getUsageLogPath → appendFile), and it can arrive from the HTTP API, so it
  // is untrusted. Two barriers, both written INLINE here rather than behind the
  // `isSafeTaskId` helper — CodeQL's path-injection analysis does not treat a
  // regexp test hidden in a boolean-returning helper as a sanitizer, so the
  // literal guards must sit in the function that reaches the sink. No-op on any
  // rejection so the fire-and-forget / never-throw contract is preserved.

  // (a) INLINE allowlist barrier at entry — the canonical single-segment id.
  if (!/^task-\d{8}-\d{4}-[a-z0-9]+$/.test(record.taskId)) return;
  const prev = usageWriteQueues.get(record.taskId) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      // (b) INLINE containment barrier before the existsSync / appendFile
      // sinks: resolve the taskId-derived paths and confirm they stay under
      // SESSIONS_DIR, then hand the sinks the resolved absolute paths.
      const root = resolve(SESSIONS_DIR);
      const dir = resolve(getSharedPath(record.taskId));
      const abs = resolve(getUsageLogPath(record.taskId));
      const rel = relative(root, abs);
      const relDir = relative(root, dir);
      if (
        rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) ||
        relDir === '..' || relDir.startsWith('..' + sep) || isAbsolute(relDir)
      )
        return;
      if (!existsSync(dir)) return;
      await appendFile(abs, JSON.stringify(record) + '\n');
    } catch (err) {
      logger.warn('usage', `Failed to persist usage record for ${record.taskId}: ${err}`);
    }
  });
  usageWriteQueues.set(record.taskId, next);
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
