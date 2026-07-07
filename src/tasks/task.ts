/**
 * Task Class
 *
 * The central unit of work. Owns agents, metadata, budgets, lifecycle.
 * Created via Task.create(thread) or Task.get(taskId).
 */

import { mkdir, writeFile } from 'fs/promises';
import type { AgentName, SlackAuthor, SlackChannel, SlackThread, SlackReaction, TaskMetadata, BranchState } from '../types/task.js';
import { CLI_CHANNEL_KEY } from '../types/task.js';
import type { AgentDef } from '../types/agent.js';
import { isPmAgent, isRepoAgent } from '../types/agent.js';
import { modelDisplayLabel, resolveAgentModel } from '../agents/model-label.js';
import { prCardFingerprint, prCardTitlePlain } from '../system/pr-card-format.js';
import { getGitHubClient } from '../connectors/github/client.js';
import { createKeyedLock } from '../system/keyed-lock.js';

/**
 * Target for postToUser — controls where the message is delivered.
 */
export interface PostTarget {
  /** Post to an existing linked thread (channel key, e.g., "slack:C123:456.789") */
  channel?: string;
  /** Start a new DM with a user (Slack user ID). Reuses existing DM thread if one is linked. */
  new_dm?: string;
  /** Start a new thread in a channel (Slack channel ID). */
  new_thread?: string;
}

/**
 * Resource budgets for a task (Defense 4 — per-task limits)
 */
export interface TaskBudgets {
  researchRequestCount: number;     // web_research calls made
  researchRequestLimit: number;     // default: 5
  interAgentMessageCount: number;   // send_message_to_agent calls
  interAgentMessageLimit: number;   // default: 100
  taskStartTime: Date;              // for wall-clock timeout
  taskTimeoutMs: number;            // default: 3_600_000 (60 minutes)
}
import { Agent } from '../agents/agent.js';

import {
  loadMetadata,
  getMetadataPath,
  appendAgentFinding,
  appendAgentMessage,
  appendMessageToUser,
  appendSlackMessage,
  appendSlackEdit,
  renderAttachmentsSuffix,
  downloadMessageFiles,
  ensureSessionsDir,
  generateTaskId,
  getSharedPath,
  getMemoryPath,
  getKnowledgeLogPath,
} from './persistence.js';
import { getIsShuttingDown } from '../system/shutdown.js';
import { scheduleIdleCheck } from './recovery.js';
import { scanAgentDefs, getAgentDef, getVisiblePeerIdsForSender, synthesizeDynamicAgentDef } from '../agents/registry.js';
import type { AttachedRepo } from '../types/task.js';
import { syncPlugins } from '../system/plugin-sync.js';
import { postSlackMessage, postSlackFiles, postInteractiveToThread, postInteractiveToThreads, updateMessage, deleteMessage, buildPrCardBlocks, addReaction, removeReaction, getMessageReactions, buildThreadUrl, openDMChannel, getChannelInfo, getUserInfo, isExternalUser, formatSlackChannelRef, formatSlackChannelDisplay } from '../connectors/slack/client.js';
import { basename } from 'path';
import { AGENT_PROMPTS } from '../agents/prompts.js';
import { logger } from '../system/logger.js';
import { emitEvent } from '../system/event-bus.js';
import { TaskStatusController, isStatusEnabled } from './status.js';
import { setSlackThreadStatus } from '../connectors/slack/status.js';
import { agentDomainLabel, deriveActivityFromEvent } from '../agents/activity.js';

// ---- Global state ----

export const activeTasks = new Map<string, Task>();

/**
 * Per-task serialization for PR-card writes. A PM turn-end (resurfacePrCards)
 * and an async GitHub webhook (refreshPrCardInPlace) can both touch the same
 * PR's card. Keyed by taskId, this lock runs card operations one at a time, so
 * for the live in-memory instance the stored `pr_card.slack.ts`/fingerprint is
 * never interleaved (no double-post or reference to a just-deleted message).
 * For an inactive task two webhooks could load separate instances; the lock
 * still serializes their writes, and since both recompute the card from the
 * same fresh GitHub state the result is idempotent. Card writes flush
 * synchronously (save(true)) so the next op sees them.
 */
const cardLock = createKeyedLock();

/**
 * Per-task serialization for the activation flow (sendMessage → activate/spawn),
 * keyed by taskId and shared across Task instances.
 *
 * `Task.get` returns the cached instance only once it's in `activeTasks`, and the
 * slot is set in `activate()` — well into the first sendMessage. So concurrent
 * reopen triggers for the same parked task (GitHub webhook + Slack reply +
 * startup recovery routinely fire in one tick) can each hold a *separate* Task
 * built by their own `Task.get` miss; left unserialized, each activates and
 * spawns its own cli.js on the same session id — two subprocesses racing edits
 * on one session (the per-Agent isRunning guard can't see across instances).
 *
 * This lock funnels them: whichever runs first activates and registers itself in
 * `activeTasks`; the rest then resolve to that canonical instance and enqueue
 * onto it, so exactly one set of agents ever spawns.
 */
const activationLock = createKeyedLock();

// ---- Task class ----

/**
 * Whether an `updateAgentState` transition should clear a pending completion
 * intent: PM genuinely re-engaging on a real inactive→active edge. Gating on the
 * pre-update `wasActive` keeps it edge-exact — the SDK `init` re-fire arrives with
 * the agent already active (the synchronous enqueue mark won the race), so it must
 * not re-clear intent on every resumed turn. Pure, for unit testing.
 */
export function shouldClearCompletionIntent(
  agentName: string,
  active: boolean,
  wasActive: boolean,
): boolean {
  return active && !wasActive && agentName === 'pm-agent';
}

export class Task {
  readonly taskId: string;
  metadata: TaskMetadata;
  readonly agentProcesses: Map<AgentName, Agent> = new Map();
  team: AgentDef[];
  budgets: TaskBudgets;
  isActive: boolean = false;
  lastActivity: Date = new Date();
  recoveryAttempts: number = 0;
  /**
   * Set by report_completion: PM has responded and is waiting on no one but the
   * user. The idle-check parks the task (instead of recovering) once all agents
   * are idle. Cleared when PM next goes active (see updateAgentState). In-memory
   * only — lost on restart, where recovery re-arms the lifecycle instead.
   */
  completionIntent: boolean = false;
  taskTimeoutTimer?: ReturnType<typeof setInterval>;
  /** Drives the "Archie is …" Slack loading indicator from agent activity. */
  private readonly statusController: TaskStatusController;

  private constructor(taskId: string, metadata: TaskMetadata, team: AgentDef[]) {
    this.taskId = taskId;
    this.team = team;
    this.statusController = new TaskStatusController((status) => this.onStatusRendered(status));
    this.budgets = {
      researchRequestCount: metadata.research_request_count ?? 0,
      researchRequestLimit: 5 + (metadata.research_budget_extra ?? 0),
      interAgentMessageCount: 0,
      interAgentMessageLimit: 100,
      taskStartTime: new Date(),
      taskTimeoutMs: 3_600_000, // 60 minutes
    };

    // Migrate legacy slack_threads → channels
    if (metadata.slack_threads?.length && !metadata.channels) {
      metadata.channels = {};
      for (const ref of metadata.slack_threads) {
        const id = `slack:${ref.channel_id}:${ref.thread_id}`;
        metadata.channels[id] = {
          type: 'slack',
          thread_id: ref.thread_id,
          channel_id: ref.channel_id,
          channel_name: '',
          last_processed_ts: ref.last_processed_ts,
        };
        metadata.default_channel ??= id;
      }
      delete metadata.slack_threads;
    }
    // Ensure channels/default_channel exist on metadata
    metadata.channels ??= {};
    metadata.default_channel ??= null;

    this.metadata = metadata;
  }

