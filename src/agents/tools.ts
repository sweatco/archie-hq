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
import type { AgentName, FindingType, AttachedRepo, SlackThreadMessage } from '../types/task.js';
import { Task } from '../tasks/task.js';
import type { Agent } from './agent.js';
import { getVisiblePeerIdsForSender, findAgentDefsContainingRepo, synthesizeDynamicAgentDef, isAutoMergeRepo } from './registry.js';
import { getGitHubClient, parseCheckRef } from '../connectors/github/client.js';
import { gitExec } from '../connectors/github/repo-clone.js';
import { hydrateBranchState, findBranchStateByPR, assignPrNumber } from '../connectors/github/branch-state.js';
import { taskBranchName } from '../connectors/github/branch-naming.js';
import { appendAgentFinding, appendArtifactShared } from '../tasks/persistence.js';
import { copyArtifactToShared, assertReadable } from './artifacts.js';
import { logger } from '../system/logger.js';
import {
  findSlackUsers,
  findSlackChannels,
  listBotChannels,
  getSlackFileInfo,
  downloadSlackFile,
  fetchChannelHistory,
  fetchExploreThread,
  postSlackMessage,
  assertPostableChannel,
  getChannelInfo,
  getUserInfo,
  listWorkspaceChannels,
  fetchChannelIsPrivate,
} from '../connectors/slack/client.js';
import { readCanvas } from '../connectors/slack/canvas-read.js';
import { collectCanvasFileAllowlist } from '../connectors/slack/channel-canvas.js';
import { isDmOrUserId } from '../connectors/slack/channel-ids.js';
import {
  formatSlackSendError,
  formatSlackPostError,
  formatSlackReadError,
} from '../connectors/slack/format-errors.js';

/**
 * Reject DM targets for the explore/post tools. These tools are channel-only;
 * 1:1 DM channel ids start with 'D', and a user id ('U'/'W') passed as a channel
 * would be coerced into a DM by Slack — block both. (Other private channels /
 * group DMs are caught at the API layer via assertAccessibleChannel.)
 */
function rejectDmTarget(channel: string): string | null {
  if (isDmOrUserId(channel)) {
    return 'This tool is channel-only and never touches DMs. Pass a channel ID (e.g. "C…"), not a DM or user ID.';
  }
  return null;
}

/**
 * The Slack channel ids THIS task is linked to (its own origin channel(s)).
 * Explore reads treat these as accessible regardless of type — so the PM can read
 * the private channel or DM the task itself lives in, but no other private/DM.
 */
function taskSlackChannelIds(task: Task): Set<string> {
  const ids = new Set<string>();
  for (const ch of Object.values(task.metadata.channels)) {
    if (ch.type === 'slack') ids.add(ch.channel_id);
  }
  return ids;
}

