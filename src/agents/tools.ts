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
import type { AgentName, FindingType, AttachedRepo } from '../types/task.js';
import type { Task } from '../tasks/task.js';
import type { Agent } from './agent.js';
import { getVisiblePeerIdsForSender, findAgentDefsContainingRepo, synthesizeDynamicAgentDef } from './registry.js';
import { getGitHubClient, parseCheckRef } from '../connectors/github/client.js';
import { gitExec } from '../connectors/github/repo-clone.js';
import { hydrateBranchState, findBranchStateByPR } from '../connectors/github/branch-state.js';
import { taskBranchName } from '../connectors/github/branch-naming.js';
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
import { findSlackUsers, findSlackChannels, getSlackFileInfo, downloadSlackFile } from '../connectors/slack/client.js';
import { readCanvas } from '../connectors/slack/canvas-read.js';
import { scheduleReminder, cancelReminder } from '../system/reminder-scheduler.js';
import * as chrono from 'chrono-node';
import { writeFile } from 'fs/promises';
import { join } from 'path';

// Re-export branch state helpers for consumers that import from tools.ts
export { hydrateBranchState, findBranchStateByPR };

/**
 * Resolve an attached repo for a repo-track agent in a task.
 *
 * If `github` is omitted, returns the agent's primary repo's `AttachedRepo`.
 * If `github` is provided, returns the matching attached repo; returns undefined
 * when the repo is not currently mounted for this agent (or when the agent has
 * never spawned).
 */
function getAttached(agent: Agent, task: Task, github?: string): AttachedRepo | undefined {
  const target = github ?? agent.def.repo!.primary;
  const attachments = task.metadata.repositories[agent.def.id];
  if (!Array.isArray(attachments)) return undefined;
  return attachments.find((a) => a.github === target);
}

/**
 * Resolve the github identifier for a tool call. Defaults to the agent's primary.
 *
 * Validates the requested github is declared in the agent's `repos` whitelist —
 * agents can only operate on repos they've declared in frontmatter. For tools
 * that also need the repo to be currently mounted (clone access), use
 * `requireAttached`.
 */
function resolveGithub(agent: Agent, requested?: string): { ok: true; github: string } | { ok: false; error: string } {
  const github = requested ?? agent.def.repo!.primary;
  const declared = agent.def.repo!.repos.some((r) => r.github === github);
  if (!declared) {
    const list = agent.def.repo!.repos.map((r) => r.github).join(', ');
    return { ok: false, error: `Repo "${github}" is not in this agent's declared repos list (${list}).` };
  }
  return { ok: true, github };
}

/**
 * Resolve and require that the github has a local clone available.
 *
 * Every declared repo is mounted at spawn, so a missing clone is unexpected —
 * it means the repo wasn't declared (caught by `resolveGithub`) or its clone
 * setup didn't complete. The error tells the agent to report rather than retry
 * blindly.
 */
function requireAttached(agent: Agent, task: Task, requested?: string): { ok: true; github: string; attached: AttachedRepo } | { ok: false; error: string } {
  const resolved = resolveGithub(agent, requested);
  if (!resolved.ok) return resolved;
  const attached = getAttached(agent, task, resolved.github);
  if (!attached?.clone_path) {
    return { ok: false, error: `Repo "${resolved.github}" has no local clone (mount may have failed). Report this rather than retrying.` };
  }
  return { ok: true, github: resolved.github, attached };
}

const githubArgSchema = z.string().optional().describe(
  'Github identifier (e.g. "org/repo") of a declared repo. Defaults to the agent\'s primary repo when omitted.',
);

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

/**
 * Build the enum of agents the given sender can message.
 *
 * Applies visibility rules from the sender's plugin (same-plugin always
 * visible; other-plugin only when `visibility === 'global'`). Always includes
 * 'pm-agent' as a fallback target so an isolated local helper can still
 * escalate. Excludes the sender itself.
 */
function visibleTargetsForSender(
  senderDef: import('../types/agent.js').AgentDef,
  task: Task,
): [string, ...string[]] {
  // Filter over the task team (registry + any PM-spawned dynamic agents), not
  // just the registry, so a dynamic agent is a valid message target.
  const visible = new Set<string>(getVisiblePeerIdsForSender(senderDef, task.team));
  // PM is always reachable (escalation channel), except when the sender is PM itself.
  if (senderDef.id !== 'pm-agent') visible.add('pm-agent');
  const list = Array.from(visible);
  return (list.length > 0 ? list : ['pm-agent']) as [string, ...string[]];
}

// ---- Base tools (all agents) ----