  // ---- Static factory methods ----

  /**
   * Create a new empty task.
   * Sets up disk structure (folders, metadata, skills).
   * Task is inert until sendMessage() is called, which activates it.
   */
  static async create(): Promise<Task> {
    await syncPlugins();
    await ensureSessionsDir();

    const taskId = generateTaskId();
    const sharedPath = getSharedPath(taskId);

    // Create task directory structure
    await mkdir(sharedPath, { recursive: true });
    await mkdir(getMemoryPath(taskId), { recursive: true });

    // Scan fresh agent defs for this task
    const team = scanAgentDefs();

    // metadata.repositories is populated lazily per-agent during spawn.
    // It maps agentId → list of currently-attached repos.
    const metadata: TaskMetadata = {
      task_id: taskId,
      task_owner: null,
      participants: [],
      channels: {},
      default_channel: null,
      agent_sessions: {},
      repositories: {},
      status: 'in_progress',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await writeFile(getMetadataPath(taskId), JSON.stringify(metadata, null, 2));
    await writeFile(getKnowledgeLogPath(taskId), '');

    logger.system(`Created task ${taskId}`);
    emitEvent('task:created', taskId);

    const task = new Task(taskId, metadata, team);
    return task;
  }

  /**
   * Load a task by ID. Returns cached instance if already active.
   * Task is inert until sendMessage() is called, which activates it.
   *
   * An in-flight task (still in activeTasks) is returned as-is — we never
   * disturb a live task's team or agents. Only when a task is reloaded from
   * disk (i.e. it was stopped/completed and is being pinged again, or the
   * process restarted) do we sync plugins and scan a fresh team, so the
   * resumed task picks up any repo changes.
   */
  static async get(taskId: string): Promise<Task> {
    const existing = activeTasks.get(taskId);
    if (existing) return existing;

    await syncPlugins();

    const metadata = await loadMetadata(taskId);
    if (!metadata) {
      throw new Error(`Task ${taskId} not found`);
    }

    // v30 migration: `metadata.repositories` used to be Record<repoKey, RepositoryInfo>
    // (one object per repo agent, keyed by short name). Now it's
    // Record<agentId, AttachedRepo[]> (per-agent list of attached repos).
    // Detect by structural check: any value that's NOT an array is old shape.
    const didMigrate = migrateRepositoriesShape(metadata);

    // Persist the upgrade once. The migration is otherwise in-memory, so a
    // terminal task that's only ever *read* (webhook resolution, comment-dedup
    // skip) would re-migrate on every load forever. Writing it back here means the
    // next load hits the fast path — and it locks in the shape now, while every
    // repo agent still resolves (a later plugin removal would otherwise make the
    // migration drop those entries). Only an active task ever re-saves on its own.
    if (didMigrate) {
      await writeFile(getMetadataPath(taskId), JSON.stringify(metadata, null, 2));
      // Log once, here — the migration persisted, so it won't run again. (The
      // migrate fn stays silent: it runs on every load, incl. read-only
      // findTaskByPRNumber, so logging there would spam.)
      logger.system(`[migrate] task ${taskId}: upgraded repositories to v30 (${Object.keys(metadata.repositories).join(', ')})`);
    }

    const team = scanAgentDefs();
    // Rehydrate PM-spawned repo agents from their persisted specs and merge
    // them into the team, so peer lists, messaging, and ensureAgentSpawned all
    // see them on a reloaded task (and after a process restart).
    for (const spec of metadata.dynamic_agents ?? []) {
      team.push(synthesizeDynamicAgentDef(spec));
    }
    return new Task(taskId, metadata, team);
  }

  // ---- Public methods ----

  /**
   * Send a message to an agent (default: PM).
   * Creates agent lazily on first message, spawns if not running.
   * Activates the task on first call (starts timeout, sets status).
   */
  async sendMessage(message: string, agentName: AgentName = 'pm-agent'): Promise<void> {
    // Serialize activation per taskId across all Task instances, and resolve to
    // the canonical instance *inside* the lock. If a concurrent trigger already
    // activated (registered itself in activeTasks), this routes the message onto
    // that instance rather than activating and spawning a duplicate; otherwise
    // `this` is the first in and becomes canonical. See `activationLock`.
    await activationLock(this.taskId, () =>
      (activeTasks.get(this.taskId) ?? this).deliver(message, agentName),
    );
  }

  /**
   * The activation + enqueue body, run under {@link activationLock} on the
   * canonical instance. Never call directly — go through `sendMessage`, which
   * holds the lock and picks the canonical instance.
   */
  private async deliver(message: string, agentName: AgentName): Promise<void> {
    if (!this.isActive) {
      this.activate();
    }
    await this.ensureAgentSpawned(agentName);
    const agent = this.agentProcesses.get(agentName);
    if (!agent) {
      throw new Error(`No agent ${agentName} after spawn`);
    }
    agent.queue.addMessage(message);
    // Mark active synchronously at enqueue (not lazily at the SDK `init` re-fire,
    // which lags). Keeps "all agents idle" a faithful proxy for "no work in
    // flight" so the idle-check can't park a recipient that's about to process,
    // and fires PM's intent-clear edge the moment work is delivered.
    this.updateAgentState(agentName, true);
  }

  /**
   * Append a Slack thread's messages to this task.
   * If the thread is new, links it as a channel and appends all messages.
   * If already linked, appends only messages newer than last_processed_ts.
   * Returns whether a new thread was linked.
   */
  async append(thread: SlackThread): Promise<{ linkedNewThread: boolean }> {
    const channelId = `slack:${thread.channel.id}:${thread.threadId}`;
    const existing = this.metadata.channels[channelId] as SlackChannel | undefined;

    // Redaction policy: when the channel is shared and the message author is
    // external, drop content and don't download files. Author info is logged.
    const writeMessage = async (msg: typeof thread.messages[number]): Promise<void> => {
      const redact = thread.shared && isExternalUser(msg.user);
      if (redact) {
        await appendSlackMessage(
          this.taskId, thread.channel, thread.threadId, msg.user, '', undefined, undefined,
          { redacted: true, ts: msg.ts },
        );
      } else {
        const downloadedFiles = msg.files ? await downloadMessageFiles(this.taskId, msg.files) : undefined;
        await appendSlackMessage(
          this.taskId, thread.channel, thread.threadId, msg.user, msg.text,
          downloadedFiles, msg.attachments,
          { ts: msg.ts, reactions: msg.reactions },
        );
      }
    };

    if (!existing) {
      // New thread — link it as a channel and append all messages
      this.metadata.channels[channelId] = {
        type: 'slack',
        thread_id: thread.threadId,
        channel_id: thread.channel.id,
        channel_name: thread.channel.name,
        last_processed_ts: thread.currentMessageTs,
        url: buildThreadUrl(thread.channel.id, thread.threadId) ?? undefined,
      };
      this.metadata.default_channel ??= channelId;

      for (const msg of thread.messages) {
        await writeMessage(msg);
      }

      this.debouncedSave();
      return { linkedNewThread: true };
    }

    // Existing thread — only append messages newer than last_processed_ts
    const lastProcessedTs = existing.last_processed_ts;
    for (const msg of thread.messages) {
      if (msg.ts <= lastProcessedTs) continue;
      await writeMessage(msg);
    }

    existing.last_processed_ts = thread.currentMessageTs;
    this.debouncedSave();
    return { linkedNewThread: false };
  }

  /**
   * Record that a Slack message previously ingested into this task was edited.
   *
   * Writes a fresh knowledge-log entry (we never mutate prior entries) keyed to
   * the original message via `msg:<ts>`, capturing the new text. The pre-edit
   * text stays in the log under that same id, so the change is recoverable by
   * correlation. Deliberately does NOT advance `last_processed_ts` — an edit
   * reuses the original message's `ts`, so touching the watermark would skip
   * genuinely new replies. Returns false when the thread isn't a linked Slack
   * channel.
   */
  async appendSlackEdit(
    channelKey: string,
    author: SlackAuthor,
    editedTs: string,
    newText: string,
  ): Promise<boolean> {
    const ch = this.metadata.channels[channelKey];
    if (ch?.type !== 'slack') return false;
    await appendSlackEdit(
      this.taskId,
      { id: ch.channel_id, name: ch.channel_name },
      ch.thread_id,
      author,
      editedTs,
      newText,
    );
    return true;
  }

  /**
   * Link the CLI channel to this task. Called on every CLI inbound (create + follow-up),
   * mirroring how Slack's append() ensures its channel is linked on every message.
   * Idempotent — overwriting the same channel entry is a no-op; default_channel is only
   * promoted the first time via ??=.
   */
  linkCliChannel(): void {
    this.metadata.channels[CLI_CHANNEL_KEY] = { type: 'cli', id: CLI_CHANNEL_KEY };
    this.metadata.default_channel ??= CLI_CHANNEL_KEY;
    this.debouncedSave();
  }

  /**
   * Post a message to the user.
   *
   * Targeting modes:
   * - No target: post to default_channel only
   * - target.channel: post to a specific already-linked thread
   * - target.new_dm: open DM with user, post message, link thread (reuses existing DM if found)
   * - target.new_thread: post top-level message in channel, link thread
   *
   * Returns the channel key when a new channel is created/reused, null otherwise.
   */
  async postToUser(message: string, agentName?: string, target?: PostTarget): Promise<string | null> {
    const sender = agentName || 'system';
    // Grey footer (task id + PM model) appended to every user-facing message:
    // a Slack `context` block, and the same string on the `message` event so the
    // CLI can render it dimmed (see logOutgoingMessage / TaskDetail).
    const footer = this.buildUserFooter();

    // New DM — open DM channel, reuse existing thread or create new
    if (target?.new_dm) {
      const dmChannelId = await openDMChannel(target.new_dm);
      const existing = this.findChannelBySlackId(dmChannelId);
      if (existing) {
        await postSlackMessage({
          channel: existing.channel.channel_id,
          threadTs: existing.channel.thread_id,
          text: message,
          footer,
        });
        this.logOutgoingMessage(sender, message, Task.formatSlackDest(existing.channel).display, existing.channel, footer);
        return existing.key;
      } else {
        const userInfo = await getUserInfo(target.new_dm);
        const channelName = `DM with ${userInfo.realName}`;
        const ts = await postSlackMessage({ channel: dmChannelId, text: message, footer });
        if (!ts) return null; // dry-run
        const key = this.registerSlackChannel(dmChannelId, ts, channelName);
        const ch = this.metadata.channels[key] as SlackChannel;
        this.logOutgoingMessage(sender, message, Task.formatSlackDest(ch).display, ch, footer);
        return key;
      }
    }

    // New thread in a channel
    if (target?.new_thread) {
      const channelInfo = await getChannelInfo(target.new_thread);
      const ts = await postSlackMessage({ channel: target.new_thread, text: message, footer });
      if (!ts) return null; // dry-run
      const key = this.registerSlackChannel(target.new_thread, ts, channelInfo.name);
      const ch = this.metadata.channels[key] as SlackChannel;
      this.logOutgoingMessage(sender, message, Task.formatSlackDest(ch).display, ch, footer);
      return key;
    }

    // Specific existing channel
    if (target?.channel) {
      const ch = this.metadata.channels[target.channel];
      if (ch?.type === 'slack') {
        await postSlackMessage({ channel: ch.channel_id, threadTs: ch.thread_id, text: message, footer });
        this.logOutgoingMessage(sender, message, Task.formatSlackDest(ch).display, ch, footer);
      }
      return null;
    }

    // Default channel
    const defaultCh = this.metadata.default_channel
      ? this.metadata.channels[this.metadata.default_channel]
      : null;
    if (!defaultCh) {
      logger.warn('task', `postToUser called on task ${this.taskId} with no default channel — message dropped`);
      return null;
    }
    if (defaultCh.type === 'slack') {
      await postSlackMessage({ channel: defaultCh.channel_id, threadTs: defaultCh.thread_id, text: message, footer });
      this.logOutgoingMessage(sender, message, Task.formatSlackDest(defaultCh).display, defaultCh, footer);
    } else if (defaultCh.type === 'cli') {
      this.logOutgoingMessage(sender, message, 'cli', undefined, footer);
    }
    return null;
  }

  /**
   * Upload one or more files to the user via Slack's `files.uploadV2`.
   *
   * Posts to the default channel or to an already-linked channel via
   * `target.channel`. New thread / DM creation is intentionally not supported —
   * agents must call `postToUser` first to open and link a thread, then call
   * this to attach files.
   */
  async postFilesToUser(filePaths: readonly string[], agentName?: string, channelKey?: string): Promise<void> {
    if (filePaths.length === 0) return;
    const sender = agentName || 'system';
    const files = filePaths.map((p) => ({ path: p, filename: basename(p) }));

    const target = channelKey
      ? this.metadata.channels[channelKey]
      : (this.metadata.default_channel ? this.metadata.channels[this.metadata.default_channel] : null);

    if (!target) {
      logger.warn(
        'task',
        `postFilesToUser on task ${this.taskId}: ${channelKey ? `channel ${channelKey} not linked` : 'no default channel'} — files dropped`,
      );
      return;
    }
    if (target.type === 'slack') {
      await postSlackFiles({ channel: target.channel_id, threadTs: target.thread_id, files });
      this.logFilesUpload(sender, filePaths, Task.formatSlackDest(target).display, target);
    } else if (target.type === 'cli') {
      // CLI channel can't render Slack uploads — log the file list so it surfaces.
      this.logFilesUpload(sender, filePaths, 'cli');
    }
  }

  /**
   * Emit event and append outgoing message to knowledge log with destination info.
   */
  /**
   * Format a SlackChannel as a destination string for logs.
   * For knowledge log: includes IDs (e.g., "slack:#<C123:bot-test>:threadTs")
   * For CLI/server: human-readable (e.g., "#bot-test", "DM with Dana")
   */
  private static formatSlackDest(ch: SlackChannel): { log: string; display: string } {
    return {
      log: formatSlackChannelRef(ch.channel_id, ch.channel_name, ch.thread_id),
      display: formatSlackChannelDisplay(ch.channel_name),
    };
  }

  private logOutgoingMessage(sender: string, message: string, destination: string, slackChannel?: SlackChannel, footer?: string): void {
    const display = destination;
    const logDest = slackChannel ? Task.formatSlackDest(slackChannel).log : destination;
    logger.agentToSlack(sender, message, { destination: display });
    emitEvent('message', this.taskId, { from: sender, to: 'user', destination: display, message, ...(footer ? { footer } : {}) });
    appendMessageToUser(this.taskId, sender, message, logDest);
    // The app just posted into the thread — Slack auto-clears the loading
    // indicator, so sync our notion of what's shown (re-pushes if work continues).
    this.statusController.notePosted();
  }

  /**
   * Log a file-upload action to the user. Mirrors `logOutgoingMessage` but the
   * "message" body is the rendered `[Attachments: …]` suffix only, since
   * `postFilesToUser` posts files without accompanying text.
   */
  private logFilesUpload(sender: string, filePaths: readonly string[], destination: string, slackChannel?: SlackChannel): void {
    const display = destination;
    const logDest = slackChannel ? Task.formatSlackDest(slackChannel).log : destination;
    const rendered = renderAttachmentsSuffix(filePaths).trimStart();
    logger.agentToSlack(sender, rendered, { destination: display });
    emitEvent('message', this.taskId, { from: sender, to: 'user', destination: display, message: rendered });
    appendMessageToUser(this.taskId, sender, '', logDest, filePaths);
  }

  /**
   * Post an interactive message (with blocks) to the user.
   *
   * Routes to `channelKey` when provided, otherwise to the task's default
   * channel (both resolved via `resolveSlackChannel`). This lets callers target
   * a specific linked thread even when the task has no default channel. Falls
   * back to a CLI log line when no Slack channel resolves — interactive
   * approvals are also surfaced in the CLI via the `approval:requested` event
   * regardless of Slack delivery.
   */
  async postInteractiveToUser(text: string, blocks: unknown[], approvalType: 'edit_mode' | 'research_budget', channelKey?: string): Promise<void> {
    emitEvent('approval:requested', this.taskId, { text, approvalType });

    const ch = this.resolveSlackChannel(channelKey);
    if (ch) {
      await postInteractiveToThreads([{
        thread_id: ch.thread_id,
        channel_id: ch.channel_id,
        last_processed_ts: ch.last_processed_ts,
      }], text, blocks);
    } else {
      logger.slack(`POST (interactive): ${text}`);
    }
  }

  /**
   * Ack a message on a Slack channel, moving the acknowledgment to it.
   *
   * The visual indicator (an `:eyes:` reaction) is already added to `messageTs`
   * by the event handler for instant feedback; this records which message holds
   * it and clears the ack from the previously-acked message (so only one
   * indicator is live per thread). We track `ack_ts` separately from
   * `last_processed_ts` because the latter advances on every processed message
   * — including plain thread replies we never ack — which would otherwise
   * orphan the indicator.
   */
  ackMessage(channelKey: string, messageTs: string): void {
    const ch = this.metadata.channels[channelKey];
    if (ch?.type !== 'slack') return;
    if (ch.ack_ts && ch.ack_ts !== messageTs) {
      removeReaction(ch.channel_id, ch.ack_ts, 'eyes');
    }
    ch.ack_ts = messageTs;
    this.debouncedSave();
  }

  /**
   * Clear the ack indicator from whichever message currently holds it on each
   * Slack channel. Called on task stop/complete to clean up indicators.
   */
  private clearAcks(): void {
    for (const ch of Object.values(this.metadata.channels)) {
      if (ch.type === 'slack' && ch.ack_ts) {
        removeReaction(ch.channel_id, ch.ack_ts, 'eyes');
        ch.ack_ts = undefined;
      }
    }
  }

  /**
   * Resolve a Slack channel for reaction operations. Uses the given channel key
   * when provided, otherwise falls back to the task's default channel. Returns
   * null when the target is missing or not a Slack channel.
   */
  private resolveSlackChannel(channelKey?: string): SlackChannel | null {
    const ch = channelKey
      ? this.metadata.channels[channelKey]
      : (this.metadata.default_channel ? this.metadata.channels[this.metadata.default_channel] : null);
    return ch?.type === 'slack' ? ch : null;
  }

  /**
   * Build the grey footer appended to every user-facing message: the task id
   * plus the PM's resolved model label (preserving any `[1m]` marker). Reads the
   * PM agent's configured model, mirroring spawn's `def.model || 'opus'` default.
   */
  private buildUserFooter(): string {
    const labels = this.collectModelsUsed().map(modelDisplayLabel);
    return `${this.taskId} · ${labels.join(' + ')}`;
  }

  /**
   * The distinct models the task has actually used, PM first. Reads the PM from
   * the team roster (always present, so the footer is right even before the PM
   * process spawns) and every spawned agent's resolved model, deduped in order.
   * As specialists join, the footer grows (e.g. `Opus 4.8 + Sonnet 4.6 (1M)`).
   */
  private collectModelsUsed(): string[] {
    const raw: string[] = [];
    const pmDef = this.team.find((d) => isPmAgent(d));
    if (pmDef) raw.push(resolveAgentModel(pmDef));
    for (const a of this.agentProcesses.values()) raw.push(resolveAgentModel(a.def));
    if (raw.length === 0) raw.push('opus');
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of raw) {
      if (seen.has(m)) continue;
      seen.add(m);
      out.push(m);
    }
    return out;
  }