/** Render explore messages in the same `@<id:name> | msg:ts` shape the PM sees elsewhere. */
function formatExploreMessages(messages: SlackThreadMessage[]): string {
  return messages
    .map((m) => {
      const who = m.user.realName || m.user.username;
      const files = m.files?.length ? `\n  [files: ${m.files.map((f) => f.name).join(', ')}]` : '';
      const reactions = m.reactions?.length
        ? `\n  [reactions: ${m.reactions.map((r) => `:${r.name}:×${r.count}`).join(' ')}]`
        : '';
      return `<@${m.user.id}:${who}> | msg:${m.ts}\n${m.text}${files}${reactions}`;
    })
    .join('\n\n');
}
import { scheduleReminder, cancelReminder } from '../system/reminder-scheduler.js';
import * as chrono from 'chrono-node';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import type { Trigger, TriggerBinding, TriggerCondition } from '../types/trigger.js';
import {
  generateTriggerId,
  saveTrigger,
  loadTrigger,
  listTriggers,
  deleteTrigger,
  countActiveTriggers,
} from '../system/trigger-store.js';
import {
  computeNextRun,
  validateRecurringInterval,
  planStatusChange,
  indexTrigger,
  deindexTrigger,
  announceTriggerChange,
  describeTrigger,
  triggerWhat,
  triggerWhen,
  triggerWhere,
  triggersEnabled,
  MAX_TRIGGERS_PER_USER,
  MAX_TRIGGERS_PER_CHANNEL,
} from '../system/trigger-scheduler.js';
import { emitEvent } from '../system/event-bus.js';
import { triggerVisibleFrom, type TriggerOrigin } from '../system/trigger-visibility.js';

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
    'Send a message to the user in this task. Without target, posts to the default channel — wherever this task already lives (use that almost always). ' +
    'Use target.channel only to reach another thread ALREADY linked to this task. ' +
    'If this task lives in a channel thread, bring someone in by @mentioning them in that thread. ' +
    'To say something in a channel that is NOT part of this task (exploration/outreach), use `post_to_channel` — it deliberately does not link to this task. ' +
    'To attach files, send the message first, then call `post_files_to_user` with the same target.',
    {
      message: z.string().describe('The message to send'),
      target: z.object({
        channel: z.string().optional().describe('Channel key of an existing linked thread (e.g., "slack:C123:456.789")'),
      }).optional().describe('Where to post. Omit to post to the default channel.'),
    },
    async (args) => {
      const agentName = agent.def.id as AgentName;
      const hasTarget = !!args.target?.channel;
      if (!hasTarget && Object.keys(task.metadata.channels).length === 0) {
        return ok(
          'No channel is linked to this task, so there is nowhere to post. ' +
          'Call report_completion() without a message to finish silently.'
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
    'This tool only attaches files to threads already linked to this task (the default channel, or a linked `channel` key). It does not open new threads or DMs. ' +
    'Files are sent without accompanying text — call `post_to_user` separately for any message you want next to the files.',
    {
      paths: z.array(z.string()).min(1).describe('Absolute file paths to upload as Slack attachments'),
      channel: z.string().optional().describe('Channel key of an existing linked thread (e.g., "slack:C123:456.789"). Omit to post to the default channel.'),
    },
    async (args) => {
      const agentName = agent.def.id as AgentName;
      if (!args.channel && Object.keys(task.metadata.channels).length === 0) {
        return ok(
          'No channel is linked to this task, so there is nowhere to attach files.'
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

function createListChannelsTool(_agent: Agent, task: Task) {
  return tool(
    'list_channels',
    "List the channels you can read for THIS task — every PUBLIC channel Archie has been added to, plus this task's own channel if it happens to be a private channel or DM. " +
    'Use this to discover where you can explore instead of guessing channel names. It never lists other private channels or DMs. ' +
    '(Posting is broader — see post_to_channel — but reading is limited to this list.)',
    {},
    async () => {
      try {
        const publicChannels = await listBotChannels();
        // Append this task's OWN channels that aren't already public (its private
        // channel / DM origin) — accessible because the task lives there. Other
        // private channels / DMs are never enumerated.
        const seen = new Set(publicChannels.map((c) => c.id));
        const own: { name: string; id: string }[] = [];
        for (const ch of Object.values(task.metadata.channels)) {
          if (ch.type === 'slack' && !seen.has(ch.channel_id)) {
            seen.add(ch.channel_id);
            own.push({ name: ch.channel_name || ch.channel_id, id: ch.channel_id });
          }
        }
        if (publicChannels.length === 0 && own.length === 0) {
          return ok("Archie isn't a member of any channels you can use yet. Invite it to a channel (`/invite @Archie`) to explore there.");
        }
        const lines = [
          ...publicChannels.map((ch) => `- #${ch.name} — ID: ${ch.id}${ch.topic ? ` — ${ch.topic}` : ''}`),
          ...own.map((ch) => `- #${ch.name} — ID: ${ch.id} (this task's own channel)`),
        ];
        return ok(`Channels you can read${own.length ? " (public channels Archie's in, plus this task's own channel)" : ''}:\n${lines.join('\n')}`);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return ok(`Couldn't list channels: ${reason}`);
      }
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
          return ok(`Channel ${args.channel} is not linked to this task. Omit channel to use the default.`);
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

function createRequestMcpAuthTool(agent: Agent, task: Task) {
  return tool(
    'request_mcp_auth',
    'Escalate an OAuth MCP server from shared credentials to the 1:1 DM participant after an authorization or permission failure. Reuses existing personal credentials or sends an authorization link, then restarts with personal access.',
    {
      server: z.string().describe('MCP server name from the configuration (e.g. "notion")'),
      reason: z.string().optional().describe('One line on why access is needed — shown to the user on the authorization message'),
    },
    async (args) => {
      const agentName = agent.def.id as AgentName;

      // Already pausing this turn — skip a duplicate wall if the tool fires twice.
      if (agent.pendingTeardown) {
        return ok('Authorization request already sent — task is pausing until a user authorizes.');
      }

      if (!task.getMcpOAuthUser()) {
        return err('Per-user MCP OAuth is available only in a 1:1 Slack DM.');
      }

      logger.agentAction(agentName, 'Requesting MCP authorization', args.server);
      task.touch();

      let outcome: 'ready' | 'authorization_started';
      try {
        outcome = await task.requestMcpAuth(args.server, args.reason);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }

      if (outcome === 'ready') {
        agent.deferTeardown(async () => {
          await task.stop();
          // OAuth headers are fixed at agent spawn, so resume through a fresh task instance.
          const resumedTask = await Task.get(task.taskId);
          await resumedTask.sendMessage(
            `Use the DM user's personal credentials for MCP server "${args.server}" and continue the task.`,
            'pm-agent',
          );
        });
        return ok(
          `Existing personal authorization selected for "${args.server}". ` +
          'The task will restart with the DM user\'s access.',
        );
      }

      agent.deferTeardown(() => task.stop());
      return ok(
        `Authorization link sent for "${args.server}". Task paused until the DM user authorizes — ` +
        `you will be re-activated with access afterwards.`,
      );
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
            'Cannot post a completion message — no channel linked to this task. ' +
            'Call report_completion() without a message to finish silently.'
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

function createReadChannelHistoryTool(_agent: Agent, task: Task) {
  return tool(
    'read_channel_history',
    "Read a channel's recent messages to understand what's happening there — exploration only, NOT linked to this task. " +
    'Pass a channel ID (use list_channels or find_slack_channel). Returns messages oldest→newest, including Archie\'s own and other bots\' posts. ' +
    "Reading never creates or joins a task. Allowed for any PUBLIC channel Archie's in, plus this task's own channel if it is private or a DM — other private channels and DMs are off-limits.",
    {
      channel: z.string().describe('Slack channel ID (e.g. "C1234567")'),
      limit: z.number().int().min(1).max(100).optional().describe('How many recent messages to read (default 30, max 100)'),
    },
    async (args) => {
      const allowed = taskSlackChannelIds(task);
      if (!allowed.has(args.channel)) {
        const dm = rejectDmTarget(args.channel);
        if (dm) return ok(dm);
      }
      try {
        const { channel, messages } = await fetchChannelHistory(args.channel, args.limit ?? 30, allowed);
        if (messages.length === 0) return ok(`#${channel.name} has no readable recent messages.`);
        return ok(`#${channel.name} — last ${messages.length} message(s):\n\n${formatExploreMessages(messages)}`);
      } catch (e) {
        return ok(formatSlackReadError(e, args.channel));
      }
    },
  );
}

function createReadThreadTool(_agent: Agent, task: Task) {
  return tool(
    'read_thread',
    'Read a specific thread (parent message + all replies) — exploration only, NOT linked to this task. ' +
    'Pass the channel ID and the parent message ts (from read_channel_history). Includes Archie\'s own and other bots\' messages. ' +
    "Allowed for any PUBLIC channel Archie's in, plus this task's own channel if it is private or a DM — other private channels and DMs are off-limits.",
    {
      channel: z.string().describe('Slack channel ID (e.g. "C1234567")'),
      thread_ts: z.string().describe('Parent message ts of the thread (e.g. "1716998400.123456")'),
    },
    async (args) => {
      const allowed = taskSlackChannelIds(task);
      if (!allowed.has(args.channel)) {
        const dm = rejectDmTarget(args.channel);
        if (dm) return ok(dm);
      }
      try {
        const { channel, messages } = await fetchExploreThread(args.channel, args.thread_ts, allowed);
        if (messages.length === 0) return ok(`No messages found in that thread.`);
        return ok(`#${channel.name} thread ${args.thread_ts} — ${messages.length} message(s):\n\n${formatExploreMessages(messages)}`);
      } catch (e) {
        return ok(formatSlackReadError(e, args.channel));
      }
    },
  );
}

function createPostToChannelTool(_agent: Agent, task: Task) {
  return tool(
    'post_to_channel',
    'Post a message into any channel Archie is a member of, WITHOUT linking it to this task — for chiming in while exploring, or escalating somewhere (e.g. a private management channel). ' +
    "Works in PUBLIC and PRIVATE channels Archie has been invited to (DMs are not allowed). Unlike reading, posting is NOT limited to this task's channel — escalating outward is a valid use. " +
    'Fire-and-forget: it does not become a touchpoint of this task, and any reply is invisible to you here. If a human replies to a NEW top-level message you post, that reply starts its OWN fresh task; a reply inside someone else\'s existing thread never does. ' +
    "GUARDRAIL: match what you post to the destination's audience — never relay private or sensitive task content into a broader or unrelated channel. " +
    'Pass a channel ID; optionally `thread_ts` to reply in an existing thread. To talk to the user about THIS task, use post_to_user instead.',
    {
      channel: z.string().describe('Slack channel ID (e.g. "C1234567")'),
      message: z.string().describe('The message to post'),
      thread_ts: z.string().optional().describe('Parent message ts to reply inside an existing thread; omit to post a new top-level message'),
    },
    async (args) => {
      const dm = rejectDmTarget(args.channel);
      if (dm) return ok(dm);
      task.touch();
      try {
        // The prefix check above rejects 1:1 DMs/user ids; this rejects group DMs
        // (mpims), which share the ambiguous `G…` prefix with private channels.
        await assertPostableChannel(args.channel);
        const ts = await postSlackMessage({ channel: args.channel, text: args.message, threadTs: args.thread_ts });
        return ok(
          ts
            ? `Message posted to ${args.channel}${args.thread_ts ? ` (in thread ${args.thread_ts})` : ` (new thread ts: ${ts})`}. Not linked to this task.`
            : 'Message posted (dry-run).',
        );
      } catch (e) {
        return ok(formatSlackPostError(e, args.channel));
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
        // Reset per-PR markers when this branch's pr_number changes — a reused
        // branch must not inherit the previous PR's merge_armed / merge_ready.
        assignPrNumber(state, result.pr_number);
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
    'Merge a pull request, subject to the repo\'s merge policy. On an auto-merge repo it merges directly if the PR is clean (returns the current status otherwise). On any other repo it posts an auto-merge approval request and pauses the task; once the user approves, the PR is armed to merge automatically as soon as all checks and required reviews pass. Works for any open PR — it does not require the PR to be mergeable yet.',
    { pr_number: z.number().describe('The PR number'), github: githubArgSchema },
    async (args) => {
      const resolved = resolveGithub(agent, args.github);
      if (!resolved.ok) return err(resolved.error);
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');

      if (isAutoMergeRepo(resolved.github)) {
        const status = await client.getPRStatus(resolved.github, args.pr_number);
        if (status.state !== 'open') {
          return ok(`Cannot merge: PR #${args.pr_number} (${resolved.github}) is ${status.state}`);
        }
        // Auto repo direct merge: clean-only (no blocked tolerance). A non-clean
        // PR returns the not-ready message and does not merge.
        if (status.mergeableState !== 'clean') {
          return ok(`Cannot merge: PR #${args.pr_number} (${resolved.github}) is not ready (mergeable=${status.mergeable}, state=${status.mergeableState})`);
        }

        const result = await client.mergePullRequest(resolved.github, args.pr_number);
        return { content: [{ type: 'text' as const, text: result.message }] };
      }

      // Non-auto repo: merging requires a user-approved `merge` gate. The
      // suppression-vs-supersede fork applies only when a merge slot is set —
      // a parked teardown with an empty slot belongs to some other approval
      // type (edit mode, research budget) and neither suppresses nor
      // supersedes a first merge request.
      const pending = task.metadata.pending_merge_approval;
      if (pending) {
        // Task-level quiescence (same predicate as idleDecision): the slot is
        // per-task while pendingTeardown is per-agent, so a concurrently
        // running second repo agent must not misread a seconds-old request as
        // stale and supersede it.
        const parked = [...task.agentProcesses.values()].some((a) => a.pendingTeardown);
        if (parked) {
          return ok(`Merge approval already pending for ${pending.github}#${pending.pr_number} — task is pausing until the user approves or denies it.`);
        }
        // Slot set but nobody parked: the task was reactivated without the
        // prompt being resolved — supersede the stale slot with this request.
      }

      // Non-auto repo: approving now means "merge as soon as it is ready". The
      // human approval is the gate; the merge is delegated to the orchestrator's
      // armed bucket. Prompt for ANY open PR — a not-yet-green PR is correct to
      // approve (it merges when checks pass). Only bail on a closed/merged PR.
      const status = await client.getPRStatus(resolved.github, args.pr_number);
      if (status.state !== 'open') {
        return ok(`Cannot merge: PR #${args.pr_number} (${resolved.github}) is ${status.state}`);
      }

      const agentName = agent.def.id as AgentName;
      logger.agentAction(agentName, 'Requesting merge approval', `${resolved.github}#${args.pr_number}`);
      task.touch();

      await appendAgentFinding(task.taskId, 'system', `Merge approval requested for ${resolved.github}#${args.pr_number}`, 'decision');

      const buttonValue = `${task.taskId}|${resolved.github}#${args.pr_number}`;
      const blocks = [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Merge request:* Approve auto-merge for PR #${args.pr_number} (${resolved.github})? It will merge automatically once all checks and required reviews pass.` },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Approve merge' },
              action_id: 'approve_merge',
              value: buttonValue,
              style: 'primary',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Deny' },
              action_id: 'deny_merge',
              value: buttonValue,
              style: 'danger',
            },
          ],
        },
      ];
      await task.postInteractiveToUser(
        `Approve auto-merge for PR #${args.pr_number} (${resolved.github})? It will merge automatically once all checks and required reviews pass.`,
        blocks,
        'merge',
        undefined,
        { github: resolved.github, pr_number: args.pr_number },
      );

      task.metadata.pending_merge_approval = {
        github: resolved.github,
        pr_number: args.pr_number,
        requested_by: agent.def.id,
        requested_at: new Date().toISOString(),
      };
      task.debouncedSave();

      // Task is now paused pending approval — freeze the status so the
      // wind-down doesn't resurface a "working…" indicator, and defer the pause
      // to turn-end (see report_completion) so stopping the queue doesn't close
      // the input stream under an in-flight hook ("stream closed").
      task.suspendStatus();
      agent.deferTeardown(() => task.stop());
      return { content: [{ type: 'text' as const, text: 'Merge approval requested. Task paused pending user approval.' }] };
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
    'Set a reminder to be woken up at a future time (within 30 days). The task is reactivated and you receive a prompt with the reason. This is the durable way to schedule a follow-up, monitor, or "check back later" — it survives restarts. For recurring monitoring, re-arm on each wake by calling set_reminder again (a self-rescheduling one-shot); native recurring/cron-style triggers are planned but not available yet. Only one reminder can be pending — calling this replaces any existing one. Use parse_datetime first to get the correct ISO 8601 value.',
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
      // Scope to canvas-referenced files only: the bot token can read far more
      // of the workspace than this task should reach, so an unscoped id would
      // let prompt-influenced input exfiltrate arbitrary accessible files.
      const allowed = await collectCanvasFileAllowlist(task.metadata);
      if (!allowed.has(fileId)) {
        return err(
          `File ${fileId} is not referenced by an adopted channel canvas for this task — only the canvas itself or files it references can be fetched.`,
        );
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

// ============================================================================
// Trigger tools (PM-only) — propose / list / update / delete persistent triggers
// ============================================================================

/** Zod shape for one tool-supplied trigger condition (shared by propose/update). */
const triggerConditionObject = z.object({
  type: z.enum(['schedule', 'channel_message']),
  cron: z.string().optional().describe('5-field cron expression for a RECURRING schedule (e.g. "0 9 * * 1-5"). Must fire at most once per hour. Omit for one-off.'),
  run_at: z.string().optional().describe('ISO 8601 datetime for a ONE-OFF schedule (use parse_datetime). Omit for recurring.'),
  tz: z.string().optional().describe('IANA timezone, e.g. "America/New_York". Defaults to the requesting user\'s timezone.'),
  channel_id: z.string().optional().describe('Channel to watch (required for channel_message).'),
  contains: z.string().optional().describe('Only fire when the new message contains this substring (channel_message).'),
  from_user: z.string().optional().describe('Only fire for messages from this Slack user ID (channel_message).'),
});

type RawCondition = z.infer<typeof triggerConditionObject>;

/**
 * Resolve the task's originating context for trigger visibility. A Slack non-DM
 * channel → channel origin; a Slack DM → dm origin (with the partner's user id);
 * a CLI/absent default → operator (full visibility, matching the CLI surface).
 */
async function resolveTriggerOrigin(task: Task): Promise<TriggerOrigin> {
  const key = task.metadata.default_channel;
  const ch = key ? task.metadata.channels[key] : null;
  if (!ch || ch.type !== 'slack') return { kind: 'operator' };
  try {
    const info = await getChannelInfo(ch.channel_id);
    if (info.isIm) return { kind: 'dm', userId: info.imUserId };
    return { kind: 'channel', channelId: ch.channel_id };
  } catch {
    // Fail closed: a Slack lookup failure must not widen visibility. Treat the
    // origin as this exact channel (sees public + its own triggers only), never
    // operator. A DM misclassified this way under-permits, which is the safe way.
    return { kind: 'channel', channelId: ch.channel_id };
  }
}

/** Memoized live channel-privacy resolver for one list/visibility pass. */
function makePrivacyResolver(): (channelId: string) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  // Built once per resolver: the workspace channel map (id → isPrivate), served
  // from listWorkspaceChannels()'s 10-min process-wide cache. The common case is
  // then an O(1) lookup with zero per-channel Slack calls. On a workspace-list
  // failure the map is empty and every channel falls through to the live path.
  let mapPromise: Promise<Map<string, boolean>> | undefined;
  const workspaceMap = () => {
    if (!mapPromise) {
      mapPromise = listWorkspaceChannels()
        .then((channels) => new Map(channels.map((c) => [c.id, c.isPrivate])))
        .catch(() => new Map<string, boolean>());
    }
    return mapPromise;
  };
  return (channelId: string) => {
    let p = cache.get(channelId);
    if (!p) {
      p = workspaceMap().then((map) => {
        if (map.has(channelId)) return map.get(channelId)!;
        // Miss — a brand-new, just-converted, or (crucially) a private channel
        // the bot was removed from and so dropped out of the workspace cache.
        // Resolve it live via the STRICT lookup that throws on error, and fail
        // closed on any error (treat as private) so a private channel is never
        // leaked into a public/DM listing. getChannelInfo can't be used here —
        // it swallows errors and returns isPrivate:false (i.e. fails open).
        return fetchChannelIsPrivate(channelId).catch(() => true);
      });
      cache.set(channelId, p);
    }
    return p;
  };
}

/** Best-effort Slack user id of whoever is asking (only known in a DM). */
async function resolveRequester(task: Task): Promise<string | undefined> {
  const origin = await resolveTriggerOrigin(task);
  return origin.kind === 'dm' ? origin.userId : undefined;
}

/**
 * Validate + normalize tool-supplied conditions into stored TriggerConditions.
 * Recurring schedules are interval-checked (≥1h) and get an initial next_run_at;
 * one-offs parse run_at and must be in the future.
 */
function buildConditions(raw: RawCondition[], defaultTz: string): { conditions: TriggerCondition[] } | { error: string } {
  const conditions: TriggerCondition[] = [];
  for (const c of raw) {
    if (c.type === 'schedule') {
      const tz = c.tz || defaultTz;
      if (c.cron) {
        const v = validateRecurringInterval(c.cron, tz);
        if (!v.ok) return { error: v.error };
        const next = computeNextRun(c.cron, tz);
        if (!next) return { error: `Could not compute the next run for cron "${c.cron}".` };
        conditions.push({ type: 'schedule', tz, cron: c.cron, next_run_at: next.toISOString() });
      } else if (c.run_at) {
        const when = new Date(c.run_at);
        if (isNaN(when.getTime())) return { error: `Invalid run_at "${c.run_at}" — use parse_datetime for an ISO 8601 value.` };
        if (when.getTime() <= Date.now()) return { error: 'A one-off schedule must be in the future.' };
        conditions.push({ type: 'schedule', tz, next_run_at: when.toISOString() });
      } else {
        return { error: 'A schedule condition needs either `cron` (recurring) or `run_at` (one-off).' };
      }
    } else if (c.type === 'channel_message') {
      if (!c.channel_id) return { error: 'A channel_message condition needs `channel_id`.' };
      const match: { contains?: string; from_user?: string } = {};
      if (c.contains) match.contains = c.contains;
      if (c.from_user) match.from_user = c.from_user;
      conditions.push({ type: 'channel_message', channel_id: c.channel_id, ...(Object.keys(match).length ? { match } : {}) });
    } else {
      return { error: `Unknown condition type "${(c as { type: string }).type}".` };
    }
  }
  if (conditions.length === 0) return { error: 'At least one condition is required.' };
  return { conditions };
}

function createProposeTriggerTool(agent: Agent, task: Task) {
  return tool(
    'propose_trigger',
    'Propose a persistent trigger ("do Y when X happens") for the user to approve. The trigger is created in a pending state and an Approve/Deny prompt is posted — it will NOT run until the user approves. Use this after you and the user have agreed on the cadence (or channel to watch), what to do, and which channel to deliver to. Results are delivered to a channel; delivery to a user DM is not supported yet. You do not need to pause the task.',
    {
      binding: z.object({
        type: z.enum(['channel']),
        channel_id: z.string().describe('Slack channel ID where fired results are delivered.'),
        channel_name: z.string().describe('Channel name without the leading #.'),
      }).describe('Where fired results are delivered — a channel (DM delivery is not supported yet).'),
      conditions: z.array(triggerConditionObject).min(1).describe('One or more conditions; any match fires the trigger.'),
      action_prompt: z.string().describe('The full internal instruction seeded to the task when the trigger fires — detailed and imperative. NOT shown to the user.'),
      summary: z.string().describe('A short, friendly one-liner describing what this does, shown to the user in the approval prompt and announcements, e.g. "Daily summary of #bot-test" or "Reply to messages mentioning Archie". Keep it under ~60 chars; do not restate the schedule (that is rendered automatically).'),
    },
    async (args) => {
      if (!triggersEnabled()) return ok('Triggers are currently disabled on this instance (ARCHIE_TRIGGERS_ENABLED=false).');

      const b = args.binding;
      if (!b.channel_id || !b.channel_name) return ok('A trigger needs both channel_id and channel_name for delivery.');
      const binding: TriggerBinding = { type: 'channel', channel_id: b.channel_id, channel_name: b.channel_name };

      // Best-effort creator id (only known in a DM) — used for cap accounting and
      // failure notices, not for delivery. Triggers deliver to a channel in v1.
      const createdBy = await resolveRequester(task);
      let defaultTz = 'UTC';
      if (createdBy) {
        try { defaultTz = (await getUserInfo(createdBy)).tz || 'UTC'; } catch { /* keep UTC */ }
      }

      const built = buildConditions(args.conditions, defaultTz);
      if ('error' in built) return ok(`Could not create the trigger: ${built.error}`);

      if (binding.type === 'channel') {
        const channelId = binding.channel_id;
        const perChannel = await countActiveTriggers((t) => t.binding.type === 'channel' && t.binding.channel_id === channelId);
        if (perChannel >= MAX_TRIGGERS_PER_CHANNEL) {
          return ok(`This channel already has the maximum of ${MAX_TRIGGERS_PER_CHANNEL} active triggers. Remove one first.`);
        }
      }
      if (createdBy) {
        const perUser = await countActiveTriggers((t) => t.created_by === createdBy);
        if (perUser >= MAX_TRIGGERS_PER_USER) {
          return ok(`You already have the maximum of ${MAX_TRIGGERS_PER_USER} active triggers. Remove one first.`);
        }
      }

      const trigger: Trigger = {
        id: generateTriggerId(),
        status: 'pending',
        created_by: createdBy || 'unknown',
        created_at: new Date().toISOString(),
        binding,
        conditions: built.conditions,
        action: { prompt: args.action_prompt },
        summary: args.summary,
      };
      await saveTrigger(trigger);
      task.metadata.pending_trigger_id = trigger.id;
      task.debouncedSave();
      await appendAgentFinding(task.taskId, 'system', `Trigger proposed: ${describeTrigger(trigger)}`, 'decision');

      // Scannable approval card: what / when / where as separate fields instead
      // of dumping the raw cron + internal prompt.
      const what = triggerWhat(trigger);
      const when = triggerWhen(trigger);
      const where = triggerWhere(trigger);
      const blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: '*Set up this automation?*' } },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*What*\n${what}` },
            { type: 'mrkdwn', text: `*When*\n${when}` },
            { type: 'mrkdwn', text: `*Where*\n${where}` },
          ],
        },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: 'Approve' }, action_id: 'approve_trigger', value: trigger.id, style: 'primary' },
            { type: 'button', text: { type: 'plain_text', text: 'Deny' }, action_id: 'deny_trigger', value: trigger.id, style: 'danger' },
          ],
        },
      ];
      await task.postInteractiveToUser(`Set up this automation? ${what} · ${when} · ${where}`, blocks, 'trigger', undefined, undefined, trigger.id);
      return ok('Trigger proposed and posted for approval. It will not run until the user approves (or types y in the CLI). No need to pause — continue if there is other work.');
    },
  );
}

function createListTriggersTool(_agent: Agent, task: Task) {
  return tool(
    'list_triggers',
    'List the triggers visible from this conversation (per privacy rules). Returns everything visible — filter or narrow it yourself when the user asks for "the ones in this channel", "just the schedules", etc.',
    {},
    async () => {
      const all = (await listTriggers()).filter((t) => t.status !== 'pending');
      const origin = await resolveTriggerOrigin(task);
      const resolvePrivacy = makePrivacyResolver();
      const visible: Trigger[] = [];
      for (const t of all) {
        if (await triggerVisibleFrom(t, origin, resolvePrivacy)) visible.push(t);
      }
      if (visible.length === 0) return ok('There are no triggers set up that are visible from here.');
      const lines = visible.map((t) => {
        const where = t.binding.type === 'channel' ? `#${t.binding.channel_name}` : 'a DM';
        const last = t.last_fired_at ? `; last fired ${t.last_fired_at}` : '';
        return `• [${t.id}] (${t.status}) ${describeTrigger(t)} — delivers to ${where}${last}`;
      });
      return ok(`Triggers visible here (${visible.length}):\n${lines.join('\n')}`);
    },
  );
}

function createUpdateTriggerTool(_agent: Agent, task: Task) {
  return tool(
    'update_trigger',
    'Pause, resume, or edit an existing trigger. You can only manage triggers visible from this conversation. Posts a one-line change notice to the trigger\'s bound channel.',
    {
      id: z.string().describe('Trigger ID (from list_triggers).'),
      status: z.enum(['paused', 'enabled']).optional().describe('"paused" to pause, "enabled" to resume.'),
      action_prompt: z.string().optional().describe('Replace the internal instruction run when the trigger fires (not shown to the user).'),
      summary: z.string().optional().describe('Replace the short, friendly user-facing name. Update this whenever you change action_prompt so the notices stay accurate.'),
      conditions: z.array(triggerConditionObject).optional().describe('Replace the conditions entirely (same shape as propose_trigger).'),
    },
    async (args) => {
      const trigger = await loadTrigger(args.id);
      if (!trigger || trigger.status === 'pending') return ok(`No trigger ${args.id} found.`);
      const origin = await resolveTriggerOrigin(task);
      if (!(await triggerVisibleFrom(trigger, origin, makePrivacyResolver()))) {
        return ok(`Trigger ${args.id} isn't visible from here, so it can't be managed from this conversation.`);
      }

      const editedContent = Boolean(args.action_prompt || args.conditions || args.summary);
      let statusChange: 'paused' | 'resumed' | null = null;

      if (args.action_prompt) trigger.action.prompt = args.action_prompt;
      if (args.summary) trigger.summary = args.summary;
      if (args.conditions) {
        const defaultTz = trigger.conditions.find((c): c is Extract<TriggerCondition, { type: 'schedule' }> => c.type === 'schedule')?.tz || 'UTC';
        const built = buildConditions(args.conditions, defaultTz);
        if ('error' in built) return ok(`Could not update the trigger: ${built.error}`);
        trigger.conditions = built.conditions;
      }
      // Decide the target state (auto-resume a rescheduled paused trigger, etc.)
      // via the pure planner, then apply the cap check for any (re-)enable.
      const plan = planStatusChange({
        currentStatus: trigger.status as 'enabled' | 'paused',
        hasNewConditions: !!args.conditions,
        requestedStatus: args.status,
      });
      const autoResume = plan.autoResume;
      if (plan.target === 'enabled') {
        // Re-check caps when (re-)enabling, so pausing to slip under a cap and
        // then resuming can't exceed it. (Counts exclude this paused trigger.)
        if (trigger.binding.type === 'channel') {
          const channelId = trigger.binding.channel_id;
          const perChannel = await countActiveTriggers((t) => t.binding.type === 'channel' && t.binding.channel_id === channelId);
          if (perChannel >= MAX_TRIGGERS_PER_CHANNEL) return ok(`Can't enable — this channel is already at the maximum of ${MAX_TRIGGERS_PER_CHANNEL} active triggers.`);
        }
        if (trigger.created_by && trigger.created_by !== 'unknown') {
          const perUser = await countActiveTriggers((t) => t.created_by === trigger.created_by);
          if (perUser >= MAX_TRIGGERS_PER_USER) return ok(`Can't enable — you're already at the maximum of ${MAX_TRIGGERS_PER_USER} active triggers.`);
        }
      }
      if (plan.target !== 'unchanged') {
        trigger.status = plan.target;
        statusChange = plan.statusChange;
      }

      if (!editedContent && !statusChange) return ok('Nothing to update — pass status, action_prompt, summary, or conditions.');

      await saveTrigger(trigger);
      if (trigger.status === 'enabled') indexTrigger(trigger);
      else deindexTrigger(trigger.id);

      if (statusChange === 'paused') emitEvent('trigger:paused', task.taskId, { trigger_id: trigger.id });
      else if (statusChange === 'resumed') emitEvent('trigger:resumed', task.taskId, { trigger_id: trigger.id });

      await announceTriggerChange(trigger, editedContent ? 'edited' : statusChange!);

      // Report state back so the PM can relay it — especially the auto-resume,
      // which the user didn't explicitly ask for and should be told about.
      const verb = editedContent ? 'updated' : (statusChange === 'paused' ? 'paused' : 'resumed');
      let msg = `Trigger ${trigger.id} ${verb}.`;
      if (statusChange === 'resumed') {
        msg += autoResume
          ? ` It had been paused, so I re-enabled it — it's now active and will run ${triggerWhen(trigger)}.`
          : ` It's now active and will run ${triggerWhen(trigger)}.`;
      } else if (trigger.status === 'enabled' && editedContent) {
        msg += ` It's active and will run ${triggerWhen(trigger)}.`;
      } else if (trigger.status === 'paused') {
        msg += ` It's paused and won't run until it's resumed.`;
      }
      return ok(msg);
    },
  );
}

function createDeleteTriggerTool(_agent: Agent, task: Task) {
  return tool(
    'delete_trigger',
    'Delete a trigger permanently. You can only delete triggers visible from this conversation. Posts a one-line notice to the bound channel.',
    {
      id: z.string().describe('Trigger ID (from list_triggers).'),
    },
    async (args) => {
      const trigger = await loadTrigger(args.id);
      if (!trigger) return ok(`No trigger ${args.id} found.`);
      const origin = await resolveTriggerOrigin(task);
      if (trigger.status !== 'pending' && !(await triggerVisibleFrom(trigger, origin, makePrivacyResolver()))) {
        return ok(`Trigger ${args.id} isn't visible from here, so it can't be deleted from this conversation.`);
      }
      deindexTrigger(trigger.id);
      await deleteTrigger(trigger.id);
      emitEvent('trigger:deleted', task.taskId, { trigger_id: trigger.id });
      if (trigger.status !== 'pending') await announceTriggerChange(trigger, 'deleted');
      return ok(`Trigger ${trigger.id} deleted.`);
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
      createListChannelsTool(agent, task),
      createReadChannelHistoryTool(agent, task),
      createReadThreadTool(agent, task),
      createPostToChannelTool(agent, task),
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
      createListAvailableReposTool(agent, task),
      createSpawnRepoAgentTool(agent, task),
      createProposeTriggerTool(agent, task),
      createListTriggersTool(agent, task),
      createUpdateTriggerTool(agent, task),
      createDeleteTriggerTool(agent, task),
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
      createRequestMcpAuthTool(agent, task),
    ],
  });
}
