/**
 * MCP Tools Implementation
 *
 * Custom tools that agents can call to communicate with each other,
 * log findings, post to Slack, and manage GitHub PRs.
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgentName, FindingType } from '../types/index.js';
import { getAllRepoAgentIds } from '../agents/repo-configs.js';

// ============================================================================
// GitHub Types
// ============================================================================

export type MergeableState = 'clean' | 'dirty' | 'blocked' | 'behind' | 'unstable' | 'unknown';

export interface PRStatus {
  state: 'open' | 'merged' | 'closed';
  mergeable: boolean;
  mergeableState: MergeableState;
  approved: boolean;
}

export interface PRReviewComment {
  path: string;
  line: number;
  body: string;
  threadId: string;
}

export interface PRReview {
  id: string;
  user: string;
  state: 'approved' | 'changes_requested' | 'commented';
  body: string;
  comments: PRReviewComment[];
}

// ============================================================================
// Callback Interfaces (split for cleaner separation)
// ============================================================================

/**
 * Base callbacks shared by all agents
 */
export interface BaseToolCallbacks {
  onSendMessage: (target: AgentName, message: string) => Promise<string>;
  onLogFinding: (entry: string, type: FindingType) => Promise<void>;
}

/**
 * Repo agent callbacks (extends base)
 * Currently no additional callbacks, but ready for future extension
 */
export interface RepoAgentToolCallbacks extends BaseToolCallbacks {
  // Repo agents only need base callbacks
}

/**
 * PM agent callbacks (extends base, adds Slack + GitHub)
 */
export interface PMToolCallbacks extends BaseToolCallbacks {
  // Existing Slack callbacks
  onPostToSlack: (message: string) => Promise<void>;
  onReportCompletion: () => Promise<void>;
  onAssignTaskOwner: (agent: AgentName) => Promise<void>;
  onRequestEditMode: (reason: string) => Promise<void>;

  // GitHub callbacks
  onTriggerMergeCheck: () => Promise<{ merged: string[]; pending: string[]; conflicts: string[] }>;
  onPushBranch: (repoKey: string) => Promise<{ success: boolean; message: string }>;
  onCreatePullRequest: (
    repoKey: string,
    title: string,
    body: string
  ) => Promise<{ pr_number: number; pr_url: string }>;
  onGetPRStatus: (repoKey: string, prNumber: number) => Promise<PRStatus>;
  onGetPRReviews: (repoKey: string, prNumber: number) => Promise<PRReview[]>;
  onUpdatePRDescription: (repoKey: string, prNumber: number, body: string) => Promise<void>;
  onAddPRComment: (repoKey: string, prNumber: number, comment: string) => Promise<void>;
  onAddReviewComment: (
    repoKey: string,
    prNumber: number,
    path: string,
    line: number,
    comment: string
  ) => Promise<void>;
  onResolveReviewThread: (repoKey: string, prNumber: number, threadId: string) => Promise<void>;
  onRequestReReview: (repoKey: string, prNumber: number) => Promise<void>;
}

/**
 * Legacy combined interface for backward compatibility
 * @deprecated Use PMToolCallbacks or RepoAgentToolCallbacks instead
 */
export interface ToolCallbacks extends PMToolCallbacks {}

/**
 * Create the send_message_to_agent tool
 *
 * This tool allows agents to send messages to other agents.
 * The sending agent pauses until a response is received.
 */
export function createSendMessageTool(callbacks: BaseToolCallbacks) {
  // Build dynamic list of all agents
  const allAgents = ['pm-agent', ...getAllRepoAgentIds()] as [string, ...string[]];

  return tool(
    'send_message_to_agent',
    'Send a message to another agent and wait for their response. Use this to coordinate with peer agents.',
    {
      target: z
        .enum(allAgents)
        .describe('The agent to send the message to'),
      message: z.string().describe('The message content to send'),
    },
    async (args) => {
      const response = await callbacks.onSendMessage(args.target as AgentName, args.message);
      return {
        content: [
          {
            type: 'text' as const,
            text: response,
          },
        ],
      };
    }
  );
}

/**
 * Create the log_finding tool
 *
 * This tool allows agents to write discoveries, decisions, and completions
 * to the shared knowledge log. The agent continues working (no pause).
 */
