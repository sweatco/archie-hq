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

/**
 * Snapshot of a pull request as shown on its "PR card" — the compact, updating
 * block rendered in Slack and the CLI. Carried verbatim in the `pr_card` event
 * (so every surface renders the same data) and used to build the Slack blocks.
 */
export interface PrCardData {
  repo: string;          // 'owner/name'
  prNumber: number;
  url: string;           // html_url to the PR
  headRef: string;       // head branch name, shown in the card title
  state: 'open' | 'merged' | 'closed';
  head_sha: string;
  ci: 'none' | 'pending' | 'passed' | 'failed';  // rolled-up CI verdict
  ciPassed: number;      // checks concluded OK
  ciTotal: number;       // total checks (0 = no CI)
}

/**
 * Per-PR card bookkeeping stored on the branch state. `fingerprint` is the
 * channel-agnostic "has this card changed?" gate (see `prCardFingerprint`);
 * `slack` holds the posted message ref so it can be deleted/reposted (resurface)
 * or edited in place. The CLI keeps no server-side state — it folds the
 * `pr_card` event stream client-side.
 */
export interface PrCardState {
  fingerprint: string;
  slack?: { ts: string; channel_id: string; thread_id: string };
}

/** Per-branch state — tracks PR lifecycle and stash */
export interface BranchState {
  base_branch?: string;                // PR target branch (e.g. 'main', 'master')
  pr_number?: number;                  // PR associated with this branch
  last_processed_comment_id?: number;  // triage tracking for this branch's PR
  stash_name?: string;                 // set if dirty work was auto-stashed when leaving
  pr_card?: PrCardState;               // PR-card message ref + change-detection fingerprint
  /**
   * Set when the "PR ready — merges on request" notification fired for this
   * branch's PR (non-auto repos only), cleared when a merge check observes the
   * PR no longer ready — so each continuous ready period notifies exactly once.
   */
  merge_ready_notified?: boolean;
  /**
   * Set when the user approved an explicit merge request for this branch's PR
   * but GitHub did not yet report it clean (non-auto repos only): the PR is
   * *armed* for auto-merge. The merge orchestrator merges an armed PR on the
   * next merge-triggering webhook once `mergeableState === 'clean'`, with no
   * Archie-side approval floor. Cleared when the PR is observed merged or
   * closed.
   */
  merge_armed?: boolean;
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
  /** Github identifier, e.g. 'acme/backend'. */
  github: string;
  /**
   * Task-local shared clone path, e.g.
   * `sessions/<id>/repos/<agentId>/acme/backend`. Set when the clone is
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
 * Spec for a repo agent the PM spawned on demand via `spawn_repo_agent`.
 *
 * Stores only the PM-supplied inputs (not a full AgentDef); the live AgentDef
 * is re-synthesized from this on every `Task.get` via `synthesizeDynamicAgentDef`,
 * so resolved/derived fields never go stale on disk. Persisted in
 * `TaskMetadata.dynamic_agents`. Such an agent eager-mounts its `repos` at spawn
 * exactly like a plugin-defined repo agent — there is no on-demand attach.
 */
export interface DynamicAgentSpec {
  /** Final agent ID, e.g. 'explorer-a3f9-agent'. */
  id: string;
  /** PM-supplied short name (`[a-z][a-z0-9-]*`). */
  shortname: string;
  /** Repos this agent works with. First entry is the primary. */
  repos: Array<{ github: string; baseBranch?: string }>;
  /** Role string used in peer lists and the agent's own prompt. */
  role: string;
  /** Expertise string used in the agent's prompt. */
  expertise: string;
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
  /**
   * Specs for repo agents the PM spawned on demand (via `spawn_repo_agent`).
   * Re-synthesized into AgentDefs and merged into the task team on every
   * `Task.get`. Absent on tasks that never spawned one.
   */
  dynamic_agents?: DynamicAgentSpec[];
  status: TaskStatus;
  edit_allowed?: boolean;     // Has user approved edit mode for this task?
  /**
   * The human who approved edit mode. Used as the git *author* on every commit
   * the repo agents make for this task (the committer stays the GitHub App bot),
   * so `git blame` and GitHub attribute the change to a person you can ask about
   * it. Absent on pre-feature tasks and on CLI/API approvals with no resolved
   * user — in which case authoring falls back to the bot (the prior behaviour).
   */
  edit_approved_by?: { id: string; name: string; email?: string };
  /**
   * The single pending merge-approval request (written by `merge_pull_request`
   * on a non-auto repo, cleared on every resolution — approve or deny). A
   * request record, not a grant: merge approval is one-shot per PR, not a
   * task-lifetime mode. Survives restart like `edit_allowed`.
   */
  pending_merge_approval?: {
    github: string;       // repo of the requested PR
    pr_number: number;    // which PR to merge on approval
    requested_by: string; // agent id — to clear its parked teardown on resolution
    requested_at: string; // ISO 8601, for the audit finding
  };
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

