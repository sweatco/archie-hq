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
import { appendAgentFinding, appendArtifactShared } from '../tasks/persistence.js';
import { copyArtifactToShared, assertReadable } from './artifacts.js';
import { launchTask } from '../tasks/launch.js';
import { logger } from '../system/logger.js';
import { SLACK_MARKDOWN_LIMIT, SlackMarkdownLimitError } from '../connectors/slack/client.js';

function formatSlackSendError(err: unknown): string {
  if (err instanceof SlackMarkdownLimitError) {
    return (
      `Slack rejected the message: ${err.actualLength} chars exceeds the ${SLACK_MARKDOWN_LIMIT}-char per-message limit. ` +
      `Nothing was delivered or logged. Split the content into multiple messages under the limit, ` +
      `breaking on paragraphs and keeping code blocks/tables whole.`
    );
  }
  const reason = err instanceof Error ? err.message : String(err);
  return `Failed to post message: ${reason}`;
}
import { findSlackUsers, findSlackChannels } from '../connectors/slack/client.js';
import { scheduleReminder, cancelReminder } from '../system/reminder-scheduler.js';
import * as chrono from 'chrono-node';

// Re-export branch state helpers for consumers that import from tools.ts
export { mirrorLegacyFields, hydrateBranchState, findBranchStateByPR };

const execAsync = promisify(exec);

// ---- Tool result helpers ----

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const err = (text: string) => ({ content: [{ type: 'text' as const, text: `Error: ${text}` }] });

/**
 * Get the agent's sandbox config. Populated by `spawnAgent` before any tool
 * runs; throws if a tool somehow executes before spawn (programmer error).
 */
function requireSandbox(agent: Agent) {
  if (!agent.sandbox) {
    throw new Error(`Agent ${agent.def.id} has no sandbox config — was it spawned?`);
  }
  return agent.sandbox;
}

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

export interface PRReview {
  id: string;
  user: string;
  state: 'approved' | 'changes_requested' | 'commented';
  body: string;
  submittedAt: string;
}

