/**
 * Task-related type definitions
 */

export type TaskStatus = 'in_progress' | 'stopped' | 'completed';

/** Core agent names - repo agents can be any string ending in '-agent' */
export type CoreAgentName = 'pm-agent' | 'triage-agent';

/** Agent name - core agents or any repo agent (e.g., 'backend-agent', 'mobile-agent', 'web-agent') */
export type AgentName = CoreAgentName | `${string}-agent`;

export type FindingType = 'discovery' | 'decision' | 'completion' | 'blocker' | 'artifact';

/** Tracking record for a Slack thread linked to a task */
export interface SlackThreadRef {
  thread_id: string;
  channel_id: string;
  last_processed_ts: string;
}

/**
 * Resolved Slack user info attached to a message or an attachment.
 *
 * Carries everything needed to classify the user (home-team membership,
 * guest status) without a second lookup. Use `isExternalUser` from the Slack
 * client to evaluate.
 */
export interface SlackAuthor {
  id: string;
  username: string;     // @handle
  realName: string;     // Full display name
  teamId?: string;
  isRestricted?: boolean;
  isUltraRestricted?: boolean;
}

/** An emoji reaction present on a Slack message (snapshot at fetch time). */
export interface SlackReaction {
  /** Emoji shortcode without colons (e.g. "thumbsup", "eyes"). */
  name: string;
  /** Number of users who reacted with this emoji. */
  count: number;
  /**
   * Display names of the users who reacted, when known. Populated by live reads
   * (`getMessageReactions`); omitted from the ingest snapshot, which only knows
   * counts.
   */
  users?: string[];
}

/** A fully-resolved message from a Slack thread */
export interface SlackThreadMessage {
  user: SlackAuthor;
  /** The author's own typed text (top-level blocks/text + file descriptions), mentions already resolved. */
  text: string;
  ts: string;
  files?: SlackFile[];    // raw file metadata (not yet downloaded)
  /** Forwarded / unfurled message attachments — each carries its author and text. */
  attachments?: SlackAttachment[];
  /** Emoji reactions present on this message at fetch time. Omitted when none. */
  reactions?: SlackReaction[];
}

/**
 * Full Slack thread context — all API data resolved, ready for task consumption.
 *
 * `shared` is a thread-level signal: when true, the channel is currently
 * shared with one or more external workspaces (Slack Connect). Consumers use
 * `shared && isExternalUser(msg.user)` to decide whether to redact a message
 * when writing it out — the data layer never strips content itself.
 */
export interface SlackThread {
  threadId: string;
  channel: { id: string; name: string };
  shared: boolean;
  messages: SlackThreadMessage[];  // full thread, bot messages excluded
  currentMessageTs: string;
}

// ---- Channel types (replace slack_threads) ----

export type ChannelType = 'slack' | 'github' | 'cli';

export interface ChannelBase {
  type: ChannelType;
}

/** Slack channel — wraps a specific thread in a Slack channel */
export interface SlackChannel extends ChannelBase {
  type: 'slack';
  thread_id: string;
  channel_id: string;
  channel_name: string;
  last_processed_ts: string;
  url?: string;     // Full Slack URL to the thread (e.g. https://workspace.slack.com/archives/C.../p...)
  muted?: boolean;  // When true, messages are not routed to task until next @mention
  /**
   * Timestamp of the message we've currently acked, if any (surfaced to the
   * user as an `:eyes:` reaction). Tracked separately from `last_processed_ts`
   * because the latter advances on every processed message (including
   * non-mention thread replies we never ack), which would otherwise orphan the
   * indicator. Cleared when the ack is removed.
   */
  ack_ts?: string;
  /** Snapshot of last observed Slack-Connect / shared-channel state for this channel. */
  isShared?: boolean;
  /** User IDs already shown the shared-channel ephemeral warning in this thread. */
  warnedUsers?: string[];
  /** User IDs already shown the forward-from-external ephemeral notice in this thread. */
  forwardNotifiedUsers?: string[];
}

/** GitHub channel — a PR conversation */
export interface GitHubChannel extends ChannelBase {
  type: 'github';
  repo: string;
  pr_number: number;
}

/** CLI channel — the REST/SSE surface the CLI tails. One per task at most. */
export interface CliChannel extends ChannelBase {
  type: 'cli';
  id: 'cli:local';
}

export const CLI_CHANNEL_KEY = 'cli:local' as const;

export type Channel = SlackChannel | GitHubChannel | CliChannel;

/** Per-branch state — tracks PR lifecycle and stash */
export interface BranchState {
  base_branch?: string;                // PR target branch (e.g. 'main', 'master')
  pr_number?: number;                  // PR associated with this branch
  last_processed_comment_id?: number;  // triage tracking for this branch's PR
  stash_name?: string;                 // set if dirty work was auto-stashed when leaving
}

/**
 * One repo attached to a specific agent in a specific task.
 *
 * Each agent has its own clone — two agents attaching the same `github` get two
 * independent `AttachedRepo` records under different agent IDs in
 * `TaskMetadata.repositories`. The base-cache path is derivable as
 * `join(REPOS_DIR, github)` and is not stored here.
 */
