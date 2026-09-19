/**
 * Task Class
 *
 * The central unit of work. Owns agents, metadata, budgets, lifecycle.
 * Created via Task.create(thread) or Task.get(taskId).
 */

import { mkdir, writeFile } from 'fs/promises';
import type { SlackAuthor, SlackChannel, SlackThread, TaskMetadata, BranchState, FindingType } from '../types/task.js';
import { CLI_CHANNEL_KEY } from '../types/task.js';
import type { AgentDef } from '../types/agent.js';
import type { TriggerBinding } from '../types/trigger.js';
import { modelDisplayLabel, resolveAgentModel } from '../agents/model-label.js';
import { prCardFingerprint, prCardTitlePlain } from '../system/pr-card-format.js';
import { APPROVAL_TTL_MS, PENDING_APPROVAL_TTL_MS } from '../agents/tool-approval-gate.js';
import { getGitHubClient } from '../connectors/github/client.js';
import { createKeyedLock } from '../system/keyed-lock.js';

/**
 * Target for postToUser — controls where the message is delivered.
 */
export interface PostTarget {
  /** Post to an existing linked thread (channel key, e.g., "slack:C123:456.789") */
  channel?: string;
}

/**
 * Resource budgets for a task (Defense 4 — per-task limits)
 */
export interface TaskBudgets {
  researchRequestCount: number;     // web_research calls made
  researchRequestLimit: number;     // default: 5
  taskStartTime: Date;              // for wall-clock timeout
  taskTimeoutMs: number;            // default: 3_600_000 (60 minutes)
}

const DEFAULT_TASK_TIMEOUT_MS = 3_600_000; // 60 minutes

/**
 * Wall-clock cap before a task parks itself, overridable with
 * `ARCHIE_TASK_TIMEOUT_MS`. Anything that is not a positive integer (blank,
 * `0`, `-1`, `abc`) falls back to the default rather than disabling the cap —
 * the backstop should not be removable by a typo. Read per task, so a restart
 * is enough to change it.
 */
export function getTaskTimeoutMs(): number {
  const raw = process.env.ARCHIE_TASK_TIMEOUT_MS;
  if (!raw) return DEFAULT_TASK_TIMEOUT_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TASK_TIMEOUT_MS;
}
import { Agent } from '../agents/agent.js';

import {
  loadMetadata,
  appendAgentFinding,
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
  getTaskClonePath,
  persistTaskMetadata,
  reconcilePersistedMemoryMetadata,
} from './persistence.js';
import { getIsShuttingDown } from '../system/shutdown.js';
import { scheduleIdleCheck } from './recovery.js';
import { scanPmDef } from '../agents/registry.js';
import type { AttachedRepo } from '../types/task.js';
import { syncPlugins } from '../system/plugin-sync.js';
import { postSlackMessage, postSlackFiles, postInteractiveToThread, postInteractiveToThreads, updateMessage, deleteMessage, buildPrCardBlocks, addReaction, removeReaction, getMessageReactions, buildThreadUrl, formatSlackChannelRef, formatSlackChannelDisplay, classifySlackMemoryScope, getBotUserId, getChannelInfo, isInternalMemoryUser } from '../connectors/slack/client.js';
import type { SlackReactionsResult } from '../connectors/slack/client.js';
import { renderMessageBody, shouldRedact } from '../connectors/slack/message-body.js';
import { basename } from 'path';
import { AGENT_PROMPTS, buildMigrationNotice } from '../agents/prompts.js';
import { logger } from '../system/logger.js';
import { emitEvent } from '../system/event-bus.js';
import { TaskStatusController, isStatusEnabled } from './status.js';
import { setSlackThreadStatus } from '../connectors/slack/status.js';
import { deriveActivityFromEvent } from '../agents/activity.js';
import { deriveMemoryDestination, isAuthorizedMemoryScope, scopeForSlackChannel } from './memory-scope.js';
import { isMemoryReady } from '../memory/paths.js';

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

/**
 * Per-task serialization for opening a task's own thread in its home channel.
 *
 * A task has exactly one thread, and an agent can emit two `post_to_user` calls in a single turn. Unserialized, both see no default channel, both root a top-level message, and the channel ends up showing two competing roots for one task with only one of them linked. Keyed by taskId at module scope so it also holds across separate `Task` instances built from disk for the same task.
 *
 * The lock is all the coordination needed because the open body re-checks for an existing thread first: whoever runs second finds the thread the first one linked and posts into it. An attempt that fails links nothing, so the next caller may legitimately try again — which is what makes a failed first post non-wedging rather than terminal.
 */
const homeThreadLock = createKeyedLock();

// ---- Task class ----

/**
 * Whether an `updateAgentState` transition should clear a pending completion
 * intent: PM genuinely re-engaging on a real inactive→active edge. Gating on the
 * pre-update `wasActive` keeps it edge-exact — the SDK `init` re-fire arrives with
 * the agent already active (the synchronous enqueue mark won the race), so it must
 * not re-clear intent on every resumed turn. Pure, for unit testing.
 */
export function shouldClearCompletionIntent(
  active: boolean,
  wasActive: boolean,
): boolean {
  return active && !wasActive;
}

export class Task {
  readonly taskId: string;
  metadata: TaskMetadata;
  /**
   * The task's one agent — the PM. Created lazily on the first message
   * (`ensurePm`) and torn down by stop()/complete().
   */
  agent?: Agent;
  /**
   * The concrete model the PM's alias resolved to, as reported by the SDK at
   * session `init` (e.g. `opus → claude-opus-5`; a max-mode swap starts a fresh
   * session, so this updates to the new model). The footer labels it so it
   * shows the real version without the app knowing the alias→model mapping —
   * that lives in the SDK. Undefined until the first init; until then the
   * footer falls back to the configured alias (family-only label).
   */
  private resolvedModel?: string;
  /** The PM definition this task runs on — scanned fresh at task start/reload. */
  pmDef: AgentDef;
  budgets: TaskBudgets;
  isActive: boolean = false;
  lastActivity: Date = new Date();
  recoveryAttempts: number = 0;
  /**
   * How many times the nuclear recovery path (stop → resume from disk) has run
   * during this activation. Capped by `MAX_NUCLEAR_RECOVERY_CYCLES`
   * (tasks/recovery.ts): a PM that keeps going idle without reporting
   * completion would otherwise loop stop→resume until the wall-clock cap.
   * Reset by `activate()` — a new inbound message is genuine progress — and
   * re-applied by the nuclear path across its own reload, so consecutive
   * nuclears keep adding up.
   */
  nuclearRecoveryCycles: number = 0;
  /**
   * Set by report_completion: PM has responded and is waiting on no one but the
   * user. The idle-check parks the task (instead of recovering) once the agent
   * is idle. Cleared when PM next goes active (see updateAgentState). In-memory
   * only — lost on restart, where recovery re-arms the lifecycle instead.
   */
  completionIntent: boolean = false;
  taskTimeoutTimer?: ReturnType<typeof setInterval>;
  /**
   * What `Task.get` migrated in memory on this load (runtime stamp, flattened
   * repositories), as one log-ready clause — and, by being set at all, the flag
   * that the upgrade still has to reach disk. Written once by `activate()`, so a
   * task that is only ever read is left exactly as the previous engine wrote it.
   * Undefined for a task that needed no migration.
   */
  private pendingMigrationNote?: string;
  /** Drives the "Archie is …" Slack loading indicator from agent activity. */
  private readonly statusController: TaskStatusController;