export function createLogFindingTool(callbacks: BaseToolCallbacks) {
  return tool(
    'log_finding',
    'Write an entry to the shared knowledge log. Use for discoveries, decisions, completions, or blockers.',
    {
      entry: z.string().describe('The finding or decision to log'),
      type: z
        .enum(['discovery', 'decision', 'completion', 'blocker'])
        .describe('The type of entry'),
    },
    async (args) => {
      await callbacks.onLogFinding(args.entry, args.type as FindingType);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Logged ${args.type}: ${args.entry}`,
          },
        ],
      };
    }
  );
}

/**
 * Create the post_to_slack tool
 *
 * This tool allows the PM agent to post messages to Slack threads.
 */
export function createPostToSlackTool(callbacks: ToolCallbacks) {
  return tool(
    'post_to_slack',
    'Post a message to the Slack thread(s) associated with this task. Write naturally, like a human PM.',
    {
      message: z.string().describe('The message to post to Slack'),
    },
    async (args) => {
      await callbacks.onPostToSlack(args.message);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Posted to Slack: ${args.message}`,
          },
        ],
      };
    }
  );
}


/**
 * Create the assign_task_owner tool
 *
 * This tool allows the PM agent to assign a task owner.
 * The task owner is responsible for leading the investigation.
 */
export function createAssignTaskOwnerTool(callbacks: ToolCallbacks) {
  // Only repo agents can be task owners
  const repoAgents = getAllRepoAgentIds() as [string, ...string[]];

  return tool(
    'assign_task_owner',
    'Assign a task owner who will lead the investigation. Call this before sending the initial assignment message.',
    {
      agent: z
        .enum(repoAgents)
        .describe('The agent to assign as task owner'),
    },
    async (args) => {
      await callbacks.onAssignTaskOwner(args.agent as AgentName);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Assigned ${args.agent} as task owner.`,
          },
        ],
      };
    }
  );
}

/**
 * Create the request_edit_mode tool
 *
 * This tool allows PM to request task-level edit mode approval from the user.
 * When called, it:
 * 1. Logs the request to shared-knowledge.log
 * 2. Posts a Slack message with Approve/Deny buttons
 * 3. Stops the task runtime (pauses all agents)
 *
 * PM should explain findings to user via Slack BEFORE calling this tool.
 */
export function createRequestEditModeTool(callbacks: ToolCallbacks) {
  return tool(
    'request_edit_mode',
    'Request permission to make code changes. Call this AFTER explaining to the user what changes are needed and why. Task will pause until user approves or denies.',
    {
      reason: z.string().describe('Brief summary of what changes need to be made (shown in approval buttons)'),
    },
    async (args) => {
      await callbacks.onRequestEditMode(args.reason);
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Edit mode request sent. Task paused pending user approval.',
          },
        ],
      };
    }
  );
}

/**
 * Create the report_completion tool
 *
 * This tool allows PM to stop the task, optionally posting a message to Slack.
 * If message is provided, it's posted to Slack first. Then the task stops.
 */
export function createReportCompletionTool(callbacks: ToolCallbacks) {
  return tool(
    'report_completion',
    'Stop the task. If message is provided, post it to Slack first. Use without message for background work where user doesn\'t need a notification.',
    {
      message: z.string().optional().describe('Optional message to post to Slack before stopping'),
    },
    async (args) => {
      // Post to Slack only if message provided
      if (args.message) {
        await callbacks.onPostToSlack(args.message);
      }

      // Signal completion
      await callbacks.onReportCompletion();

      return {
        content: [
          {
            type: 'text' as const,
            text: args.message
              ? 'Posted message to Slack and stopped task.'
              : 'Stopped task.',
          },
        ],
      };
    }
  );
}

// ============================================================================
// GitHub Tools (PM Agent only)
// ============================================================================

/**
 * Create the push_branch tool
 *
 * Pushes commits from the local worktree to origin.
 */
export function createPushBranchTool(callbacks: PMToolCallbacks) {
  const repoKeys = getAllRepoAgentIds().map((id) => id.replace('-agent', '')) as [
    string,
    ...string[],
  ];

  return tool(
    'push_branch',
    'Push commits from the local worktree to the remote origin. Use after repo agent commits changes.',
    {
      repo_key: z.enum(repoKeys).describe('The repository to push (e.g., "backend", "mobile")'),
    },
    async (args) => {
      const result = await callbacks.onPushBranch(args.repo_key);
      return {
        content: [
          {
            type: 'text' as const,
            text: result.success
              ? `Successfully pushed ${args.repo_key}: ${result.message}`
              : `Failed to push ${args.repo_key}: ${result.message}`,
          },
        ],
      };
    }
  );
}

/**
 * Create the create_pull_request tool
 *
 * Creates a PR on GitHub and registers it in task metadata.
 */
export function createPullRequestTool(callbacks: PMToolCallbacks) {
  const repoKeys = getAllRepoAgentIds().map((id) => id.replace('-agent', '')) as [
    string,
    ...string[],
  ];

  return tool(
    'create_pull_request',
    'Create a pull request on GitHub. The PR will be linked to this task.',
    {
      repo_key: z.enum(repoKeys).describe('The repository to create PR for'),
      title: z.string().describe('PR title'),
      body: z.string().describe('PR description body (markdown supported)'),
    },
    async (args) => {
      const result = await callbacks.onCreatePullRequest(args.repo_key, args.title, args.body);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Created PR #${result.pr_number}: ${result.pr_url}`,
          },
        ],
      };
    }
  );
}

