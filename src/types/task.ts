/**
 * Task-related type definitions
 */

export type TaskStatus = 'in_progress' | 'stopped' | 'completed';

/** Core agent names - repo agents can be any string ending in '-agent' */
export type CoreAgentName = 'pm-agent' | 'triage-agent';

/** Agent name - core agents or any repo agent (e.g., 'backend-agent', 'mobile-agent', 'web-agent') */
export type AgentName = CoreAgentName | `${string}-agent`;

export type FindingType = 'discovery' | 'decision' | 'completion' | 'blocker';

/** Tracking record for a Slack thread linked to a task */
export interface SlackThreadRef {
  thread_id: string;
  channel_id: string;
  last_processed_ts: string;
}

/** A fully-resolved message from a Slack thread */
export interface SlackThreadMessage {
  user: { id: string; username: string; realName: string };
  text: string;           // mentions already resolved
  ts: string;
  files?: SlackFile[];    // raw file metadata (not yet downloaded)
}

/** Full Slack thread context — all API data resolved, ready for task consumption */
export interface SlackThread {
  threadId: string;
  channel: { id: string; name: string };
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

export interface RepositoryInfo {
  path: string;
  branch?: string;                     // legacy, unused
  base_branch?: string;                // legacy — now per-branch in BranchState
  base_sha?: string;                   // legacy, unused
  clone_path?: string;                 // Path to shared clone (task-local independent repo)
  feature_branch?: string;             // legacy — now current_branch
  pr_number?: number;                  // legacy — now per-branch in BranchState
  last_processed_comment_id?: number;  // legacy — now per-branch in BranchState

  current_branch?: string;                          // branch agent is on right now (key into branch_states)
  branch_states?: Record<string, BranchState>;      // keyed by branch name
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
  slack_threads?: SlackThreadRef[];    // Legacy — only present on old tasks loaded from disk, removed after migration
  agent_sessions: Record<string, AgentSessionState | string>; // union handles legacy string values on disk
  repositories: Record<string, RepositoryInfo>;
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

export interface SlackMessage {
  type: string;
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  /** Files attached to this message */
  files?: SlackFile[];
}
