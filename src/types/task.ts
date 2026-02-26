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

export interface RepositoryInfo {
  path: string;
  branch?: string;
  base_branch?: string;
  base_sha?: string;
  worktree_path?: string;     // Path to active worktree (edit mode)
  feature_branch?: string;    // Branch name in worktree (feature/task-{id})
  pr_number?: number;         // PR number for this repo in this task
  last_processed_comment_id?: number;  // Last processed PR comment ID (for triage)
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
  slack_threads: SlackThreadRef[];
  agent_sessions: Record<string, AgentSessionState | string>; // union handles legacy string values on disk
  repositories: Record<string, RepositoryInfo>;
  status: TaskStatus;
  edit_allowed?: boolean;     // Has user approved edit mode for this task?
  research_budget_extra?: number;    // Additional research budget granted via Slack approval (+5 per approval)
  research_request_count?: number;   // Persisted research request count (survives stop/reactivate)
  failure_counter?: number;          // Consecutive recovery attempts (Stage 3 idle detection)
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