  // ---- PR cards ----------------------------------------------------------
  //
  // A PR card is a compact, updating block describing a pull request. It is
  // driven by a channel-agnostic `pr_card` event (rendered by the CLI / any SSE
  // client) and, for tasks with a Slack channel, a posted Slack message. Cards
  // are coalesced to PM turn-ends (resurfacePrCards, called from complete/stop)
  // and updated in place on async GitHub webhooks (refreshPrCardInPlace).

  /**
   * Collect every PR tracked by this task (deduped by repo#number), along with
   * the branch state that owns its card bookkeeping.
   */
  private collectPrCards(): Array<{ github: string; prNumber: number; state: BranchState }> {
    const seen = new Set<string>();
    const out: Array<{ github: string; prNumber: number; state: BranchState }> = [];
    for (const attachments of Object.values(this.metadata.repositories)) {
      if (!Array.isArray(attachments)) continue;
      for (const attached of attachments) {
        for (const state of Object.values(attached.branch_states ?? {})) {
          if (!state.pr_number) continue;
          const cardId = `${attached.github}#${state.pr_number}`;
          if (seen.has(cardId)) continue;
          seen.add(cardId);
          out.push({ github: attached.github, prNumber: state.pr_number, state });
        }
      }
    }
    return out;
  }

  /**
   * (Re)post PR cards for any PR that changed since its last card. Called when
   * the PM yields its turn to the user (complete/stop), so a card lands right
   * under the PM's final message. On change, the Slack card is deleted and
   * reposted at the bottom (resurface); the CLI re-anchors via the `pr_card`
   * event. Unchanged PRs are skipped. Best-effort — never throws.
   */
  async resurfacePrCards(): Promise<void> {
    const client = getGitHubClient();
    if (!client) return;
    await cardLock(this.taskId, async () => {
      const slack = this.resolveSlackChannel();
      let dirty = false;
      for (const { github, prNumber, state } of this.collectPrCards()) {
        try {
          const card = await client.getPRCardData(github, prNumber);
          const fingerprint = prCardFingerprint(card);
          if (state.pr_card && state.pr_card.fingerprint === fingerprint) continue; // unchanged
          // Do the Slack work first; only emit + persist once it lands, so a
          // failed repost doesn't diverge the CLI (which renders off the event).
          let slackRef = state.pr_card?.slack;
          if (slack) {
            if (slackRef?.ts) await deleteMessage(slackRef.channel_id, slackRef.ts);
            const ts = await postInteractiveToThread(slack.channel_id, slack.thread_id, prCardTitlePlain(card), buildPrCardBlocks(card));
            slackRef = ts ? { ts, channel_id: slack.channel_id, thread_id: slack.thread_id } : undefined;
          }
          emitEvent('pr_card', this.taskId, { action: 'post', cardId: `${github}#${prNumber}`, ...card });
          state.pr_card = { fingerprint, ...(slackRef ? { slack: slackRef } : {}) };
          dirty = true;
        } catch (error) {
          logger.warn('task', `Failed to (re)post PR card for ${github}#${prNumber}`, error);
        }
      }
      // Flush synchronously: the fingerprint/slack ref gates future updates, so a
      // debounced (lossy on restart) write would risk a redundant re-edit.
      if (dirty) await this.save(true);
    });
  }