/**
 * Create the get_pr_status tool
 *
 * Gets the current status of a PR including mergeable state.
 */
export function createGetPRStatusTool(callbacks: PMToolCallbacks) {
  const repoKeys = getAllRepoAgentIds().map((id) => id.replace('-agent', '')) as [
    string,
    ...string[],
  ];

  return tool(
    'get_pr_status',
    'Get the current status of a pull request including approval and mergeable state.',
    {
      repo_key: z.enum(repoKeys).describe('The repository'),
      pr_number: z.number().describe('The PR number'),
    },
    async (args) => {
      const status = await callbacks.onGetPRStatus(args.repo_key, args.pr_number);
      return {
        content: [
          {
            type: 'text' as const,
            text: `PR #${args.pr_number} status:
- State: ${status.state}
- Mergeable: ${status.mergeable}
- Mergeable State: ${status.mergeableState}
- Approved: ${status.approved}`,
          },
        ],
      };
    }
  );
}

/**
 * Create the get_pr_reviews tool
 *
 * Fetches all reviews and comments on a PR.
 */
export function createGetPRReviewsTool(callbacks: PMToolCallbacks) {
  const repoKeys = getAllRepoAgentIds().map((id) => id.replace('-agent', '')) as [
    string,
    ...string[],
  ];

  return tool(
    'get_pr_reviews',
    'Get all reviews and comments on a pull request.',
    {
      repo_key: z.enum(repoKeys).describe('The repository'),
      pr_number: z.number().describe('The PR number'),
    },
    async (args) => {
      const reviews = await callbacks.onGetPRReviews(args.repo_key, args.pr_number);
      if (reviews.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No reviews found for PR #${args.pr_number}` }],
        };
      }

      const reviewText = reviews
        .map((r) => {
          let text = `- ${r.user} (${r.state}): ${r.body || '(no comment)'}`;
          if (r.comments.length > 0) {
            text +=
              '\n  Comments:\n' +
              r.comments.map((c) => `    - ${c.path}:${c.line}: ${c.body}`).join('\n');
          }
          return text;
        })
        .join('\n');

      return {
        content: [
          {
            type: 'text' as const,
            text: `Reviews for PR #${args.pr_number}:\n${reviewText}`,
          },
        ],
      };
    }
  );
}

/**
 * Create the update_pr_description tool
 */
export function createUpdatePRDescriptionTool(callbacks: PMToolCallbacks) {
  const repoKeys = getAllRepoAgentIds().map((id) => id.replace('-agent', '')) as [
    string,
    ...string[],
  ];

  return tool(
    'update_pr_description',
    'Update the body/description of a pull request.',
    {
      repo_key: z.enum(repoKeys).describe('The repository'),
      pr_number: z.number().describe('The PR number'),
      body: z.string().describe('New PR description body'),
    },
    async (args) => {
      await callbacks.onUpdatePRDescription(args.repo_key, args.pr_number, args.body);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Updated description for PR #${args.pr_number}`,
          },
        ],
      };
    }
  );
}

/**
 * Create the add_pr_comment tool
 */
export function createAddPRCommentTool(callbacks: PMToolCallbacks) {
  const repoKeys = getAllRepoAgentIds().map((id) => id.replace('-agent', '')) as [
    string,
    ...string[],
  ];

  return tool(
    'add_pr_comment',
    'Add a general comment to a pull request.',
    {
      repo_key: z.enum(repoKeys).describe('The repository'),
      pr_number: z.number().describe('The PR number'),
      comment: z.string().describe('The comment text'),
    },
    async (args) => {
      await callbacks.onAddPRComment(args.repo_key, args.pr_number, args.comment);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Added comment to PR #${args.pr_number}`,
          },
        ],
      };
    }
  );
}

/**
 * Create the add_review_comment tool
 */
