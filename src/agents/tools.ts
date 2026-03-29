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
import { getAgentIds } from './registry.js';
import { getGitHubClient } from '../connectors/github/client.js';
import { gitExec } from '../connectors/github/repo-clone.js';
import { mirrorLegacyFields, hydrateBranchState, findBranchStateByPR } from '../connectors/github/branch-state.js';
import { appendAgentFinding } from '../tasks/persistence.js';
import { logger } from '../system/logger.js';

// Re-export branch state helpers for consumers that import from tools.ts
export { mirrorLegacyFields, hydrateBranchState, findBranchStateByPR };

const execAsync = promisify(exec);

// ---- Tool result helpers ----

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const err = (text: string) => ({ content: [{ type: 'text' as const, text: `Error: ${text}` }] });

/**
 * Find stash index by message name in `git stash list` output.
 */
function findStashIndex(stashList: string, stashName: string): number | null {
  const lines = stashList.split('\n');
  for (const line of lines) {
    if (line.includes(stashName)) {
      const match = line.match(/^stash@\{(\d+)\}/);
      if (match) return parseInt(match[1], 10);
    }
  }
  return null;
}

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
      await task.postToUser(args.message, agentName);
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
      await task.postInteractiveToUser(`Edit mode request: ${args.reason}`, blocks, 'edit_mode');

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
        await task.postToUser(args.message, agentName);
      }
      logger.agentAction(agentName, 'Reporting completion', '');
      task.touch();
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