  /**
   * Update an already-posted PR card in place (no resurface) — used by async
   * GitHub webhooks (CI conclusion, PR merged/closed). No-ops if the PR has no
   * card yet (the first card waits for the next PM turn-end). Best-effort.
   */
  async refreshPrCardInPlace(github: string, prNumber: number): Promise<void> {
    const client = getGitHubClient();
    if (!client) return;
    await cardLock(this.taskId, async () => {
      // Re-resolve under the lock — a concurrent resurface may have just created
      // or replaced this card.
      const target = this.collectPrCards().find((c) => c.github === github && c.prNumber === prNumber);
      if (!target || !target.state.pr_card) {
        logger.system(`PR card ${github}#${prNumber}: no card posted yet — skipping in-place update`);
        return;
      }
      try {
        const card = await client.getPRCardData(github, prNumber);
        const fingerprint = prCardFingerprint(card);
        if (target.state.pr_card.fingerprint === fingerprint) {
          logger.system(`PR card ${github}#${prNumber}: unchanged (${fingerprint}) — no update`);
          return;
        }
        const slackRef = target.state.pr_card.slack;
        logger.system(`PR card ${github}#${prNumber}: updating in place (${target.state.pr_card.fingerprint} → ${fingerprint}), slack=${slackRef?.ts ? 'yes' : 'no'}`);
        if (slackRef?.ts) {
          await updateMessage(slackRef.channel_id, slackRef.ts, prCardTitlePlain(card), buildPrCardBlocks(card));
        }
        emitEvent('pr_card', this.taskId, { action: 'update', cardId: `${github}#${prNumber}`, ...card });
        target.state.pr_card.fingerprint = fingerprint;
        await this.save(true); // flush synchronously — the fingerprint gates future updates
      } catch (error) {
        logger.warn('task', `Failed to update PR card for ${github}#${prNumber}`, error);
      }
    });
  }

