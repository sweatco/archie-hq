/**
 * Agent Tools — Co-located Definitions + Implementations
 *
 * Each tool is a self-contained function that imports what it needs directly.
 * Tools receive the Task instance for lifecycle/coordination only (stop, complete,
 * debouncedSave, metadata access). External systems (GitHub, Slack, persistence)
 * are imported directly — no pass-through via Task.
 *
 * Replaces: mcp/tools.ts (definitions) + task-runtime.ts closures (implementations)
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgentName, FindingType } from '../types/task.js';
import type { Task } from '../tasks/task.js';
import type { Agent } from './agent.js';
import { getRepoAgentIds, getAgentIds, getAgentDef } from './registry.js';
import { getGitHubClient } from '../connectors/github/client.js';
import { appendAgentFinding } from '../tasks/persistence.js';
import { triggerMergeCheck } from '../connectors/github/merge.js';
import { logger } from '../system/logger.js';

const execAsync = promisify(exec);

// ---- GitHub Types (moved here, re-exported for backward compat) ----

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

// ---- Tool creation helpers ----

function repoKeys(): [string, ...string[]] {
  return getRepoAgentIds().map((id) => id.replace('-agent', '')) as [string, ...string[]];
}

function allAgents(): [string, ...string[]] {
  return ['pm-agent', ...getAgentIds()] as [string, ...string[]];
}

// ---- Base tools (all agents) ----

function createSendMessageTool(agent: Agent, task: Task) {
  return tool(
    'send_message_to_agent',
    'Send a message to another agent and wait for their response. Use this to coordinate with peer agents.',
    {
      target: z.enum(allAgents()).describe('The agent to send the message to'),
      message: z.string().describe('The message content to send'),
    },
    async (args) => {
      const response = await task.toolSendMessage(agent.def.id as AgentName, args.target as AgentName, args.message);
      return { content: [{ type: 'text' as const, text: response }] };
    },
  );
}

function createLogFindingTool(agent: Agent, task: Task) {
  return tool(
    'log_finding',
    'Write an entry to the shared knowledge log. Use for discoveries, decisions, completions, or blockers.',
    {
      entry: z.string().describe('The finding or decision to log'),
      type: z.enum(['discovery', 'decision', 'completion', 'blocker']).describe('The type of entry'),
    },
    async (args) => {
      const agentName = agent.def.id as AgentName;
      const findingType = args.type as FindingType;
      if (findingType === 'decision') {
        logger.agentFinding(agentName, findingType, args.entry);
      } else {
        logger.agentFinding(agentName, findingType, args.entry, { truncate: 100 });
      }
      task.touch();
      await appendAgentFinding(task.taskId, agentName, args.entry, findingType);
      return { content: [{ type: 'text' as const, text: `Logged ${args.type}: ${args.entry}` }] };
    },
  );
}

// ---- PM-only tools ----

function createPostToSlackTool(agent: Agent, task: Task) {
  return tool(
    'post_to_slack',
    'Post a message to the Slack thread(s) associated with this task. Write naturally, like a human PM.',
    {
      message: z.string().describe('The message to post to Slack'),
    },
    async (args) => {
      const agentName = agent.def.id as AgentName;
      logger.agentToSlack(agentName, args.message);
      task.touch();
      await task.postToUser(args.message);
      await appendAgentFinding(task.taskId, agentName, `@user ${args.message}`);
      return { content: [{ type: 'text' as const, text: `Posted to user: ${args.message}` }] };
    },
  );
}

function createAssignTaskOwnerTool(agent: Agent, task: Task) {
  const taskOwnerAgents = getAgentIds() as [string, ...string[]];
  return tool(
    'assign_task_owner',
    'Assign a task owner who will lead the investigation. Call this before sending the initial assignment message.',
    {
      agent: z.enum(taskOwnerAgents).describe('The agent to assign as task owner'),
    },
    async (args) => {
      const agentName = agent.def.id as AgentName;
      const targetAgent = args.agent as AgentName;
      logger.agentAction(agentName, 'Assigning task owner', targetAgent);
      task.touch();

      task.metadata.task_owner = targetAgent;
      if (!task.metadata.participants.includes(targetAgent)) {
        task.metadata.participants.push(targetAgent);
      }
      task.debouncedSave();

      await appendAgentFinding(task.taskId, agentName, `Assigned ${targetAgent} as task owner`, 'decision');
      logger.system(`Task ${task.taskId} owner set to ${targetAgent}`);
      return { content: [{ type: 'text' as const, text: `Assigned ${targetAgent} as task owner.` }] };
    },
  );
}

function createRequestEditModeTool(agent: Agent, task: Task) {
  return tool(
    'request_edit_mode',
    'Request permission to make code changes. Call this AFTER explaining to the user what changes are needed and why. Task will pause until user approves or denies.',
    {
      reason: z.string().describe('Brief summary of what changes need to be made'),
    },
    async (args) => {
      const agentName = agent.def.id as AgentName;
      logger.agentAction(agentName, 'Requesting edit mode', args.reason);
      task.touch();

      await appendAgentFinding(task.taskId, 'system', `Edit mode requested: ${args.reason}`, 'decision');

      const blocks = [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Edit mode request:* ${args.reason}` },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Approve' },
              action_id: 'approve_edit_mode',
              value: task.taskId,
              style: 'primary',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Deny' },
              action_id: 'deny_edit_mode',
              value: task.taskId,
              style: 'danger',
            },
          ],
        },
      ];
      await task.postInteractiveToUser(`Edit mode request: ${args.reason}`, blocks);

      await task.stop();
      return { content: [{ type: 'text' as const, text: 'Edit mode request sent. Task paused pending user approval.' }] };
    },
  );
}

function createReportCompletionTool(agent: Agent, task: Task) {
  return tool(
    'report_completion',
    'Stop the task. If message is provided, post it to Slack first.',
    {
      message: z.string().optional().describe('Optional message to post to Slack before stopping'),
    },
    async (args) => {
      const agentName = agent.def.id as AgentName;
      if (args.message) {
        logger.agentToSlack(agentName, args.message);
        await task.postToUser(args.message);
        await appendAgentFinding(task.taskId, agentName, `@user ${args.message}`);
      }
      logger.agentAction(agentName, 'Reporting completion', '');
      task.touch();
      await appendAgentFinding(task.taskId, agentName, 'Task completed', 'completion');
      await task.complete();
      return {
        content: [{
          type: 'text' as const,
          text: args.message ? 'Posted message to Slack and stopped task.' : 'Stopped task.',
        }],
      };
    },
  );
}

function createGetAgentsStatusTool(agent: Agent, task: Task) {
  return tool(
    'get_agents_status',
    'Get the status of all agents for the current task.',
    {},
    async () => {
      const statuses = task.getAgentStatus();
      if (statuses.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No agents spawned yet.' }] };
      }
      const lines = statuses.map((s) => {
        const state = s.active ? 'active' : 'idle';
        const activity = s.last_activity ? ` (last activity: ${s.last_activity})` : '';
        return `- ${s.agent}: ${state}${activity}`;
      });
      return { content: [{ type: 'text' as const, text: `Agent statuses:\n${lines.join('\n')}` }] };
    },
  );
}

// ---- GitHub tools (PM only) ----

function createPushBranchTool(agent: Agent, task: Task) {
  return tool(
    'push_branch',
    'Push commits from the local worktree to the remote origin.',
    { repo_key: z.enum(repoKeys()).describe('The repository to push') },
    async (args) => {
      const agentName = agent.def.id as AgentName;
      logger.agentAction(agentName, 'Pushing branch', args.repo_key);

      const repoInfo = task.metadata.repositories[args.repo_key];
      if (!repoInfo?.worktree_path) {
        return { content: [{ type: 'text' as const, text: `Failed to push ${args.repo_key}: No worktree found for ${args.repo_key}` }] };
      }
      if (!repoInfo.feature_branch) {
        return { content: [{ type: 'text' as const, text: `Failed to push ${args.repo_key}: No feature branch found for ${args.repo_key}` }] };
      }

      try {
        const branch = repoInfo.feature_branch;
        await execAsync(`git push -u origin HEAD:${branch}`, { cwd: repoInfo.worktree_path });
        const message = `Pushed ${branch} to origin`;
        logger.system(`GitHub: ${message}`);
        return { content: [{ type: 'text' as const, text: `Successfully pushed ${args.repo_key}: ${message}` }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.error('task', `Failed to push ${args.repo_key}: ${message}`);
        return { content: [{ type: 'text' as const, text: `Failed to push ${args.repo_key}: ${message}` }] };
      }
    },
  );
}

function createPullRequestTool(agent: Agent, task: Task) {
  return tool(
    'create_pull_request',
    'Create a pull request on GitHub.',
    {
      repo_key: z.enum(repoKeys()).describe('The repository'),
      title: z.string().describe('PR title'),
      body: z.string().describe('PR description body'),
    },
    async (args) => {
      const agentName = agent.def.id as AgentName;
      logger.agentAction(agentName, 'Creating PR', `${args.repo_key}: ${args.title}`);

      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');

      const def = getAgentDef(`${args.repo_key}-agent`);
      if (!def?.repo) throw new Error(`No config found for repo key: ${args.repo_key}`);

      const repoInfo = task.metadata.repositories[args.repo_key];
      const head = repoInfo?.feature_branch || `feature/task-${task.taskId}`;
      const base = repoInfo?.base_branch || 'main';

      const result = await client.createPullRequest(def.repo.githubRepo, head, base, args.title, args.body);

      if (repoInfo) {
        repoInfo.pr_number = result.pr_number;
        task.debouncedSave();
      }

      await appendAgentFinding(task.taskId, agentName, `Created PR #${result.pr_number}: ${result.pr_url}`, 'decision');
      return { content: [{ type: 'text' as const, text: `Created PR #${result.pr_number}: ${result.pr_url}` }] };
    },
  );
}

function createGetPRStatusTool(agent: Agent, task: Task) {
  return tool(
    'get_pr_status',
    'Get the current status of a pull request.',
    {
      repo_key: z.enum(repoKeys()).describe('The repository'),
      pr_number: z.number().describe('The PR number'),
    },
    async (args) => {
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      const def = getAgentDef(`${args.repo_key}-agent`);
      if (!def?.repo) throw new Error(`No config found for repo key: ${args.repo_key}`);
      const status = await client.getPRStatus(def.repo.githubRepo, args.pr_number);
      return {
        content: [{
          type: 'text' as const,
          text: `PR #${args.pr_number} status:\n- State: ${status.state}\n- Mergeable: ${status.mergeable}\n- Mergeable State: ${status.mergeableState}\n- Approved: ${status.approved}`,
        }],
      };
    },
  );
}

function createGetPRReviewsTool(agent: Agent, task: Task) {
  return tool(
    'get_pr_reviews',
    'Get all reviews and comments on a pull request.',
    {
      repo_key: z.enum(repoKeys()).describe('The repository'),
      pr_number: z.number().describe('The PR number'),
    },
    async (args) => {
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      const def = getAgentDef(`${args.repo_key}-agent`);
      if (!def?.repo) throw new Error(`No config found for repo key: ${args.repo_key}`);
      const reviews = await client.getPRReviews(def.repo.githubRepo, args.pr_number);
      if (reviews.length === 0) {
        return { content: [{ type: 'text' as const, text: `No reviews found for PR #${args.pr_number}` }] };
      }
      const reviewText = reviews.map((r) => {
        let text = `- ${r.user} (${r.state}): ${r.body || '(no comment)'}`;
        if (r.comments.length > 0) {
          text += '\n  Comments:\n' + r.comments.map((c) => `    - ${c.path}:${c.line}: ${c.body}`).join('\n');
        }
        return text;
      }).join('\n');
      return { content: [{ type: 'text' as const, text: `Reviews for PR #${args.pr_number}:\n${reviewText}` }] };
    },
  );
}

function createUpdatePRDescriptionTool(agent: Agent, task: Task) {
  return tool(
    'update_pr_description',
    'Update the body/description of a pull request.',
    {
      repo_key: z.enum(repoKeys()).describe('The repository'),
      pr_number: z.number().describe('The PR number'),
      body: z.string().describe('New PR description body'),
    },
    async (args) => {
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      const def = getAgentDef(`${args.repo_key}-agent`);
      if (!def?.repo) throw new Error(`No config found for repo key: ${args.repo_key}`);
      await client.updatePRDescription(def.repo.githubRepo, args.pr_number, args.body);
      return { content: [{ type: 'text' as const, text: `Updated description for PR #${args.pr_number}` }] };
    },
  );
}

function createAddPRCommentTool(agent: Agent, task: Task) {
  return tool(
    'add_pr_comment',
    'Add a general comment to a pull request.',
    {
      repo_key: z.enum(repoKeys()).describe('The repository'),
      pr_number: z.number().describe('The PR number'),
      comment: z.string().describe('The comment text'),
    },
    async (args) => {
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      const def = getAgentDef(`${args.repo_key}-agent`);
      if (!def?.repo) throw new Error(`No config found for repo key: ${args.repo_key}`);
      await client.addPRComment(def.repo.githubRepo, args.pr_number, args.comment);
      return { content: [{ type: 'text' as const, text: `Added comment to PR #${args.pr_number}` }] };
    },
  );
}

function createAddReviewCommentTool(agent: Agent, task: Task) {
  return tool(
    'add_review_comment',
    'Add a comment on a specific line of code in a PR.',
    {
      repo_key: z.enum(repoKeys()).describe('The repository'),
      pr_number: z.number().describe('The PR number'),
      path: z.string().describe('File path relative to repo root'),
      line: z.number().describe('Line number in the file'),
      comment: z.string().describe('The comment text'),
    },
    async (args) => {
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      const def = getAgentDef(`${args.repo_key}-agent`);
      if (!def?.repo) throw new Error(`No config found for repo key: ${args.repo_key}`);
      await client.addReviewComment(def.repo.githubRepo, args.pr_number, args.path, args.line, args.comment);
      return { content: [{ type: 'text' as const, text: `Added review comment to ${args.path}:${args.line} on PR #${args.pr_number}` }] };
    },
  );
}

function createResolveReviewThreadTool(agent: Agent, task: Task) {
  return tool(
    'resolve_review_thread',
    'Mark a review comment thread as resolved.',
    {
      repo_key: z.enum(repoKeys()).describe('The repository'),
      pr_number: z.number().describe('The PR number'),
      thread_id: z.string().describe('The thread ID to resolve'),
    },
    async (args) => {
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      const def = getAgentDef(`${args.repo_key}-agent`);
      if (!def?.repo) throw new Error(`No config found for repo key: ${args.repo_key}`);
      await client.resolveReviewThread(def.repo.githubRepo, args.pr_number, args.thread_id);
      return { content: [{ type: 'text' as const, text: `Resolved review thread ${args.thread_id} on PR #${args.pr_number}` }] };
    },
  );
}

function createRequestReReviewTool(agent: Agent, task: Task) {
  return tool(
    'request_re_review',
    'Request reviewers to re-review the PR after changes.',
    {
      repo_key: z.enum(repoKeys()).describe('The repository'),
      pr_number: z.number().describe('The PR number'),
    },
    async (args) => {
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      const def = getAgentDef(`${args.repo_key}-agent`);
      if (!def?.repo) throw new Error(`No config found for repo key: ${args.repo_key}`);
      await client.requestReReview(def.repo.githubRepo, args.pr_number);
      return { content: [{ type: 'text' as const, text: `Requested re-review for PR #${args.pr_number}` }] };
    },
  );
}

function createTriggerMergeCheckTool(agent: Agent, task: Task) {
  return tool(
    'trigger_merge_check',
    'Check all linked PRs and merge them if ready.',
    {},
    async () => {
      const agentName = agent.def.id as AgentName;
      logger.agentAction(agentName, 'Triggering merge check', task.taskId);
      const result = await triggerMergeCheck(task.taskId);
      const parts: string[] = [];
      if (result.merged.length > 0) parts.push(`Merged: ${result.merged.join(', ')}`);
      if (result.pending.length > 0) parts.push(`Pending: ${result.pending.join(', ')}`);
      if (result.conflicts.length > 0) parts.push(`Conflicts: ${result.conflicts.join(', ')}`);
      return { content: [{ type: 'text' as const, text: parts.length > 0 ? parts.join('\n') : 'No linked PRs found.' }] };
    },
  );
}

// ---- MCP Server creation ----

/**
 * Create the MCP server with PM agent tools.
 */
