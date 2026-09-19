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
import type { AttachedRepo, SlackThreadMessage } from '../types/task.js';
import type { Task } from '../tasks/task.js';
import type { Agent } from './agent.js';
import { isAutoMergeRepo } from './registry.js';
import { getGitHubClient, parseCheckRef, getArchieAttributionIdentity } from '../connectors/github/client.js';
import { buildAttributedBody } from '../connectors/github/pr-attribution.js';
import { gitExec, ensureTaskClone, recordedBaseBranch } from '../connectors/github/repo-clone.js';
import { hydrateBranchState, findBranchStateByPR, assignPrNumber } from '../connectors/github/branch-state.js';
import { taskBranchName } from '../connectors/github/branch-naming.js';
import { appendAgentFinding, isThreadMuted, getTaskClonePath } from '../tasks/persistence.js';
import { getBaseCachePath } from '../system/workdir.js';
import { exploreBody } from '../connectors/slack/message-body.js';
import { assertReadable } from './artifacts.js';
import { aggregateTaskUsage, formatTaskUsageReport } from './task-usage.js';
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
import {
  collectCanvasFileAllowlist,
  ensureChannelCanvas,
  buildOtherChannelContextSection,
} from '../connectors/slack/channel-canvas.js';
import { collectPinnedFileAllowlist } from '../connectors/slack/channel-pins.js';
import { isDmOrUserId, findMutedTarget, taskSlackChannelIds, taskSlackChannelLabels } from '../connectors/slack/channel-ids.js';
import {
  formatSlackSendError,
  formatSlackPostError,
  formatSlackReadError,
  formatMutedTargetRefusal,
  formatCrossTaskMuteRefusal,
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
 * The Slack channel ids THIS task is linked to (its own origin channel(s)), plus the
 * home channel a trigger-fired task has before it opens its own thread there.
 * Explore reads treat these as accessible regardless of type — so the PM can read
 * the private channel or DM the task itself lives in, but no other private/DM.
 *
 * Delegates to the shared derivation so the channels a task may READ are the same ones whose standing context it was given: a task homed in a private channel is handed that channel's pin index on its first turn, and refusing to let it read the channel that index describes made its own prompt incoherent for exactly one turn.
 */
function taskChannelIds(task: Task): Set<string> {
  return taskSlackChannelIds(task.metadata);
}

/** Render explore messages in the same `@<id:name> | msg:ts` shape the PM sees elsewhere. */
export function formatExploreMessages(messages: SlackThreadMessage[]): string {
  return messages
    .map((m) => {
      const who = m.user.realName || m.user.username;
      // `exploreBody` is the one sanctioned never-redacted render, and it is named rather than an inline `redacted: false` so that decision is greppable and auditable in a single place. Explore is deliberately unredacted because the agent asked to look at this channel: redacting here would hand back a wall of placeholders instead of the content it went to read. `SlackChannelMessages` accordingly carries no `shared` field — there is nothing here for a redaction policy to consult.
      const body = exploreBody(m);
      return `<@${m.user.id}:${who}> | msg:${m.ts}\n${body}`;
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
import { isSlackAuthorId, isAppAuthorId } from '../system/trigger-match.js';

// Re-export branch state helpers for consumers that import from tools.ts
export { hydrateBranchState, findBranchStateByPR };

/** GitHub repo identifiers are case-insensitive; the task records one casing. */
function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Accept what people paste — a clone URL, a browser URL, a trailing `.git` —
 * and return the bare `owner/repo`, or null when it is not one.
 */
export function normalizeGithubRef(raw: string): string | null {
  const trimmed = raw
    .trim()
    .replace(/^git@github\.com:/i, '')
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : null;
}

/**
 * Resolve a repo mounted into this task by its `github` identifier.
 *
 * The repositories list is flat and task-scoped, so there is nothing to key on
 * but the identifier. Returns undefined when the repo is not mounted.
 */
function getAttached(task: Task, github?: string): AttachedRepo | undefined {
  const mounted = task.metadata.repositories;
  if (!github) return mounted.length === 1 ? mounted[0] : undefined;
  return mounted.find((a) => sameRepo(a.github, github));
}

/**
 * Resolve the github identifier for a tool call.
 *
 * There is no per-agent repo whitelist — the GitHub App installation is the
 * allowlist and `mount_repo` is the gate. When the caller omits `github`, the
 * task's single mounted repo is the default; with several mounted, the
 * argument is required.
 */
function resolveGithub(task: Task, requested?: string): { ok: true; github: string } | { ok: false; error: string } {
  const mounted = task.metadata.repositories;
  if (requested) {
    // Answer with the identifier as this task recorded it, so casing typed by
    // the caller cannot split one mounted repo into two.
    const match = mounted.find((a) => sameRepo(a.github, requested));
    return { ok: true, github: match?.github ?? requested };
  }
  if (mounted.length === 1) return { ok: true, github: mounted[0].github };
  if (mounted.length === 0) {
    return { ok: false, error: 'No repository is mounted in this task. Call mount_repo first.' };
  }
  return {
    ok: false,
    error: `Several repos are mounted (${mounted.map((a) => a.github).join(', ')}) — pass the \`github\` argument to say which one.`,
  };
}

/**
 * Resolve and require that the github has a local clone available.
 *
 * The error tells the agent to mount rather than retry blindly.
 */
function requireAttached(task: Task, requested?: string): { ok: true; github: string; attached: AttachedRepo } | { ok: false; error: string } {
  const resolved = resolveGithub(task, requested);
  if (!resolved.ok) return resolved;
  const attached = getAttached(task, resolved.github);
  if (!attached?.clone_path) {
    return { ok: false, error: `Repo "${resolved.github}" has no local clone. Call mount_repo("${resolved.github}") first.` };
  }
  return { ok: true, github: resolved.github, attached };
}

const githubArgSchema = z.string().optional().describe(
  'Github identifier (e.g. "org/repo") of a repo mounted in this task. Optional when exactly one repo is mounted.',
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

// ---- PM tools ----

function createPostToUserTool(agent: Agent, task: Task) {
  return tool(
    'post_to_user',
    'Send a message to the user in this task. Without target, posts to the default channel — wherever this task already lives (use that almost always). ' +
    'Use target.channel only to reach another thread ALREADY linked to this task. ' +
    'If this task lives in a channel thread, bring someone in by @mentioning them in that thread. ' +
    'To say something in a channel that is NOT part of this task (exploration/outreach), use `post_to_channel` — it deliberately does not link to this task. ' +
    'A muted channel is refused. ' +
    'To attach files, send the message first, then call `post_files_to_user` with the same target.',
    {
      message: z.string().describe('The message to send'),
      target: z.object({
        channel: z.string().optional().describe('Channel key of an existing linked thread (e.g., "slack:C123:456.789")'),
      }).optional().describe('Where to post. Omit to post to the default channel.'),
    },
    async (args) => {
      const agentName = agent.def.id;
      const hasTarget = !!args.target?.channel;
      // A trigger-fired task has no thread yet but does have a home channel, and this call is exactly what opens that thread — so "no channels" is only "nowhere to post" when there is no home channel either.
      if (!hasTarget && Object.keys(task.metadata.channels).length === 0 && !task.metadata.home_channel) {
        return ok(
          'No channel is linked to this task, so there is nowhere to post. ' +
          'Call report_completion() without a message to finish silently.'
        );
      }
      const mutedKey = args.target?.channel ?? task.metadata.default_channel;
      const muted = mutedKey ? findMutedTarget(task.metadata.channels, mutedKey) : null;
      if (muted) return ok(formatMutedTargetRefusal(muted.channel_name));
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
      const agentName = agent.def.id;
      if (!args.channel && Object.keys(task.metadata.channels).length === 0) {
        return ok(
          'No channel is linked to this task, so there is nowhere to attach files.'
        );
      }
      const mutedKey = args.channel ?? task.metadata.default_channel;
      const muted = mutedKey ? findMutedTarget(task.metadata.channels, mutedKey) : null;
      if (muted) return ok(formatMutedTargetRefusal(muted.channel_name, 'files'));
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

function createFindSlackUserTool() {
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

function createFindSlackChannelTool() {
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

function createListChannelsTool(task: Task) {
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
        // A trigger-fired task's home channel counts as its own before it has a thread there, and it must be
        // enumerable for the same reason it is readable: the canvas and pin blocks in the prompt name that
        // channel by its `#label`, and every read tool takes an id. Listing the capability without listing the
        // channel leaves the agent told about context it cannot go and look at.
        //
        // Derived from the same helper the read gate and the standing-context blocks use, rather than reading
        // `home_channel` again here. The linked channels above are a subset of it, so this only ever adds what
        // `seen` has not already covered — and there is one answer to "which channels are this task's own"
        // instead of two that can drift.
        for (const [channelId, label] of taskSlackChannelLabels(task.metadata)) {
          if (seen.has(channelId)) continue;
          seen.add(channelId);
          own.push({ name: label.replace(/^#/, ''), id: channelId });
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
      const agentName = agent.def.id;

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

function createRequestMaxModeTool(agent: Agent, task: Task) {
  return tool(
    'request_max_mode',
    'Request permission to switch this task into "max mode" — an upgrade that raises YOUR OWN model and reasoning effort for the rest of the task. The workers you spawn are not affected: you keep naming their models yourself, exactly as you do outside max mode. Call this AFTER explaining to the user why the extra cost is worth it (max mode is more expensive). Task will pause until the user approves or denies. ' +
    'Max mode is a task-LIFETIME grant: once approved it stays in effect for the rest of the task, so you only ever need to request it once. If it is already approved this call is a no-op — it will not prompt the user again, it just confirms the grant. ' +
    'Without `channel`, the request posts to the task\'s default channel. Pass `channel` (a channel key like "slack:C123:456.789") to post it to a specific linked thread — useful when the task has no default channel yet or you opened a new thread to talk to the user.',
    {
      reason: z.string().describe('Brief explanation of why max mode is warranted for this task'),
      channel: z.string().optional().describe('Channel key of an existing linked thread to post the request to (e.g., "slack:C123:456.789"). Omit to use the task\'s default channel.'),
    },
    async (args) => {
      const agentName = agent.def.id;

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
      const agentName = agent.def.id;
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
      // A muted default channel drops the message but still completes: the turn
      // has to be allowed to end, and refusing outright would just push the
      // agent to find another way to say it.
      const mutedDefault = task.metadata.default_channel
        ? findMutedTarget(task.metadata.channels, task.metadata.default_channel)
        : null;
      if (args.message && !mutedDefault) {
        // Same exception as post_to_user: a trigger-fired task's home channel is a place to post, and the completion message is often the first thing it says — posting it is what opens the task's own thread.
        if (Object.keys(task.metadata.channels).length === 0 && !task.metadata.home_channel) {
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
      if (args.message && mutedDefault) {
        return ok(
          `${formatMutedTargetRefusal(mutedDefault.channel_name)}\n\n` +
          'Completion is recorded either way — end your turn now, silently.'
        );
      }
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
    'Step out of a Slack channel/thread, in both directions: messages there stop reaching you, AND your own posts there are refused (post_to_user, post_files_to_user, post_to_channel) — until someone @mentions the bot there again. ' +
    'Posts a notification to the thread it muted, so add no farewell message of your own. Call it before saying anything else when asked to stop, step back, or go away. ' +
    'Pass `channel` (a channel key like "slack:C123:456.789") to mute that specific thread. ' +
    'Omit `channel` to mute the task\'s default channel only (never all linked channels). ' +
    'DM channels cannot be muted — DMs have no @mention to unmute by, so muting one would lock the user out permanently.',
    {
      channel: z.string().optional().describe('Channel key of the thread to mute (e.g., "slack:C123:456.789"). Omit to mute the task\'s default channel.'),
    },
    async (args) => {
      const agentName = agent.def.id;
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
    'value shown next to each message that arrived in your conversation (e.g. "1716998400.123456"). ' +
    'Omit `channel` to target the task\'s default channel. ' +
    'The emoji is a Slack shortcode WITHOUT colons (e.g. "thumbsup", "eyes", "tada", "white_check_mark").',
    {
      message_id: z.string().describe('The target message timestamp — the `msg:<ts>` id shown on the message as it reached you (e.g. "1716998400.123456")'),
      emoji: z.string().describe('Slack emoji shortcode without colons (e.g. "thumbsup", "heart", "eyes")'),
      channel: z.string().optional().describe('Channel key of the linked thread (e.g. "slack:C123:456.789"). Omit for the default channel.'),
    },
    async (args) => {
      const agentName = agent.def.id;
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
      message_id: z.string().describe('The target message timestamp — the `msg:<ts>` id shown on the message as it reached you'),
      emoji: z.string().describe('Slack emoji shortcode without colons (e.g. "eyes")'),
      channel: z.string().optional().describe('Channel key of the linked thread. Omit for the default channel.'),
    },
    async (args) => {
      const agentName = agent.def.id;
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

function createGetMessageReactionsTool(task: Task) {
  return tool(
    'get_message_reactions',
    'Read the CURRENT emoji reactions on a Slack message (live state, fresher than ' +
    'the snapshot you were given). Pass the `message_id` (`msg:<ts>` id). ' +
    'Returns each reaction\'s emoji shortcode, how many users reacted, and who they were.',
    {
      message_id: z.string().describe('The target message timestamp — the `msg:<ts>` id shown on the message as it reached you'),
      channel: z.string().optional().describe('Channel key of the linked thread. Omit for the default channel.'),
    },
    async (args) => {
      const result = await task.readMessageReactions(args.message_id, args.channel);
      if (result === null) {
        return ok(`Could not read reactions: ${args.channel ? `channel ${args.channel} is not a linked Slack thread` : 'task has no default Slack channel'}.`);
      } else if (!result.ok) {
        // A failed read is NOT an unreacted message — say so, and never guess why.
        const hint = result.error === 'missing_scope'
          ? ' Archie\'s Slack app is missing the `reactions:read` scope — it must be reinstalled with that scope before reactions can be read. Do not infer anything about this message\'s reactions.'
          : ' The reactions on this message are unknown — do not assume there are none.';
        return ok(`Could not read reactions on ${args.message_id}: Slack returned \`${result.error}\`.${hint}`);
      } else if (result.reactions.length === 0) {
        return ok(`Message ${args.message_id} has no reactions.`);
      } else {
        const summary = result.reactions
          .map((r) => {
            const who = r.users && r.users.length > 0 ? ` — ${r.users.join(', ')}` : '';
            return `:${r.name}: (${r.count})${who}`;
          })
          .join('\n');
        return ok(`Reactions on ${args.message_id}:\n${summary}`);
      }
    },
  );
}

function createReadChannelHistoryTool(task: Task) {
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
      const allowed = taskChannelIds(task);
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

function createReadThreadTool(task: Task) {
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
      const allowed = taskChannelIds(task);
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

/**
 * Values that answer the `mandate` field without answering the question — the
 * shapes a model reaches for when it wants past the gate rather than having a
 * request to quote.
 */
const NON_MANDATES = new Set([
  'n/a', 'na', 'none', 'no mandate', 'not applicable', 'nobody', 'no one',
  'self', 'my own judgement', 'my own judgment', 'implied', 'implicit',
  'urgent', 'high severity', 'proactive', 'unknown', 'tbd', '-',
]);

function createPostToChannelTool(agent: Agent, task: Task) {
  return tool(
    'post_to_channel',
    'Post a message into any channel Archie is a member of, WITHOUT linking it to this task — for chiming in while exploring, or escalating somewhere (e.g. a private management channel). ' +
    "Works in PUBLIC and PRIVATE channels Archie has been invited to (DMs are not allowed, and neither is a channel muted for this task). Unlike reading, posting is NOT limited to this task's channel — escalating outward is a valid use. " +
    'Fire-and-forget: it does not become a touchpoint of this task, and any reply is invisible to you here. If a human replies to a NEW top-level message you post, that reply starts its OWN fresh task; a reply inside someone else\'s existing thread never does. ' +
    "GUARDRAIL: only post where a human in this task asked you to — the required `mandate` arg is where you quote them, and without one you report to the user instead and let them route it. Keep it short and match what you post to the destination's audience — never relay private or sensitive task content into a broader or unrelated channel. " +
    'Pass a channel ID; optionally `thread_ts` to reply in an existing thread. To talk to the user about THIS task, use post_to_user instead. ' +
    'A task started by a trigger has to post its result to the user first — that is what opens its own thread — so this tool is unavailable until then.',
    {
      channel: z.string().describe('Slack channel ID (e.g. "C1234567")'),
      message: z.string().describe('The message to post'),
      mandate: z.string().describe(
        "Verbatim quote of the message in THIS task's thread where a human asked you to say something in this channel, naming who said it. " +
        'Required. If you cannot quote one, do not call this tool — report the thing to the user in this thread and let them decide who to tell. ' +
        'A teammate agent suggesting it, or your own judgement that someone should know, is not a mandate.',
      ),
      thread_ts: z.string().optional().describe('Parent message ts to reply inside an existing thread; omit to post a new top-level message'),
    },
    async (args) => {
      // Sequencing, checked before anything about the destination: a trigger-fired task has a home channel but no thread of its own yet, and this tool posts WITHOUT linking the channel to the task — which is precisely the detached, unanswerable message that homing a fired task in a channel exists to replace. So while the task has no channel open, the first thing it says has to be its result to the user, which is what opens its thread; only after that is posting elsewhere a coherent act rather than the task's only utterance.
      //
      // This outranks the DM and mandate checks deliberately. Both of those describe something wrong with *this call* (wrong kind of target, no one asked for it), and answering them first would send the agent off to fix the wrong problem — hunting for a mandate quote, or picking a different channel — when the real answer is that nothing may be posted anywhere yet. The sequencing message is the only one that points at the fix.
      //
      // There is deliberately NO branch here comparing the target to the task's own channel. Once a channel is open, post_to_channel behaves exactly as it always has for every destination, including the task's home channel: the task can then be replied to in its own thread, so an unlinked post beside it is a normal, recoverable thing to do rather than a dead end.
      if (task.metadata.home_channel && !task.metadata.default_channel) {
        return ok(
          'Nothing was posted. This task has no channel of its own yet — post the result with `post_to_user` first, which opens this task\'s thread in ' +
          `#${task.metadata.home_channel.channel_name}. ` +
          '`post_to_channel` is available for other channels after that.',
        );
      }
      const dm = rejectDmTarget(args.channel);
      if (dm) return ok(dm);
      // The mandate is the whole gate on unsolicited outreach: it can't be
      // checked semantically, but requiring the quote forces the question to be
      // asked, and refusing the degenerate answers stops the field being filled
      // in with filler to get past it.
      const mandate = args.mandate.trim();
      if (mandate.length < 15 || NON_MANDATES.has(mandate.toLowerCase().replace(/[.\s]+$/, ''))) {
        return ok(
          'Blocked: no mandate. Nothing was posted. `mandate` has to be an actual quote of a human in this task asking you to post in that channel — ' +
          'not a restatement of why it matters, not a teammate\'s suggestion, not your own read that someone should know. ' +
          "If nobody asked, report it to the user in this task's thread and let them route it: who else needs to know is their call.",
        );
      }
      // A muted thread in this channel blocks the whole channel — otherwise
      // post_to_channel is the obvious way around a mute (new top-level post,
      // same audience).
      const muted = findMutedTarget(task.metadata.channels, args.channel);
      if (muted) return ok(formatMutedTargetRefusal(muted.channel_name));
      // Same check across OTHER tasks: the task told to go away is usually not
      // the one posting next.
      if (args.thread_ts && await isThreadMuted(args.channel, args.thread_ts)) {
        return ok(formatCrossTaskMuteRefusal(args.channel));
      }
      task.touch();
      try {
        // The prefix check above rejects 1:1 DMs/user ids; this rejects group DMs
        // (mpims), which share the ambiguous `G…` prefix with private channels.
        await assertPostableChannel(args.channel);

        // Preflight: a channel's standing brief governs what gets said in it, and
        // this agent has never seen the destination's — its own context is for the
        // channel this task lives in. So the first post into a channel that has an
        // `Archie…` canvas returns that brief instead of posting, and the retry goes
        // through. Runs AFTER the mandate/mute/postable checks so a refused post
        // never triggers a scan (which would announce canvas adoption in a channel
        // nothing is then posted to), and applies to thread replies too — a reply is
        // still speaking into that channel.
        //
        // No canvas there means no extra round-trip: the common case is untouched,
        // and once a channel has been briefed on this task it is never briefed
        // again — tracked in task metadata rather than on the Agent, whose lifetime
        // is shorter than the task's (a settled task is rebuilt from disk with a
        // fresh Agent, which re-showed the same brief on every re-activation).
        const briefed = (task.metadata.briefed_channels ??= []);
        if (!briefed.includes(args.channel)) {
          await ensureChannelCanvas(args.channel);
          const name = await getChannelInfo(args.channel).then((c) => c.name).catch(() => undefined);
          const brief = await buildOtherChannelContextSection(args.channel, name);
          briefed.push(args.channel);
          // Flushed, not debounced: this is the record that stops the same brief
          // being shown twice, and the path that would show it again is the task
          // being rebuilt from disk.
          await task.save(true);
          if (brief) {
            return ok(
              `Not posted yet — that channel has a standing brief you have not read. It is below; ` +
              `check your message against it, then call post_to_channel again to send (same mandate).\n\n${brief}`,
            );
          }
        }
        const ts = await postSlackMessage({ channel: args.channel, text: args.message, threadTs: args.thread_ts });
        // Record the claimed mandate in the knowledge log: outreach lands in
        // front of people outside this task, so the reason it happened has to be
        // auditable after the fact.
        await appendAgentFinding(
          task.taskId,
          agent.def.id,
          `Posted to ${args.channel} outside this task. Mandate: ${mandate}`,
          'decision',
        );
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

function createGetTaskUsageTool(task: Task) {
  return tool(
    'get_task_usage',
    "Report this task's total token usage (always) and SDK-reported cost when available, with a per-agent breakdown. Current task only.",
    {},
    async () => {
      try {
        return ok(formatTaskUsageReport(await aggregateTaskUsage(task.taskId)));
      } catch (e) {
        return err(e instanceof Error ? e.message : 'usage aggregation failed');
      }
    },
  );
}

// ---- GitHub tools (write side gated by edit mode) ----

function createPushBranchTool(agent: Agent, task: Task) {
  return tool(
    'push_branch',
    'Push commits from the local clone to the remote origin. Set force=true after a rebase to force-push with lease (safe against overwriting concurrent updates). Do not use force=true just because a normal push was rejected — investigate why first.',
    {
      force: z.boolean().optional().describe('Use --force-with-lease. Required after rebasing a pushed branch.'),
      github: githubArgSchema,
    },
    async (args) => {
      const agentName = agent.def.id;
      const resolved = requireAttached(task, args.github);
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

/**
 * Stamp the attribution line onto a PR body: who opened it, and for whom.
 *
 * The human is the edit-mode approver, which is also who the task's commits
 * are authored as (`buildCommitAuthorEnv`) — so the PR names exactly whoever
 * `git blame` will name. Their Slack display name is used as-is.
 */
function attributePrBody(task: Task, body: string): string {
  return buildAttributedBody(
    body,
    task.metadata.edit_approved_by?.name ?? null,
    getArchieAttributionIdentity()?.mention ?? null,
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
      const agentName = agent.def.id;
      logger.agentAction(agentName, 'Creating PR', args.title);

      const resolved = requireAttached(task, args.github);
      if (!resolved.ok) return err(resolved.error);

      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');

      const { github, attached } = resolved;
      const branch = attached.current_branch;
      const state = branch ? attached.branch_states?.[branch] : undefined;
      const head = branch || taskBranchName(task.taskId);
      // Where this branch forks from. `branch_states` records it at mount time;
      // a repo whose state predates that (or a branch created outside the mount
      // path) falls back to asking GitHub for the repository default, which is
      // what mount_repo would have recorded. There is no agent-declared base
      // branch any more — an agent definition no longer carries repos.
      const base = state?.base_branch
        || (await client.resolveRepo(github))?.default_branch
        || 'main';

      const body = attributePrBody(task, args.body);
      const result = await client.createPullRequest(github, head, base, args.title, body);

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

function createGetPRStatusTool(task: Task) {
  return tool(
    'get_pr_status',
    'Get the current status of a pull request.',
    { pr_number: z.number().describe('The PR number'), github: githubArgSchema },
    async (args) => {
      const resolved = resolveGithub(task, args.github);
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

function createGetPRChecksTool(task: Task) {
  return tool(
    'get_pr_checks',
    'List CI checks (check-runs + legacy commit statuses) attached to a PR\'s HEAD commit. Returns conclusion, URL, and — for failed checks — the full output (title/summary/text). Use this when a "checks updated" event arrives or get_pr_status reports mergeableState=unstable, to find which specific check broke.',
    { pr_number: z.number().describe('The PR number'), github: githubArgSchema },
    async (args) => {
      const resolved = resolveGithub(task, args.github);
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

function createGetCheckRunTool(task: Task) {
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
      const resolved = resolveGithub(task, args.github);
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

function createListCodeScanningAlertsTool(task: Task) {
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
      const resolved = resolveGithub(task, args.github);
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

function createGetCodeScanningAlertTool(task: Task) {
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
      const resolved = resolveGithub(task, args.github);
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

function createGetPRReviewsTool(task: Task) {
  return tool(
    'get_pr_reviews',
    'Get review-level summary for a PR (approvals, change requests, review bodies). For line-level comments, use get_review_threads.',
    { pr_number: z.number().describe('The PR number'), github: githubArgSchema },
    async (args) => {
      const resolved = resolveGithub(task, args.github);
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

function createGetPRCommentsTool(task: Task) {
  return tool(
    'get_pr_comments',
    'Get top-level PR conversation comments (the "Conversation" tab). Does not include line-level review comments — use get_review_threads for those.',
    { pr_number: z.number().describe('The PR number'), github: githubArgSchema },
    async (args) => {
      const resolved = resolveGithub(task, args.github);
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

function createGetReviewThreadsTool(task: Task) {
  return tool(
    'get_review_threads',
    'Get every review thread on a PR with its thread_id (for resolve_review_thread) and each comment\'s comment_id (for reply_to_review_comment).',
    { pr_number: z.number().describe('The PR number'), github: githubArgSchema },
    async (args) => {
      const resolved = resolveGithub(task, args.github);
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

function createListPRsTool(task: Task) {
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
      const resolved = resolveGithub(task, args.github);
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

function createGetPRTool(task: Task) {
  return tool(
    'get_pr',
    'Get full PR details: title, description, diff, state, and branches.',
    { pr_number: z.number().describe('The PR number'), github: githubArgSchema },
    async (args) => {
      const resolved = resolveGithub(task, args.github);
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

function createUpdatePRTool(task: Task) {
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
      const resolved = resolveGithub(task, args.github);
      if (!resolved.ok) return err(resolved.error);
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      // Re-stamp attribution: a body rewrite would otherwise drop the line naming
      // the human this PR was opened for.
      await client.updatePR(resolved.github, args.pr_number, {
        title: args.title,
        body: args.body === undefined ? undefined : attributePrBody(task, args.body),
        base: args.base,
      });
      return ok(`Updated PR #${args.pr_number} (${resolved.github})`);
    },
  );
}

function createAddPRCommentTool(task: Task) {
  return tool(
    'add_pr_comment',
    'Add a general comment to a pull request.',
    {
      pr_number: z.number().describe('The PR number'),
      comment: z.string().describe('The comment text'),
      github: githubArgSchema,
    },
    async (args) => {
      const resolved = resolveGithub(task, args.github);
      if (!resolved.ok) return err(resolved.error);
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      await client.addPRComment(resolved.github, args.pr_number, args.comment);
      return ok(`Added comment to PR #${args.pr_number} (${resolved.github})`);
    },
  );
}

function createAddReviewCommentTool(task: Task) {
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
      const resolved = resolveGithub(task, args.github);
      if (!resolved.ok) return err(resolved.error);
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      await client.addReviewComment(resolved.github, args.pr_number, args.path, args.line, args.comment);
      return ok(`Added review comment to ${args.path}:${args.line} on PR #${args.pr_number} (${resolved.github})`);
    },
  );
}

function createReplyToReviewCommentTool(task: Task) {
  return tool(
    'reply_to_review_comment',
    'Reply inside an existing review thread. Requires the comment_id of any comment in the target thread (from the GitHub activity you were woken with, or get_review_threads).',
    {
      pr_number: z.number().describe('The PR number'),
      comment_id: z.number().describe('REST comment id of any comment in the target thread'),
      comment: z.string().describe('The reply text'),
      github: githubArgSchema,
    },
    async (args) => {
      const resolved = resolveGithub(task, args.github);
      if (!resolved.ok) return err(resolved.error);
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      await client.replyToReviewComment(resolved.github, args.pr_number, args.comment_id, args.comment);
      return ok(`Replied to review comment ${args.comment_id} on PR #${args.pr_number} (${resolved.github})`);
    },
  );
}

function createResolveReviewThreadTool(task: Task) {
  return tool(
    'resolve_review_thread',
    'Mark a review thread as resolved. thread_id must be a GraphQL node id (e.g. PRRT_...) obtained from get_review_threads.',
    {
      pr_number: z.number().describe('The PR number'),
      thread_id: z.string().describe('GraphQL thread node id from get_review_threads (e.g. PRRT_...)'),
      github: githubArgSchema,
    },
    async (args) => {
      const resolved = resolveGithub(task, args.github);
      if (!resolved.ok) return err(resolved.error);
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      await client.resolveReviewThread(resolved.github, args.pr_number, args.thread_id);
      return ok(`Resolved review thread ${args.thread_id} on PR #${args.pr_number} (${resolved.github})`);
    },
  );
}

function createRequestReReviewTool(task: Task) {
  return tool(
    'request_re_review',
    'Request reviewers to re-review the PR after changes.',
    { pr_number: z.number().describe('The PR number'), github: githubArgSchema },
    async (args) => {
      const resolved = resolveGithub(task, args.github);
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
      const resolved = resolveGithub(task, args.github);
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
        // Task-level quiescence (same predicate as idleDecision): a parked
        // agent means the request is live and the task is pausing on it.
        const parked = task.agent?.pendingTeardown != null;
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

      const agentName = agent.def.id;
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

function createClosePRTool(task: Task) {
  return tool(
    'close_pull_request',
    'Close a pull request without merging.',
    { pr_number: z.number().describe('The PR number'), github: githubArgSchema },
    async (args) => {
      const resolved = resolveGithub(task, args.github);
      if (!resolved.ok) return err(resolved.error);
      const client = getGitHubClient();
      if (!client) throw new Error('GitHub client not configured');
      await client.closePullRequest(resolved.github, args.pr_number);
      return ok(`Closed PR #${args.pr_number} (${resolved.github})`);
    },
  );
}

// ---- Git workflow tools ----

function createFetchTool(task: Task) {
  return tool(
    'fetch',
    'Fetch latest refs from origin.',
    { github: githubArgSchema },
    async (args) => {
      const resolved = requireAttached(task, args.github);
      if (!resolved.ok) return err(resolved.error);
      await gitExec(resolved.attached.clone_path!, 'fetch origin');
      return ok(`Fetched latest from origin (${resolved.github})`);
    },
  );
}

function createSwitchBranchTool(task: Task) {
  return tool(
    'switch_branch',
    'Switch to a different branch. Fetches latest, auto-stashes dirty work, auto-pops on return.',
    {
      branch: z.string().describe('Branch name to switch to'),
      github: githubArgSchema,
    },
    async (args) => {
      const resolved = requireAttached(task, args.github);
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

function createCreateBranchTool(task: Task) {
  return tool(
    'create_branch',
    'Create a new branch and switch to it. Branch name is auto-generated from the task ID. Returns the full branch name.',
    {
      base: z.string().optional().describe('Base branch or commit (default: current HEAD)'),
      github: githubArgSchema,
    },
    async (args) => {
      const resolved = requireAttached(task, args.github);
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

function createListBranchesTool(task: Task) {
  return tool(
    'list_branches',
    'List branches created or visited in the current task. With no arguments, lists branches across every mounted repo.',
    { github: githubArgSchema },
    async (args) => {
      const mounted = task.metadata.repositories;
      if (mounted.length === 0) {
        return ok('No repos are mounted in this task.');
      }
      let filtered = mounted;
      if (args.github) {
        const resolved = resolveGithub(task, args.github);
        if (!resolved.ok) return err(resolved.error);
        filtered = mounted.filter((a) => a.github === resolved.github);
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

function createParseDatetimeTool() {
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

      const agentName = agent.def.id;
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

      const agentName = agent.def.id;
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
 * project-context canvas, or pinned in the channel, into the PM workspace so it
 * can be read. The agent never has to know whether the reference is a canvas or
 * a plain file: the tool inspects `files.info.filetype` and routes internally
 * (canvas → converted markdown; anything else → native bytes). The file lands in
 * the PM's own workspace, not shared — the PM decides what to do with it next.
 */
function createFetchSlackReferenceTool(agent: Agent, task: Task) {
  return tool(
    'fetch_slack_reference',
    'Fetch a file referenced in the channel\'s project-context canvas, or pinned in the channel, and save it into your workspace so you can read it. ' +
    'Pass the reference exactly as it appears in the canvas or in the pinned-messages index — a Slack file link or a file id. ' +
    'Documents and images are saved in their original form; a referenced canvas is saved as readable markdown.',
    {
      reference: z.string().describe(
        'A Slack file link (e.g. https://….slack.com/files/…/F…/name) or a bare file id (F…) taken from the channel canvas or the pinned-messages index.',
      ),
    },
    async (args) => {
      const fileId = extractSlackFileId(args.reference);
      if (!fileId) {
        return err(`No Slack file id found in "${args.reference}". Pass a Slack file link or an F… id.`);
      }
      // Scope to canvas-referenced and pinned files only: the bot token can read
      // far more of the workspace than this task should reach, so an unscoped id
      // would let prompt-influenced input exfiltrate arbitrary accessible files.
      // Both standing context sources are in scope, and nothing else is.
      const [canvasIds, pinnedIds] = await Promise.all([
        collectCanvasFileAllowlist(task.metadata),
        collectPinnedFileAllowlist(task.metadata),
      ]);
      const allowed = new Set([...canvasIds, ...pinnedIds]);
      if (!allowed.has(fileId)) {
        return err(
          `File ${fileId} is neither referenced by an adopted channel canvas nor pinned in one of this task's channels — only the canvas itself, files it references, and pinned files can be fetched.`,
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
  tz: z.string().optional().describe('IANA timezone, e.g. "America/New_York". Defaults to the DM participant\'s timezone when proposing in a DM, otherwise UTC; updates keep the existing timezone.'),
  channel_id: z.string().optional().describe('Channel to watch (required for channel_message).'),
  contains: z.string().optional().describe('Only fire when the new message contains this substring (channel_message).'),
  from_user: z.string().optional().describe('Only fire for messages from this author (channel_message). A person\'s user id (`U…`), or — for a report posted by an app, bot or incoming webhook — that app\'s bot id (`B…`), which is the id that appears as the author of its messages. Not a name or @handle.'),
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
      if (c.from_user) {
        // Refuse an author filter that cannot name any author. Without this
        // check the trigger is accepted, announced, and listed as active — and
        // then never fires, which is indistinguishable from "nobody posted".
        if (!isSlackAuthorId(c.from_user)) {
          return { error: `"${c.from_user}" is not a Slack author id. Use the person's user id (\`U…\`) or, for a report posted by an app or webhook, the app's bot id (\`B…\`) — that is the id shown in the author of the message you want to watch for. A name or @handle will not match anything.` };
        }
        match.from_user = c.from_user;
      }
      conditions.push({ type: 'channel_message', channel_id: c.channel_id, ...(Object.keys(match).length ? { match } : {}) });
    } else {
      return { error: `Unknown condition type "${(c as { type: string }).type}".` };
    }
  }
  if (conditions.length === 0) return { error: 'At least one condition is required.' };
  return { conditions };
}

function createProposeTriggerTool(task: Task) {
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
      // The binding's channel id is model-supplied text, and a fired task is HOMED in that channel: it opens its
      // own thread there and treats it as its own for reads. So the id has to be a channel. Without this check a
      // `D…` or `U…` value would hand a fired task DM access that `post_to_channel` and the explore reads both
      // refuse by prefix everywhere else — and the human approving it sees only the channel NAME on the card.
      if (isDmOrUserId(b.channel_id)) {
        return ok('A trigger has to deliver to a channel, not a DM or a user. Pass a channel ID (e.g. "C…"). Delivery to a person\'s DM is not supported yet.');
      }
      const binding: TriggerBinding = { type: 'channel', channel_id: b.channel_id, channel_name: b.channel_name };

      const origin = await resolveTriggerOrigin(task);
      let defaultTz = 'UTC';
      if (origin.kind === 'dm' && origin.userId) {
        try { defaultTz = (await getUserInfo(origin.userId)).tz || 'UTC'; } catch { /* keep UTC */ }
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
      const trigger: Trigger = {
        id: generateTriggerId(),
        status: 'pending',
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

function createListTriggersTool(task: Task) {
  return tool(
    'list_triggers',
    'List the triggers visible from this conversation (per privacy rules), one summary line each. Returns everything visible — filter or narrow it yourself when the user asks for "the ones in this channel", "just the schedules", etc. These lines are summaries, not the stored rule: call `get_trigger` for the exact conditions, filters and action prompt before answering a question about what one watches, and always before editing one.',
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

/** Render one stored condition in full — every field the matcher actually reads. */
function detailCondition(c: TriggerCondition, index: number): string {
  const head = `  ${index + 1}. `;
  if (c.type === 'schedule') {
    const lines = [
      `${head}${c.cron ? 'a recurring schedule' : 'a one-off schedule'}`,
      `       cron: ${c.cron ?? '(none — fires once)'}`,
      `       timezone: ${c.tz}`,
      `       next run: ${c.next_run_at}`,
    ];
    return lines.join('\n');
  }
  const lines = [`${head}a new top-level message in <#${c.channel_id}> (${c.channel_id})`];
  if (c.match?.contains) lines.push(`       body contains (case-insensitive): "${c.match.contains}"`);
  else lines.push('       body filter: none — any message in that channel');
  if (c.match?.from_user) {
    const kind = isAppAuthorId(c.match.from_user)
      ? 'an app/bot id, matched against the message\'s bot_id'
      : 'a user id, matched against the message\'s author';
    lines.push(`       author is: ${c.match.from_user} (${kind})`);
  } else {
    lines.push('       author filter: none — anyone in that channel');
  }
  return lines.join('\n');
}

/**
 * `get_trigger` — the full stored record of one visible trigger.
 *
 * This exists because `list_triggers` renders a deliberately short one-liner,
 * and an agent that can only read the one-liner cannot manage what it can
 * already delete: it cannot say which sender is filtered, cannot quote the
 * instruction that runs, and — since `update_trigger` REPLACES the condition
 * list wholesale — cannot edit one condition without silently dropping the
 * filters it never saw. Visibility is the gate on WHICH triggers an agent may
 * touch; withholding fields from a trigger that already passed that gate
 * protects nobody, since the same agent may rewrite or delete it outright.
 */
function createGetTriggerTool(task: Task) {
  return tool(
    'get_trigger',
    'Read one trigger in full: every condition exactly as stored (watched channel, keyword filter, author id), the internal action prompt it runs, and its status/binding/history. Use this before editing a trigger — `update_trigger` replaces the whole condition list, so you need to see what is there — and whenever the user asks what a trigger actually watches or does.',
    {
      id: z.string().describe('Trigger ID (from list_triggers).'),
    },
    async (args) => {
      const trigger = await loadTrigger(args.id);
      if (!trigger || trigger.status === 'pending') return ok(`No trigger ${args.id} found.`);
      const origin = await resolveTriggerOrigin(task);
      if (!(await triggerVisibleFrom(trigger, origin, makePrivacyResolver()))) {
        return ok(`Trigger ${args.id} isn't visible from here, so it can't be read from this conversation.`);
      }

      const where = trigger.binding.type === 'channel'
        ? `#${trigger.binding.channel_name} (${trigger.binding.channel_id})`
        : `a DM with <@${trigger.binding.user_id}>`;
      const approver = trigger.approved_by === 'cli' ? 'CLI operator'
        : trigger.approved_by && trigger.approved_by !== 'unknown' ? `<@${trigger.approved_by}>` : 'unknown';

      const lines = [
        `Trigger ${trigger.id} — ${trigger.status}`,
        `Name shown to users: ${trigger.summary?.trim() || '(none set — listings fall back to a clip of the action prompt)'}`,
        `Delivers to: ${where}`,
        `Created at ${trigger.created_at}; approved by ${approver}`,
        `Last fired: ${trigger.last_fired_at ?? 'never'}`,
        '',
        `Fires when ANY of these match (${trigger.conditions.length}):`,
        ...trigger.conditions.map((c, i) => detailCondition(c, i)),
        '',
        'Action prompt — the internal instruction seeded to a fresh PM task on every fire. It is working text, not a user-facing description: explain it in your own words rather than pasting it into Slack.',
        '<<<',
        trigger.action.prompt,
        '>>>',
        '',
        'To change it, use `update_trigger`. `conditions` REPLACES the whole list above — restate every condition and every filter you want to keep, or it is dropped.',
      ];
      return ok(lines.join('\n'));
    },
  );
}

function createUpdateTriggerTool(task: Task) {
  return tool(
    'update_trigger',
    'Pause, resume, or edit an existing trigger. Read it with `get_trigger` first — `conditions` replaces the whole list, so editing blind silently drops filters. You can only manage triggers visible from this conversation. Posts a one-line change notice to the trigger\'s bound channel.',
    {
      id: z.string().describe('Trigger ID (from list_triggers).'),
      status: z.enum(['paused', 'enabled']).optional().describe('"paused" to pause, "enabled" to resume.'),
      action_prompt: z.string().optional().describe('Replace the internal instruction run when the trigger fires (not shown to the user).'),
      summary: z.string().optional().describe('Replace the short, friendly user-facing name. Update this whenever you change action_prompt so the notices stay accurate.'),
      conditions: z.array(triggerConditionObject).optional().describe('REPLACES the condition list entirely (same shape as propose_trigger) — anything you leave out is dropped, including a keyword or author filter you never saw. Call `get_trigger` first and restate every condition you want to keep.'),
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
        if (trigger.approved_by && trigger.approved_by !== 'unknown') {
          const perUser = await countActiveTriggers((t) => t.approved_by === trigger.approved_by);
          if (perUser >= MAX_TRIGGERS_PER_USER) return ok(`Can't enable — the approver is already at the maximum of ${MAX_TRIGGERS_PER_USER} active triggers.`);
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

function createDeleteTriggerTool(task: Task) {
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
 * PM tools, split by concern.
 */

/** User-facing communication (Slack messaging, lookups, channel control, reactions). */
export function createCommsMcpServer(agent: Agent, task: Task) {
  return createSdkMcpServer({
    name: 'comms-tools',
    version: '1.0.0',
    tools: [
      createPostToUserTool(agent, task),
      createPostFilesToUserTool(agent, task),
      createFindSlackUserTool(),
      createFindSlackChannelTool(),
      createListChannelsTool(task),
      createReadChannelHistoryTool(task),
      createReadThreadTool(task),
      createPostToChannelTool(agent, task),
      createMuteChannelTool(agent, task),
      createReactToMessageTool(agent, task),
      createUnreactFromMessageTool(agent, task),
      createGetMessageReactionsTool(task),
      createFetchSlackReferenceTool(agent, task),
    ],
  });
}

/**
 * `list_available_repos` — the PM discovers which repos the GitHub App can
 * reach. The installation is the allowlist; there is nothing else to consult.
 * Cached on the task for the turn.
 */
function createListAvailableReposTool(task: Task) {
  return tool(
    'list_available_repos',
    'List every GitHub repository this installation can reach.',
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
        const desc = r.description ? ` — ${r.description}` : '';
        return `- ${r.github} (default: ${r.default_branch})${desc}`;
      });
      return ok(`Repos accessible to this installation:\n${lines.join('\n')}`);
    },
  );
}

/**
 * `mount_repo` — check out a repository into this task and hand back the path.
 *
 * This is the ONLY way a clone comes into existence: nothing is cloned at
 * spawn, so the PM mounts what a piece of work needs and passes the returned
 * path to whoever does the work. One clone per repo per task, at
 * `sessions/{taskId}/repos/{owner}/{repo}`.
 *
 * The checkout follows edit mode, exactly as the edit-mode approval path does
 * (`decideCloneCheckout` is shared with it): the repository's base branch
 * while the task is read-only, `archie/{taskId}` cut from base on the first
 * mount after approval, and the branch the task was last on when a clone is
 * re-created later.
 *
 * A repo mounted mid-session is reachable immediately: the sandbox grants the
 * task's repos DIRECTORY (and the base clone cache read-only), not the clones
 * that happened to exist at spawn — see the grants in `spawn.ts`.
 */
function createMountRepoTool(agent: Agent, task: Task) {
  return tool(
    'mount_repo',
    'Check out a GitHub repository into this task and return its local path. Call this before any code work — nothing is cloned until you ask. ' +
    'Pass an "owner/repo" identifier from `list_available_repos`. ' +
    'While the task is read-only the clone sits on the repository default branch and cannot be written to; once edit mode is approved it moves onto this task\'s own branch and becomes writable. ' +
    'Mounting a repo that is already mounted is safe — it returns the same path. ' +
    'Pass the returned path to any worker you spawn, and never point two workers at the same clone at the same time.',
    {
      github: z.string().describe('Repository identifier, e.g. "org/backend".'),
    },
    async (args) => {
      const github = normalizeGithubRef(args.github);
      if (!github) {
        return err(`"${args.github}" is not a repository identifier. Pass "owner/repo", e.g. "org/backend".`);
      }

      const client = getGitHubClient();
      if (!client) {
        return err(
          'GitHub is not configured for this deployment, so no repository can be mounted. ' +
          'Tell the user rather than retrying.',
        );
      }

      const existing = task.metadata.repositories.find((a) => sameRepo(a.github, github));
      const attached: AttachedRepo = existing ?? { github };

      // The base branch this repo forks from. A repo the task already mounted
      // recorded it; a fresh one asks GitHub, and that same call is the
      // reachability check — the App installation is the allowlist, so a repo
      // it cannot see is not mountable no matter what the caller believes.
      let baseBranch = recordedBaseBranch(attached);
      if (!baseBranch) {
        const reachable = await client.resolveRepo(github);
        if (!reachable) {
          return err(
            `The GitHub App cannot reach "${github}". Check it appears in list_available_repos ` +
            `(the App has to be installed on it), then retry.`,
          );
        }
        baseBranch = reachable.default_branch;
      }

      const editAllowed = task.metadata.edit_allowed === true;
      // Cloning a large repo takes a while; keep the task from looking idle
      // while git works.
      task.touch();
      let result;
      try {
        result = await ensureTaskClone({
          attached,
          clonePath: getTaskClonePath(task.taskId, github),
          baseRepoPath: attached.base_path || getBaseCachePath(github),
          editAllowed,
          taskBranch: taskBranchName(task.taskId),
          baseBranch,
        });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        logger.error('task', `Failed to mount ${github} into ${task.taskId}`, e);
        return err(`Could not check out "${github}": ${reason}. Report this rather than retrying.`);
      }

      // Recorded only once the clone is on disk, so a failed mount does not
      // leave behind an attachment the repo tools would then resolve to.
      if (!existing) task.metadata.repositories.push(attached);
      // Flushed, not debounced: the clone exists on disk now, and the record
      // that points at it (and gets it cleaned up on teardown) must survive a
      // crash in the next second.
      await task.save(true);

      logger.agentAction(
        agent.def.id,
        result.created ? 'Mounted repo' : 'Re-used mounted repo',
        `${github} @ ${result.branch}`,
      );

      const lines = [
        `${result.created ? 'Mounted' : 'Already mounted'}: ${github}`,
        `Path: ${result.clone_path}`,
        `Branch: ${result.branch}`,
        `Default branch: ${result.base_branch}`,
        `Mode: ${editAllowed ? 'read-write — commits, pushes and PRs are allowed' : 'read-only — request edit mode before changing anything'}`,
      ];
      return ok(lines.join('\n'));
    },
  );
}

/** Task orchestration (completion, edit mode, max mode, usage, repos, triggers). */
export function createOrchestrationMcpServer(agent: Agent, task: Task) {
  return createSdkMcpServer({
    name: 'orchestration-tools',
    version: '1.0.0',
    tools: [
      createReportCompletionTool(agent, task),
      createRequestEditModeTool(agent, task),
      createRequestMaxModeTool(agent, task),
      createGetTaskUsageTool(task),
      createListAvailableReposTool(task),
      createMountRepoTool(agent, task),
      createProposeTriggerTool(task),
      createListTriggersTool(task),
      createGetTriggerTool(task),
      createUpdateTriggerTool(task),
      createDeleteTriggerTool(task),
    ],
  });
}

/** Scheduling (datetime parsing and reminders). */
export function createSchedulingMcpServer(agent: Agent, task: Task) {
  return createSdkMcpServer({
    name: 'scheduling-tools',
    version: '1.0.0',
    tools: [
      createParseDatetimeTool(),
      createSetReminderTool(agent, task),
      createCancelReminderTool(agent, task),
    ],
  });
}

/**
 * Create the MCP server with every repo tool (git, PR, branch).
 *
 * All of them resolve their target out of `metadata.repositories` — what this
 * task has mounted — so there is nothing per-agent to scope here. The write
 * side is withheld until edit mode is approved, via `disallowedTools` in
 * spawn.ts rather than by leaving tools unregistered.
 */
export function createRepoToolsMcpServer(agent: Agent, task: Task) {
  return createSdkMcpServer({
    name: 'repo-tools',
    version: '1.0.0',
    tools: [
      // Git workflow
      createFetchTool(task),
      createSwitchBranchTool(task),
      createCreateBranchTool(task),
      createListBranchesTool(task),
      // PR read
      createListPRsTool(task),
      createGetPRTool(task),
      createGetPRStatusTool(task),
      createGetPRChecksTool(task),
      createGetCheckRunTool(task),
      createGetPRReviewsTool(task),
      createGetPRCommentsTool(task),
      createGetReviewThreadsTool(task),
      // Security / code scanning
      createListCodeScanningAlertsTool(task),
      createGetCodeScanningAlertTool(task),
      // PR write
      createPushBranchTool(agent, task),
      createPullRequestTool(agent, task),
      createUpdatePRTool(task),
      createAddPRCommentTool(task),
      createAddReviewCommentTool(task),
      createReplyToReviewCommentTool(task),
      createResolveReviewThreadTool(task),
      createRequestReReviewTool(task),
      createMergePRTool(agent, task),
      createClosePRTool(task),
    ],
  });
}