  /** Update every PR card this task has already posted (used on CI webhooks). */
  async refreshAllPrCards(): Promise<void> {
    for (const { github, prNumber, state } of this.collectPrCards()) {
      if (state.pr_card) await this.refreshPrCardInPlace(github, prNumber);
    }
  }

  /**
   * Single sink for a rendered status line ('' clears it). Delivers it to every
   * surface so the indicator can be observed without Slack:
   *   - a `status` event on the bus → SSE → the CLI shows the same line live
   *   - the Slack assistant-thread indicator (best-effort)
   * Gated as a whole by ARCHIE_LIVE_STATUS so the feature has one off switch.
   */
  private onStatusRendered(status: string): void {
    if (!isStatusEnabled()) return;
    emitEvent('status', this.taskId, { status });
    this.pushSlackStatus(status);
  }

  /**
   * Push (or clear, with an empty string) the "Archie is …" loading indicator
   * on every linked Slack thread. Fire-and-forget and best-effort — each call
   * swallows its own errors. Muted channels are skipped so a thread the PM has
   * gone quiet in doesn't keep shimmering. No-op when there are no Slack
   * channels (e.g. CLI-only tasks), where the CLI shows the status instead.
   */
  private pushSlackStatus(status: string): void {
    for (const ch of Object.values(this.metadata.channels)) {
      if (ch.type !== 'slack' || ch.muted) continue;
      void setSlackThreadStatus(ch.channel_id, ch.thread_id, status);
    }
  }

  /**
   * Freeze the live status — called when a turn is winding down to stop/complete
   * (report_completion, edit-mode request, research-budget stop) so trailing
   * tool calls in the teardown window don't resurface the indicator a couple of
   * seconds after the final message.
   */
  suspendStatus(): void {
    this.statusController.suspend();
  }

  /**
   * Feed an agent's SDK event into the status indicator. Called once per event
   * from the spawn loop; it inspects tool_use blocks and, when one maps to a
   * surfaceable action, records the agent's current activity. No-op for events
   * without a status-worthy tool call.
   */
  noteActivityFromEvent(agentId: string, event: unknown): void {
    const agent = this.agentProcesses.get(agentId as AgentName);
    if (!agent) return;
    const def = agent.def;
    const isPm = isPmAgent(def);
    const domain = agentDomainLabel(def);
    const editMode = isRepoAgent(def) && this.metadata.edit_allowed === true;
    const phrase = deriveActivityFromEvent(event, {
      isPm,
      editMode,
      domain,
      mcpDescriptions: def.mcpDescriptions,
      mcpTools: agent.mcpTools,
      resolveAgentDomain: (id) => {
        const d = this.team.find((x) => x.id === id);
        return d ? agentDomainLabel(d) : undefined;
      },
    });
    if (phrase) this.statusController.note(agentId, isPm, domain, phrase);
  }

  /**
   * Add an emoji reaction to a message in a linked Slack thread.
   *
   * `messageTs` is the Slack message timestamp (the `msg:<ts>` id shown in the
   * knowledge log). Omit `channelKey` to target the task's default channel.
   * Returns true when the reaction was dispatched, false when no Slack channel
   * could be resolved.
   */
  async reactToMessage(messageTs: string, emoji: string, channelKey?: string): Promise<boolean> {
    const ch = this.resolveSlackChannel(channelKey);
    if (!ch) {
      logger.warn('task', `reactToMessage on task ${this.taskId}: ${channelKey ? `channel ${channelKey} not linked` : 'no default channel'} — reaction dropped`);
      return false;
    }
    await addReaction(ch.channel_id, messageTs, emoji);
    return true;
  }

  /**
   * Remove an emoji reaction Archie previously added to a message.
   * Mirrors `reactToMessage`. Returns true when dispatched.
   */
  async unreactFromMessage(messageTs: string, emoji: string, channelKey?: string): Promise<boolean> {
    const ch = this.resolveSlackChannel(channelKey);
    if (!ch) {
      logger.warn('task', `unreactFromMessage on task ${this.taskId}: ${channelKey ? `channel ${channelKey} not linked` : 'no default channel'} — reaction removal dropped`);
      return false;
    }
    await removeReaction(ch.channel_id, messageTs, emoji);
    return true;
  }

  /**
   * Read the live emoji reactions on a message in a linked Slack thread.
   * Returns null when no Slack channel could be resolved, otherwise the current
   * reactions (empty array when the message has none).
   */
  async readMessageReactions(messageTs: string, channelKey?: string): Promise<SlackReaction[] | null> {
    const ch = this.resolveSlackChannel(channelKey);
    if (!ch) {
      logger.warn('task', `readMessageReactions on task ${this.taskId}: ${channelKey ? `channel ${channelKey} not linked` : 'no default channel'}`);
      return null;
    }
    return getMessageReactions(ch.channel_id, messageTs);
  }

  /**
   * Find an existing channel entry by Slack channel ID.
   * Used for DM reuse — conversations.open returns the same channel ID for a given user.
   */
  private findChannelBySlackId(slackChannelId: string): { key: string; channel: SlackChannel } | null {
    for (const [key, ch] of Object.entries(this.metadata.channels)) {
      if (ch.type === 'slack' && ch.channel_id === slackChannelId) return { key, channel: ch };
    }
    return null;
  }

  /**
   * Register a new Slack channel/thread in the task metadata.
   *
   * Promotes the channel to `default_channel` when the task has none yet. This
   * matters for self-launched tasks, which start with zero channels (and a null
   * default): the first channel the PM opens via `post_to_user(new_thread/new_dm)`
   * becomes the default so subsequent default-routed messages — including
   * interactive approval prompts like edit-mode requests — reach Slack instead of
   * being dropped to the CLI log.
   */
  private registerSlackChannel(channelId: string, threadTs: string, channelName: string): string {
    const key = `slack:${channelId}:${threadTs}`;
    this.metadata.channels[key] = {
      type: 'slack',
      thread_id: threadTs,
      channel_id: channelId,
      channel_name: channelName,
      last_processed_ts: threadTs,
      url: buildThreadUrl(channelId, threadTs) ?? undefined,
    };
    this.metadata.default_channel ??= key;
    this.debouncedSave();
    return key;
  }