function createMuteThreadTool(agent: Agent, task: Task) {
  return tool(
    'mute_thread',
    'Unsubscribe from the current Slack thread. Messages will be ignored until someone @mentions the bot again. Posts a notification to the thread.',
    {},
    async () => {
      const agentName = agent.def.id as AgentName;
      logger.agentAction(agentName, 'Muting thread', '');
      task.touch();

      // Mute all Slack channels
      let mutedCount = 0;
      for (const ch of Object.values(task.metadata.channels)) {
        if (ch.type === 'slack' && !ch.muted) {
          (ch as import('../types/task.js').SlackChannel).muted = true;
          mutedCount++;
        }
      }

      if (mutedCount === 0) {
        return ok('No active Slack threads to mute.');
      }

      task.debouncedSave();
      await appendAgentFinding(task.taskId, agentName, 'Muted Slack thread — will not process messages until next @mention', 'decision');

      // Notify the thread
      await task.postToUser("I'll step back from this thread. Mention me again when you need me.", agentName);

      return ok(`Muted ${mutedCount} Slack thread(s). Will resume on next @mention.`);
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

// ---- GitHub tools (repo agents in edit mode) ----

function createPushBranchTool(agent: Agent, task: Task) {
  const repoKey = agent.def.repo!.repoKey;
  return tool(
    'push_branch',
    'Push commits from the local clone to the remote origin.',
    {},
    async () => {
      const agentName = agent.def.id as AgentName;
      logger.agentAction(agentName, 'Pushing branch', repoKey);

      const repoInfo = task.metadata.repositories[repoKey];
      if (!repoInfo?.clone_path) {
        return err('No clone found');
      }

      const branch = repoInfo.current_branch;
      const state = branch ? repoInfo.branch_states?.[branch] : undefined;

      if (!branch || !state) {
        return err('No branch to push');
      }

      try {
        await execAsync(`git push -u origin HEAD:${branch}`, { cwd: repoInfo.clone_path });

        mirrorLegacyFields(repoInfo);
        task.debouncedSave();

        const message = `Pushed ${branch} to origin`;
        logger.system(`GitHub: ${message}`);
        return ok(`Successfully pushed: ${message}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.error('task', `Failed to push: ${message}`);
        return err(`Failed to push: ${message}`);
      }
    },
  );
}

function createPullRequestTool(agent: Agent, task: Task) {
  const repoKey = agent.def.repo!.repoKey;
  const githubRepo = agent.def.repo!.githubRepo;
  return tool(
    'create_pull_request',
    'Create a pull request on GitHub.',
    {
      title: z.string().describe('PR title'),
      body: z.string().describe('PR description body'),
    },
    async (args) => {
      const agentName = agent.def.id as AgentName;
      logger.agentAction(agentName, 'Creating PR', args.title);

      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');

      const repoInfo = task.metadata.repositories[repoKey];
      const branch = repoInfo?.current_branch;
      const state = branch ? repoInfo?.branch_states?.[branch] : undefined;
      const head = branch || `feature/task-${task.taskId}`;
      const base = state?.base_branch || 'main';

      const result = await client.createPullRequest(githubRepo, head, base, args.title, args.body);

      if (state) {
        state.pr_number = result.pr_number;
      }
      if (repoInfo) {
        mirrorLegacyFields(repoInfo);
        task.debouncedSave();
      }

      await appendAgentFinding(task.taskId, agentName, `Created PR #${result.pr_number}: ${result.pr_url}`, 'decision');
      return ok(`Created PR #${result.pr_number}: ${result.pr_url}`);
    },
  );
}

function createGetPRStatusTool(agent: Agent, task: Task) {
  const githubRepo = agent.def.repo!.githubRepo;
  return tool(
    'get_pr_status',
    'Get the current status of a pull request.',
    { pr_number: z.number().describe('The PR number') },
    async (args) => {
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      const status = await client.getPRStatus(githubRepo, args.pr_number);
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
  const githubRepo = agent.def.repo!.githubRepo;
  return tool(
    'get_pr_reviews',
    'Get all reviews and comments on a pull request.',
    { pr_number: z.number().describe('The PR number') },
    async (args) => {
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      const reviews = await client.getPRReviews(githubRepo, args.pr_number);
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

function createListPRsTool(agent: Agent, task: Task) {
  const githubRepo = agent.def.repo!.githubRepo;
  return tool(
    'list_prs',
    'List pull requests with optional filters.',
    {
      state: z.enum(['open', 'closed', 'all']).optional().describe('PR state filter (default: open)'),
      base: z.string().optional().describe('Filter by base branch (e.g. "main")'),
      sort: z.enum(['created', 'updated', 'popularity', 'long-running']).optional().describe('Sort field (default: updated)'),
      limit: z.number().optional().describe('Max results to return (default: 10)'),
    },
    async (args) => {
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      const prs = await client.listPRs(githubRepo, {
        state: args.state,
        base: args.base,
        sort: args.sort,
        per_page: args.limit,
      });
      if (prs.length === 0) {
        return ok('No PRs found matching the filters.');
      }
      const lines = prs.map((pr) =>
        `#${pr.number} [${pr.state}] ${pr.title} (${pr.head} → ${pr.base}) by ${pr.author} — ${pr.url}`
      );
      return ok(lines.join('\n'));
    },
  );
}

function createGetPRTool(agent: Agent, task: Task) {
  const githubRepo = agent.def.repo!.githubRepo;
  return tool(
    'get_pr',
    'Get full PR details: title, description, diff, state, and branches.',
    { pr_number: z.number().describe('The PR number') },
    async (args) => {
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      const pr = await client.getPRDetails(githubRepo, args.pr_number);
      const text = [
        `PR #${pr.number}: ${pr.title}`,
        `State: ${pr.state} | ${pr.head} → ${pr.base}`,
        `URL: ${pr.url}`,
        '',
        '--- Description ---',
        pr.body || '(no description)',
        '',
        '--- Diff ---',
        pr.diff,
      ].join('\n');
      return ok(text);
    },
  );
}

function createUpdatePRTool(agent: Agent, task: Task) {
  const githubRepo = agent.def.repo!.githubRepo;
  return tool(
    'update_pr',
    'Update the title and/or description of a pull request. Both fields are optional — include only what needs to change.',
    {
      pr_number: z.number().describe('The PR number'),
      title: z.string().optional().describe('New PR title'),
      body: z.string().optional().describe('New PR description body'),
    },
    async (args) => {
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      await client.updatePR(githubRepo, args.pr_number, { title: args.title, body: args.body });
      return { content: [{ type: 'text' as const, text: `Updated PR #${args.pr_number}` }] };
    },
  );
}

function createAddPRCommentTool(agent: Agent, task: Task) {
  const githubRepo = agent.def.repo!.githubRepo;
  return tool(
    'add_pr_comment',
    'Add a general comment to a pull request.',
    {
      pr_number: z.number().describe('The PR number'),
      comment: z.string().describe('The comment text'),
    },
    async (args) => {
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      await client.addPRComment(githubRepo, args.pr_number, args.comment);
      return { content: [{ type: 'text' as const, text: `Added comment to PR #${args.pr_number}` }] };
    },
  );
}

function createAddReviewCommentTool(agent: Agent, task: Task) {
  const githubRepo = agent.def.repo!.githubRepo;
  return tool(
    'add_review_comment',
    'Add a comment on a specific line of code in a PR.',
    {
      pr_number: z.number().describe('The PR number'),
      path: z.string().describe('File path relative to repo root'),
      line: z.number().describe('Line number in the file'),
      comment: z.string().describe('The comment text'),
    },
    async (args) => {
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      await client.addReviewComment(githubRepo, args.pr_number, args.path, args.line, args.comment);
      return { content: [{ type: 'text' as const, text: `Added review comment to ${args.path}:${args.line} on PR #${args.pr_number}` }] };
    },
  );
}

function createResolveReviewThreadTool(agent: Agent, task: Task) {
  const githubRepo = agent.def.repo!.githubRepo;
  return tool(
    'resolve_review_thread',
    'Mark a review comment thread as resolved.',
    {
      pr_number: z.number().describe('The PR number'),
      thread_id: z.string().describe('The thread ID to resolve'),
    },
    async (args) => {
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      await client.resolveReviewThread(githubRepo, args.pr_number, args.thread_id);
      return { content: [{ type: 'text' as const, text: `Resolved review thread ${args.thread_id} on PR #${args.pr_number}` }] };
    },
  );
}

function createRequestReReviewTool(agent: Agent, task: Task) {
  const githubRepo = agent.def.repo!.githubRepo;
  return tool(
    'request_re_review',
    'Request reviewers to re-review the PR after changes.',
    { pr_number: z.number().describe('The PR number') },
    async (args) => {
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      await client.requestReReview(githubRepo, args.pr_number);
      return { content: [{ type: 'text' as const, text: `Requested re-review for PR #${args.pr_number}` }] };
    },
  );
}


function createMergePRTool(agent: Agent, task: Task) {
  const githubRepo = agent.def.repo!.githubRepo;
  return tool(
    'merge_pull_request',
    'Merge a pull request. Checks mergeability first and returns the current status if not ready.',
    { pr_number: z.number().describe('The PR number') },
    async (args) => {
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');

      const status = await client.getPRStatus(githubRepo, args.pr_number);
      if (status.state !== 'open') {
        return { content: [{ type: 'text' as const, text: `Cannot merge: PR #${args.pr_number} is ${status.state}` }] };
      }
      if (!status.mergeable || status.mergeableState !== 'clean') {
        return { content: [{ type: 'text' as const, text: `Cannot merge: PR #${args.pr_number} is not ready (mergeable=${status.mergeable}, state=${status.mergeableState})` }] };
      }

      const result = await client.mergePullRequest(githubRepo, args.pr_number);
      return { content: [{ type: 'text' as const, text: result.message }] };
    },
  );
}

function createClosePRTool(agent: Agent, task: Task) {
  const githubRepo = agent.def.repo!.githubRepo;
  return tool(
    'close_pull_request',
    'Close a pull request without merging.',
    { pr_number: z.number().describe('The PR number') },
    async (args) => {
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      await client.closePullRequest(githubRepo, args.pr_number);
      return { content: [{ type: 'text' as const, text: `Closed PR #${args.pr_number}` }] };
    },
  );
}

// ---- Git workflow tools (repo agents) ----

function createFetchTool(agent: Agent, task: Task) {
  const repoKey = agent.def.repo!.repoKey;
  return tool(
    'fetch',
    'Fetch latest refs from origin.',
    {},
    async () => {
      const repoInfo = task.metadata.repositories[repoKey];
      const clonePath = repoInfo?.clone_path;
      if (!clonePath) return err('No clone path');
      await gitExec(clonePath, 'fetch origin');
      return ok('Fetched latest from origin');
    },
  );
}

function createSwitchBranchTool(agent: Agent, task: Task) {
  const repoKey = agent.def.repo!.repoKey;
  return tool(
    'switch_branch',
    'Switch to a different branch. Fetches latest, auto-stashes dirty work, auto-pops on return.',
    {
      branch: z.string().describe('Branch name to switch to'),
    },
    async (args) => {
      const repoInfo = task.metadata.repositories[repoKey];
      const clonePath = repoInfo.clone_path;
      if (!clonePath) return err('No clone available');

      const branch = args.branch;
      const currentBranch = repoInfo.current_branch;

      // 1. Fetch branch into clone
      await gitExec(clonePath, `fetch origin ${branch}`).catch(() => {});

      // 2. Auto-stash if dirty
      const status = await gitExec(clonePath, 'status --porcelain');
      if (status.trim()) {
        const stashName = `archie:${task.taskId}:${currentBranch}`;
        await gitExec(clonePath, `stash push --include-untracked -m "${stashName}"`);
        if (currentBranch && repoInfo.branch_states?.[currentBranch]) {
          repoInfo.branch_states[currentBranch].stash_name = stashName;
        }
      }

      // 3. Checkout — always normal (shared clones have no branch conflicts)
      try {
        await gitExec(clonePath, `checkout ${branch}`);
      } catch {
        // Branch doesn't exist locally yet — track remote
        await gitExec(clonePath, `checkout -b ${branch} origin/${branch}`);
      }

      // 4. Track branch state
      repoInfo.branch_states ??= {};
      if (!repoInfo.branch_states[branch]) {
        repoInfo.branch_states[branch] = {};
      }

      // 5. Update current_branch
      repoInfo.current_branch = branch;

      // 7. Auto-pop stash if exists for target branch
      const targetState = repoInfo.branch_states[branch];
      if (targetState?.stash_name) {
        const stashList = await gitExec(clonePath, 'stash list');
        const stashIndex = findStashIndex(stashList, targetState.stash_name);
        if (stashIndex !== null) {
          await gitExec(clonePath, `stash pop stash@{${stashIndex}}`);
        }
        targetState.stash_name = undefined;
      }

      mirrorLegacyFields(repoInfo);
      task.debouncedSave();
      return ok(`Switched to ${branch}`);
    },
  );
}

function createCreateBranchTool(agent: Agent, task: Task) {
  const repoKey = agent.def.repo!.repoKey;
  return tool(
    'create_branch',
    'Create a new branch and switch to it. Branch name is auto-generated from the task ID. Returns the full branch name.',
    {
      base: z.string().optional().describe('Base branch or commit (default: current HEAD)'),
    },
    async (args) => {
      const repoInfo = task.metadata.repositories[repoKey];
      if (!repoInfo?.clone_path) return err('No clone');

      // Count existing branches to generate unique name
      const existing = Object.keys(repoInfo.branch_states || {}).length;
      const branchName = existing === 0
        ? `feature/${task.taskId}`
        : `feature/${task.taskId}-${existing + 1}`;

      const base = args.base || 'HEAD';
      await gitExec(repoInfo.clone_path, `checkout -b ${branchName} ${base}`);

      repoInfo.branch_states ??= {};
      repoInfo.branch_states[branchName] = {};
      repoInfo.current_branch = branchName;
      mirrorLegacyFields(repoInfo);
      task.debouncedSave();
      return ok(`Created and switched to ${branchName}`);
    },
  );
}

function createListBranchesTool(agent: Agent, task: Task) {
  const repoKey = agent.def.repo!.repoKey;
  return tool(
    'list_branches',
    'List branches created or visited by this agent in the current task.',
    {},
    async () => {
      const repoInfo = task.metadata.repositories[repoKey];
      const current = repoInfo?.current_branch || '(unknown)';
      const states = repoInfo?.branch_states || {};
      const branches = Object.entries(states)
        .map(([name, s]) => `${name}${s.pr_number ? ` (PR #${s.pr_number})` : ''}`);
      const lines = [
        `Current: ${current}`,
        `Branches: ${branches.join(', ') || '(none)'}`,
      ];
      return ok(lines.join('\n'));
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
      createMuteThreadTool(agent, task),
    ],
  });
}

/**
 * Create the MCP server with all repo agent tools (git, PR, branch).
 * Access is controlled by allowedTools in spawn.ts, not by server registration.
 */
export function createRepoToolsMcpServer(agent: Agent, task: Task) {
  return createSdkMcpServer({
    name: 'repo-tools',
    version: '1.0.0',
    tools: [
      // Git workflow
      createFetchTool(agent, task),
      createSwitchBranchTool(agent, task),
      createCreateBranchTool(agent, task),
      createListBranchesTool(agent, task),
      // PR read
      createListPRsTool(agent, task),
      createGetPRTool(agent, task),
      createGetPRStatusTool(agent, task),
      createGetPRReviewsTool(agent, task),
      // PR write
      createPushBranchTool(agent, task),
      createPullRequestTool(agent, task),
      createUpdatePRTool(agent, task),
      createAddPRCommentTool(agent, task),
      createAddReviewCommentTool(agent, task),
      createResolveReviewThreadTool(agent, task),
      createRequestReReviewTool(agent, task),
      createMergePRTool(agent, task),
      createClosePRTool(agent, task),
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