export function createPMAgentMcpServer(agent: Agent, task: Task) {
  return createSdkMcpServer({
    name: 'pm-agent-tools',
    version: '1.0.0',
    tools: [
      createSendMessageTool(agent, task),
      createPostToSlackTool(agent, task),
      createAssignTaskOwnerTool(agent, task),
      createReportCompletionTool(agent, task),
      createRequestEditModeTool(agent, task),
      createGetAgentsStatusTool(agent, task),
      createPushBranchTool(agent, task),
      createPullRequestTool(agent, task),
      createGetPRStatusTool(agent, task),
      createGetPRReviewsTool(agent, task),
      createUpdatePRDescriptionTool(agent, task),
      createAddPRCommentTool(agent, task),
      createAddReviewCommentTool(agent, task),
      createResolveReviewThreadTool(agent, task),
      createRequestReReviewTool(agent, task),
      createTriggerMergeCheckTool(agent, task),
    ],
  });
}

/**
 * Create the MCP server with base agent tools (repo + plugin agents).
 */
export function createBaseAgentMcpServer(agent: Agent, task: Task) {
  return createSdkMcpServer({
    name: 'repo-agent-tools',
    version: '1.0.0',
    tools: [
      createSendMessageTool(agent, task),
      createLogFindingTool(agent, task),
    ],
  });
}