  /**
   * Stop the task and clean up all agents.
   */
  async stop(): Promise<void> {
    if (!this.isActive) {
      logger.system(`Task ${this.taskId} already stopped`);
      return;
    }

    // PM has yielded the turn — (re)post any changed PR cards so they land under
    // the final message. Best-effort; must never block teardown.
    await this.resurfacePrCards().catch((e) => logger.warn('task', 'PR card resurface failed on stop', e));

    this.isActive = false;
    activeTasks.delete(this.taskId);
    this.clearTaskTimeout();

    // Stop all queues. A parked or just-finished agent (session inactive) exits
    // gracefully on its next queue pull — the resume-safe path the deferred
    // teardown relies on (see spawn.ts: never .return() the generator), so do
    // NOT abort it. But an agent still mid-turn keeps generating and hits
    // "Stream closed" on every tool/hook control request, looping until maxTurns
    // — stopping its queue can't end it, so hard-abort those. agent:inactive is
    // emitted by the Stop hook / crash handler (or the aborted loop exiting).
    for (const a of this.agentProcesses.values()) {
      const midTurn = a.session.active;
      a.queue.stop();
      if (midTurn) a.handle?.abort();
    }

    // Clean up clones to free disk space (only when not in edit mode)
    if (this.metadata.edit_allowed !== true) {
      await this.cleanupClones();
    }

    this.clearAcks();
    this.statusController.clear();

    this.metadata.status = 'stopped';
    await this.save(true);

    logger.system(`Task ${this.taskId} stopped`);
    emitEvent('task:stopped', this.taskId);
  }

  /**
   * Complete the task.
   */
  async complete(): Promise<void> {
    if (!this.isActive) {
      logger.system(`Task ${this.taskId} already completed/stopped`);
      return;
    }

    // PM has yielded the turn — (re)post any changed PR cards so they land under
    // the final message. Best-effort; must never block teardown.
    await this.resurfacePrCards().catch((e) => logger.warn('task', 'PR card resurface failed on complete', e));

    this.isActive = false;
    activeTasks.delete(this.taskId);
    this.clearTaskTimeout();

    // Stop all queues. A parked or just-finished agent (session inactive) exits
    // gracefully on its next queue pull — the resume-safe path the deferred
    // teardown relies on (see spawn.ts: never .return() the generator), so do
    // NOT abort it. But an agent still mid-turn keeps generating and hits
    // "Stream closed" on every tool/hook control request, looping until maxTurns
    // — stopping its queue can't end it, so hard-abort those. agent:inactive is
    // emitted by the Stop hook / crash handler (or the aborted loop exiting).
    for (const a of this.agentProcesses.values()) {
      const midTurn = a.session.active;
      a.queue.stop();
      if (midTurn) a.handle?.abort();
    }

    // Clean up clones to free disk space (only when not in edit mode).
    // RW clones (edit_allowed) are kept — they have branches, commits, PRs.
    if (this.metadata.edit_allowed !== true) {
      await this.cleanupClones();
    }

    this.clearAcks();
    this.statusController.clear();

    this.metadata.status = 'completed';
    await this.save(true);

    logger.system(`Task ${this.taskId} completed`);
    emitEvent('task:completed', this.taskId);
  }

  /**
   * Remove shared clones and clear clone_path so next spawn creates a fresh one.
   * Iterates every attached repo across every agent in the task.
   */
  private async cleanupClones(): Promise<void> {
    const { removeClone } = await import('../connectors/github/repo-clone.js');
    for (const [agentId, attachments] of Object.entries(this.metadata.repositories)) {
      if (!Array.isArray(attachments)) continue;
      for (const attached of attachments) {
        if (!attached.clone_path) continue;
        try {
          await removeClone(attached.clone_path);
          attached.clone_path = undefined as unknown as string;
          logger.system(`Task ${this.taskId}: cleaned up clone for ${agentId}/${attached.github}`);
        } catch (error) {
          logger.warn('task', `Failed to cleanup clone for ${agentId}/${attached.github}: ${error}`);
        }
      }
    }
  }

  /**
   * Get status of all spawned agents.
   */
  getAgentStatus(): { agent: string; active: boolean; last_activity?: string }[] {
    const statuses: { agent: string; active: boolean; last_activity?: string }[] = [];
    for (const [agentName, agent] of this.agentProcesses) {
      statuses.push({
        agent: agentName,
        active: agent.session.active,
        last_activity: agent.session.last_activity,
      });
    }
    return statuses;
  }

  /**
   * Record that PM has finished and is waiting on no one but the user (called by
   * report_completion). The idle-check parks the task — instead of recovering —
   * once all agents are idle (quiescent). Completion is thus decided at
   * quiescence, not by a synchronous peer-active gate that races the Stop hook.
   */
  setCompletionIntent(): void {
    this.completionIntent = true;
  }

  /**
   * Touch — update last activity timestamp.
   */
  touch(): void {
    this.lastActivity = new Date();
  }

  /**
   * Save task state to disk (debounced unless flush=true).
   * Syncs agent sessions to metadata before write.
   */
  async save(flush?: boolean): Promise<void> {
    // Sync agent sessions into metadata
    for (const [agentName, agent] of this.agentProcesses) {
      this.metadata.agent_sessions[agentName] = { ...agent.session };
    }
    this.metadata.updated_at = new Date().toISOString();

    // Use legacy save for now (debounced write)
    // saveLegacyTask expects TaskRuntimeState, but we need to bridge
    // For now, write directly
    if (flush) {
      await writeFile(
        getMetadataPath(this.taskId),
        JSON.stringify(this.metadata, null, 2),
      );
    } else {
      // Debounced — use the legacy saveTask by creating a compat shim
      this.debouncedSave();
    }
  }

  /**
   * Handle send_message_to_agent tool call.
   * Routes message from one agent to another within this task.
   * Stays on Task because it involves lazy spawn + budget tracking + queue routing.
   */
  async toolSendMessage(fromAgent: AgentName, target: AgentName, message: string): Promise<string> {
    // Defensive visibility gate — Zod on the tool already filters the targets,
    // but if the agent constructs a call outside that allowlist (jailbreak /
    // fuzz), reject the message and surface the visible set so it can recover.
    // Scope to the task team (registry + PM-spawned dynamic agents), so a
    // dynamic agent created mid-session is reachable from same-session peers.
    const senderDef = this.team.find((d) => d.id === fromAgent);
    if (senderDef && target !== 'pm-agent') {
      const visible = new Set(getVisiblePeerIdsForSender(senderDef, this.team));
      if (!visible.has(target)) {
        const list = Array.from(visible).sort().join(', ') || '(none)';
        return `Error: ${target} is not addressable from ${fromAgent} (visibility rules). Visible peers: ${list}, pm-agent`;
      }
    }

    logger.agentMessage(fromAgent, target, message, { truncate: 100 });
    this.lastActivity = new Date();

    // Inter-agent message budget tracking
    this.budgets.interAgentMessageCount++;
    if (this.budgets.interAgentMessageCount > this.budgets.interAgentMessageLimit) {
      logger.warn('budget', `Inter-agent message limit exceeded for task ${this.taskId}`);
      this.postToUser(
        `⚠️ Inter-agent message limit exceeded (${this.budgets.interAgentMessageCount}/${this.budgets.interAgentMessageLimit}).`,
      ).catch((err: unknown) => logger.error('budget', 'Failed to post message limit warning', err));
    }

    await appendAgentMessage(this.taskId, fromAgent, target, message);

    if (!this.isActive) {
      logger.warn('task', `Task ${this.taskId} is inactive but ${fromAgent} is sending message`);
      return 'Task is inactive, message logged to knowledge.log.';
    }

    await this.ensureAgentSpawned(target);
    const targetAgent = this.agentProcesses.get(target);
    if (!targetAgent) {
      throw new Error(`No agent ${target} after spawn`);
    }
    targetAgent.queue.addMessage(message, fromAgent);
    // Mark active synchronously at enqueue (see sendMessage). A peer reporting to
    // PM marks PM active here — so a parked-intent PM is never read as idle while
    // its relay is in flight, and its intent-clear edge fires immediately.
    this.updateAgentState(target, true);

    return `Message sent to ${target}. They will process it and log findings.`;
  }