function createSendMessageTool(agent: Agent, task: Task) {
  return tool(
    'send_message_to_agent',
    'Send a message to another agent and wait for their response. Use this to coordinate with peer agents.',
    {
      // Free-form string (validated at runtime against the live task team) so a
      // dynamic agent spawned mid-session is immediately addressable — a static
      // enum would freeze the peer set at MCP-server creation time.
      target: z.string().describe(
        'The agent id to send the message to. Visible peers right now: ' +
        visibleTargetsForSender(agent.def, task).join(', ') +
        '. PM-spawned dynamic agents added during this session are also valid targets.',
      ),
      message: z.string().describe('The message content to send'),
    },
    async (args) => {
      const allowed = new Set(visibleTargetsForSender(agent.def, task));
      if (!allowed.has(args.target)) {
        return err(
          `"${args.target}" is not a visible peer. Allowed: ${Array.from(allowed).join(', ')}.`,
        );
      }
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
    'Send a message to the user. Without target, posts to the default channel — wherever this task already lives. ' +
    'Use that default almost always; use target.channel to reach another already-linked thread. ' +
    'target.new_dm (user ID) and target.new_thread (channel ID) OPEN A NEW conversation and link it to this task — ' +
    'use them ONLY when the user explicitly asks you to reach someone elsewhere, or a loaded skill/workflow requires it. ' +
    'If this task lives in a channel thread, bring someone in by @mentioning them in that thread, not by DMing them. ' +
    'If it lives in a DM, you are 1:1 with that user — keep it private and don\'t pull others in. ' +
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
  return tool(
    'assign_task_owner',
    'Assign a task owner who will lead the investigation. Call this before sending the initial assignment message.',
    {
      // Free-form string (validated at runtime against the live task team) so a
      // PM-spawned dynamic agent can be made owner in the same session — a
      // static enum would freeze the set at MCP-server creation time.
      agent: z.string().describe(
        'The agent id to assign as task owner. Visible candidates right now: ' +
        getVisiblePeerIdsForSender(agent.def, task.team).join(', ') +
        '. PM-spawned dynamic agents added during this session are also valid.',
      ),
    },
    async (args) => {
      const agentName = agent.def.id as AgentName;
      const allowed = new Set(getVisiblePeerIdsForSender(agent.def, task.team));
      if (allowed.size > 0 && !allowed.has(args.agent)) {
        return err(
          `"${args.agent}" is not a visible candidate. Allowed: ${Array.from(allowed).join(', ')}.`,
        );
      }
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
    'Request permission to make code changes. Call this AFTER explaining to the user what changes are needed and why. Task will pause until user approves or denies. ' +
    'Edit mode is a task-LIFETIME grant: once approved it stays in effect for the rest of the task, so you only ever need to request it once. If it is already approved this call is a no-op — it will not prompt the user again, it just confirms the grant. ' +
    'Without `channel`, the request posts to the task\'s default channel. Pass `channel` (a channel key like "slack:C123:456.789") to post it to a specific linked thread — useful when the task has no default channel yet or you opened a new thread to talk to the user.',
    {
      reason: z.string().describe('Brief summary of what changes need to be made'),
      channel: z.string().optional().describe('Channel key of an existing linked thread to post the request to (e.g., "slack:C123:456.789"). Omit to use the task\'s default channel.'),
    },
    async (args) => {
      const agentName = agent.def.id as AgentName;

      // Idempotency: edit mode is a task-lifetime grant. If it is already active,
      // don't post another approval prompt or pause the task — just tell the
      // caller it's already granted so it proceeds instead of waiting on a user
      // who has nothing to approve.
      if (task.metadata.edit_allowed === true) {
        return ok('Edit mode is already approved for this task and persists for its lifetime — no need to request it again. Go ahead and make the changes.');
      }

      // Already pausing this turn — the spawn loop tears the task down at turn
      // end. Skip a duplicate approval post if the tool fires twice.
      if (agent.pendingTeardown) {
        return ok('Edit mode request already sent — task is pausing pending user approval.');
      }

      // Validate an explicit target before posting so a bad key surfaces as
      // actionable feedback instead of silently dropping to the CLI log. The
      // task is left running so the agent can retry with a valid channel.
      if (args.channel) {
        const ch = task.metadata.channels[args.channel];
        if (!ch) {
          return ok(`Channel ${args.channel} is not linked to this task. Open one with post_to_user(target.new_thread/new_dm), or omit channel to use the default.`);
        }
        if (ch.type !== 'slack') {
          return ok(`Channel ${args.channel} is not a Slack channel (type: ${ch.type}).`);
        }
      }

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
      await task.postInteractiveToUser(`Edit mode request: ${args.reason}`, blocks, 'edit_mode', args.channel);

      // Task is now paused pending approval — freeze the status so the wind-down
      // doesn't resurface a "working…" indicator.
      task.suspendStatus();
      // Defer the pause to turn-end (see report_completion) so stopping the queue
      // doesn't close the input stream under an in-flight hook ("stream closed").
      agent.deferTeardown(() => task.stop());
      return { content: [{ type: 'text' as const, text: 'Edit mode request sent. Task paused pending user approval.' }] };
    },
  );
}

function createRequestMaxModeTool(agent: Agent, task: Task) {
  return tool(
    'request_max_mode',
    'Request permission to switch this task into "max mode" — an upgrade that runs the coding agents with more capability (maximum reasoning effort, plus a premium model such as Fable for agents configured to swap). Call this AFTER explaining to the user why the extra cost is worth it (max mode is more expensive). Task will pause until the user approves or denies. ' +
    'Max mode is a task-LIFETIME grant: once approved it stays in effect for the rest of the task, so you only ever need to request it once. If it is already approved this call is a no-op — it will not prompt the user again, it just confirms the grant. ' +
    'Without `channel`, the request posts to the task\'s default channel. Pass `channel` (a channel key like "slack:C123:456.789") to post it to a specific linked thread — useful when the task has no default channel yet or you opened a new thread to talk to the user.',
    {
      reason: z.string().describe('Brief explanation of why max mode is warranted for this task'),
      channel: z.string().optional().describe('Channel key of an existing linked thread to post the request to (e.g., "slack:C123:456.789"). Omit to use the task\'s default channel.'),
    },
    async (args) => {
      const agentName = agent.def.id as AgentName;

      // Idempotency: max mode is a task-lifetime grant. If it is already active,
      // don't post another approval prompt or pause the task — just tell the
      // caller it's already granted so it proceeds instead of waiting on a user
      // who has nothing to approve.
      if (task.metadata.max_mode === true) {
        return ok('Max mode is already approved for this task and persists for its lifetime — no need to request it again. Continue the work.');
      }

      // Already pausing this turn — the spawn loop tears the task down at turn
      // end. Skip a duplicate approval post if the tool fires twice.
      if (agent.pendingTeardown) {
        return ok('Max mode request already sent — task is pausing pending user approval.');
      }

      // Validate an explicit target before posting so a bad key surfaces as
      // actionable feedback instead of silently dropping to the CLI log. The
      // task is left running so the agent can retry with a valid channel.
      if (args.channel) {
        const ch = task.metadata.channels[args.channel];
        if (!ch) {
          return ok(`Channel ${args.channel} is not linked to this task. Open one with post_to_user(target.new_thread/new_dm), or omit channel to use the default.`);
        }
        if (ch.type !== 'slack') {
          return ok(`Channel ${args.channel} is not a Slack channel (type: ${ch.type}).`);
        }
      }

      logger.agentAction(agentName, 'Requesting max mode', args.reason);
      task.touch();

      await appendAgentFinding(task.taskId, 'system', `Max mode requested: ${args.reason}`, 'decision');

      const blocks = [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Max mode request:* ${args.reason}` },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Approve' },
              action_id: 'approve_max_mode',
              value: task.taskId,
              style: 'primary',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Deny' },
              action_id: 'deny_max_mode',
              value: task.taskId,
              style: 'danger',
            },
          ],
        },
      ];
      await task.postInteractiveToUser(`Max mode request: ${args.reason}`, blocks, 'max_mode', args.channel);

      // Task is now paused pending approval — freeze the status so the wind-down
      // doesn't resurface a "working…" indicator.
      task.suspendStatus();
      // Defer the pause to turn-end (see report_completion) so stopping the queue
      // doesn't close the input stream under an in-flight hook ("stream closed").
      agent.deferTeardown(() => task.stop());
      return { content: [{ type: 'text' as const, text: 'Max mode request sent. Task paused pending user approval.' }] };
    },
  );
}

function createReportCompletionTool(agent: Agent, task: Task) {
  return tool(
    'report_completion',
    'Finish your turn: signal you have responded and are now waiting only on the user (not on any agent). If a message is provided, it is posted first.',
    {
      message: z.string().optional().describe('Optional message to post to Slack before finishing'),
    },
    async (args) => {
      const agentName = agent.def.id as AgentName;
      // Idempotency: task already parked/stopped — nothing to do.
      if (!task.isActive) {
        return ok('Task already completed. End your turn.');
      }
      // A forced stop (request_edit_mode / research-budget) is already deferred
      // this turn — don't double up.
      if (agent.pendingTeardown) {
        return ok('Task already stopping. End your turn.');
      }
      // Already recorded completion this turn — don't re-post or re-signal.
      if (task.completionIntent) {
        return ok('Completion already recorded. End your turn.');
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
          // message). Do NOT record completion — it only proceeds after a
          // successful post (or no message at all).
          return ok(formatSlackSendError(err));
        }
      }
      logger.agentAction(agentName, 'Reporting completion', '');
      task.touch();
      // Post any changed PR card now, right under the final message. Under the
      // quiescence model the task isn't torn down here — complete() runs later
      // from the idle-check once the system goes quiet — so this is the prompt
      // path for the card; posting now also means it exists before CI webhooks
      // arrive, so they have something to update in place.
      await task.resurfacePrCards();
      // Blank the live status now — the final message is sent and the turn is
      // ending; without this the indicator would pop back during the wind-down.
      task.suspendStatus();
      // Record intent instead of tearing down. The idle-check parks the task once
      // every agent is idle (quiescent); if a peer is in fact still working, the
      // task stays active until it's done — so completion can't orphan a peer, and
      // no synchronous peer-gate races the Stop-hook boundary. The agent must end
      // its turn now: that's what lets the system reach quiescence and park.
      task.setCompletionIntent();
      return ok(
        args.message
          ? 'Message posted. Nothing left to do — end your turn.'
          : 'Completion recorded. Nothing left to do — end your turn.'
      );
    },
  );
}

function createMuteChannelTool(agent: Agent, task: Task) {
  return tool(
    'mute_channel',
    'Unsubscribe from a Slack channel/thread. Once muted, messages in it are ignored until someone @mentions the bot there again. Posts a notification to the thread it muted. ' +
    'Pass `channel` (a channel key like "slack:C123:456.789") to mute that specific thread. ' +
    'Omit `channel` to mute the task\'s default channel only (never all linked channels). ' +
    'DM channels cannot be muted — DMs have no @mention to unmute by, so muting one would lock the user out permanently.',
    {
      channel: z.string().optional().describe('Channel key of the thread to mute (e.g., "slack:C123:456.789"). Omit to mute the task\'s default channel.'),
    },
    async (args) => {
      const agentName = agent.def.id as AgentName;
      const channelKey = args.channel ?? task.metadata.default_channel;

      if (!channelKey) {
        return ok('No channel specified and task has no default channel — nothing to mute.');
      }

      const ch = task.metadata.channels[channelKey];
      if (!ch) {
        return ok(`Channel ${channelKey} is not linked to this task.`);
      }
      if (ch.type !== 'slack') {
        return ok(`Channel ${channelKey} is not a Slack channel (type: ${ch.type}).`);
      }
      if (ch.channel_id.startsWith('D')) {
        return ok(
          `Cannot mute DM channel ${channelKey} — DMs have no @mention to unmute by, so muting would lock the user out permanently. ` +
          `Every DM is implicitly addressed to the bot, so just stop responding to disengage.`
        );
      }
      if (ch.muted) {
        return ok(`Channel ${channelKey} is already muted.`);
      }

      logger.agentAction(agentName, 'Muting channel', channelKey);
      task.touch();

      ch.muted = true;
      task.debouncedSave();
      await appendAgentFinding(task.taskId, agentName, `Muted Slack channel ${channelKey} — will not process messages until next @mention`, 'decision');

      // Notify only the channel we muted
      await task.postToUser("I'll step back from this thread. Mention me again when you need me.", agentName, { channel: channelKey });

      return ok(`Muted ${channelKey}. Will resume on next @mention.`);
    },
  );
}

function createReactToMessageTool(agent: Agent, task: Task) {
  return tool(
    'react_to_message',
    'Add an emoji reaction to a message in a Slack thread. Use to acknowledge, ' +
    'express sentiment, or signal status without sending a text message. ' +
    'Reacts to ANY message in a linked thread — pass `message_id`, the `msg:<ts>` ' +
    'value shown next to each message in the knowledge log (e.g. "1716998400.123456"). ' +
    'Omit `channel` to target the task\'s default channel. ' +
    'The emoji is a Slack shortcode WITHOUT colons (e.g. "thumbsup", "eyes", "tada", "white_check_mark").',
    {
      message_id: z.string().describe('The target message timestamp — the `msg:<ts>` id from the knowledge log (e.g. "1716998400.123456")'),
      emoji: z.string().describe('Slack emoji shortcode without colons (e.g. "thumbsup", "heart", "eyes")'),
      channel: z.string().optional().describe('Channel key of the linked thread (e.g. "slack:C123:456.789"). Omit for the default channel.'),
    },
    async (args) => {
      const agentName = agent.def.id as AgentName;
      const emoji = args.emoji.replace(/:/g, '').trim();
      const dispatched = await task.reactToMessage(args.message_id, emoji, args.channel);
      if (!dispatched) {
        return ok(`Could not react: ${args.channel ? `channel ${args.channel} is not a linked Slack thread` : 'task has no default Slack channel'}.`);
      }
      logger.agentAction(agentName, `Reacted :${emoji}:`, args.message_id);
      return ok(`Added :${emoji}: to message ${args.message_id}.`);
    },
  );
}

function createUnreactFromMessageTool(agent: Agent, task: Task) {
  return tool(
    'unreact_from_message',
    'Remove an emoji reaction Archie previously added to a Slack message. ' +
    'Mirrors `react_to_message`: pass the `message_id` (`msg:<ts>` id) and the emoji shortcode. ' +
    'Only removes Archie\'s own reaction; other users\' reactions are unaffected.',
    {
      message_id: z.string().describe('The target message timestamp — the `msg:<ts>` id from the knowledge log'),
      emoji: z.string().describe('Slack emoji shortcode without colons (e.g. "eyes")'),
      channel: z.string().optional().describe('Channel key of the linked thread. Omit for the default channel.'),
    },
    async (args) => {
      const agentName = agent.def.id as AgentName;
      const emoji = args.emoji.replace(/:/g, '').trim();
      const dispatched = await task.unreactFromMessage(args.message_id, emoji, args.channel);
      if (!dispatched) {
        return ok(`Could not remove reaction: ${args.channel ? `channel ${args.channel} is not a linked Slack thread` : 'task has no default Slack channel'}.`);
      }
      logger.agentAction(agentName, `Removed :${emoji}:`, args.message_id);
      return ok(`Removed :${emoji}: from message ${args.message_id}.`);
    },
  );
}

function createGetMessageReactionsTool(_agent: Agent, task: Task) {
  return tool(
    'get_message_reactions',
    'Read the CURRENT emoji reactions on a Slack message (live state, fresher than ' +
    'the snapshot in the knowledge log). Pass the `message_id` (`msg:<ts>` id). ' +
    'Returns each reaction\'s emoji shortcode, how many users reacted, and who they were.',
    {
      message_id: z.string().describe('The target message timestamp — the `msg:<ts>` id from the knowledge log'),
      channel: z.string().optional().describe('Channel key of the linked thread. Omit for the default channel.'),
    },
    async (args) => {
      const reactions = await task.readMessageReactions(args.message_id, args.channel);
      if (reactions === null) {
        return ok(`Could not read reactions: ${args.channel ? `channel ${args.channel} is not a linked Slack thread` : 'task has no default Slack channel'}.`);
      }
      if (reactions.length === 0) {
        return ok(`Message ${args.message_id} has no reactions.`);
      }
      const summary = reactions
        .map((r) => {
          const who = r.users && r.users.length > 0 ? ` — ${r.users.join(', ')}` : '';
          return `:${r.name}: (${r.count})${who}`;
        })
        .join('\n');
      return ok(`Reactions on ${args.message_id}:\n${summary}`);
    },
  );
}

function createLaunchTaskTool(_agent: Agent, task: Task) {
  return tool(
    'launch_task',
    'Launch a SEPARATE, independent background task with NO link back to this one — its origin is invisible to whoever picks it up. ' +
    'Keep follow-up work inside the current task by delegating to an agent here, so everything stays on one traceable thread. ' +
    'Use this ONLY when the user explicitly asks for separate/background work, or a loaded skill/workflow requires it. ' +
    'The launched task starts with no channel — its own PM decides whether to reach someone or complete silently. ' +
    'Cannot be called from a task that has no channel of its own.',
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
  return tool(
    'push_branch',
    'Push commits from the local clone to the remote origin. Set force=true after a rebase to force-push with lease (safe against overwriting concurrent updates). Do not use force=true just because a normal push was rejected — investigate why first.',
    {
      force: z.boolean().optional().describe('Use --force-with-lease. Required after rebasing a pushed branch.'),
      github: githubArgSchema,
    },
    async (args) => {
      const agentName = agent.def.id as AgentName;
      const resolved = requireAttached(agent, task, args.github);
      if (!resolved.ok) return err(resolved.error);
      const force = args.force === true;
      logger.agentAction(
        agentName,
        force ? 'Force-pushing branch (with lease)' : 'Pushing branch',
        resolved.github,
      );

      const { attached } = resolved;
      const branch = attached.current_branch;
      const state = branch ? attached.branch_states?.[branch] : undefined;

      if (!branch || !state) {
        return err('No branch to push');
      }

      try {
        const forceFlag = force ? '--force-with-lease ' : '';
        await execAsync(`git push ${forceFlag}-u origin HEAD:${branch}`, { cwd: attached.clone_path! });

        task.debouncedSave();

        const message = `${force ? 'Force-pushed' : 'Pushed'} ${branch} to origin (${resolved.github})`;
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
  return tool(
    'create_pull_request',
    'Create a pull request on GitHub.',
    {
      title: z.string().describe('PR title'),
      body: z.string().describe('PR description body'),
      github: githubArgSchema,
    },
    async (args) => {
      const agentName = agent.def.id as AgentName;
      logger.agentAction(agentName, 'Creating PR', args.title);

      const resolved = requireAttached(agent, task, args.github);
      if (!resolved.ok) return err(resolved.error);

      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');

      const { github, attached } = resolved;
      const branch = attached.current_branch;
      const state = branch ? attached.branch_states?.[branch] : undefined;
      const head = branch || taskBranchName(task.taskId);
      const entry = agent.def.repo!.repos.find((r) => r.github === github);
      const base = state?.base_branch || entry?.baseBranch || 'main';

      const result = await client.createPullRequest(github, head, base, args.title, args.body);

      if (state) {
        state.pr_number = result.pr_number;
      }
      task.debouncedSave();

      await appendAgentFinding(task.taskId, agentName, `Created PR #${result.pr_number} on ${github}: ${result.pr_url}`, 'decision');
      return ok(`Created PR #${result.pr_number} on ${github}: ${result.pr_url}`);
    },
  );
}

function createGetPRStatusTool(agent: Agent, task: Task) {
  return tool(
    'get_pr_status',
    'Get the current status of a pull request.',
    { pr_number: z.number().describe('The PR number'), github: githubArgSchema },
    async (args) => {
      const resolved = resolveGithub(agent, args.github);
      if (!resolved.ok) return err(resolved.error);
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      const status = await client.getPRStatus(resolved.github, args.pr_number);
      return {
        content: [{
          type: 'text' as const,
          text: `PR #${args.pr_number} (${resolved.github}) status:\n- State: ${status.state}\n- Mergeable: ${status.mergeable}\n- Mergeable State: ${status.mergeableState}\n- Approved: ${status.approved}`,
        }],
      };
    },
  );
}

function createGetPRChecksTool(agent: Agent, task: Task) {
  return tool(
    'get_pr_checks',
    'List CI checks (check-runs + legacy commit statuses) attached to a PR\'s HEAD commit. Returns conclusion, URL, and — for failed checks — the full output (title/summary/text). Use this when a "checks updated" event arrives or get_pr_status reports mergeableState=unstable, to find which specific check broke.',
    { pr_number: z.number().describe('The PR number'), github: githubArgSchema },
    async (args) => {
      const resolved = resolveGithub(agent, args.github);
      if (!resolved.ok) return err(resolved.error);
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      const report = await client.listPRChecks(resolved.github, args.pr_number);
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

function createGetCheckRunTool(agent: Agent, task: Task) {
  return tool(
    'get_check_run',
    'Fetch a single CI check/run by its id or a github.com URL — no PR needed. ' +
    'Use this when someone shares a raw check-run, Actions job, or workflow-run link (e.g. ".../runs/123", ".../actions/runs/123", or ".../actions/runs/123/job/456") or just a run id, and you need the failure details. ' +
    'Returns the conclusion, check output, annotations, and — for GitHub Actions — the failing slice of the job log (the rspec "Failures:" / "Failed examples:" block). ' +
    'For checks on a PR you already know, prefer get_pr_checks.',
    {
      ref: z.string().describe('A numeric check-run/job/workflow-run id, or a full github.com URL pointing at one.'),
      github: githubArgSchema,
    },
    async (args) => {
      const resolved = resolveGithub(agent, args.github);
      if (!resolved.ok) return err(resolved.error);
      const githubRepo = resolved.github;
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');

      let parsed;
      try {
        parsed = parseCheckRef(args.ref);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }

      // Stay within this agent's repo: a URL pointing elsewhere is out of scope.
      if (parsed.owner && parsed.repo) {
        const refRepo = `${parsed.owner}/${parsed.repo}`;
        if (refRepo.toLowerCase() !== githubRepo.toLowerCase()) {
          return err(
            `That link points at ${refRepo}, but you are scoped to ${githubRepo}. ` +
            `I can only fetch checks for ${githubRepo}.`
          );
        }
      }

      if (parsed.kind === 'workflow_run') {
        const report = await client.getWorkflowRunById(githubRepo, parsed.id);
        const lines: string[] = [
          `Workflow run ${report.id} — ${report.name} [${report.conclusion ?? report.status}]`,
          `Branch: ${report.headBranch ?? 'unknown'} (head ${report.headSha ? report.headSha.slice(0, 7) : 'unknown'})`,
        ];
        if (report.url) lines.push(`URL: ${report.url}`);
        lines.push('', `Jobs (${report.jobs.length}):`);
        for (const job of report.jobs) {
          lines.push(`- [${job.conclusion ?? job.status}] ${job.name} (job ${job.id})${job.url ? ` — ${job.url}` : ''}`);
        }
        for (const job of report.jobs) {
          if (job.logTail) {
            lines.push('', `${job.name} log:`, job.logTail);
          }
        }
        return ok(lines.join('\n'));
      }

      const report = await client.getCheckRunById(githubRepo, parsed.id);
      const lines: string[] = [
        `Check run ${report.id} — ${report.name} (${report.app}) [${report.conclusion ?? report.status}]`,
        `Head: ${report.headSha ? report.headSha.slice(0, 7) : 'unknown'}`,
      ];
      if (report.url) lines.push(`URL: ${report.url}`);
      if (report.output?.title) lines.push(`title: ${report.output.title}`);
      if (report.output?.summary) {
        lines.push('summary:', report.output.summary);
      }
      if (report.output?.text) {
        lines.push('text:', report.output.text);
      }
      if (report.annotations?.length) {
        lines.push('', `Annotations (${report.annotations.length}):`);
        for (const a of report.annotations) {
          const loc = a.startLine !== null ? `${a.path}:${a.startLine}` : a.path;
          lines.push(`- [${a.level}] ${loc}${a.title ? ` ${a.title}` : ''}: ${a.message}`);
        }
      }
      if (report.logTail) {
        lines.push('', 'log:', report.logTail);
      }
      return ok(lines.join('\n'));
    },
  );
}

/**
 * Code scanning endpoints 403 when the GitHub App lacks the "Code scanning
 * alerts" read permission, and 404 when code scanning isn't enabled for the
 * repo (or there are no analyses / the alert number doesn't exist). Translate
 * both into guidance the agent can act on instead of a raw HTTP error.
 */
function codeScanningErrorHint(e: unknown, githubRepo: string): string {
  const status = (e as { status?: number })?.status;
  const message = e instanceof Error ? e.message : String(e);
  if (status === 403) {
    return (
      `Access denied reading code scanning alerts for ${githubRepo}. The GitHub App ` +
      `likely needs the "Code scanning alerts" (read) permission granted and the ` +
      `installation re-approved. Report this rather than retrying. (${message})`
    );
  }
  if (status === 404) {
    return (
      `No code scanning data for ${githubRepo} — code scanning may not be enabled, ` +
      `there are no analyses yet, or the alert number doesn't exist. (${message})`
    );
  }
  return message;
}

function createListCodeScanningAlertsTool(agent: Agent, task: Task) {
  return tool(
    'list_code_scanning_alerts',
    'List code scanning security alerts (e.g. CodeQL) from the repo\'s Security tab. ' +
    'Returns each alert\'s number, state, severity, rule, file location, and URL. ' +
    'Use this to review security findings, audit open vulnerabilities, or check a specific branch. ' +
    'Filter by state (defaults to open), a git ref/branch, or severity. For full detail on one alert, use get_code_scanning_alert.',
    {
      github: githubArgSchema,
      state: z
        .enum(['open', 'dismissed', 'fixed'])
        .optional()
        .describe('Filter by alert state. Defaults to open.'),
      ref: z
        .string()
        .optional()
        .describe('Git ref to filter by, e.g. "refs/heads/main" or a branch name.'),
      severity: z
        .enum(['critical', 'high', 'medium', 'low', 'warning', 'note', 'error'])
        .optional()
        .describe('Filter by severity level.'),
    },
    async (args) => {
      const resolved = resolveGithub(agent, args.github);
      if (!resolved.ok) return err(resolved.error);
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');

      let alerts;
      try {
        alerts = await client.listCodeScanningAlerts(resolved.github, {
          state: args.state ?? 'open',
          ref: args.ref,
          severity: args.severity,
        });
      } catch (e) {
        return err(codeScanningErrorHint(e, resolved.github));
      }

      if (alerts.length === 0) {
        return ok(
          `No code scanning alerts found for ${resolved.github} (state=${args.state ?? 'open'}).`
        );
      }

      const lines: string[] = [
        `Code scanning alerts for ${resolved.github} (${alerts.length}):`,
      ];
      for (const a of alerts) {
        const sev = a.securitySeverity ?? a.severity ?? 'unknown';
        const inst = a.mostRecentInstance;
        const loc = inst?.path
          ? ` — ${inst.path}${inst.startLine ? `:${inst.startLine}` : ''}`
          : '';
        const urlPart = a.url ? ` — ${a.url}` : '';
        lines.push(
          `- #${a.number} [${a.state}] [${sev}] ${a.ruleName ?? a.ruleId ?? 'unknown rule'} (${a.tool})${loc}${urlPart}`
        );
      }
      return ok(lines.join('\n'));
    },
  );
}

function createGetCodeScanningAlertTool(agent: Agent, task: Task) {
  return tool(
    'get_code_scanning_alert',
    'Fetch full detail for a single code scanning alert (e.g. CodeQL) by its number. ' +
    'Returns the rule description, severity, state, dismissal info, and the most recent instance ' +
    '(file path, line range, git ref, and the alert message). Get the alert number from list_code_scanning_alerts.',
    {
      alert_number: z.number().describe('The code scanning alert number.'),
      github: githubArgSchema,
    },
    async (args) => {
      const resolved = resolveGithub(agent, args.github);
      if (!resolved.ok) return err(resolved.error);
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');

      let alert;
      try {
        alert = await client.getCodeScanningAlert(resolved.github, args.alert_number);
      } catch (e) {
        return err(codeScanningErrorHint(e, resolved.github));
      }

      const ruleLabel = alert.ruleName ?? alert.ruleId ?? 'unknown';
      const lines: string[] = [
        `Code scanning alert #${alert.number} (${resolved.github}) [${alert.state}]`,
        `Tool: ${alert.tool}`,
        `Rule: ${ruleLabel}${alert.ruleId && alert.ruleName ? ` (${alert.ruleId})` : ''}`,
        `Severity: ${alert.securitySeverity ?? alert.severity ?? 'unknown'}`,
      ];
      if (alert.url) lines.push(`URL: ${alert.url}`);
      if (alert.ruleDescription) lines.push('', `Description: ${alert.ruleDescription}`);

      const inst = alert.mostRecentInstance;
      if (inst) {
        const endPart =
          inst.endLine && inst.endLine !== inst.startLine ? `-${inst.endLine}` : '';
        const loc = inst.path
          ? `${inst.path}${inst.startLine ? `:${inst.startLine}${endPart}` : ''}`
          : 'unknown';
        lines.push('', `Location: ${loc}`);
        if (inst.ref) lines.push(`Ref: ${inst.ref}`);
        if (inst.message) lines.push(`Message: ${inst.message}`);
      }

      if (alert.state === 'dismissed') {
        if (alert.dismissedReason) lines.push('', `Dismissed reason: ${alert.dismissedReason}`);
        if (alert.dismissedComment) lines.push(`Dismissed comment: ${alert.dismissedComment}`);
      }

      return ok(lines.join('\n'));
    },
  );
}

function createGetPRReviewsTool(agent: Agent, task: Task) {
  return tool(
    'get_pr_reviews',
    'Get review-level summary for a PR (approvals, change requests, review bodies). For line-level comments, use get_review_threads.',
    { pr_number: z.number().describe('The PR number'), github: githubArgSchema },
    async (args) => {
      const resolved = resolveGithub(agent, args.github);
      if (!resolved.ok) return err(resolved.error);
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      const reviews = await client.getPRReviews(resolved.github, args.pr_number);
      if (reviews.length === 0) {
        return ok(`No reviews found for PR #${args.pr_number} (${resolved.github})`);
      }
      const lines = reviews.map((r) =>
        `- ${r.user} [${r.state}] @ ${r.submittedAt}: ${r.body || '(no body)'}`
      );
      return ok(`Reviews for PR #${args.pr_number} (${resolved.github}):\n${lines.join('\n')}`);
    },
  );
}

function createGetPRCommentsTool(agent: Agent, task: Task) {
  return tool(
    'get_pr_comments',
    'Get top-level PR conversation comments (the "Conversation" tab). Does not include line-level review comments — use get_review_threads for those.',
    { pr_number: z.number().describe('The PR number'), github: githubArgSchema },
    async (args) => {
      const resolved = resolveGithub(agent, args.github);
      if (!resolved.ok) return err(resolved.error);
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      const comments = await client.getPRComments(resolved.github, args.pr_number);
      if (comments.length === 0) {
        return ok(`No conversation comments on PR #${args.pr_number} (${resolved.github})`);
      }
      const lines = comments.map((c) =>
        `- [comment_id=${c.id}] ${c.author} @ ${c.createdAt}: ${c.body}`
      );
      return ok(`Comments on PR #${args.pr_number} (${resolved.github}):\n${lines.join('\n')}`);
    },
  );
}

function createGetReviewThreadsTool(agent: Agent, task: Task) {
  return tool(
    'get_review_threads',
    'Get every review thread on a PR with its thread_id (for resolve_review_thread) and each comment\'s comment_id (for reply_to_review_comment).',
    { pr_number: z.number().describe('The PR number'), github: githubArgSchema },
    async (args) => {
      const resolved = resolveGithub(agent, args.github);
      if (!resolved.ok) return err(resolved.error);
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      const threads = await client.getReviewThreads(resolved.github, args.pr_number);
      if (threads.length === 0) {
        return ok(`No review threads on PR #${args.pr_number} (${resolved.github})`);
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
      return ok(`Review threads on PR #${args.pr_number} (${resolved.github}):\n${chunks.join('\n\n')}`);
    },
  );
}

function createListPRsTool(agent: Agent, task: Task) {
  return tool(
    'list_prs',
    'List pull requests with optional filters.',
    {
      state: z.enum(['open', 'closed', 'all']).optional().describe('PR state filter (default: open)'),
      base: z.string().optional().describe('Filter by base branch (e.g. "main")'),
      sort: z.enum(['created', 'updated', 'popularity', 'long-running']).optional().describe('Sort field (default: updated)'),
      limit: z.number().optional().describe('Max results to return (default: 10)'),
      github: githubArgSchema,
    },
    async (args) => {
      const resolved = resolveGithub(agent, args.github);
      if (!resolved.ok) return err(resolved.error);
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      const prs = await client.listPRs(resolved.github, {
        state: args.state,
        base: args.base,
        sort: args.sort,
        per_page: args.limit,
      });
      if (prs.length === 0) {
        return ok(`No PRs found in ${resolved.github} matching the filters.`);
      }
      const lines = prs.map((pr) =>
        `#${pr.number} [${pr.state}] ${pr.title} (${pr.head} → ${pr.base}) by ${pr.author} — ${pr.url}`
      );
      return ok(`PRs in ${resolved.github}:\n${lines.join('\n')}`);
    },
  );
}

function createGetPRTool(agent: Agent, task: Task) {
  return tool(
    'get_pr',
    'Get full PR details: title, description, diff, state, and branches.',
    { pr_number: z.number().describe('The PR number'), github: githubArgSchema },
    async (args) => {
      const resolved = resolveGithub(agent, args.github);
      if (!resolved.ok) return err(resolved.error);
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      const pr = await client.getPRDetails(resolved.github, args.pr_number);
      const text = [
        `PR #${pr.number} (${resolved.github}): ${pr.title}`,
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
  return tool(
    'update_pr',
    'Update the title, description, and/or base branch of a pull request. All fields are optional — include only what needs to change.',
    {
      pr_number: z.number().describe('The PR number'),
      title: z.string().optional().describe('New PR title'),
      body: z.string().optional().describe('New PR description body'),
      base: z.string().optional().describe('New base branch (retarget the PR, e.g. "main" → "release-1.2")'),
      github: githubArgSchema,
    },
    async (args) => {
      const resolved = resolveGithub(agent, args.github);
      if (!resolved.ok) return err(resolved.error);
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      await client.updatePR(resolved.github, args.pr_number, {
        title: args.title,
        body: args.body,
        base: args.base,
      });
      return ok(`Updated PR #${args.pr_number} (${resolved.github})`);
    },
  );
}

function createAddPRCommentTool(agent: Agent, task: Task) {
  return tool(
    'add_pr_comment',
    'Add a general comment to a pull request.',
    {
      pr_number: z.number().describe('The PR number'),
      comment: z.string().describe('The comment text'),
      github: githubArgSchema,
    },
    async (args) => {
      const resolved = resolveGithub(agent, args.github);
      if (!resolved.ok) return err(resolved.error);
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      await client.addPRComment(resolved.github, args.pr_number, args.comment);
      return ok(`Added comment to PR #${args.pr_number} (${resolved.github})`);
    },
  );
}

function createAddReviewCommentTool(agent: Agent, task: Task) {
  return tool(
    'add_review_comment',
    'Start a NEW review thread on a specific line of code. To reply inside an existing thread, use reply_to_review_comment instead.',
    {
      pr_number: z.number().describe('The PR number'),
      path: z.string().describe('File path relative to repo root'),
      line: z.number().describe('Line number in the file'),
      comment: z.string().describe('The comment text'),
      github: githubArgSchema,
    },
    async (args) => {
      const resolved = resolveGithub(agent, args.github);
      if (!resolved.ok) return err(resolved.error);
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      await client.addReviewComment(resolved.github, args.pr_number, args.path, args.line, args.comment);
      return ok(`Added review comment to ${args.path}:${args.line} on PR #${args.pr_number} (${resolved.github})`);
    },
  );
}

function createReplyToReviewCommentTool(agent: Agent, task: Task) {
  return tool(
    'reply_to_review_comment',
    'Reply inside an existing review thread. Requires the comment_id of any comment in the target thread (from the knowledge log or get_review_threads).',
    {
      pr_number: z.number().describe('The PR number'),
      comment_id: z.number().describe('REST comment id of any comment in the target thread'),
      comment: z.string().describe('The reply text'),
      github: githubArgSchema,
    },
    async (args) => {
      const resolved = resolveGithub(agent, args.github);
      if (!resolved.ok) return err(resolved.error);
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      await client.replyToReviewComment(resolved.github, args.pr_number, args.comment_id, args.comment);
      return ok(`Replied to review comment ${args.comment_id} on PR #${args.pr_number} (${resolved.github})`);
    },
  );
}

function createResolveReviewThreadTool(agent: Agent, task: Task) {
  return tool(
    'resolve_review_thread',
    'Mark a review thread as resolved. thread_id must be a GraphQL node id (e.g. PRRT_...) obtained from get_review_threads.',
    {
      pr_number: z.number().describe('The PR number'),
      thread_id: z.string().describe('GraphQL thread node id from get_review_threads (e.g. PRRT_...)'),
      github: githubArgSchema,
    },
    async (args) => {
      const resolved = resolveGithub(agent, args.github);
      if (!resolved.ok) return err(resolved.error);
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      await client.resolveReviewThread(resolved.github, args.pr_number, args.thread_id);
      return ok(`Resolved review thread ${args.thread_id} on PR #${args.pr_number} (${resolved.github})`);
    },
  );
}

function createRequestReReviewTool(agent: Agent, task: Task) {
  return tool(
    'request_re_review',
    'Request reviewers to re-review the PR after changes.',
    { pr_number: z.number().describe('The PR number'), github: githubArgSchema },
    async (args) => {
      const resolved = resolveGithub(agent, args.github);
      if (!resolved.ok) return err(resolved.error);
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      await client.requestReReview(resolved.github, args.pr_number);
      return ok(`Requested re-review for PR #${args.pr_number} (${resolved.github})`);
    },
  );
}


function createMergePRTool(agent: Agent, task: Task) {
  return tool(
    'merge_pull_request',
    'Merge a pull request. Checks mergeability first and returns the current status if not ready.',
    { pr_number: z.number().describe('The PR number'), github: githubArgSchema },
    async (args) => {
      const resolved = resolveGithub(agent, args.github);
      if (!resolved.ok) return err(resolved.error);
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');

      const status = await client.getPRStatus(resolved.github, args.pr_number);
      if (status.state !== 'open') {
        return ok(`Cannot merge: PR #${args.pr_number} (${resolved.github}) is ${status.state}`);
      }
      if (!status.mergeable || status.mergeableState !== 'clean') {
        return ok(`Cannot merge: PR #${args.pr_number} (${resolved.github}) is not ready (mergeable=${status.mergeable}, state=${status.mergeableState})`);
      }

      const result = await client.mergePullRequest(resolved.github, args.pr_number);
      return { content: [{ type: 'text' as const, text: result.message }] };
    },
  );
}

function createClosePRTool(agent: Agent, task: Task) {
  return tool(
    'close_pull_request',
    'Close a pull request without merging.',
    { pr_number: z.number().describe('The PR number'), github: githubArgSchema },
    async (args) => {
      const resolved = resolveGithub(agent, args.github);
      if (!resolved.ok) return err(resolved.error);
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      await client.closePullRequest(resolved.github, args.pr_number);
      return ok(`Closed PR #${args.pr_number} (${resolved.github})`);
    },
  );
}

// ---- Git workflow tools (repo agents) ----

function createFetchTool(agent: Agent, task: Task) {
  return tool(
    'fetch',
    'Fetch latest refs from origin.',
    { github: githubArgSchema },
    async (args) => {
      const resolved = requireAttached(agent, task, args.github);
      if (!resolved.ok) return err(resolved.error);
      await gitExec(resolved.attached.clone_path!, 'fetch origin');
      return ok(`Fetched latest from origin (${resolved.github})`);
    },
  );
}

function createSwitchBranchTool(agent: Agent, task: Task) {
  return tool(
    'switch_branch',
    'Switch to a different branch. Fetches latest, auto-stashes dirty work, auto-pops on return.',
    {
      branch: z.string().describe('Branch name to switch to'),
      github: githubArgSchema,
    },
    async (args) => {
      const resolved = requireAttached(agent, task, args.github);
      if (!resolved.ok) return err(resolved.error);
      const { attached } = resolved;
      const clonePath = attached.clone_path!;

      const branch = args.branch;
      const currentBranch = attached.current_branch;

      // 1. Fetch branch into clone
      await gitExec(clonePath, `fetch origin ${branch}`).catch(() => {});

      // 2. Auto-stash if dirty
      const status = await gitExec(clonePath, 'status --porcelain');
      if (status.trim()) {
        const stashName = `archie:${task.taskId}:${currentBranch}`;
        await gitExec(clonePath, `stash push --include-untracked -m "${stashName}"`);
        if (currentBranch && attached.branch_states?.[currentBranch]) {
          attached.branch_states[currentBranch].stash_name = stashName;
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
      attached.branch_states ??= {};
      if (!attached.branch_states[branch]) {
        attached.branch_states[branch] = {};
      }

      // 5. Update current_branch
      attached.current_branch = branch;

      // 7. Auto-pop stash if exists for target branch
      const targetState = attached.branch_states[branch];
      if (targetState?.stash_name) {
        const stashList = await gitExec(clonePath, 'stash list');
        const stashIndex = findStashIndex(stashList, targetState.stash_name);
        if (stashIndex !== null) {
          await gitExec(clonePath, `stash pop stash@{${stashIndex}}`);
        }
        targetState.stash_name = undefined;
      }

      task.debouncedSave();
      return ok(`Switched to ${branch}`);
    },
  );
}

function createCreateBranchTool(agent: Agent, task: Task) {
  return tool(
    'create_branch',
    'Create a new branch and switch to it. Branch name is auto-generated from the task ID. Returns the full branch name.',
    {
      base: z.string().optional().describe('Base branch or commit (default: current HEAD)'),
      github: githubArgSchema,
    },
    async (args) => {
      const resolved = requireAttached(agent, task, args.github);
      if (!resolved.ok) return err(resolved.error);
      const { attached } = resolved;

      // Count existing branches to generate unique name
      const existing = Object.keys(attached.branch_states || {}).length;
      const branchName = taskBranchName(task.taskId, existing);

      const base = args.base || 'HEAD';
      await gitExec(attached.clone_path!, `checkout -b ${branchName} ${base}`);

      attached.branch_states ??= {};
      attached.branch_states[branchName] = {};
      attached.current_branch = branchName;
      task.debouncedSave();
      return ok(`Created and switched to ${branchName} (${resolved.github})`);
    },
  );
}

function createListBranchesTool(agent: Agent, task: Task) {
  return tool(
    'list_branches',
    'List branches created or visited by this agent in the current task. With no arguments, lists branches across every attached repo.',
    { github: githubArgSchema },
    async (args) => {
      const attachments = task.metadata.repositories[agent.def.id];
      if (!Array.isArray(attachments) || attachments.length === 0) {
        return ok('No attached repos.');
      }
      let filtered = attachments;
      if (args.github) {
        const resolved = resolveGithub(agent, args.github);
        if (!resolved.ok) return err(resolved.error);
        filtered = attachments.filter((a) => a.github === resolved.github);
      }
      const blocks = filtered.map((a) => {
        const current = a.current_branch || '(unknown)';
        const states = a.branch_states || {};
        const branches = Object.entries(states)
          .map(([name, s]) => `${name}${s.pr_number ? ` (PR #${s.pr_number})` : ''}`);
        return [
          `[${a.github}]`,
          `  Current: ${current}`,
          `  Branches: ${branches.join(', ') || '(none)'}`,
        ].join('\n');
      });
      return ok(blocks.join('\n\n'));
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

/** Pull a Slack file id (F…) out of a file permalink or a bare id. */
function extractSlackFileId(ref: string): string | null {
  const m =
    ref.match(/\/files\/[^/]+\/(F[0-9A-Z]+)/) || // /files/<U>/<F>/name permalink
    ref.match(/\b(F[0-9A-Z]{6,})\b/);            // bare F… id
  return m ? m[1] : null;
}

/** Make a referenced file's name safe to write into the workspace. */
function safeReferenceFileName(name: string, forceExt?: string): string {
  let base = (name.split('/').pop() || 'file').replace(/[^A-Za-z0-9._ -]/g, '_').trim() || 'file';
  if (forceExt && !base.toLowerCase().endsWith(forceExt)) base += forceExt;
  return base;
}

/**
 * `fetch_slack_reference` (PM-only) — pull a file referenced in the channel's
 * project-context canvas into the PM workspace so it can be read. The agent
 * never has to know whether the reference is a canvas or a plain file: the tool
 * inspects `files.info.filetype` and routes internally (canvas → converted
 * markdown; anything else → native bytes). The file lands in the PM's own
 * workspace, not shared — the PM decides what to do with it next.
 */
function createFetchSlackReferenceTool(agent: Agent, task: Task) {
  return tool(
    'fetch_slack_reference',
    'Fetch a file referenced in the channel\'s project-context canvas and save it into your workspace so you can read it. ' +
    'Pass the reference exactly as it appears in the canvas — a Slack file link or a file id. ' +
    'Documents and images are saved in their original form; a referenced canvas is saved as readable markdown.',
    {
      reference: z.string().describe(
        'A Slack file link (e.g. https://….slack.com/files/…/F…/name) or a bare file id (F…) taken from the channel canvas.',
      ),
    },
    async (args) => {
      const fileId = extractSlackFileId(args.reference);
      if (!fileId) {
        return err(`No Slack file id found in "${args.reference}". Pass a Slack file link or an F… id.`);
      }
      const cwd = requireSandbox(agent).cwd;
      try {
        const info = await getSlackFileInfo(fileId);
        if (!info) return err(`Could not load file ${fileId} — it may be inaccessible.`);

        if (info.filetype === 'quip') {
          const read = await readCanvas(fileId, info);
          if (!read) return err(`Could not read canvas ${fileId}.`);
          const dest = join(cwd, safeReferenceFileName(read.title || fileId, '.md'));
          await writeFile(dest, read.markdown);
          task.touch();
          return ok(`Saved to ${dest}.`);
        }

        const url = info.url_private_download || info.url_private;
        if (!url) return err(`File ${fileId} has no downloadable URL.`);
        const dest = join(cwd, safeReferenceFileName(info.name || info.title || fileId));
        await downloadSlackFile(url, dest);
        task.touch();
        return ok(`Saved to ${dest}.`);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );
}

// ---- MCP Server creation ----

/**
 * PM coordinator tools, split by concern. The PM also gets the shared
 * `agent-tools` server (send_message_to_agent, log_finding, share_artifact),
 * so those are not repeated here.
 */

/** User-facing communication (Slack messaging, lookups, channel control, reactions). */
export function createCommsMcpServer(agent: Agent, task: Task) {
  return createSdkMcpServer({
    name: 'comms-tools',
    version: '1.0.0',
    tools: [
      createPostToUserTool(agent, task),
      createPostFilesToUserTool(agent, task),
      createFindSlackUserTool(agent, task),
      createFindSlackChannelTool(agent, task),
      createMuteChannelTool(agent, task),
      createReactToMessageTool(agent, task),
      createUnreactFromMessageTool(agent, task),
      createGetMessageReactionsTool(agent, task),
      createFetchSlackReferenceTool(agent, task),
    ],
  });
}

/**
 * `list_available_repos` — PM discovers which repos the GitHub App can reach.
 * Tags repos already covered by a plugin specialist so PM prefers the
 * specialist over spawning a generic agent. Cached on the task for the turn.
 */
function createListAvailableReposTool(_agent: Agent, task: Task) {
  return tool(
    'list_available_repos',
    'List every GitHub repository this installation can reach. Use this before ' +
    '`spawn_repo_agent` to see what is available. Repos already covered by a ' +
    'plugin specialist are marked — prefer messaging that specialist over ' +
    'spawning a generic agent.',
    {},
    async () => {
      const client = getGitHubClient();
      if (!client) return err('GitHub client not configured');

      // Cache on the Task instance to avoid re-listing within a task.
      type Cached = Array<{ github: string; default_branch: string; description?: string }>;
      const t = task as Task & { _availableRepos?: Cached };
      let repos = t._availableRepos;
      if (!repos) {
        repos = await client.listAccessibleRepos();
        t._availableRepos = repos;
      }
      if (repos.length === 0) {
        return ok('No repositories accessible to this installation.');
      }
      const lines = repos.map((r) => {
        const owners = findAgentDefsContainingRepo(r.github);
        const primaryOf = owners.find((d) => d.repo!.primary === r.github);
        const tags: string[] = [];
        if (primaryOf) tags.push(`primary of ${primaryOf.id}`);
        else if (owners.length > 0) tags.push(`declared by ${owners.map((d) => d.id).join(', ')}`);
        const desc = r.description ? ` — ${r.description}` : '';
        const tagStr = tags.length > 0 ? ` [${tags.join('; ')}]` : '';
        return `- ${r.github} (default: ${r.default_branch})${tagStr}${desc}`;
      });
      return ok(`Repos accessible to this installation:\n${lines.join('\n')}`);
    },
  );
}

/**
 * `spawn_repo_agent` — PM creates an on-demand repo agent bound to a chosen
 * list of available repos. The agent eager-mounts all of them at spawn (first
 * = primary), behaving like a plugin-defined repo agent. Persisted in
 * `metadata.dynamic_agents` and added to the live `task.team`.
 *
 * Anti-duplication: rejects a repo already covered as a plugin specialist's
 * primary — PM should message that specialist instead.
 */
function createSpawnRepoAgentTool(agent: Agent, task: Task) {
  return tool(
    'spawn_repo_agent',
    [
      'Spawn an on-demand repo agent for one or more GitHub repos, chosen from',
      '`list_available_repos`. Use when no plugin specialist covers the repo(s)',
      'you need. All listed repos are mounted at spawn; the first is the primary',
      '(the default target for the agent\'s repo-tools).',
      '',
      'Prefer an existing plugin specialist when one exists — it has a curated',
      'prompt and skills. After spawning, `send_message_to_agent` to the returned',
      'id to give it work.',
    ].join('\n'),
    {
      shortname: z.string().regex(/^[a-z][a-z0-9-]*$/).describe(
        'Short identifier matching /^[a-z][a-z0-9-]*$/. The agent id becomes `<shortname>-<4hex>-agent`.',
      ),
      repos: z.array(z.object({
        github: z.string().describe('Github identifier, e.g. "org/repo"'),
        baseBranch: z.string().optional().describe('Base branch (default: the repo\'s default branch)'),
      })).min(1).describe('Repos this agent will work with. First entry is the primary.'),
      role: z.string().optional().describe('Short role description (default: "Generic engineer for <primary>")'),
      expertise: z.string().optional().describe('Detailed expertise string used in the agent\'s prompt'),
    },
    async (args) => {
      const agentName = agent.def.id as AgentName;
      const primary = args.repos[0].github;

      // Anti-duplication: a repo that's already a plugin specialist's primary
      // should be reached via that specialist, not a generic clone.
      for (const r of args.repos) {
        const conflict = findAgentDefsContainingRepo(r.github)
          .find((d) => d.pluginName !== '<dynamic>' && d.repo!.primary === r.github);
        if (conflict) {
          return err(
            `Repo "${r.github}" is already the primary of ${conflict.id}. ` +
            `Use send_message_to_agent with target=${conflict.id} instead of spawning a new agent.`,
          );
        }
      }

      // Validate every requested repo is reachable; fill in default branches.
      const client = getGitHubClient();
      if (!client) return err('GitHub client not configured');
      const resolvedRepos: Array<{ github: string; baseBranch: string }> = [];
      for (const r of args.repos) {
        const reachable = await client.resolveRepo(r.github);
        if (!reachable) {
          return err(
            `GitHub App cannot reach "${r.github}". Check it appears in ` +
            `list_available_repos (the App must be installed on it), then retry.`,
          );
        }
        resolvedRepos.push({ github: r.github, baseBranch: r.baseBranch || reachable.default_branch });
      }

      // Stable id; 4-hex suffix makes same-task shortname collisions negligible.
      const suffix = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
      const id = `${args.shortname}-${suffix}-agent`;

      const spec = {
        id,
        shortname: args.shortname,
        repos: resolvedRepos,
        role: args.role || `Generic engineer for ${primary}`,
        expertise: args.expertise || `Investigation and work in ${resolvedRepos.map((r) => r.github).join(', ')}.`,
      };

      task.metadata.dynamic_agents ??= [];
      task.metadata.dynamic_agents.push(spec);
      task.team.push(synthesizeDynamicAgentDef(spec));
      task.debouncedSave();

      await appendAgentFinding(
        task.taskId,
        agentName,
        `Spawned repo agent ${id} for ${resolvedRepos.map((r) => r.github).join(', ')}`,
        'decision',
      );

      return ok(
        `Spawned repo agent ${id} (primary: ${primary}). ` +
        `Use send_message_to_agent with target=${id} to give it work.`,
      );
    },
  );
}

/** Task orchestration (ownership, completion, edit mode, team status, repo-agent spawning). */
export function createOrchestrationMcpServer(agent: Agent, task: Task) {
  return createSdkMcpServer({
    name: 'orchestration-tools',
    version: '1.0.0',
    tools: [
      createAssignTaskOwnerTool(agent, task),
      createReportCompletionTool(agent, task),
      createRequestEditModeTool(agent, task),
      createRequestMaxModeTool(agent, task),
      createGetAgentsStatusTool(agent, task),
      createLaunchTaskTool(agent, task),
      createListAvailableReposTool(agent, task),
      createSpawnRepoAgentTool(agent, task),
    ],
  });
}

/** Scheduling (datetime parsing and reminders). */
export function createSchedulingMcpServer(agent: Agent, task: Task) {
  return createSdkMcpServer({
    name: 'scheduling-tools',
    version: '1.0.0',
    tools: [
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
      createGetCheckRunTool(agent, task),
      createGetPRReviewsTool(agent, task),
      createGetPRCommentsTool(agent, task),
      createGetReviewThreadsTool(agent, task),
      // Security / code scanning
      createListCodeScanningAlertsTool(agent, task),
      createGetCodeScanningAlertTool(agent, task),
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
 * Create the MCP server with base agent tools shared by every agent
 * (PM, repo, and plugin): inter-agent messaging, findings, and artifacts.
 */
export function createBaseAgentMcpServer(agent: Agent, task: Task) {
  return createSdkMcpServer({
    name: 'agent-tools',
    version: '1.0.0',
    tools: [
      createSendMessageTool(agent, task),
      createLogFindingTool(agent, task),
      createShareArtifactTool(agent, task),
    ],
  });
}