export interface ReviewThreadComment {
  commentId: number;
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export interface ReviewThread {
  threadId: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  comments: ReviewThreadComment[];
}

export interface PRComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export type CheckConclusion =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'timed_out'
  | 'neutral'
  | 'action_required'
  | 'skipped'
  | 'stale'
  | null;

export interface PRCheckEntry {
  source: 'check_run' | 'status';
  name: string;
  app: string;
  status: string;
  conclusion: CheckConclusion;
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
  output?: {
    title?: string;
    summary?: string;
    text?: string;
  };
}

export interface PRChecksReport {
  headSha: string;
  entries: PRCheckEntry[];
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

function createShareArtifactTool(agent: Agent, task: Task) {
  return tool(
    'share_artifact',
    'Share a document (plan, report, diff, or any longer output) with OTHER AGENTS by publishing an immutable snapshot to the task\'s shared artifacts folder. ' +
    'This is for inter-agent sharing only — to deliver a file to the user, use `post_files_to_user`. ' +
    'The tool COPIES the file — your local file is left in place, and the published copy is read-only and never updated. ' +
    'Pass an absolute path to a file inside your readable sandbox; the tool returns the absolute path of the immutable copy under shared/artifacts/, which you should send in `send_message_to_agent` instead of pasting the document body. ' +
    'Identical content is deduped by hash — re-sharing the same bytes returns the existing snapshot path. To publish revisions, edit your local file and call share_artifact again — each call creates a new versioned snapshot, preserving history.',
    {
      path: z.string().describe('Absolute path to the file you want to share'),
      description: z.string().describe('Short description of what the artifact contains; logged for other agents'),
    },
    async (args) => {
      const agentName = agent.def.id as AgentName;
      let resolvedSource: string;
      try {
        resolvedSource = await assertReadable(args.path, requireSandbox(agent));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
      let copyResult;
      try {
        copyResult = await copyArtifactToShared(task.taskId, resolvedSource);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
      task.touch();
      await appendArtifactShared(task.taskId, agentName, copyResult.artifactPath, args.description);
      const verb = copyResult.reused ? 'Already shared' : 'Shared immutable snapshot';
      return ok(`${verb} at ${copyResult.artifactPath}. This is a read-only copy — other agents can Read it but it will never be updated. To publish revisions, edit your local file and call share_artifact again. Logged to knowledge log.`);
    },
  );
}

// ---- PM-only tools ----

function createPostToUserTool(agent: Agent, task: Task) {
  return tool(
    'post_to_user',
    'Send a message to the user. Without target, posts to the default channel. ' +
    'Use target.channel to post to a specific linked thread. ' +
    'Use target.new_dm with a user ID to start a DM conversation (links it to this task). ' +
    'Use target.new_thread with a channel ID to start a new thread in a channel (links it to this task). ' +
    'When creating new DMs/threads, returns the channel key for future use. ' +
    'To attach files, send the message first, then call `post_files_to_user` with the same target.',
    {
      message: z.string().describe('The message to send'),
      target: z.object({
        channel: z.string().optional().describe('Channel key of an existing linked thread (e.g., "slack:C123:456.789")'),
        new_dm: z.string().optional().describe('User ID to start a new DM conversation with'),
        new_thread: z.string().optional().describe('Channel ID to start a new thread in'),
      }).optional().describe('Where to post. Omit to post to the default channel.'),
    },
    async (args) => {
      const agentName = agent.def.id as AgentName;
      const hasTarget = !!(args.target?.channel || args.target?.new_dm || args.target?.new_thread);
      if (!hasTarget && Object.keys(task.metadata.channels).length === 0) {
        return ok(
          'No channel linked to this task. Use target.new_dm <userId> or target.new_thread <channelId> ' +
          'to open a destination, or call report_completion() without a message to finish silently.'
        );
      }
      task.touch();
      let newChannelKey: string | null;
      try {
        newChannelKey = await task.postToUser(args.message, agentName, args.target);
      } catch (e) {
        return ok(formatSlackSendError(e));
      }
      if (newChannelKey) {
        return ok(`Message posted. New channel linked: ${newChannelKey} (saved in task metadata for future use)`);
      }
      return ok('Message posted.');
    },
  );
}

function createPostFilesToUserTool(agent: Agent, task: Task) {
  return tool(
    'post_files_to_user',
    'Upload one or more files as Slack file attachments to the user. Files must point to absolute paths inside your readable sandbox (e.g. shared/artifacts/...). ' +
    'Without `channel`, attaches to the default channel. With `channel`, attaches to an already-linked thread. ' +
    'This tool only attaches files to existing threads — it does not create new threads or DMs. To open a destination, call `post_to_user` first with `target.new_dm` or `target.new_thread`, then pass the returned channel key here. ' +
    'Files are sent without accompanying text — call `post_to_user` separately for any message you want next to the files.',
    {
      paths: z.array(z.string()).min(1).describe('Absolute file paths to upload as Slack attachments'),
      channel: z.string().optional().describe('Channel key of an existing linked thread (e.g., "slack:C123:456.789"). Omit to post to the default channel.'),
    },
    async (args) => {
      const agentName = agent.def.id as AgentName;
      if (!args.channel && Object.keys(task.metadata.channels).length === 0) {
        return ok(
          'No channel linked to this task. Open one first with post_to_user(target.new_dm or target.new_thread), then call post_files_to_user with the returned channel key.'
        );
      }
      let validatedPaths: string[];
      try {
        const sandbox = requireSandbox(agent);
        validatedPaths = await Promise.all(args.paths.map((p) => assertReadable(p, sandbox)));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
      task.touch();
      try {
        await task.postFilesToUser(validatedPaths, agentName, args.channel);
      } catch (e) {
        return ok(formatSlackSendError(e));
      }
      return ok(`${validatedPaths.length} file(s) uploaded.`);
    },
  );
}

function createFindSlackUserTool(_agent: Agent, _task: Task) {
  return tool(
    'find_slack_user',
    'Find a Slack user by name or ID. Returns matching users with their details. Use this to find user IDs before sending DMs.',
    {
      query: z.string().describe('User ID (e.g., "U1234567") or name/part of name to search for'),
    },
    async (args) => {
      const matches = await findSlackUsers(args.query);
      if (matches.length === 0) return ok('No users found matching that query.');
      const list = matches.slice(0, 10).map(u => {
        const parts = [`${u.realName} (@${u.name}) — ID: ${u.id}`];
        if (u.title) parts.push(`  Title: ${u.title}`);
        if (u.tz) parts.push(`  Timezone (IANA): ${u.tz}`);
        if (u.timezone) parts.push(`  Timezone (label): ${u.timezone}`);
        if (u.displayName && u.displayName !== u.realName) parts.push(`  Display name: ${u.displayName}`);
        return `- ${parts.join('\n')}`;
      }).join('\n');
      return ok(`Found ${matches.length} user(s):\n${list}`);
    },
  );
}

function createFindSlackChannelTool(_agent: Agent, _task: Task) {
  return tool(
    'find_slack_channel',
    'Find a Slack channel by name or ID. Returns matching channels with their details. Use this to find channel IDs before posting to new threads.',
    {
      query: z.string().describe('Channel ID (e.g., "C1234567"), or channel name/part of name to search for (with or without #)'),
    },
    async (args) => {
      const matches = await findSlackChannels(args.query);
      if (matches.length === 0) return ok('No channels found matching that query.');
      const list = matches.slice(0, 10).map(ch => {
        const parts = [`#${ch.name} — ID: ${ch.id} (${ch.memberCount} members)`];
        if (ch.topic) parts.push(`  Topic: ${ch.topic}`);
        if (ch.purpose) parts.push(`  Purpose: ${ch.purpose}`);
        if (ch.isPrivate) parts.push(`  Private channel`);
        return `- ${parts.join('\n')}`;
      }).join('\n');
      return ok(`Found ${matches.length} channel(s):\n${list}`);
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
      // Idempotency: if the task is already completing/completed, skip side-effects.
      // Prevents duplicate Slack posts when the agent retries after a stream-closed error
      // (the previous complete() tore down the agent mid-response, so the retry is spurious).
      if (!task.isActive) {
        return ok('Task already completed.');
      }
      if (args.message) {
        if (Object.keys(task.metadata.channels).length === 0) {
          return ok(
            'Cannot post a completion message — no channel linked. ' +
            'Either open a destination via post_to_user(target.new_dm/new_thread) first, ' +
            'or call report_completion() without a message to finish silently.'
          );
        }
        try {
          await task.postToUser(args.message, agentName);
        } catch (err) {
          // Surface the error to the agent so it can retry (e.g. split the
          // message). Do NOT complete the task — completion only proceeds
          // after a successful post (or no message at all).
          return ok(formatSlackSendError(err));
        }
      }
      logger.agentAction(agentName, 'Reporting completion', '');
      task.touch();
      // Run complete() on next tick so this tool response streams back to the agent
      // before the runtime tears it down. Without this, the response is lost and the
      // agent's SDK reports "stream closed", causing a retry loop.
      setImmediate(() => {
        task.complete().catch((err) =>
          logger.error('report_completion', 'Error completing task', err)
        );
      });
      return ok(args.message ? 'Posted message to Slack and stopped task.' : 'Stopped task.');
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

function createLaunchTaskTool(_agent: Agent, task: Task) {
  return tool(
    'launch_task',
    'Launch a new independent task that runs in the background. Use for fire-and-forget ' +
    'work that should not block the current conversation. The launched task starts with no ' +
    'channel — its own PM will decide whether to ping someone (DM, new thread) or complete ' +
    'silently based on the task. Cannot be called from a task that has no channel of its own.',
    {
      prompt: z.string().describe('The task prompt for the launched PM agent'),
      reason: z.string().describe('Why this task is being launched (shown to the new PM and in the notification)'),
    },
    async (args) => {
      try {
        const { newTaskId, notifiedInChannel } = await launchTask(task, args.prompt, args.reason);
        return ok(
          notifiedInChannel
            ? `Task ${newTaskId} launched. User was already notified in the current channel — do not repost.`
            : `Task ${newTaskId} launched. No channel notified.`
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return ok(`Failed to launch task: ${msg}`);
      }
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
      const base = state?.base_branch || agent.def.repo!.baseBranch || 'main';

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

function createGetPRChecksTool(agent: Agent, task: Task) {
  const githubRepo = agent.def.repo!.githubRepo;
  return tool(
    'get_pr_checks',
    'List CI checks (check-runs + legacy commit statuses) attached to a PR\'s HEAD commit. Returns conclusion, URL, and — for failed checks — the full output (title/summary/text). Use this when a "checks updated" event arrives or get_pr_status reports mergeableState=unstable, to find which specific check broke.',
    { pr_number: z.number().describe('The PR number') },
    async (args) => {
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      const report = await client.listPRChecks(githubRepo, args.pr_number);
      if (report.entries.length === 0) {
        return ok(`No checks found for PR #${args.pr_number} (head ${report.headSha.slice(0, 7)}).`);
      }

      const FAILED_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required']);
      const lines: string[] = [
        `Checks for PR #${args.pr_number} (head ${report.headSha.slice(0, 7)}):`,
      ];

      for (const entry of report.entries) {
        const state = entry.conclusion ?? entry.status;
        const urlPart = entry.url ? ` — ${entry.url}` : '';
        lines.push(`- [${state}] ${entry.name} (${entry.app})${urlPart}`);
      }

      const failed = report.entries.filter(
        (e) => e.conclusion && FAILED_CONCLUSIONS.has(e.conclusion) && e.output
      );
      for (const entry of failed) {
        const blocks: string[] = ['', `${entry.name} output:`];
        if (entry.output?.title) blocks.push(`title: ${entry.output.title}`);
        if (entry.output?.summary) {
          blocks.push('summary:');
          blocks.push(entry.output.summary);
        }
        if (entry.output?.text) {
          blocks.push('text:');
          blocks.push(entry.output.text);
        }
        lines.push(blocks.join('\n'));
      }

      return ok(lines.join('\n'));
    },
  );
}

function createGetPRReviewsTool(agent: Agent, task: Task) {
  const githubRepo = agent.def.repo!.githubRepo;
  return tool(
    'get_pr_reviews',
    'Get review-level summary for a PR (approvals, change requests, review bodies). For line-level comments, use get_review_threads.',
    { pr_number: z.number().describe('The PR number') },
    async (args) => {
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      const reviews = await client.getPRReviews(githubRepo, args.pr_number);
      if (reviews.length === 0) {
        return ok(`No reviews found for PR #${args.pr_number}`);
      }
      const lines = reviews.map((r) =>
        `- ${r.user} [${r.state}] @ ${r.submittedAt}: ${r.body || '(no body)'}`
      );
      return ok(`Reviews for PR #${args.pr_number}:\n${lines.join('\n')}`);
    },
  );
}

function createGetPRCommentsTool(agent: Agent, task: Task) {
  const githubRepo = agent.def.repo!.githubRepo;
  return tool(
    'get_pr_comments',
    'Get top-level PR conversation comments (the "Conversation" tab). Does not include line-level review comments — use get_review_threads for those.',
    { pr_number: z.number().describe('The PR number') },
    async (args) => {
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      const comments = await client.getPRComments(githubRepo, args.pr_number);
      if (comments.length === 0) {
        return ok(`No conversation comments on PR #${args.pr_number}`);
      }
      const lines = comments.map((c) =>
        `- [comment_id=${c.id}] ${c.author} @ ${c.createdAt}: ${c.body}`
      );
      return ok(`Comments on PR #${args.pr_number}:\n${lines.join('\n')}`);
    },
  );
}

function createGetReviewThreadsTool(agent: Agent, task: Task) {
  const githubRepo = agent.def.repo!.githubRepo;
  return tool(
    'get_review_threads',
    'Get every review thread on a PR with its thread_id (for resolve_review_thread) and each comment\'s comment_id (for reply_to_review_comment).',
    { pr_number: z.number().describe('The PR number') },
    async (args) => {
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      const threads = await client.getReviewThreads(githubRepo, args.pr_number);
      if (threads.length === 0) {
        return ok(`No review threads on PR #${args.pr_number}`);
      }
      const chunks = threads.map((t) => {
        const flags = [
          t.isResolved ? 'RESOLVED' : 'UNRESOLVED',
          t.isOutdated ? 'OUTDATED' : null,
        ].filter(Boolean).join(', ');
        const location = t.line !== null ? `${t.path}:${t.line}` : `${t.path} (outdated)`;
        const header = `Thread ${t.threadId} — ${location} [${flags}]`;
        const lines = t.comments.map((c) =>
          `  [comment_id=${c.commentId}] ${c.author} @ ${c.createdAt}: ${c.body}`
        );
        return [header, ...lines].join('\n');
      });
      return ok(`Review threads on PR #${args.pr_number}:\n${chunks.join('\n\n')}`);
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
    'Update the title, description, and/or base branch of a pull request. All fields are optional — include only what needs to change.',
    {
      pr_number: z.number().describe('The PR number'),
      title: z.string().optional().describe('New PR title'),
      body: z.string().optional().describe('New PR description body'),
      base: z.string().optional().describe('New base branch (retarget the PR, e.g. "main" → "release-1.2")'),
    },
    async (args) => {
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      await client.updatePR(githubRepo, args.pr_number, {
        title: args.title,
        body: args.body,
        base: args.base,
      });
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
    'Start a NEW review thread on a specific line of code. To reply inside an existing thread, use reply_to_review_comment instead.',
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
      return ok(`Added review comment to ${args.path}:${args.line} on PR #${args.pr_number}`);
    },
  );
}

function createReplyToReviewCommentTool(agent: Agent, task: Task) {
  const githubRepo = agent.def.repo!.githubRepo;
  return tool(
    'reply_to_review_comment',
    'Reply inside an existing review thread. Requires the comment_id of any comment in the target thread (from the knowledge log or get_review_threads).',
    {
      pr_number: z.number().describe('The PR number'),
      comment_id: z.number().describe('REST comment id of any comment in the target thread'),
      comment: z.string().describe('The reply text'),
    },
    async (args) => {
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      await client.replyToReviewComment(githubRepo, args.pr_number, args.comment_id, args.comment);
      return ok(`Replied to review comment ${args.comment_id} on PR #${args.pr_number}`);
    },
  );
}

function createResolveReviewThreadTool(agent: Agent, task: Task) {
  const githubRepo = agent.def.repo!.githubRepo;
  return tool(
    'resolve_review_thread',
    'Mark a review thread as resolved. thread_id must be a GraphQL node id (e.g. PRRT_...) obtained from get_review_threads.',
    {
      pr_number: z.number().describe('The PR number'),
      thread_id: z.string().describe('GraphQL thread node id from get_review_threads (e.g. PRRT_...)'),
    },
    async (args) => {
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      await client.resolveReviewThread(githubRepo, args.pr_number, args.thread_id);
      return ok(`Resolved review thread ${args.thread_id} on PR #${args.pr_number}`);
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

// ---- Reminder tools ----

function createParseDatetimeTool(agent: Agent, task: Task) {
  return tool(
    'parse_datetime',
    'Parse a natural language date/time expression into an ISO 8601 timestamp. Call this before set_reminder to get the correct datetime value. You must provide the timezone of the person the reminder relates to.',
    {
      expression: z.string().describe('Natural language date/time, e.g. "in 2 hours", "tomorrow at 10am", "next Monday at 9am"'),
      timezone: z.string().describe('IANA timezone, e.g. "Europe/Moscow", "America/New_York", "UTC"'),
    },
    async (args) => {
      const tz = args.timezone;
      const refDate = new Date();
      const results = chrono.parse(args.expression, { instant: refDate, timezone: tz });
      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: `Could not parse "${args.expression}". Try a different format like "in 2 hours", "tomorrow at 10am", or "next Monday at 9am".` }] };
      }
      const parsed = results[0].start.date();
      return { content: [{ type: 'text' as const, text: parsed.toISOString() }] };
    },
  );
}

function createSetReminderTool(agent: Agent, task: Task) {
  return tool(
    'set_reminder',
    'Set a reminder to be woken up at the specified time. The task will be reactivated and you will receive a prompt with the reason. Only one reminder can be pending — calling this replaces any existing reminder. Use parse_datetime first to get the correct ISO 8601 value.',
    {
      datetime: z.string().describe('ISO 8601 datetime, e.g. "2026-04-15T10:00:00Z"'),
      reason: z.string().describe('What to do when woken — this will be shown to you'),
    },
    async (args) => {
      const triggerAt = new Date(args.datetime);
      if (isNaN(triggerAt.getTime())) {
        return { content: [{ type: 'text' as const, text: 'Invalid datetime. Use parse_datetime to get a valid ISO 8601 value.' }] };
      }
      if (triggerAt <= new Date()) {
        return { content: [{ type: 'text' as const, text: 'Datetime must be in the future.' }] };
      }
      const maxFuture = new Date(Date.now() + 30 * 24 * 60 * 60_000);
      if (triggerAt > maxFuture) {
        return { content: [{ type: 'text' as const, text: 'Datetime must be within 30 days.' }] };
      }

      const agentName = agent.def.id as AgentName;
      scheduleReminder(task, triggerAt, args.reason);
      logger.agentAction(agentName, 'Setting reminder', `${triggerAt.toISOString()}: ${args.reason}`);

      return { content: [{ type: 'text' as const, text: `Reminder set for ${args.datetime}. Reason: ${args.reason}` }] };
    },
  );
}

function createCancelReminderTool(agent: Agent, task: Task) {
  return tool(
    'cancel_reminder',
    'Cancel the pending reminder for this task. Use when the reason for the reminder is no longer relevant.',
    {},
    async () => {
      if (!task.metadata.reminder) {
        return { content: [{ type: 'text' as const, text: 'No pending reminder to cancel.' }] };
      }

      const agentName = agent.def.id as AgentName;
      cancelReminder(task);

      await appendAgentFinding(task.taskId, agentName, 'Cancelled scheduled reminder', 'decision');
      logger.agentAction(agentName, 'Cancelled reminder', '');

      return { content: [{ type: 'text' as const, text: 'Reminder cancelled.' }] };
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
      createPostToUserTool(agent, task),
      createPostFilesToUserTool(agent, task),
      createShareArtifactTool(agent, task),
      createFindSlackUserTool(agent, task),
      createFindSlackChannelTool(agent, task),
      createAssignTaskOwnerTool(agent, task),
      createReportCompletionTool(agent, task),
      createRequestEditModeTool(agent, task),
      createGetAgentsStatusTool(agent, task),
      createMuteThreadTool(agent, task),
      createLaunchTaskTool(agent, task),
      createParseDatetimeTool(agent, task),
      createSetReminderTool(agent, task),
      createCancelReminderTool(agent, task),
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
      createGetPRChecksTool(agent, task),
      createGetPRReviewsTool(agent, task),
      createGetPRCommentsTool(agent, task),
      createGetReviewThreadsTool(agent, task),
      // PR write
      createPushBranchTool(agent, task),
      createPullRequestTool(agent, task),
      createUpdatePRTool(agent, task),
      createAddPRCommentTool(agent, task),
      createAddReviewCommentTool(agent, task),
      createReplyToReviewCommentTool(agent, task),
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
      createShareArtifactTool(agent, task),
    ],
  });
}