  // Research budget methods (used by tools and research-tools)

  checkResearchBudget(): { allowed: boolean; used: number; limit: number } {
    return {
      allowed: this.budgets.researchRequestCount < this.budgets.researchRequestLimit,
      used: this.budgets.researchRequestCount,
      limit: this.budgets.researchRequestLimit,
    };
  }

  incrementResearchCount(): void {
    this.budgets.researchRequestCount++;
    logger.debug(
      'budget',
      `Research request ${this.budgets.researchRequestCount}/${this.budgets.researchRequestLimit} for task ${this.taskId}`,
    );
    this.metadata.research_request_count = this.budgets.researchRequestCount;
    this.debouncedSave();
  }

  async onResearchBudgetExceeded(agent: Agent): Promise<void> {
    // Already pausing this turn — the spawn loop stops the task at turn-end.
    // Skip a duplicate approval post if web_research goes over budget again.
    if (agent.pendingTeardown) return;

    logger.warn(
      'budget',
      `Research budget exceeded for task ${this.taskId} (${this.budgets.researchRequestCount}/${this.budgets.researchRequestLimit})`,
    );

    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Research budget reached* (${this.budgets.researchRequestCount}/${this.budgets.researchRequestLimit} requests). Approve additional research?`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Approve (+5)' },
            action_id: 'approve_research_budget',
            value: this.taskId,
            style: 'primary',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Deny' },
            action_id: 'deny_research_budget',
            value: this.taskId,
            style: 'danger',
          },
        ],
      },
    ];
    await this.postInteractiveToUser(
      `Research budget reached (${this.budgets.researchRequestCount}/${this.budgets.researchRequestLimit} requests)`,
      blocks,
      'research_budget',
    ).catch((err: unknown) => logger.error('budget', 'Failed to post budget approval request', err));

    // Defer the stop to the calling agent's turn-end (see report_completion):
    // web_research is mid-turn here, so stopping the queue now would close the
    // input stream under an in-flight hook ("stream closed" error).
    this.statusController.suspend(); // don't let the wind-down resurface the status
    agent.deferTeardown(() => this.stop());
  }

  // ---- Approval handlers ----

  async handleEditModeApproval(approver?: { id: string; name: string; email?: string }): Promise<void> {
    // Cancel any park armed by request_edit_mode on the PM this turn. The tool
    // defers task.stop() to the PM's turn-end so it doesn't close the input
    // stream under an in-flight hook. If the user approves *before* that turn
    // ends, the stop is still armed and fires right after approval — stopping
    // the task we just approved and tearing the stream out from under the PM's
    // delegation (the "stream closed" loop). Approval means "continue", so drop
    // the park: the PM stays read-only; the repo agent it delegates to is what
    // spawns read-write off edit_allowed.
    this.agentProcesses.get('pm-agent')?.clearPendingTeardown();
    this.metadata.edit_allowed = true;
    // Remember who approved so repo agents author their commits as this person
    // (committer stays the bot — see spawnAgent's GIT_AUTHOR_* env). First
    // resolved approver wins: only set when we don't already have one, so a
    // later re-approval (e.g. a repeat POST to the approve route) can't reassign
    // authorship mid-task or clobber it with an unresolved user.
    if (approver && !this.metadata.edit_approved_by) {
      this.metadata.edit_approved_by = approver;
    }
    // Flush synchronously (not debouncedSave): a repo agent reads edit_allowed at
    // spawn time, so the writable-mount flag must be on disk before any (re)spawn
    // — including one after a park/reload — rather than 500ms later.
    await this.save(true);

    // Restart any live repo agent so it re-mounts its clone writable. Edit mode
    // only flips the sandbox at spawn time (editAllowed puts the clone in
    // allowWritePaths); an agent that is already running keeps its read-only mount
    // and never re-reads the flag, so writes keep hitting a read-only filesystem
    // after approval (observed on task-20260625-1122-30wkzk: EROFS persisted for
    // ~20 min post-approval). Tear it down so PM's delegation re-spawns it fresh —
    // it resumes the same session (session_id persists in metadata), just with a
    // writable checkout. PM is not a repo agent, so it is left running.
    for (const [name, agent] of [...this.agentProcesses]) {
      if (isRepoAgent(agent.def) && agent.isRunning) {
        agent.handle?.abort();
        agent.queue.stop();
        this.agentProcesses.delete(name);
        logger.system(`Edit mode approved — restarting ${name} for a writable mount`);
      }
    }

    const approvedBy = this.metadata.edit_approved_by?.name || 'user';
    await appendAgentFinding(this.taskId, 'system', `Edit mode approved by ${approvedBy}`, 'decision');
    await this.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
  }

  async handleEditModeDenial(): Promise<void> {
    await appendAgentFinding(this.taskId, 'system', 'Edit mode denied by user', 'decision');
    await this.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
  }

  async handleResearchBudgetApproval(): Promise<void> {
    this.metadata.research_budget_extra = (this.metadata.research_budget_extra ?? 0) + 5;
    this.budgets.researchRequestLimit = 5 + (this.metadata.research_budget_extra ?? 0);
    this.debouncedSave();
    await appendAgentFinding(
      this.taskId,
      'system',
      `Research budget extended by user (+5 requests, total extra: ${this.metadata.research_budget_extra})`,
      'decision',
    );
    await this.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
  }

  async handleResearchBudgetDenial(): Promise<void> {
    await appendAgentFinding(this.taskId, 'system', 'Additional research denied by user', 'decision');
    await this.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
  }

  // ---- Internal methods ----

  /**
   * Update an agent's active state and persist.
   */
  updateAgentState(agentName: AgentName | string, active: boolean, sessionId?: string): void {
    if (!active && getIsShuttingDown()) return;

    const name = agentName as AgentName;
    const agent = this.agentProcesses.get(name);

    // Note: an agent parked on a background task is allowed to go idle here — it
    // isn't actively working, so we don't fake it as active. Recovery is still
    // held off while a task is pending via idleDecision's backgroundTasks check;
    // the ⏳ background-task entry is the in-progress indication.

    // Idempotency: skip if agent is already in the requested state (no sessionId update needed)
    if (agent && agent.session.active === active && !sessionId) return;

    // Clear a pending completion intent when PM genuinely re-engages: its prior
    // "waiting on no one" is stale, so the next quiescence should re-decide.
    // agent.session.active is still the pre-update value here (updateSession runs
    // below), so this is edge-exact — see shouldClearCompletionIntent.
    if (agent && shouldClearCompletionIntent(name, active, agent.session.active)) {
      this.completionIntent = false;
    }

    if (agent) {
      agent.updateSession(active, sessionId);
      if (active) {
        this.statusController.setActive(name, isPmAgent(agent.def), agentDomainLabel(agent.def));
      } else {
        this.statusController.setIdle(name);
      }
    }

    emitEvent(active ? 'agent:active' : 'agent:inactive', this.taskId, {}, name);
    this.debouncedSave();

    if (!active) {
      // Schedule idle check via legacy function
      // Pass a compat shim
      scheduleIdleCheck(this);
    }
  }

  /**
   * Ensure an agent is created and spawned.
   */
  private async ensureAgentSpawned(agentName: AgentName): Promise<void> {
    let agent = this.agentProcesses.get(agentName);

    if (!agent) {
      const def = this.team.find((d) => d.id === agentName);
      if (!def) {
        throw new Error(`Unknown agent: ${agentName}`);
      }
      agent = new Agent(def);
      this.agentProcesses.set(agentName, agent);
    }

    await agent.spawn(this);
  }

  /**
   * Activate the task — start timeout, mark in_progress.
   * Called lazily on first sendMessage().
   */
  private activate(): void {
    this.isActive = true;
    // A fresh activation (new task or reopen of a parked one) starts a new cycle —
    // any completion intent from a prior cycle is stale. Clearing here covers
    // reopens routed to a specialist (which don't pass through PM's active edge);
    // the updateAgentState edge-clear covers mid-cycle PM re-engagement.
    this.completionIntent = false;
    this.metadata.status = 'in_progress';
    activeTasks.set(this.taskId, this);
    this.startTaskTimeout();
    emitEvent('task:resumed', this.taskId);
    this.debouncedSave();
  }

  private startTaskTimeout(): void {
    this.taskTimeoutTimer = setInterval(async () => {
      const elapsed = Date.now() - this.budgets.taskStartTime.getTime();
      if (elapsed < this.budgets.taskTimeoutMs) return;

      const mins = Math.round(elapsed / 60_000);
      // The wall-clock cap is a backstop, not a failure verdict. A task that's
      // simply waiting on a human reply (all agents idle) must not announce a
      // scary "timed out" — it was working as intended. Reframe as a pause and
      // `complete()` (park) so it reopens cleanly on the next reply, rather
      // than `stop()`. Only when an agent is still mid-turn is this a genuinely
      // long-running task being capped.
      const anyAgentActive = [...this.agentProcesses.values()].some((a) => a.session.active);
      logger.warn(
        'budget',
        `Task ${this.taskId} hit wall-clock cap (${mins}min, agents ${anyAgentActive ? 'active' : 'idle'}) — pausing`,
      );
      const msg = anyAgentActive
        ? `⏸️ This task has been running for ${mins} minutes, so I'm pausing it here. Reply in this thread and I'll pick it back up.`
        : `⏸️ Pausing this task — I'd been waiting on a reply for a while. Just respond in this thread whenever you're ready and I'll continue.`;
      await this.postToUser(msg).catch((err: unknown) =>
        logger.error('budget', 'Failed to post pause message', err),
      );
      await this.complete();
    }, 60_000);
  }

  private clearTaskTimeout(): void {
    if (this.taskTimeoutTimer) {
      clearInterval(this.taskTimeoutTimer);
      this.taskTimeoutTimer = undefined;
    }
  }

  // Debounced save timer
  private saveTimer?: ReturnType<typeof setTimeout>;

  debouncedSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = undefined;
      try {
        // Sync sessions
        for (const [agentName, agent] of this.agentProcesses) {
          this.metadata.agent_sessions[agentName] = { ...agent.session };
        }
        this.metadata.updated_at = new Date().toISOString();
        await writeFile(
          getMetadataPath(this.taskId),
          JSON.stringify(this.metadata, null, 2),
        );
      } catch (err) {
        logger.error('task', `Failed to save task ${this.taskId}`, err);
      }
    }, 500);
  }

}