  private constructor(taskId: string, metadata: TaskMetadata, pmDef: AgentDef) {
    this.taskId = taskId;
    this.pmDef = pmDef;
    this.statusController = new TaskStatusController((status) => this.onStatusRendered(status));
    this.budgets = {
      researchRequestCount: metadata.research_request_count ?? 0,
      researchRequestLimit: 5 + (metadata.research_budget_extra ?? 0),
      taskStartTime: new Date(),
      taskTimeoutMs: getTaskTimeoutMs(),
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
    metadata.memory_destination ??= deriveMemoryDestination(
      metadata.channels,
      metadata.default_channel,
      metadata.home_channel?.channel_id,
    );
    metadata.memory_authors ??= {};
    metadata.memory_message_authors ??= {};

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

    // Scan a fresh PM definition for this task
    const pmDef = scanPmDef();

    // metadata.repositories is populated lazily as the PM mounts repos.
    const metadata: TaskMetadata = {
      task_id: taskId,
      channels: {},
      default_channel: null,
      agent_sessions: {},
      repositories: [],
      status: 'in_progress',
      runtime_version: RUNTIME_VERSION,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await persistTaskMetadata(taskId, metadata);
    await writeFile(getKnowledgeLogPath(taskId), '');

    logger.system(`Created task ${taskId}`);
    emitEvent('task:created', taskId);

    const task = new Task(taskId, metadata, pmDef);
    return task;
  }

  /**
   * Load a task by ID. Returns cached instance if already active.
   * Task is inert until sendMessage() is called, which activates it.
   *
   * An in-flight task (still in activeTasks) is returned as-is — we never
   * disturb a live task's definition or agent. Only when a task is reloaded
   * from disk (i.e. it was stopped/completed and is being pinged again, or the
   * process restarted) do we sync plugins and re-scan the PM definition, so the
   * resumed task picks up any plugin changes.
   */
  static async get(taskId: string): Promise<Task> {
    const existing = activeTasks.get(taskId);
    if (existing) return existing;

    await syncPlugins();

    const metadata = await loadMetadata(taskId);
    if (!metadata) {
      throw new Error(`Task ${taskId} not found`);
    }

    // `metadata.repositories` has had three shapes: pre-v30
    // Record<repoKey, RepositoryInfo>, then Record<agentId, AttachedRepo[]>,
    // now a flat AttachedRepo[]. Both legacy shapes migrate in place.
    const didMigrate = migrateRepositoriesShape(metadata);

    // Stamp the engine generation. A folder with no stamp was written by the
    // pre-flattening multi-agent engine, so the PM's resumed session still
    // believes in specialists and the tools that messaged them — it gets the
    // migration notice on its next wake (see `deliver`).
    const didStamp = stampRuntimeVersion(metadata);

    // Both changes stay IN MEMORY here. Every reader goes through this path —
    // GitHub webhook resolution, the API's task listing, comment dedup — and a
    // read has no business rewriting a task folder: it would upgrade tasks that
    // never run on this engine at all, making a rollback to the previous release
    // destructive for them. The write is deferred to `activate()`, the moment the
    // task genuinely runs here; readers see the identical in-memory shape either
    // way, and an unactivated task simply re-migrates on its next load (cheap,
    // and the derivation is deterministic).
    const task = new Task(taskId, metadata, scanPmDef());
    if (didMigrate || didStamp) {
      task.pendingMigrationNote = [
        ...(didMigrate ? [`flattened repositories (${metadata.repositories.map((r) => r.github).join(', ') || 'none'})`] : []),
        ...(didStamp ? [`stamped runtime_version ${RUNTIME_VERSION} — migration notice queued for its next wake`] : []),
      ].join('; ');
    }
    return task;
  }

  // ---- Public methods ----

  /**
   * Send a message to the task's agent (the PM).
   * Creates the agent lazily on first message, spawns it if not running.
   * Activates the task on first call (starts timeout, sets status).
   */
  async sendMessage(message: string): Promise<void> {
    // Serialize activation per taskId across all Task instances, and resolve to
    // the canonical instance *inside* the lock. If a concurrent trigger already
    // activated (registered itself in activeTasks), this routes the message onto
    // that instance rather than activating and spawning a duplicate; otherwise
    // `this` is the first in and becomes canonical. See `activationLock`.
    await activationLock(this.taskId, async () => {
      const active = activeTasks.get(this.taskId);
      if (active) {
        await active.deliver(message);
        return;
      }
      const persisted = await loadMetadata(this.taskId);
      if (persisted) reconcilePersistedMemoryMetadata(persisted, this.metadata);
      await this.deliver(message);
    });
  }

  /**
   * The activation + enqueue body, run under {@link activationLock} on the
   * canonical instance. Never call directly — go through `sendMessage`, which
   * holds the lock and picks the canonical instance.
   */
  private async deliver(message: string): Promise<void> {
    if (!this.isActive) {
      await this.activate();
    }
    const wake = await this.withMigrationNotice(message);
    const agent = await this.ensurePm();
    agent.queue.addMessage(wake);
    // Mark active synchronously at enqueue (not lazily at the SDK `init` re-fire,
    // which lags). Keeps "idle" a faithful proxy for "no work in flight" so the
    // idle-check can't park an agent that's about to process, and fires the
    // intent-clear edge the moment work is delivered.
    this.updateAgentState(true);
  }

  /**
   * Prefix a wake with the one-time migration notice when this task predates the flat-PM rework, then clear the flag and flush it.
   *
   * Sits in `deliver` because that is the one place every wake is enqueued — Slack thread messages, API follow-ups, GitHub events, triggers, reminders, approval notices (`notifyPm`) and the startup recovery prompt (`recoverActiveTasks` → `sendMessage`) all funnel through `sendMessage`. The flush is synchronous rather than debounced: the notice is already in the PM's queue, so a crash in the debounce window would deliver it a second time on the next boot.
   */
  private async withMigrationNotice(message: string): Promise<string> {
    if (this.metadata.migration_notice_pending === true) {
      const notice = buildMigrationNotice(this.metadata);
      this.metadata.migration_notice_pending = false;
      await this.save(true);
      logger.system(`Task ${this.taskId}: prepended the runtime migration notice to this wake`);
      return `${notice}\n\n${message}`;
    } else {
      return message;
    }
  }

  /**
   * Append a Slack thread's messages to this task.
   * If the thread is new, links it as a channel and appends all messages.
   * If already linked, appends only messages newer than last_processed_ts.
   *
   * Returns whether a new thread was linked, and `entries` — the lines just
   * written, in order. Those lines are what the caller hands the PM inline
   * (`AGENT_PROMPTS.inboundNewTask` / `inboundActivity`); the PM is never told to go
   * and read them. `entries` is empty when the thread carried nothing new,
   * which is a real case: an edit, or a redelivery under the watermark.
   */
  async append(thread: SlackThread): Promise<{ linkedNewThread: boolean; entries: string[] }> {
    const channelId = `slack:${thread.channel.id}:${thread.threadId}`;
    const existing = this.metadata.channels[channelId] as SlackChannel | undefined;
    const entries: string[] = [];
    this.setMemoryDestination(thread.channel.id);
    if (isMemoryReady()) {
      const memoryScope = scopeForSlackChannel(
        await classifySlackMemoryScope(thread.channel.id),
        thread.channel.id,
      );
      if (isAuthorizedMemoryScope(this.metadata.memory_destination, memoryScope)) {
        for (const message of thread.messages) this.recordMemoryAuthor(message.user, message.ts);
      }
    }
    await this.save(true);

    // Redaction policy: when the channel is shared and the message author is
    // external, drop content and don't download files. Author info is logged.
    // The predicate lives in the shared render module so this call site cannot
    // drift from the other paths that ask the same question.
    const writeMessage = async (msg: typeof thread.messages[number]): Promise<void> => {
      const redacted = shouldRedact(msg, thread);
      if (redacted) {
        // Skipping the download is load-bearing, not an optimisation: a redacted
        // message's files must never reach the task's attachments folder, since
        // the body that would reference them is a placeholder.
        //
        // The redacted line is delivered inline like any other: the placeholder
        // is what the PM must see, and dropping the entry would hide that
        // someone external spoke at all.
        entries.push(await appendSlackMessage(
          this.taskId, thread.channel, thread.threadId, msg.user,
          renderMessageBody(msg, { redacted: true }),
          { redacted: true, ts: msg.ts },
        ));
      } else {
        const downloadedFiles = msg.files ? await downloadMessageFiles(this.taskId, msg.files) : undefined;
        // Render AFTER the download, from `downloadedFiles` rather than `msg.files`: only the
        // downloaded copies carry `localPath`, and the `[Attachments: …]` suffix prints the path
        // only when it is set — rendering earlier would silently strip every local path an agent
        // needs to open the file.
        entries.push(await appendSlackMessage(
          this.taskId, thread.channel, thread.threadId, msg.user,
          renderMessageBody({ ...msg, files: downloadedFiles }, { redacted }),
          { ts: msg.ts },
        ));
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
      return { linkedNewThread: true, entries };
    }

    // Existing thread — only append messages newer than last_processed_ts
    const lastProcessedTs = existing.last_processed_ts;
    for (const msg of thread.messages) {
      if (msg.ts <= lastProcessedTs) continue;
      await writeMessage(msg);
    }

    existing.last_processed_ts = thread.currentMessageTs;
    this.debouncedSave();
    return { linkedNewThread: false, entries };
  }

  /**
   * Record that a Slack message previously ingested into this task was edited.
   *
   * Writes a fresh knowledge-log entry (we never mutate prior entries) keyed to
   * the original message via `msg:<ts>`, capturing the new text. The pre-edit
   * text stays in the log under that same id, so the change is recoverable by
   * correlation. Deliberately does NOT advance `last_processed_ts` — an edit
   * reuses the original message's `ts`, so touching the watermark would skip
   * genuinely new replies.
   *
   * Returns the written line, for the caller to deliver to the PM inline, or
   * null when the thread isn't a linked Slack channel and nothing was recorded.
   */
  async appendSlackEdit(
    channelKey: string,
    author: SlackAuthor,
    editedTs: string,
    newText: string,
  ): Promise<string | null> {
    const ch = this.metadata.channels[channelKey];
    if (ch?.type !== 'slack') return null;
    this.setMemoryDestination(ch.channel_id);
    if (isMemoryReady()) {
      const memoryScope = scopeForSlackChannel(
        await classifySlackMemoryScope(ch.channel_id),
        ch.channel_id,
      );
      if (isAuthorizedMemoryScope(this.metadata.memory_destination, memoryScope)) {
        this.recordMemoryAuthor(author, editedTs);
      }
    }
    await this.save(true);
    const entry = await appendSlackEdit(
      this.taskId,
      { id: ch.channel_id, name: ch.channel_name },
      ch.thread_id,
      author,
      editedTs,
      newText,
    );
    this.debouncedSave();
    return entry;
  }

  setMemoryDestination(channelId: string): void {
    const current = this.metadata.memory_destination;
    if (current && current.channel_id !== channelId) {
      throw new Error('this task belongs to a different Slack destination');
    }
    if (!current) {
      const derived = deriveMemoryDestination(
        this.metadata.channels,
        this.metadata.default_channel,
        this.metadata.home_channel?.channel_id,
      );
      if (derived && derived.channel_id !== channelId) {
        throw new Error('this task belongs to a different Slack destination');
      }
      const hasSlackHistory = Object.values(this.metadata.channels).some((channel) => channel.type === 'slack');
      if (!derived && hasSlackHistory) {
        throw new Error('this task has no unambiguous Slack destination');
      }
      this.metadata.memory_destination = { channel_id: channelId };
    }
  }

  async prepareMemoryDelivery(channelId: string): Promise<void> {
    const destination = this.metadata.memory_destination;
    if (!destination || destination.channel_id !== channelId) {
      throw new Error('delivery blocked: this task belongs to a different Slack destination');
    }
  }

  async prepareTriggerDelivery(binding: TriggerBinding): Promise<void> {
    if (binding.type === 'channel') {
      await this.prepareMemoryDelivery(binding.channel_id);
      return;
    }
    const destination = this.metadata.memory_destination;
    if (!destination) throw new Error('delivery blocked: this task has no Slack destination');
    await this.prepareMemoryDelivery(destination.channel_id);
    const channel = await getChannelInfo(destination.channel_id);
    if (channel.isIm !== true || channel.imUserId !== binding.user_id) {
      throw new Error('delivery blocked: trigger belongs to a different Slack destination');
    }
  }

  async updateSlackMessageSafely(
    channelId: string,
    messageTs: string,
    text: string,
    blocks: unknown[],
  ): Promise<void> {
    await this.prepareMemoryDelivery(channelId);
    await updateMessage(channelId, messageTs, text, blocks);
  }

  private recordMemoryAuthor(author: SlackAuthor, messageTs: string): void {
    if (author.id === getBotUserId()) return;
    if (!/^[UW][A-Z0-9]{6,}$/.test(author.id)) return;
    if (!/^\d+\.\d+$/.test(messageTs)) return;
    if (author.isBot !== false || author.isAppUser !== false) return;
    if (!isInternalMemoryUser(author)) return;
    this.metadata.memory_authors ??= {};
    this.metadata.memory_message_authors ??= {};
    this.metadata.memory_authors[author.id] = author.realName || author.username || author.id;
    this.metadata.memory_message_authors[messageTs] = author.id;
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
   *
   * Posts to `default_channel`, or to an already-linked thread via
   * `target.channel`. For a trigger-fired task that has a `home_channel` and no
   * channel yet, a message sent by an agent opens the task's own thread there
   * (the message itself becomes the thread root) and returns its channel key —
   * that is the only way a new thread is ever opened. Otherwise returns null.
   */
  async postToUser(message: string, agentName?: string, target?: PostTarget): Promise<string | null> {
    const sender = agentName || 'system';
    // Grey footer (task id + PM model) appended to every user-facing message:
    // a Slack `context` block, and the same string on the `message` event so the
    // CLI can render it dimmed (see logOutgoingMessage / TaskDetail).
    const footer = this.buildUserFooter();

    // Specific existing channel
    if (target?.channel) {
      const ch = this.metadata.channels[target.channel];
      if (ch?.type === 'slack') {
        await this.prepareMemoryDelivery(ch.channel_id);
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
      // A trigger-fired task starts with no thread: its first user-facing message becomes the root of
      // the thread it will live in. `sender !== 'system'` is load-bearing, not defensive — `sender` is
      // `agentName || 'system'`, and the internal callers that post without an agentName are operational
      // notices (the inter-agent budget warning and the wall-clock pause message). Letting one of those
      // open the thread would make the root a preamble about the machinery rather than the result the
      // trigger was created to deliver, which is exactly what this feature exists to avoid. So only an
      // agent's own message may open a task's thread; a system notice with nowhere to go is still dropped.
      if (this.metadata.home_channel && sender !== 'system') {
        return this.openHomeThread(message, sender, footer);
      }
      logger.warn('task', `postToUser called on task ${this.taskId} with no default channel — message dropped`);
      return null;
    }
    if (defaultCh.type === 'slack') {
      await this.prepareMemoryDelivery(defaultCh.channel_id);
      await postSlackMessage({ channel: defaultCh.channel_id, threadTs: defaultCh.thread_id, text: message, footer });
      this.logOutgoingMessage(sender, message, Task.formatSlackDest(defaultCh).display, defaultCh, footer);
    } else if (defaultCh.type === 'cli') {
      this.logOutgoingMessage(sender, message, 'cli', undefined, footer);
    }
    return null;
  }

  /**
   * Post `message` as a new top-level message in the task's home channel and adopt that message as the task's thread, so every human reply to it routes back to this task instead of starting a new one.
   *
   * The message is the thread root: nothing is posted ahead of it. Only reached from `postToUser` for a task that has a `home_channel` and no channel yet.
   *
   * Serialized per task by {@link homeThreadLock}, because a task has exactly one thread and an agent can emit two `post_to_user` calls in one turn. Whoever runs second finds the thread the first one linked and posts into it rather than rooting a second one beside it.
   */
  private async openHomeThread(message: string, sender: string, footer: string): Promise<string | null> {
    return homeThreadLock(this.taskId, () => this.rootHomeThread(message, sender, footer));
  }

  /** The body of {@link openHomeThread}, run one at a time per task by it. */
  private async rootHomeThread(message: string, sender: string, footer: string): Promise<string | null> {
    const home = this.metadata.home_channel!;

    // One thread per channel: if this task already has a thread in the home channel (a reply arrived
    // and linked it, or a restart re-read it from disk while default_channel was still null), post
    // into that thread rather than rooting a second one alongside it.
    const existing = Object.entries(this.metadata.channels).find(
      (entry): entry is [string, SlackChannel] => entry[1].type === 'slack' && entry[1].channel_id === home.channel_id,
    );
    if (existing) {
      const [key, ch] = existing;
      this.metadata.default_channel = key;
      await this.prepareMemoryDelivery(ch.channel_id);
      await postSlackMessage({ channel: ch.channel_id, threadTs: ch.thread_id, text: message, footer });
      this.logOutgoingMessage(sender, message, Task.formatSlackDest(ch).display, ch, footer);
      await this.save(true);
      return key;
    }

    // No threadTs — this is a new top-level post in the channel, and its ts becomes the thread root.
    await this.prepareMemoryDelivery(home.channel_id);
    const ts = await postSlackMessage({ channel: home.channel_id, text: message, footer });
    if (!ts) {
      // Dry-run mode returns undefined without ever reaching Slack, so there is no thread to link to.
      // Log the message so it still surfaces, but leave the task threadless rather than inventing a key.
      logger.warn('task', `openHomeThread on task ${this.taskId}: no message ts returned for channel ${home.channel_id} — nothing linked`);
      this.logOutgoingMessage(sender, message, formatSlackChannelDisplay(home.channel_name), undefined, footer);
      return null;
    }

    const key = this.linkSlackThread(home.channel_id, ts, home.channel_name);
    const ch = this.metadata.channels[key] as SlackChannel;
    this.logOutgoingMessage(sender, message, Task.formatSlackDest(ch).display, ch, footer);
    // Flushed rather than debounced on purpose: this record is what routes every future human reply back
    // to this task, and the message is already live in Slack. A crash in the debounce window would leave a
    // thread nobody owns — replies to it would open a brand-new task, which is the bug this feature fixes.
    await this.save(true);
    return key;
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
      await this.prepareMemoryDelivery(target.channel_id);
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
  async postInteractiveToUser(
    text: string,
    blocks: unknown[],
    approvalType: 'edit_mode' | 'research_budget' | 'merge' | 'trigger' | 'max_mode' | 'tool_call',
    channelKey?: string,
    context?: { github: string; pr_number: number },
    ref?: string,
  ): Promise<void> {
    // Merge approvals carry the PR identity so CLI/SSE consumers can echo it
    // back on resolution (the API route requires github+pr_number for
    // type:'merge'). `ref` is an opaque id the approval applies to (e.g. a
    // trigger id), echoed so the CLI can resolve the exact item when several
    // approvals of the same type are outstanding. Other types omit both.
    emitEvent('approval:requested', this.taskId, {
      text,
      approvalType,
      ...(context ? { github: context.github, pr_number: context.pr_number } : {}),
      ...(ref ? { ref } : {}),
    });

    const ch = this.resolveSlackChannel(channelKey);
    if (ch) {
      await this.prepareMemoryDelivery(ch.channel_id);
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
   * plus the PM's model label (preserving any `[1m]` marker). Prefers the
   * concrete model the SDK resolved the alias to (so the footer shows the
   * version), falling back to the configured alias until that arrives — which
   * means the footer is right even before the PM process spawns.
   */
  private buildUserFooter(): string {
    const alias = resolveAgentModel(this.pmDef, this.metadata.max_mode === true);
    let model = alias;
    if (this.resolvedModel) {
      // The SDK's concrete id carries no `[1m]` suffix; re-attach it when the
      // configured alias asked for the 1M window so the `(1M)` marker survives.
      model = /\[1m\]$/i.test(alias) && !/\[1m\]$/i.test(this.resolvedModel)
        ? `${this.resolvedModel}[1m]`
        : this.resolvedModel;
    }
    return `${this.taskId} · ${modelDisplayLabel(model)}`;
  }

  /**
   * Record the concrete model the PM resolved to, as reported by the SDK at its
   * session `init`. Lets the footer show the real version (`Opus 5`) without
   * the app hard-coding the alias→model mapping. No-op for a falsy model.
   */
  recordResolvedModel(model?: string): void {
    if (model && typeof model === 'string') this.resolvedModel = model;
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
    for (const attached of this.metadata.repositories) {
      for (const state of Object.values(attached.branch_states ?? {})) {
        if (!state.pr_number) continue;
        const cardId = `${attached.github}#${state.pr_number}`;
        if (seen.has(cardId)) continue;
        seen.add(cardId);
        out.push({ github: attached.github, prNumber: state.pr_number, state });
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
            await this.prepareMemoryDelivery(slack.channel_id);
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
          await this.prepareMemoryDelivery(slackRef.channel_id);
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
    const destination = this.metadata.memory_destination;
    if (!destination) return;
    void this.prepareMemoryDelivery(destination.channel_id)
      .then(() => Promise.all(
        Object.values(this.metadata.channels)
          .filter((ch): ch is SlackChannel => ch.type === 'slack' && !ch.muted && ch.channel_id === destination.channel_id)
          .map((ch) => setSlackThreadStatus(ch.channel_id, ch.thread_id, status)),
      ))
      .catch((error) => logger.warn('task', `Slack status suppressed for ${this.taskId}: ${error}`));
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
   * Feed an SDK event into the status indicator. Called once per event from the
   * spawn loop; it inspects tool_use blocks and, when one maps to a surfaceable
   * action, records the current activity. No-op for events without a
   * status-worthy tool call.
   */
  noteActivityFromEvent(event: unknown): void {
    const agent = this.agent;
    if (!agent) return;
    const phrase = deriveActivityFromEvent(event, {
      mcpDescriptions: agent.def.mcpDescriptions,
      mcpTools: agent.mcpTools,
    });
    if (phrase) this.statusController.note(phrase);
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
    await this.prepareMemoryDelivery(ch.channel_id);
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
    await this.prepareMemoryDelivery(ch.channel_id);
    await removeReaction(ch.channel_id, messageTs, emoji);
    return true;
  }

  /**
   * Read the live emoji reactions on a message in a linked Slack thread.
   * Returns null when no Slack channel could be resolved, otherwise the read's
   * outcome: the current reactions (empty array when the message has none) or
   * the Slack error code that stopped the read.
   */
  async readMessageReactions(messageTs: string, channelKey?: string): Promise<SlackReactionsResult | null> {
    const ch = this.resolveSlackChannel(channelKey);
    if (!ch) {
      logger.warn('task', `readMessageReactions on task ${this.taskId}: ${channelKey ? `channel ${channelKey} not linked` : 'no default channel'}`);
      return null;
    }
    return getMessageReactions(ch.channel_id, messageTs);
  }

  /**
   * Link an existing Slack thread to this task and promote it to the default
   * channel. Posts nothing — this is how a task takes ownership of a thread it is
   * about to speak in, so every human reply to that thread routes back here. Its
   * only caller is `openHomeThread`, which links the thread it just rooted in the
   * task's home channel. Idempotent; mirrors the channel-registration shape used
   * by `append`. Returns the channel key.
   */
  linkSlackThread(channelId: string, threadTs: string, channelName: string): string {
    const key = `slack:${channelId}:${threadTs}`;
    if (!this.metadata.channels[key]) {
      this.metadata.channels[key] = {
        type: 'slack',
        thread_id: threadTs,
        channel_id: channelId,
        channel_name: channelName,
        last_processed_ts: threadTs,
        url: buildThreadUrl(channelId, threadTs) ?? undefined,
      };
    }
    this.metadata.default_channel ??= key;
    this.debouncedSave();
    return key;
  }

  /**
   * Stop the task and tear its agent down.
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

    // Stop the queue. A parked or just-finished agent (session inactive) exits
    // gracefully on its next queue pull — the resume-safe path the deferred
    // teardown relies on (see spawn.ts: never .return() the generator), so do
    // NOT abort it. But an agent still mid-turn keeps generating and hits
    // "Stream closed" on every tool/hook control request, looping until maxTurns
    // — stopping its queue can't end it, so hard-abort that. agent:inactive is
    // emitted by the Stop hook / crash handler (or the aborted loop exiting).
    if (this.agent) {
      const midTurn = this.agent.session.active;
      this.agent.queue.stop();
      if (midTurn) this.agent.handle?.abort();
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

    // Stop the queue. A parked or just-finished agent (session inactive) exits
    // gracefully on its next queue pull — the resume-safe path the deferred
    // teardown relies on (see spawn.ts: never .return() the generator), so do
    // NOT abort it. But an agent still mid-turn keeps generating and hits
    // "Stream closed" on every tool/hook control request, looping until maxTurns
    // — stopping its queue can't end it, so hard-abort that. agent:inactive is
    // emitted by the Stop hook / crash handler (or the aborted loop exiting).
    if (this.agent) {
      const midTurn = this.agent.session.active;
      this.agent.queue.stop();
      if (midTurn) this.agent.handle?.abort();
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
   * Remove shared clones and clear clone_path so the next mount creates a fresh
   * one. Iterates every repo mounted into the task.
   */
  private async cleanupClones(): Promise<void> {
    const { removeClone } = await import('../connectors/github/repo-clone.js');
    for (const attached of this.metadata.repositories) {
      if (!attached.clone_path) continue;
      try {
        await removeClone(attached.clone_path);
        attached.clone_path = undefined;
        logger.system(`Task ${this.taskId}: cleaned up clone for ${attached.github}`);
      } catch (error) {
        logger.warn('task', `Failed to cleanup clone for ${attached.github}: ${error}`);
      }
    }
  }

  /**
   * Record that the PM has finished and is waiting on no one but the user
   * (called by report_completion). The idle-check parks the task — instead of
   * recovering — once the agent is idle (quiescent). Completion is thus decided
   * at quiescence, not by a synchronous gate that races the Stop hook.
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
    this.syncAgentSession();
    this.metadata.updated_at = new Date().toISOString();

    if (flush) {
      await persistTaskMetadata(this.taskId, this.metadata);
    } else {
      this.debouncedSave();
    }
  }

  /**
   * Copy the live agent's session into metadata, so the on-disk record always
   * reflects the latest `session_id` / `active` / `last_activity`.
   */
  private syncAgentSession(): void {
    if (this.agent) {
      this.metadata.agent_sessions[this.agent.def.id] = { ...this.agent.session };
    }
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

  async onResearchBudgetExceeded(): Promise<void> {
    // Already pausing this turn — the spawn loop stops the task at turn-end.
    // Skip a duplicate approval post if web_research goes over budget again.
    if (!this.agent || this.agent.pendingTeardown) return;

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

    // Defer the stop to the PM's turn-end (see report_completion):
    // web_research is mid-turn here, so stopping the queue now would close the
    // input stream under an in-flight hook ("stream closed" error).
    this.statusController.suspend(); // don't let the wind-down resurface the status
    this.agent.deferTeardown(() => this.stop());
  }

  // ---- Approval handlers ----

  /**
   * Record a system-side decision and wake the PM WITH IT.
   *
   * Every approval, denial and budget change reaches the PM this way. The
   * finding goes to knowledge.log for the offline record (memory extraction,
   * audit) and the same sentence goes into the PM's stream, because the PM does
   * not read that file: a wake saying only "something happened, go look" is one
   * the PM cannot act on. One helper rather than a pair of calls per handler so
   * the two cannot drift apart — a logged decision the PM never hears about is
   * exactly the failure this replaces.
   */
  private async notifyPm(finding: string, type: FindingType): Promise<void> {
    await appendAgentFinding(this.taskId, 'system', finding, type);
    await this.sendMessage(AGENT_PROMPTS.systemNotice(finding));
  }

  async handleEditModeApproval(approver?: { id: string; name: string; email?: string }): Promise<void> {
    // Cancel any park armed by request_edit_mode on the PM this turn. The tool
    // defers task.stop() to the PM's turn-end so it doesn't close the input
    // stream under an in-flight hook. If the user approves *before* that turn
    // ends, the stop is still armed and fires right after approval — stopping
    // the task we just approved and tearing the stream out from under the PM's
    // own work (the "stream closed" loop). Approval means "continue", so drop
    // the park.
    this.agent?.clearPendingTeardown();
    this.metadata.edit_allowed = true;
    // Remember who approved so commits are authored as this person (committer
    // stays the bot — see spawnAgent's GIT_AUTHOR_* env). First resolved
    // approver wins: only set when we don't already have one, so a later
    // re-approval (e.g. a repeat POST to the approve route) can't reassign
    // authorship mid-task or clobber it with an unresolved user.
    if (approver && !this.metadata.edit_approved_by) {
      this.metadata.edit_approved_by = approver;
    }
    // Flush synchronously (not debouncedSave): the spawn reads edit_allowed at
    // spawn time, so the writable-mount flag must be on disk before any
    // (re)spawn — including one after a park/reload — rather than 500ms later.
    await this.save(true);

    // Put every mounted clone on the task branch before the respawn, so the
    // writable mount the PM comes back to is already checked out where its
    // commits belong.
    await this.recheckoutClonesForEditMode();

    // Restart the PM so it re-mounts the clones writable. Edit mode only flips
    // the sandbox at spawn time (editAllowed puts the clones in
    // allowWritePaths); a process that is already running keeps its read-only
    // mount and never re-reads the flag, so writes keep hitting a read-only
    // filesystem after approval (observed on task-20260625-1122-30wkzk: EROFS
    // persisted for ~20 min post-approval). Tearing it down here means the
    // sendMessage below spawns it fresh — resuming the SAME SDK session
    // (session_id is synced to metadata first, and Agent.spawn rehydrates from
    // there), so context is kept and only the mount changes.
    await this.restartAgent('Edit mode approved — restarting for a writable mount');

    const approvedBy = this.metadata.edit_approved_by?.name || 'user';
    await this.notifyPm(`Edit mode approved by ${approvedBy}`, 'decision');
  }

  async handleEditModeDenial(): Promise<void> {
    await this.notifyPm('Edit mode denied by user', 'decision');
  }

  /**
   * Tear down the running agent so the next `sendMessage` spawns it fresh.
   *
   * The session is synced into metadata first, so the replacement resumes the
   * same SDK session rather than cold-starting. Abort + queue-stop is the
   * pairing every other teardown path uses.
   */
  private async restartAgent(reason: string): Promise<void> {
    const agent = this.agent;
    if (!agent) return;
    this.syncAgentSession();
    agent.handle?.abort();
    agent.queue.stop();
    this.agent = undefined;
    await this.save(true);
    logger.system(`Task ${this.taskId}: ${reason}`);
  }

  /**
   * Put every clone mounted into this task onto the task's feature branch,
   * creating it from base on the first approval and restoring the branch the
   * task was last on when a clone is re-created later.
   *
   * One call to `ensureTaskClone` per mounted repo, with `editAllowed` forced
   * on — the same helper `mount_repo` uses, so the checkout decision, the
   * `base_path` pinning, the branch-state hydration and the git identity all
   * live in one place and cannot drift. This method used to restate that logic,
   * and the restatement was wrong in one case: it skipped any clone that was
   * still on disk, so a repo mounted while the task was read-only stayed parked
   * on the base branch after approval and the PM committed onto base. The
   * shared helper cuts the task branch in place instead.
   *
   * A clone the read-only teardown removed is re-created here, so approval —
   * not the next tool call — is what makes the writable checkout appear.
   */
  private async recheckoutClonesForEditMode(): Promise<void> {
    if (this.metadata.repositories.length === 0) return;
    const { ensureTaskClone } = await import('../connectors/github/repo-clone.js');
    const { getBaseCachePath } = await import('../system/workdir.js');
    const { taskBranchName } = await import('../connectors/github/branch-naming.js');

    for (const att of this.metadata.repositories) {
      try {
        // `edit_allowed` is already true on metadata by the time this runs, but
        // the argument is passed literally: this method exists only for the
        // approval path, and reading the flag would make it look conditional.
        const result = await ensureTaskClone({
          attached: att,
          clonePath: getTaskClonePath(this.taskId, att.github),
          baseRepoPath: att.base_path || getBaseCachePath(att.github),
          editAllowed: true,
          taskBranch: taskBranchName(this.taskId),
        });
        logger.system(
          `Task ${this.taskId}: ${att.github} checked out on ${result.branch} for edit mode`,
        );
      } catch (error) {
        logger.error('task', `Failed to check out ${att.github} for edit mode`, error);
      }
    }
    await this.save(true);
  }

  /**
   * Resolve a pending merge approval (approve side).
   *
   * The identity gate is a **synchronous read-compare-clear** on
   * `pending_merge_approval`: no await between reading the slot, comparing it
   * to `expected`, and clearing it. A supersede landing mid-resolution
   * therefore turns an in-flight click into a stale no-op — it can never merge
   * the superseding PR. Adapters (Slack handlers, API route) do no slot
   * verification of their own; this method is the single verification point.
   *
   * On match the engine takes the merge-now-or-arm decision (no agent re-wake):
   * fetch PR status, and if it is open and GitHub reports it **clean** merge
   * immediately (completion finding on success, decision finding on a merge-API
   * failure). Otherwise the PR is **armed** for auto-merge — its BranchState
   * gains `merge_armed`, the orchestrator merges it on the next
   * merge-triggering webhook once it turns clean, and a decision finding records
   * the arming with no error surfaced (AC4). **No `approved` check anywhere on
   * this path** (AC5) — GitHub branch protection is the sole review authority.
   * Either way the PM is reactivated so the user learns the outcome.
   */
  async handleMergeApproval(
    approver: { id: string; name: string; email?: string } | undefined,
    expected: { github: string; pr_number: number },
  ): Promise<'resolved' | 'stale'> {
    const pending = this.metadata.pending_merge_approval;
    if (!pending || pending.github !== expected.github || pending.pr_number !== expected.pr_number) {
      logger.warn(
        'task',
        `Stale merge approval for ${expected.github}#${expected.pr_number} on task ${this.taskId} — ` +
        `slot ${pending ? `holds ${pending.github}#${pending.pr_number}` : 'is empty'}`,
      );
      return 'stale';
    }
    // Clear-before-awaits invariant: the slot is consumed here, synchronously
    // with the read+compare above. Moving this clear after the GitHub awaits
    // below would let a supersede that lands mid-await pass the compare too
    // (double resolution) and then be wiped by this resolution's clear.
    this.metadata.pending_merge_approval = undefined;

    // Cancel the park armed by merge_pull_request — same stream-closed-loop
    // protection edit mode applies.
    this.agent?.clearPendingTeardown();

    const prRef = `${pending.github}#${pending.pr_number}`;
    const bySuffix = approver?.name ? ` by ${approver.name}` : '';
    let findingType: 'completion' | 'decision';
    let finding: string;
    // Arming must reach a later webhook-loaded instance, so it persists durably
    // (save(true)) rather than via the 500ms debounce that a concurrent
    // activation could clobber. Every other outcome uses the debounced save.
    let armed = false;
    const client = getGitHubClient();
    if (!client) {
      findingType = 'decision';
      finding = `Merge approved${bySuffix} but PR ${prRef} was not merged: GitHub client not configured`;
    } else {
      try {
        const status = await client.getPRStatus(pending.github, pending.pr_number);
        if (status.state === 'open' && status.mergeableState === 'clean') {
          // Merge-now path: the PR is already green, so merge on approval.
          const result = await client.mergePullRequest(pending.github, pending.pr_number);
          if (result.success) {
            findingType = 'completion';
            finding = `PR ${prRef} merged on user approval${bySuffix}`;
          } else {
            findingType = 'decision';
            finding = `Merge approved${bySuffix} but PR ${prRef} was not merged: ${result.message}`;
          }
        } else if (status.state === 'open') {
          // Open but not clean yet: arm the PR for auto-merge (no error). The
          // merge orchestrator merges it on the next merge-triggering webhook
          // once GitHub reports it clean — the reframe's whole point (AC4).
          // Mark every BranchState entry for the PR via the same
          // repositories → branch_states walk the orchestrator uses (mirrored
          // here, not imported, to avoid a task ↔ orchestrator circular
          // dependency: arming is the Task's job, the deferred merge is the
          // orchestrator's).
          for (const attached of this.metadata.repositories) {
            if (attached.github !== pending.github || !attached.branch_states) continue;
            for (const state of Object.values(attached.branch_states)) {
              if (state.pr_number === pending.pr_number) state.merge_armed = true;
            }
          }
          armed = true;
          findingType = 'decision';
          finding = `Auto-merge armed for ${prRef} — will merge once checks pass`;
        } else {
          // Closed or merged by the time the click resolved (the PR can close
          // during the approval window): there is nothing to merge and arming a
          // dead PR would seed a stale merge_armed onto the branch. Report the
          // real outcome (AC4) and do not arm.
          findingType = 'decision';
          finding = `Merge approval resolved but PR ${prRef} is ${status.state} — nothing to merge`;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        findingType = 'decision';
        finding = `Merge approved${bySuffix} but PR ${prRef} was not merged: ${message}`;
      }
    }

    if (armed) {
      // Flush the arm synchronously before the PM reactivation: a debounced
      // write could be lost if a concurrent trigger registers a different
      // canonical instance before it lands, and the armed PR would then never
      // auto-merge despite the user being told it would.
      await this.save(true);
    } else {
      this.debouncedSave();
    }
    await this.notifyPm(finding, findingType);
    return 'resolved';
  }

  /**
   * Resolve a pending merge approval (deny side). Same synchronous
   * read-compare-clear gate as {@link handleMergeApproval}; on match the slot
   * and the parked teardown are cleared and the PM is reactivated. No GitHub
   * call of any kind — deny must never merge.
   */
  async handleMergeDenial(expected: { github: string; pr_number: number }): Promise<'resolved' | 'stale'> {
    const pending = this.metadata.pending_merge_approval;
    if (!pending || pending.github !== expected.github || pending.pr_number !== expected.pr_number) {
      logger.warn(
        'task',
        `Stale merge denial for ${expected.github}#${expected.pr_number} on task ${this.taskId} — ` +
        `slot ${pending ? `holds ${pending.github}#${pending.pr_number}` : 'is empty'}`,
      );
      return 'stale';
    }
    this.metadata.pending_merge_approval = undefined;

    this.agent?.clearPendingTeardown();

    this.debouncedSave();
    await this.notifyPm('Merge denied by user — PR not merged', 'decision');
    return 'resolved';
  }


  // ---- MCP tool-call approvals ---------------------------------------------
  // The gate itself lives in agents/tool-approval-gate.ts; this section owns
  // the metadata invariants it depends on. See docs/architecture/tool-approvals.md.

  /**
   * Spend a grant for `digest`.
   *
   * **Synchronous read-compare-remove, no awaits.** The gate hook calls this on
   * every gated tool call, so two calls with the same digest in one turn must
   * not both find the grant — the splice has to land before anything can yield.
   * (Same invariant as `handleMergeApproval`'s clear-before-awaits.)
   *
   * The *spend* is then flushed durably before the caller proceeds, which is
   * why this returns a promise on the spend path. Durability is inverted for a
   * single-use token: losing the grant write costs an extra approval prompt,
   * but losing the spend write means a crash — after the tool call has already
   * run — leaves the grant on disk, unexpired and spendable a second time. The
   * splice above is what has to be synchronous; awaiting the write afterwards
   * costs one fsync on a path that is about to make a network call anyway.
   */
  consumeToolApproval(digest: string): boolean | Promise<boolean> {
    const grants = this.metadata.approved_tool_calls;
    if (!grants || grants.length === 0) return false;

    const now = Date.now();
    const index = grants.findIndex((a) => a.digest === digest && Date.parse(a.expires_at) > now);
    // Prune anything stale while we're here — an unspent grant is a standing
    // permission, so it should not outlive its window on disk.
    const live = grants.filter((a, i) => i !== index && Date.parse(a.expires_at) > now);

    if (index === -1) {
      if (live.length !== grants.length) {
        this.metadata.approved_tool_calls = live;
        this.debouncedSave();
      }
      return false;
    }

    this.metadata.approved_tool_calls = live;

    // Record that the grant was actually *spent* — without this the audit trail
    // stops at "approved" and nobody can tell from the thread whether the call
    // ever ran. Fire-and-forget: a failed log write must not block the call.
    const spent = grants[index];
    void appendAgentFinding(
      this.taskId,
      'system',
      `Gated tool call ran on approval ${spent.digest}: ${spent.server}:${spent.tool}` +
        (spent.approved_by ? ` (approved by <@${spent.approved_by}>)` : ''),
      'completion',
    ).catch(() => {});

    // A failed flush is not a reason to refuse a call a human approved — the
    // cost of that write being lost is a possible replay, which is strictly
    // less bad than denying an approved action. Log and proceed.
    return this.save(true)
      .catch((error) => logger.warn('task', `Failed to flush spent tool-call grant ${digest}`, error))
      .then(() => true);
  }

  /**
   * Post a tool-call approval request and park the task.
   *
   * One outstanding request per task: a second gated call while one is pending
   * is refused rather than queued, so a human never faces a stack of approval
   * buttons to clear. There is no supersede path for a *live* request —
   * superseding would let an agent swap the call out from under a human who is
   * mid-way through reading it. Instead the slot ages out
   * (PENDING_APPROVAL_TTL_MS), and a failed Slack post clears it.
   */
  async requestToolApproval(
    agentId: string,
    request: { digest: string; server: string; tool: string; summary: string; heading: string },
  ): Promise<'posted' | 'already-pending'> {
    // A pending request goes stale: nobody clicked, and a prompt raised against
    // state that is now hours old should not keep blocking every other call for
    // the rest of the task's life, nor mint a fresh grant if someone finds it
    // days later. Past its window it is discarded and this request replaces it.
    const pending = this.metadata.pending_tool_approval;
    const live = pending && Date.parse(pending.requested_at) > Date.now() - PENDING_APPROVAL_TTL_MS
      ? pending
      : undefined;
    if (live && live.digest !== request.digest) return 'already-pending';
    // Same digest already pending: the agent retried before the human answered.
    // Re-arm the park — the previous teardown has already fired, so returning
    // without arming would leave the agent running against a prompt nobody has
    // answered, free to try something else.
    //
    // Only the *requester* re-arms. A grant is bound to the call, not to the
    // agent, so a second agent can reach this with the same digest — and both
    // resolution paths clear the teardown of `requested_by` alone, so arming
    // anyone else leaves a deferred stop() nothing will cancel: it fires at that
    // agent's turn end and tears the task down while the requester's retry is
    // in flight. Tell the other agent to wait instead.
    if (live && live.requested_by !== agentId) return 'already-pending';
    if (live) {
      this.suspendStatus();
      this.agent?.deferTeardown(() => this.stop());
      return 'posted';
    }

    this.metadata.pending_tool_approval = {
      digest: request.digest,
      server: request.server,
      tool: request.tool,
      summary: request.summary,
      heading: request.heading,
      requested_by: agentId,
      requested_at: new Date().toISOString(),
    };

    // Audit prose, fire-and-forget like the spent-finding: an awaited write here
    // is one more way to leave the slot set with no prompt behind it.
    void appendAgentFinding(
      this.taskId,
      'system',
      `Tool-call approval requested: ${request.server}:${request.tool} — ${request.heading}`,
      'decision',
    ).catch(() => {});

    const buttonValue = `${this.taskId}|${request.digest}`;
    const blocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Approval needed:* ${request.summary}` },
      },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `Requested by \`${agentId}\` · approving runs this one call once`,
        }],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Approve' },
            action_id: 'approve_tool_call',
            value: buttonValue,
            style: 'primary',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Deny' },
            action_id: 'deny_tool_call',
            value: buttonValue,
            style: 'danger',
          },
        ],
      },
    ];

    try {
      // Flush before posting: the resolution arrives on a *different* instance
      // (the task is about to stop and be reloaded by the button handler), so
      // the slot must be on disk before the park, not 500ms later.
      await this.save(true);
      await this.postInteractiveToUser(
        `Approve tool call: ${request.heading}?`,
        blocks,
        'tool_call',
        undefined,
        undefined,
        request.digest,
      );
    } catch (error) {
      // The slot's presence means "a prompt exists in Slack" — the same-digest
      // re-arm branch and the one-at-a-time refusal both key off it. Anything
      // that fails between setting it and the prompt landing must therefore
      // clear it, or the task spends an hour refusing every call and a retry
      // parks it against a button nobody can see. This catch covers the flush
      // as well as the post for that reason. Rethrow so the gate's fail-closed
      // wrapper denies this attempt.
      this.metadata.pending_tool_approval = undefined;
      await this.save(true).catch((saveError) =>
        logger.warn('task', `Failed to clear the pending tool-approval slot`, saveError),
      );
      throw error;
    }

    // Park: freeze the status so the wind-down doesn't resurface "working…",
    // and defer the stop to turn-end so stopping the queue doesn't close the
    // input stream under this in-flight hook.
    this.suspendStatus();
    this.agent?.deferTeardown(() => this.stop());
    return 'posted';
  }

  /**
   * Resolve a pending tool-call approval (approve side).
   *
   * Same synchronous read-compare-clear identity gate as
   * {@link handleMergeApproval}: a click whose digest doesn't match the slot is
   * a stale no-op and can never authorize the call currently pending. On match
   * the grant is *stored*, not executed — the agent spends it by retrying its
   * own call, which keeps the action running through the same audited MCP path
   * as everything else.
   */
  async handleToolCallApproval(
    approver: { id: string; name: string } | undefined,
    expectedDigest: string,
  ): Promise<'resolved' | 'stale'> {
    const pending = this.metadata.pending_tool_approval;
    if (!pending || pending.digest !== expectedDigest) {
      logger.warn(
        'task',
        `Stale tool-call approval for ${expectedDigest} on task ${this.taskId} — ` +
        `slot ${pending ? `holds ${pending.digest}` : 'is empty'}`,
      );
      return 'stale';
    }
    // The Slack message never expires on its own, so a prompt found days later
    // would otherwise resolve and mint a fresh spendable grant against state the
    // approver never saw. Bound the render→click interval, not just grant→spend.
    if (Date.parse(pending.requested_at) <= Date.now() - PENDING_APPROVAL_TTL_MS) {
      logger.warn(
        'task',
        `Expired tool-call approval for ${expectedDigest} on task ${this.taskId} — requested ${pending.requested_at}`,
      );
      this.metadata.pending_tool_approval = undefined;
      await this.save(true);
      await appendAgentFinding(
        this.taskId,
        'system',
        `Tool-call approval expired unspent: ${pending.server}:${pending.tool} — ${pending.heading}`,
        'decision',
      );
      return 'stale';
    }
    this.metadata.pending_tool_approval = undefined;

    // Dedupe on digest so two prompts for the same call cannot become two
    // grants: "cannot be spent twice" has to hold per *call*, not per grant.
    const now = new Date();
    this.metadata.approved_tool_calls = [
      ...(this.metadata.approved_tool_calls ?? []).filter((a) => a.digest !== pending.digest),
      {
        digest: pending.digest,
        server: pending.server,
        tool: pending.tool,
        approved_by: approver?.id,
        approved_at: now.toISOString(),
        expires_at: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
      },
    ];

    // Cancel the park armed by the gate hook on the requesting agent —
    // approval means "continue", so the deferred stop must not fire and tear
    // down the task we just approved.
    this.agent?.clearPendingTeardown();

    // Durable, not debounced: the agent's retry reads this from a reloaded
    // instance, so the grant has to be on disk before the reactivation below.
    await this.save(true);

    const bySuffix = approver?.name ? ` by ${approver.name}` : '';
    const notice = `Tool call approved${bySuffix}: ${pending.server}:${pending.tool} — ${pending.heading}`;
    await appendAgentFinding(this.taskId, 'system', notice, 'decision');
    // Wake the PM, which owns the grant: only a byte-identical retry spends it.
    // No `approval:resolved` here — every other approval type emits it once,
    // from the API route (src/connectors/api/routes.ts), and tool_call emitting
    // from both places produced two events per resolution.
    await this.sendMessage(AGENT_PROMPTS.systemNotice(notice));
    return 'resolved';
  }

  /**
   * Resolve a pending tool-call approval (deny side). Same identity gate;
   * clears the slot and grants nothing. No grant is ever stored on this path.
   */
  async handleToolCallDenial(expectedDigest: string): Promise<'resolved' | 'stale'> {
    const pending = this.metadata.pending_tool_approval;
    if (!pending || pending.digest !== expectedDigest) {
      logger.warn(
        'task',
        `Stale tool-call denial for ${expectedDigest} on task ${this.taskId} — ` +
        `slot ${pending ? `holds ${pending.digest}` : 'is empty'}`,
      );
      return 'stale';
    }
    this.metadata.pending_tool_approval = undefined;

    this.agent?.clearPendingTeardown();

    // Durable, matching the approve path: a denial lost to a crash in the
    // debounce window would leave the slot set and block every later call.
    await this.save(true);
    const notice = `Tool call denied by user: ${pending.server}:${pending.tool} — ${pending.heading}`;
    await appendAgentFinding(this.taskId, 'system', notice, 'decision');
    // No `approval:resolved` here either — see handleToolCallApproval.
    await this.sendMessage(AGENT_PROMPTS.systemNotice(notice));
    return 'resolved';
  }

  async handleMaxModeApproval(approverName?: string): Promise<void> {
    // Idempotency: max mode is a one-way, task-lifetime grant. A repeat approval
    // (e.g. a duplicate API POST) must not re-notify the PM or re-save state for
    // a grant that's already active. The Slack path is guarded by the button
    // strip; the API path is not, so guard here.
    if (this.metadata.max_mode === true) return;

    // Cancel any park armed by request_max_mode on the PM this turn — same race
    // as edit mode (see handleEditModeApproval): approval means "continue", so
    // drop the deferred stop before it fires and tears down the task we just
    // approved.
    this.agent?.clearPendingTeardown();
    this.metadata.max_mode = true;

    // No session reset needed: the resumed session picks up the new model and
    // effort from the next spawn's query() options (see buildQueryOptions in
    // src/agents/spawn.ts), which resolve fresh on every spawn.

    this.debouncedSave();
    await this.notifyPm(`Max mode approved by ${approverName || 'user'}`, 'decision');
  }

  async handleMaxModeDenial(): Promise<void> {
    await this.notifyPm('Max mode denied by user', 'decision');
  }

  async handleResearchBudgetApproval(): Promise<void> {
    this.metadata.research_budget_extra = (this.metadata.research_budget_extra ?? 0) + 5;
    this.budgets.researchRequestLimit = 5 + (this.metadata.research_budget_extra ?? 0);
    this.debouncedSave();
    await this.notifyPm(
      `Research budget extended by user (+5 requests, total extra: ${this.metadata.research_budget_extra})`,
      'decision',
    );
  }

  async handleResearchBudgetDenial(): Promise<void> {
    await this.notifyPm('Additional research denied by user', 'decision');
  }

  /**
   * Approve the trigger this task proposed (read from `metadata.pending_trigger_id`).
   * Flips it to `enabled`, indexes the scheduler, and announces to the bound
   * channel. Shared by the Slack `approve_trigger` button and the CLI
   * `/tasks/:id/approve` endpoint. Returns the enabled trigger (or null if the
   * pending proposal is gone). Dynamic imports avoid a static task↔scheduler cycle.
   */
  async handleTriggerApproval(approverId: string, triggerId?: string): Promise<import('../types/trigger.js').Trigger | null> {
    const id = triggerId ?? this.metadata.pending_trigger_id;
    if (!id) {
      logger.warn('task', `handleTriggerApproval on ${this.taskId} with no trigger id`);
      return null;
    }
    const { loadTrigger, enableProposedTrigger, deleteTrigger, countActiveTriggers } = await import('../system/trigger-store.js');
    const { indexTrigger, announceTriggerChange, MAX_TRIGGERS_PER_USER, MAX_TRIGGERS_PER_CHANNEL } = await import('../system/trigger-scheduler.js');

    // Re-check caps at approval: pending proposals don't count toward the caps,
    // so approving several proposed while under the limit could otherwise blow
    // past it. Refuse (delete the pending file) if enabling would exceed a cap.
    const pending = await loadTrigger(id);
    if (pending && pending.status === 'pending') {
      try {
        await this.prepareTriggerDelivery(pending.binding);
      } catch (error) {
        await appendAgentFinding(
          this.taskId,
          'system',
          `Trigger ${id} not enabled — ${error instanceof Error ? error.message : String(error)}`,
          'decision',
        );
        return null;
      }
      const overChannel = pending.binding.type === 'channel'
        && (await countActiveTriggers((t) => t.binding.type === 'channel' && t.binding.channel_id === (pending.binding as { channel_id: string }).channel_id)) >= MAX_TRIGGERS_PER_CHANNEL;
      const overUser = pending.created_by && pending.created_by !== 'unknown'
        && (await countActiveTriggers((t) => t.created_by === pending.created_by)) >= MAX_TRIGGERS_PER_USER;
      if (overChannel || overUser) {
        await deleteTrigger(id);
        if (this.metadata.pending_trigger_id === id) this.metadata.pending_trigger_id = undefined;
        this.debouncedSave();
        await appendAgentFinding(this.taskId, 'system', `Trigger ${id} not enabled — active-trigger cap reached`, 'decision');
        return null;
      }
    }

    const trigger = await enableProposedTrigger(id, approverId);
    if (this.metadata.pending_trigger_id === id) this.metadata.pending_trigger_id = undefined;
    this.debouncedSave();
    if (!trigger) return null;
    indexTrigger(trigger);
    await appendAgentFinding(this.taskId, 'system', `Trigger ${id} approved by user`, 'decision');
    emitEvent('trigger:created', this.taskId, { trigger_id: id });
    await announceTriggerChange(trigger, 'enabled');
    return trigger;
  }

  /**
   * Deny the trigger this task proposed — delete the pending file. Shared by the
   * Slack `deny_trigger` button and the CLI `/approve` endpoint.
   */
  async handleTriggerDenial(triggerId?: string): Promise<void> {
    const id = triggerId ?? this.metadata.pending_trigger_id;
    if (this.metadata.pending_trigger_id === id) this.metadata.pending_trigger_id = undefined;
    this.debouncedSave();
    if (!id) return;
    const { deleteTrigger } = await import('../system/trigger-store.js');
    await deleteTrigger(id);
    await appendAgentFinding(this.taskId, 'system', `Trigger ${id} denied by user`, 'decision');
  }

  // ---- Internal methods ----

  /**
   * Update the agent's active state and persist.
   */
  updateAgentState(active: boolean, sessionId?: string): void {
    if (!active && getIsShuttingDown()) return;

    const agent = this.agent;

    // Note: an agent parked on a background task is allowed to go idle here — it
    // isn't actively working, so we don't fake it as active. Recovery is still
    // held off while a task is pending via idleDecision's backgroundTasks check;
    // the ⏳ background-task entry is the in-progress indication.

    // Idempotency: skip if the agent is already in the requested state (no sessionId update needed)
    if (agent && agent.session.active === active && !sessionId) return;

    // Clear a pending completion intent when the PM genuinely re-engages: its
    // prior "waiting on no one" is stale, so the next quiescence should
    // re-decide. agent.session.active is still the pre-update value here
    // (updateSession runs below), so this is edge-exact — see
    // shouldClearCompletionIntent.
    if (agent && shouldClearCompletionIntent(active, agent.session.active)) {
      this.completionIntent = false;
    }

    if (agent) {
      agent.updateSession(active, sessionId);
      if (active) this.statusController.setActive();
      else this.statusController.setIdle();
    }

    emitEvent(active ? 'agent:active' : 'agent:inactive', this.taskId, {}, this.pmDef.id);
    this.debouncedSave();

    if (!active) {
      scheduleIdleCheck(this);
    }
  }

  /**
   * Ensure the task's agent exists and is spawned. Returns it.
   */
  private async ensurePm(): Promise<Agent> {
    // Reconcile an agent that booted read-only just as edit mode was approved.
    // The sandbox mount and repo-tool allowlist are frozen from edit_allowed at
    // spawn time (spawn.ts), so a process that came up read-only can never
    // write. `handleEditModeApproval` restarts the running agent, but one still
    // mid-boot at that moment (no live handle to abort) finishes booting
    // read-only and stays that way — every write is then denied. Catch it here
    // the moment work is next delivered: tear it down (abort + stop its queue,
    // the pairing the rest of the teardown paths use) and drop it, so the fresh
    // spawn below comes up writable. Sync its session across first so the
    // replacement resumes the same SDK session rather than cold-starting.
    if (
      this.agent &&
      this.metadata.edit_allowed === true &&
      this.agent.editModeAtSpawn === false
    ) {
      this.agent.handle?.abort();
      this.agent.queue.stop();
      this.syncAgentSession();
      this.agent = undefined;
      logger.system(`Edit mode approved — restarting ${this.pmDef.id} for a writable mount`);
    }

    this.agent ??= new Agent(this.pmDef);
    await this.agent.spawn(this);
    return this.agent;
  }

  /**
   * Activate the task — start timeout, mark in_progress.
   * Called lazily on first sendMessage().
   */
  private async activate(): Promise<void> {
    this.isActive = true;
    // A fresh activation (new task or reopen of a parked one) starts a new cycle —
    // any completion intent from a prior cycle is stale. Clearing here covers
    // reopens routed to a specialist (which don't pass through PM's active edge);
    // the updateAgentState edge-clear covers mid-cycle PM re-engagement.
    this.completionIntent = false;
    // A fresh activation also restarts the nuclear-recovery budget: the loop the
    // cap guards against lives inside one activation, and the message that
    // reopens a paused task is genuine progress. (triggerRecovery re-applies its
    // count after a nuclear respawn, which activates the reloaded task too.)
    this.nuclearRecoveryCycles = 0;
    this.metadata.status = 'in_progress';
    activeTasks.set(this.taskId, this);
    this.startTaskTimeout();
    emitEvent('task:resumed', this.taskId);
    // First activation of a task `Task.get` migrated in memory: this is where
    // the upgrade earns its write. Flushed rather than debounced, and ahead of
    // the wake being enqueued, so the runtime stamp and the notice flag that
    // rides on it are on disk before the PM can answer — a crash in a debounce
    // window would otherwise repeat the notice on the next boot. One save: the
    // debounced one below is the alternative, not an addition.
    if (this.pendingMigrationNote) {
      const note = this.pendingMigrationNote;
      this.pendingMigrationNote = undefined;
      await this.save(true);
      logger.system(`[migrate] task ${this.taskId}: persisted on activation — ${note}`);
    } else {
      this.debouncedSave();
    }
  }

  private startTaskTimeout(): void {
    this.taskTimeoutTimer = setInterval(async () => {
      const elapsed = Date.now() - this.budgets.taskStartTime.getTime();
      if (elapsed < this.budgets.taskTimeoutMs) return;

      const mins = Math.round(elapsed / 60_000);
      // The wall-clock cap is a backstop, not a failure verdict. A task that's
      // simply waiting on a human reply (agent idle) must not announce a
      // scary "timed out" — it was working as intended. Reframe as a pause and
      // `complete()` (park) so it reopens cleanly on the next reply, rather
      // than `stop()`. Only when the agent is still mid-turn is this a genuinely
      // long-running task being capped.
      const agentActive = this.agent?.session.active === true;
      logger.warn(
        'budget',
        `Task ${this.taskId} hit wall-clock cap (${mins}min, agent ${agentActive ? 'active' : 'idle'}) — pausing`,
      );
      const msg = agentActive
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
        this.syncAgentSession();
        this.metadata.updated_at = new Date().toISOString();
        await persistTaskMetadata(this.taskId, this.metadata);
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

// ---- runtime-version stamp ----

/**
 * The engine generation this build writes. `2` is the flat single-PM runtime; metadata with no stamp was written by the multi-agent engine that preceded it.
 */
export const RUNTIME_VERSION = 2;

/**
 * Stamp `runtime_version` on metadata that has none, and flag its first wake for the migration notice.
 *
 * Every task folder that existed at the cutover was written by the old engine, and the PM session inside it is conditioned on that world — specialists to message, owners to assign, replies to wait for. The flag is what turns that into a single corrective wake rather than a tool call that no longer resolves. Completed and stopped tasks are stamped too: the notice costs nothing until such a task is resumed, and a resumed one needs it just as much.
 *
 * Returns true when the stamp was added, so `Task.get` can hand the write to the task's first activation instead of writing on every load — including the read-only ones. Exported for testing.
 */
export function stampRuntimeVersion(metadata: TaskMetadata): boolean {
  if (typeof metadata.runtime_version === 'number') {
    return false;
  } else {
    metadata.runtime_version = RUNTIME_VERSION;
    metadata.migration_notice_pending = true;
    return true;
  }
}

// ---- repositories-shape migration ----

/**
 * Migrate `metadata.repositories` to the flat `AttachedRepo[]`.
 *
 * Two legacy shapes exist on disk:
 *
 *  - `Record<agentId, AttachedRepo[]>` — one list per agent. Flattened by union
 *    on `github`: two agents that both mounted a repo produce one entry, the
 *    first one seen (an arbitrary but stable choice — their branch state is the
 *    same PR history, and only one clone survives per task now).
 *  - Pre-v30 `Record<repoKey, RepositoryInfo>` — keyed by a short repo name
 *    whose `github` identifier only the (now removed) agent registry could
 *    resolve. Those entries are dropped with a warning; such tasks predate the
 *    per-agent shape by many months and are terminal.
 *
 * Returns true when anything changed, so `Task.get` can defer the write to the
 * task's first activation. A task that is only ever read re-migrates on every
 * load, which is deliberate: the derivation is deterministic, and a read must
 * not rewrite a folder the previous engine still owns.
 *
 * `Task.get` is the only caller, i.e. this runs when a task is picked up. A path
 * that merely inspects many tasks — the webhook lookups in persistence.ts — uses
 * `readRepositories` instead, which derives the same list without the write-back
 * or the log line. Also exported for testing.
 */
export function migrateRepositoriesShape(metadata: TaskMetadata): boolean {
  const { flat, dropped, changed } = flattenRepositories(metadata.repositories as unknown);
  if (!changed) return false;

  for (const key of dropped) {
    logger.warn(
      'task',
      `[migrate] task ${metadata.task_id}: dropping pre-v30 repositories["${key}"] — its github identifier is no longer resolvable`,
    );
  }

  metadata.repositories = flat;
  return true;
}

/**
 * The task's repositories as the flat `AttachedRepo[]`, derived for a *reader*:
 * nothing is written back to `metadata` and nothing is logged.
 *
 * This is what a lookup wants. Webhook routing walks every candidate a fleet-wide
 * scan turned up (`findTaskByPRNumber`, `findTaskByBranch`), and migrating each
 * one as it passes would upgrade — and log about — tasks this process is not
 * picking up. Migration belongs to the pickup: `Task.get` on the task being
 * activated, persisted by `activate()`. The list this returns is identical to
 * the migrated one, so callers see the same repos either way.
 */
export function readRepositories(metadata: TaskMetadata): AttachedRepo[] {
  return flattenRepositories(metadata.repositories as unknown).flat;
}

/**
 * Derive the flat shape from whatever is on disk. Pure: the caller decides
 * whether to write it back (`migrateRepositoriesShape`) or merely read it
 * (`readRepositories`), and whether dropped pre-v30 keys deserve a log line.
 *
 * `changed: false` means the value was already a flat array, so a migration
 * would be a no-op.
 */
function flattenRepositories(
  repos: unknown,
): { flat: AttachedRepo[]; dropped: string[]; changed: boolean } {
  if (Array.isArray(repos)) return { flat: repos as AttachedRepo[], dropped: [], changed: false };
  if (!repos || typeof repos !== 'object') return { flat: [], dropped: [], changed: true };

  const flat: AttachedRepo[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(repos as Record<string, unknown>)) {
    if (!Array.isArray(value)) {
      dropped.push(key);
    } else {
      for (const attached of value as AttachedRepo[]) {
        if (!attached?.github || seen.has(attached.github)) continue;
        seen.add(attached.github);
        flat.push(attached);
      }
    }
  }

  return { flat, dropped, changed: true };
}