export function createAddReviewCommentTool(callbacks: PMToolCallbacks) {
  const repoKeys = getAllRepoAgentIds().map((id) => id.replace('-agent', '')) as [
    string,
    ...string[],
  ];

  return tool(
    'add_review_comment',
    'Add a comment on a specific line of code in a PR.',
    {
      repo_key: z.enum(repoKeys).describe('The repository'),
      pr_number: z.number().describe('The PR number'),
      path: z.string().describe('File path relative to repo root'),
      line: z.number().describe('Line number in the file'),
      comment: z.string().describe('The comment text'),
    },
    async (args) => {
      await callbacks.onAddReviewComment(
        args.repo_key,
        args.pr_number,
        args.path,
        args.line,
        args.comment
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: `Added review comment to ${args.path}:${args.line} on PR #${args.pr_number}`,
          },
        ],
      };
    }
  );
}

/**
 * Create the resolve_review_thread tool
 */
export function createResolveReviewThreadTool(callbacks: PMToolCallbacks) {
  const repoKeys = getAllRepoAgentIds().map((id) => id.replace('-agent', '')) as [
    string,
    ...string[],
  ];

  return tool(
    'resolve_review_thread',
    'Mark a review comment thread as resolved.',
    {
      repo_key: z.enum(repoKeys).describe('The repository'),
      pr_number: z.number().describe('The PR number'),
      thread_id: z.string().describe('The thread ID to resolve'),
    },
    async (args) => {
      await callbacks.onResolveReviewThread(args.repo_key, args.pr_number, args.thread_id);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Resolved review thread ${args.thread_id} on PR #${args.pr_number}`,
          },
        ],
      };
    }
  );
}

/**
 * Create the request_re_review tool
 */
export function createRequestReReviewTool(callbacks: PMToolCallbacks) {
  const repoKeys = getAllRepoAgentIds().map((id) => id.replace('-agent', '')) as [
    string,
    ...string[],
  ];

  return tool(
    'request_re_review',
    'Request reviewers to re-review the PR after changes.',
    {
      repo_key: z.enum(repoKeys).describe('The repository'),
      pr_number: z.number().describe('The PR number'),
    },
    async (args) => {
      await callbacks.onRequestReReview(args.repo_key, args.pr_number);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Requested re-review for PR #${args.pr_number}`,
          },
        ],
      };
    }
  );
}

/**
 * Create the trigger_merge_check tool
 *
 * Allows PM to manually trigger a merge check for all linked PRs.
 * Use when user asks to merge PRs or check if they're ready.
 */
export function createTriggerMergeCheckTool(callbacks: PMToolCallbacks) {
  return tool(
    'trigger_merge_check',
    'Check all linked PRs and merge them if ready (approved + CI passing + no conflicts). Use when user asks to merge or check PR status.',
    {},
    async () => {
      const result = await callbacks.onTriggerMergeCheck();

      const parts: string[] = [];
      if (result.merged.length > 0) {
        parts.push(`Merged: ${result.merged.join(', ')}`);
      }
      if (result.pending.length > 0) {
        parts.push(`Pending (waiting for approval/CI): ${result.pending.join(', ')}`);
      }
      if (result.conflicts.length > 0) {
        parts.push(`Conflicts (need resolution): ${result.conflicts.join(', ')}`);
      }

      const summary = parts.length > 0 ? parts.join('\n') : 'No linked PRs found.';

      return {
        content: [
          {
            type: 'text' as const,
            text: summary,
          },
        ],
      };
    }
  );
}

// ============================================================================
// MCP Server Creation
// ============================================================================

/**
 * Create an MCP server with PM agent tools
 */
export function createPMAgentMcpServer(callbacks: PMToolCallbacks) {
  return createSdkMcpServer({
    name: 'pm-agent-tools',
    version: '1.0.0',
    tools: [
      // Communication tools
      createSendMessageTool(callbacks),
      createPostToSlackTool(callbacks),
      createAssignTaskOwnerTool(callbacks),
      createReportCompletionTool(callbacks),
      createRequestEditModeTool(callbacks),
      // GitHub tools
      createPushBranchTool(callbacks),
      createPullRequestTool(callbacks),
      createGetPRStatusTool(callbacks),
      createGetPRReviewsTool(callbacks),
      createUpdatePRDescriptionTool(callbacks),
      createAddPRCommentTool(callbacks),
      createAddReviewCommentTool(callbacks),
      createResolveReviewThreadTool(callbacks),
      createRequestReReviewTool(callbacks),
      createTriggerMergeCheckTool(callbacks),
    ],
  });
}

/**
 * Create an MCP server with repo agent tools (Backend, Mobile)
 */
export function createRepoAgentMcpServer(callbacks: RepoAgentToolCallbacks) {
  return createSdkMcpServer({
    name: 'repo-agent-tools',
    version: '1.0.0',
    tools: [createSendMessageTool(callbacks), createLogFindingTool(callbacks)],
  });
}