// ---- Module-level accessor functions (backward compat) ----

export function isTaskActive(taskId: string): boolean {
  return activeTasks.has(taskId);
}

export function getActiveTaskIds(): string[] {
  return Array.from(activeTasks.keys());
}

export function getTask(taskId: string): Task | undefined {
  return activeTasks.get(taskId);
}

// ---- v30 migration ----

/**
 * Migrate `metadata.repositories` from the legacy `Record<repoKey, RepositoryInfo>`
 * shape to the new `Record<agentId, AttachedRepo[]>` shape.
 *
 * Detection: legacy values are objects with a `clone_path` / `current_branch`
 * field; the new shape is always an array. We discriminate per-value and rewrite
 * in-place. Persistence happens on the next `debouncedSave()`.
 *
 * For each legacy entry, we map `repoKey -> agentId` as `${repoKey}-agent` and
 * use the registered agent's primary github to construct the new `AttachedRepo`.
 * If the agent is no longer registered (plugin removed), the entry is dropped
 * with a warning.
 *
 * Exported for testing — exercised in the normal flow only via `Task.get`.
 */
export function migrateRepositoriesShape(metadata: TaskMetadata): boolean {
  const repos = metadata.repositories;
  if (!repos || typeof repos !== 'object') return false;

  // Fast path: nothing to migrate if every entry is already an array.
  let needsMigration = false;
  for (const value of Object.values(repos)) {
    if (!Array.isArray(value)) {
      needsMigration = true;
      break;
    }
  }
  if (!needsMigration) return false;

  const migrated: Record<string, AttachedRepo[]> = {};
  for (const [key, value] of Object.entries(repos)) {
    if (Array.isArray(value)) {
      migrated[key] = value;
      continue;
    }
    // Legacy entry: object keyed by short repoKey (e.g. 'backend')
    const agentId = `${key}-agent`;
    const def = getAgentDef(agentId);
    const primary = def?.repo?.primary;
    if (!primary) {
      logger.warn('task', `[migrate] Dropping legacy metadata.repositories[${key}] — no agent ${agentId} found in registry`);
      continue;
    }
    const legacy = value as {
      path?: string;
      clone_path?: string;
      current_branch?: string;
      branch_states?: Record<string, any>;
      feature_branch?: string;
      base_branch?: string;
      pr_number?: number;
      last_processed_comment_id?: number;
    };
    const currentBranch = legacy.current_branch ?? legacy.feature_branch;
    const attached: AttachedRepo = {
      github: primary,
      // Absent clone_path means "no clone yet" — keep it undefined (uniform with
      // the live shape) rather than an empty-string sentinel. Spawn re-clones.
      clone_path: legacy.clone_path || undefined,
      // Preserve the legacy base-cache path the clone borrows from. The pre-v30
      // base cache lived at $ARCHIE_WORKDIR/repos/<short-key>/, which differs
      // from the new github-nested layout — without this, an in-flight clone
      // whose alternates point at the old base path would lose read access
      // through the sandbox when the spawner re-derives baseObjectsPath from
      // the new layout convention. Spawn falls back to getBaseCachePath(github)
      // only when base_path is absent (e.g. a fresh clone or a legacy entry
      // with no `path` field).
      base_path: legacy.path || undefined,
      current_branch: currentBranch,
      branch_states: legacy.branch_states,
    };
    // Lift legacy top-level PR/branch state into the branch_states map when the
    // branch the task is on has no entry yet. Key off current_branch (the
    // post-v17 norm) and fall back to feature_branch (older shape) — earlier
    // code only handled feature_branch, losing PR state for tasks sitting on
    // current_branch with no branch_states map.
    if (currentBranch && !attached.branch_states?.[currentBranch]) {
      attached.branch_states ??= {};
      attached.branch_states[currentBranch] = {
        base_branch: legacy.base_branch,
        pr_number: legacy.pr_number,
        last_processed_comment_id: legacy.last_processed_comment_id,
      };
    }
    // Guard against a legacy repoKey and its v30 agentId key coexisting
    // mid-rollout: don't append a second AttachedRepo for a github the
    // already-migrated array entry covers.
    const list = (migrated[agentId] ??= []);
    if (!list.some((a) => a.github === attached.github)) {
      list.push(attached);
    } else {
      logger.warn('task', `[migrate] task ${metadata.task_id}: skipping legacy ${key} — ${agentId} already has ${attached.github}`);
    }
  }

  metadata.repositories = migrated;
  return true;
}