export interface AttachedRepo {
  /** Github identifier, e.g. 'sweatco/backend'. */
  github: string;
  /**
   * Task-local shared clone path, e.g.
   * `sessions/<id>/repos/<agentId>/sweatco/backend`. Set when the clone is
   * created during agent spawn; undefined briefly between attachment record
   * creation and clone setup. Lives outside the agent's cwd
   * (`sessions/<id>/agents/<agentId>/`) so workspace and repo state are
   * cleanly separated.
   */
  clone_path?: string;
  /**
   * Absolute path to the base cache this clone borrows from — i.e. the
   * directory the clone's `.git/objects/info/alternates` file points at the
   * parent of. Pinned at clone time and used by the sandbox to grant read
   * access to the borrowed object store, so the clone keeps working even if
   * the layout convention changes underneath it (pre-v30 caches lived at
   * `$ARCHIE_WORKDIR/repos/<short-key>/`; new caches at
   * `$ARCHIE_WORKDIR/repos/<org>/<repo>/`). Migration preserves the legacy
   * `path` here; fresh clones populate it from `getBaseCachePath(github)`.
   */
  base_path?: string;
  /** Branch the agent is on right now (key into `branch_states`). */
  current_branch?: string;
  /** Per-branch state — PR number, base branch, stash, last-processed-comment id. */
  branch_states?: Record<string, BranchState>;
}

/**
 * Legacy per-repo state shape (pre-v30).
 * Retained only to type the lazy migration path in Task.get; new code uses
 * `AttachedRepo` and `metadata.repositories: Record<agentId, AttachedRepo[]>`.
 */
export interface RepositoryInfo {
  path: string;
  branch?: string;
  base_branch?: string;
  base_sha?: string;
  clone_path?: string;
  feature_branch?: string;
  pr_number?: number;
  last_processed_comment_id?: number;
  current_branch?: string;
  branch_states?: Record<string, BranchState>;
}

/**
 * Per-agent session state — tracks whether each agent is active
 * and preserves session IDs for SDK resume.
 */
export interface AgentSessionState {
  session_id?: string;       // undefined = no session yet or cleared (fresh start)
  active: boolean;           // true = doing work, false = finished turn / crashed
  last_activity?: string;    // ISO timestamp
}

export interface TaskMetadata {
  task_id: string;
  task_owner: AgentName | null;
  participants: AgentName[];
  channels: Record<string, Channel>;   // Active message delivery targets, keyed by channel ID
  default_channel: string | null;      // Channel ID of the originating channel (null for CLI-originated tasks)
  title?: string;                      // AI-generated one-line summary; absent on pre-feature tasks
  slack_threads?: SlackThreadRef[];    // Legacy — only present on old tasks loaded from disk, removed after migration
  agent_sessions: Record<string, AgentSessionState | string>; // union handles legacy string values on disk
  /**
   * Per-agent attached repos. Keyed by agent ID. Each value is the list of
   * repos that agent currently has mounted (always includes the agent's
   * primary at minimum, once it has spawned).
   *
   * Legacy on-disk shape (pre-v30): `Record<repoKey, RepositoryInfo>` keyed by
   * short repo name. Migrated lazily in `Task.get`.
   */
  repositories: Record<string, AttachedRepo[]>;
  status: TaskStatus;
  edit_allowed?: boolean;     // Has user approved edit mode for this task?
  research_budget_extra?: number;    // Additional research budget granted via Slack approval (+5 per approval)
  research_request_count?: number;   // Persisted research request count (survives stop/reactivate)
  failure_counter?: number;          // Consecutive recovery attempts (Stage 3 idle detection)
  reminder?: {                       // Pending self-scheduled reminder (set by agent via set_reminder tool)
    trigger_at: string;              // ISO 8601 datetime when the task should be reactivated
    reason: string;                  // Why — shown to agent when woken
  };
  created_at: string;
  updated_at: string;
}

export interface LogEntry {
  timestamp: string;
  source: string;
  type?: FindingType;
  message: string;
}

export interface TriageResult {
  action: 'new_task' | 'existing_task' | 'cancel_task' | 'noop';
  task_id?: string;
  confidence: 'high' | 'medium' | 'low';
  similar_tasks?: string[];
}

/** File metadata from Slack */
export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  url_private: string;
  /** URL for downloading with Bearer token (preferred for API downloads) */
  url_private_download?: string;
  /** Local path after download (set by task processing) */
  localPath?: string;
}

/**
 * A simplified attachment on a Slack message.
 *
 * Slack attachments cover several use cases (forwarded messages, permalink
 * unfurls, link previews). We collapse them into a single shape: each entry
 * has its own text and, when known, the original author resolved to a
 * SlackAuthor. This keeps the author + content correlation that flat parallel
 * fields would lose.
 */
export interface SlackAttachment {
  /** Resolved author info, when the attachment carries an author (forwards / message unfurls). */
  author?: SlackAuthor;
  /** Text content of the attachment (forwarded message body, unfurled preview, etc.). */
  text: string;
}

