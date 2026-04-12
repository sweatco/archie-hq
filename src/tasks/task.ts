/**
 * Task Class
 *
 * The central unit of work. Owns agents, metadata, budgets, lifecycle.
 * Created via Task.create(thread) or Task.get(taskId).
 */

import { mkdir, writeFile } from 'fs/promises';
import type { AgentName, SlackChannel, SlackThread, TaskMetadata } from '../types/task.js';
import type { AgentDef } from '../types/agent.js';

/**
 * Resource budgets for a task (Defense 4 — per-task limits)
 */
export interface TaskBudgets {
  researchRequestCount: number;     // web_research calls made
  researchRequestLimit: number;     // default: 5
  interAgentMessageCount: number;   // send_message_to_agent calls
  interAgentMessageLimit: number;   // default: 100
  taskStartTime: Date;              // for wall-clock timeout
  taskTimeoutMs: number;            // default: 1_800_000 (30 minutes)
}
import { Agent } from '../agents/agent.js';

import {
  loadMetadata,
  getMetadataPath,
  appendAgentFinding,
  appendAgentMessage,
  appendCrossTaskMessage,
  appendMessageToUser,
  appendSlackMessage,
  downloadMessageFiles,
  ensureSessionsDir,
  generateTaskId,
  getSharedPath,
  getMemoryPath,
  getKnowledgeLogPath,
} from './persistence.js';
import { getIsShuttingDown } from '../system/shutdown.js';
import { scheduleIdleCheck } from './recovery.js';
import { scanAgentDefs } from '../agents/registry.js';
import { refreshPlugins } from '../system/workdir.js';
import { postToThreads, postInteractiveToThreads, removeReaction, buildThreadUrl } from '../connectors/slack/client.js';
import { AGENT_PROMPTS } from '../agents/prompts.js';
import { logger } from '../system/logger.js';
import { emitEvent } from '../system/event-bus.js';

// ---- Global state ----

export const activeTasks = new Map<string, Task>();

// ---- Task class ----

export class Task {
  readonly taskId: string;
  metadata: TaskMetadata;
  readonly agentProcesses: Map<AgentName, Agent> = new Map();
  team: AgentDef[];
  budgets: TaskBudgets;
  isActive: boolean = false;
  lastActivity: Date = new Date();
  recoveryAttempts: number = 0;
  taskTimeoutTimer?: ReturnType<typeof setInterval>;

  private constructor(taskId: string, metadata: TaskMetadata, team: AgentDef[]) {
    this.taskId = taskId;
    this.team = team;
    this.budgets = {
      researchRequestCount: metadata.research_request_count ?? 0,
      researchRequestLimit: 5 + (metadata.research_budget_extra ?? 0),
      interAgentMessageCount: 0,
      interAgentMessageLimit: 100,
      taskStartTime: new Date(),
      taskTimeoutMs: 1_800_000, // 30 minutes
    };

    // Migrate legacy slack_threads → channels
    if (metadata.slack_threads?.length && !metadata.channels) {
      metadata.channels = {};
      for (const ref of metadata.slack_threads) {
        const id = `slack:${ref.channel_id}:${ref.thread_id}`;
        metadata.channels[id] = {
          type: 'slack',
          thread_id: ref.thread_id,
          channel_id: ref.channel_id,
          channel_name: '',
          last_processed_ts: ref.last_processed_ts,
        };
        metadata.default_channel ??= id;
      }
      delete metadata.slack_threads;
    }
    // Ensure channels/default_channel exist on metadata
    metadata.channels ??= {};
    metadata.default_channel ??= null;

    this.metadata = metadata;
  }

  // ---- Static factory methods ----

  /**
   * Create a new empty task.
   * Sets up disk structure (folders, metadata, skills).
   * Task is inert until sendMessage() is called, which activates it.
   */
  static async create(): Promise<Task> {
    await refreshPlugins();
    await ensureSessionsDir();

    const taskId = generateTaskId();
    const sharedPath = getSharedPath(taskId);

    // Create task directory structure
    await mkdir(sharedPath, { recursive: true });
    await mkdir(getMemoryPath(taskId), { recursive: true });

    // Scan fresh agent defs for this task
    const team = scanAgentDefs();

    // Build repositories map from repo agent defs
    const repositories: Record<string, { path: string }> = {};
    for (const def of team) {
      if (def.track === 'repo' && def.repo) {
        repositories[def.repo.repoKey] = { path: def.repo.defaultPath };
      }
    }

    // Create initial metadata
    const metadata: TaskMetadata = {
      task_id: taskId,
      task_owner: null,
      participants: [],
      channels: {},
      default_channel: null,
      agent_sessions: {},
      repositories,
      status: 'in_progress',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await writeFile(getMetadataPath(taskId), JSON.stringify(metadata, null, 2));
    await writeFile(getKnowledgeLogPath(taskId), '');

    logger.system(`Created task ${taskId}`);
    emitEvent('task:created', taskId);

    const task = new Task(taskId, metadata, team);
    return task;
  }

  /**
   * Load a task by ID. Returns cached instance if already active.
   * Task is inert until sendMessage() is called, which activates it.
   */
  static async get(taskId: string): Promise<Task> {
    const existing = activeTasks.get(taskId);
    if (existing) return existing;

    await refreshPlugins();

    const metadata = await loadMetadata(taskId);
    if (!metadata) {
      throw new Error(`Task ${taskId} not found`);
    }

    const team = scanAgentDefs();
    return new Task(taskId, metadata, team);
  }

  // ---- Public methods ----

  /**
   * Send a message to an agent (default: PM).
   * Creates agent lazily on first message, spawns if not running.
   * Activates the task on first call (starts timeout, sets status).
   */
  async sendMessage(message: string, agentName: AgentName = 'pm-agent'): Promise<void> {
    if (!this.isActive) {
      this.activate();
    }
    await this.ensureAgentSpawned(agentName);
    const agent = this.agentProcesses.get(agentName);
    if (!agent) {
      throw new Error(`No agent ${agentName} after spawn`);
    }
    agent.queue.addMessage(message);
  }

  /**
   * Append a Slack thread's messages to this task.
   * If the thread is new, links it as a channel and appends all messages.
   * If already linked, appends only messages newer than last_processed_ts.
   * Returns whether a new thread was linked.
   */
  async append(thread: SlackThread): Promise<{ linkedNewThread: boolean }> {
    const channelId = `slack:${thread.channel.id}:${thread.threadId}`;
    const existing = this.metadata.channels[channelId] as SlackChannel | undefined;

    if (!existing) {
      // New thread — link it as a channel and append all messages
      this.metadata.channels[channelId] = {
        type: 'slack',
        thread_id: thread.threadId,
        channel_id: thread.channel.id,
        channel_name: thread.channel.name,
        last_processed_ts: thread.currentMessageTs,
        url: buildThreadUrl(thread.channel.id, thread.threadId) ?? undefined,
      };
      this.metadata.default_channel ??= channelId;

      for (const msg of thread.messages) {
        const downloadedFiles = msg.files ? await downloadMessageFiles(this.taskId, msg.files) : undefined;
        await appendSlackMessage(this.taskId, thread.channel, thread.threadId, msg.user, msg.text, downloadedFiles);
      }

      this.debouncedSave();
      return { linkedNewThread: true };
    }

    // Existing thread — only append messages newer than last_processed_ts
    const lastProcessedTs = existing.last_processed_ts;
    for (const msg of thread.messages) {
      if (msg.ts <= lastProcessedTs) continue;
      const downloadedFiles = msg.files ? await downloadMessageFiles(this.taskId, msg.files) : undefined;
      await appendSlackMessage(this.taskId, thread.channel, thread.threadId, msg.user, msg.text, downloadedFiles);
    }

    existing.last_processed_ts = thread.currentMessageTs;
    this.debouncedSave();
    return { linkedNewThread: false };
  }

  /**
   * Post a message to the user via the default channel.
   * Always emits an event (so CLI sees it via SSE). If the default channel
   * is a Slack thread, also posts there.
   */
  async postToUser(message: string, agentName?: string): Promise<void> {
    const sender = agentName || 'system';
    emitEvent('message', this.taskId, { from: sender, to: 'user', message });
    await appendMessageToUser(this.taskId, sender, message);

    const defaultCh = this.metadata.default_channel
      ? this.metadata.channels[this.metadata.default_channel]
      : null;
    if (defaultCh?.type === 'parent') {
      // Route to parent task's originating agent — same as Slack/CLI: log + event + standard prompt
      await deliverMessage(defaultCh.parent_task_id, message, `subtask:${this.taskId}`, defaultCh.parent_agent as AgentName);
    } else {
      // Post to Slack threads
      const slackRefs = this.getSlackThreadRefs();
      if (slackRefs.length > 0) {
        // Remove eyes acknowledgment before posting the reply
        await Promise.all(
          slackRefs.map((ref) => removeReaction(ref.channel_id, ref.last_processed_ts, 'eyes')),
        );
        await postToThreads(slackRefs, message);
      }
    }
  }

  /**
   * Post an interactive message (with blocks) to the user.
   * Always emits an approval:requested event (so CLI sees it).
   * If Slack channels exist, also posts interactive message there.
   */
  async postInteractiveToUser(text: string, blocks: unknown[], approvalType: 'edit_mode' | 'research_budget' | 'subtask_budget'): Promise<void> {
    emitEvent('approval:requested', this.taskId, { text, approvalType });

    const slackRefs = this.getSlackThreadRefs();
    if (slackRefs.length > 0) {
      await postInteractiveToThreads(slackRefs, text, blocks);
    } else {
      logger.slack(`POST (interactive): ${text}`);
    }
  }

  /**
   * Extract SlackThreadRef[] from channels for posting via Slack client.
   */
  private getSlackThreadRefs(): { thread_id: string; channel_id: string; last_processed_ts: string }[] {
    return Object.values(this.metadata.channels)
      .filter((ch): ch is SlackChannel => ch.type === 'slack')
      .map((ch) => ({
        thread_id: ch.thread_id,
        channel_id: ch.channel_id,
        last_processed_ts: ch.last_processed_ts,
      }));
  }

  /**
   * Stop the task and clean up all agents.
   */
  async stop(): Promise<void> {
    if (!this.isActive) {
      logger.system(`Task ${this.taskId} already stopped`);
      return;
    }

    this.isActive = false;
    activeTasks.delete(this.taskId);
    this.clearTaskTimeout();
    this.stopAgents();

    // Clean up clones to free disk space (only when not in edit mode)
    if (this.metadata.edit_allowed !== true) {
      await this.cleanupClones();
    }

    this.metadata.status = 'stopped';
    await this.save(true);

    logger.system(`Task ${this.taskId} stopped`);
    emitEvent('task:stopped', this.taskId);
  }

  /**
   * Complete the task.
   */
  async complete(): Promise<void> {
    if (!this.isActive) {
      logger.system(`Task ${this.taskId} already completed/stopped`);
      return;
    }

    this.isActive = false;
    activeTasks.delete(this.taskId);
    this.clearTaskTimeout();

    this.stopAgents();

    // Clean up clones to free disk space (only when not in edit mode).
    // RW clones (edit_allowed) are kept — they have branches, commits, PRs.
    if (this.metadata.edit_allowed !== true) {
      await this.cleanupClones();
    }

    this.metadata.status = 'completed';
    await this.save(true);

    logger.system(`Task ${this.taskId} completed`);
    emitEvent('task:completed', this.taskId);
  }

  /**
   * Stop all agents gracefully.
   * Active agents (mid-turn) get pendingClose — they finish their turn,
   * the Stop hook fires, and close() runs on the next tick.
   * Idle agents (waiting for input) get closed immediately.
   */
  private stopAgents(): void {
    for (const a of this.agentProcesses.values()) {
      if (a.session.active) {
        a.pendingClose = true;
      } else {
        a.close();
      }
    }
  }

  /**
   * Remove shared clones and clear clone_path so next spawn creates a fresh one.
   */
  private async cleanupClones(): Promise<void> {
    const { removeClone } = await import('../connectors/github/repo-clone.js');
    for (const [repoKey, repoInfo] of Object.entries(this.metadata.repositories)) {
      if (repoInfo.clone_path) {
        try {
          await removeClone(repoInfo.clone_path);
          repoInfo.clone_path = undefined;
          logger.system(`Task ${this.taskId}: cleaned up clone for ${repoKey}`);
        } catch (error) {
          logger.warn('task', `Failed to cleanup clone for ${repoKey}: ${error}`);
        }
      }
    }
  }

  /**
   * Get status of all spawned agents.
   */
  getAgentStatus(): { agent: string; active: boolean; last_activity?: string }[] {
    const statuses: { agent: string; active: boolean; last_activity?: string }[] = [];
    for (const [agentName, agent] of this.agentProcesses) {
      statuses.push({
        agent: agentName,
        active: agent.session.active,
        last_activity: agent.session.last_activity,
      });
    }
    return statuses;
  }

  /**
   * Touch — update last activity timestamp.
   */
  touch(): void {
    this.lastActivity = new Date();
  }

  /**
   * Save task state to disk (debounced unless flush=true).
   * Syncs agent sessions to metadata before write.
   */
  async save(flush?: boolean): Promise<void> {
    // Sync agent sessions into metadata
    for (const [agentName, agent] of this.agentProcesses) {
      this.metadata.agent_sessions[agentName] = { ...agent.session };
    }
    this.metadata.updated_at = new Date().toISOString();

    // Use legacy save for now (debounced write)
    // saveLegacyTask expects TaskRuntimeState, but we need to bridge
    // For now, write directly
    if (flush) {
      await writeFile(
        getMetadataPath(this.taskId),
        JSON.stringify(this.metadata, null, 2),
      );
    } else {
      // Debounced — use the legacy saveTask by creating a compat shim
      this.debouncedSave();
    }
  }

  /**
   * Handle send_message_to_agent tool call.
   * Routes message from one agent to another within this task.
   * Stays on Task because it involves lazy spawn + budget tracking + queue routing.
   */
  async toolSendMessage(fromAgent: AgentName, target: AgentName, message: string): Promise<string> {
    logger.agentMessage(fromAgent, target, message, { truncate: 100 });
    this.lastActivity = new Date();

    // Inter-agent message budget tracking
    this.budgets.interAgentMessageCount++;
    if (this.budgets.interAgentMessageCount > this.budgets.interAgentMessageLimit) {
      logger.warn('budget', `Inter-agent message limit exceeded for task ${this.taskId}`);
      this.postToUser(
        `⚠️ Inter-agent message limit exceeded (${this.budgets.interAgentMessageCount}/${this.budgets.interAgentMessageLimit}).`,
      ).catch((err: unknown) => logger.error('budget', 'Failed to post message limit warning', err));
    }

    await appendAgentMessage(this.taskId, fromAgent, target, message);

    if (!this.isActive) {
      logger.warn('task', `Task ${this.taskId} is inactive but ${fromAgent} is sending message`);
      return 'Task is inactive, message logged to knowledge.log.';
    }

    await this.ensureAgentSpawned(target);
    const targetAgent = this.agentProcesses.get(target);
    if (!targetAgent) {
      throw new Error(`No agent ${target} after spawn`);
    }
    targetAgent.queue.addMessage(message, fromAgent);

    return `Message sent to ${target}. They will process it and log findings.`;
  }

  // Research budget methods (used by tools and research-tools)

  checkResearchBudget(): { allowed: boolean; used: number; limit: number } {
    return {
      allowed: this.budgets.researchRequestCount < this.budgets.researchRequestLimit,
      used: this.budgets.researchRequestCount,
      limit: this.budgets.researchRequestLimit,
    };
  }

  incrementResearchCount(): void {
    this.budgets.researchRequestCount++;
    logger.debug(
      'budget',
      `Research request ${this.budgets.researchRequestCount}/${this.budgets.researchRequestLimit} for task ${this.taskId}`,
    );
    this.metadata.research_request_count = this.budgets.researchRequestCount;
    this.debouncedSave();
  }

  async onResearchBudgetExceeded(): Promise<void> {
    logger.warn(
      'budget',
      `Research budget exceeded for task ${this.taskId} (${this.budgets.researchRequestCount}/${this.budgets.researchRequestLimit})`,
    );

    // Subtasks: no approval flow, research tool will return error, agent reports back naturally
    if (this.metadata.parent_task_id) return;

    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Research budget reached* (${this.budgets.researchRequestCount}/${this.budgets.researchRequestLimit} requests). Approve additional research?`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Approve (+5)' },
            action_id: 'approve_research_budget',
            value: this.taskId,
            style: 'primary',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Deny' },
            action_id: 'deny_research_budget',
            value: this.taskId,
            style: 'danger',
          },
        ],
      },
    ];
    await this.postInteractiveToUser(
      `Research budget reached (${this.budgets.researchRequestCount}/${this.budgets.researchRequestLimit} requests)`,
      blocks,
      'research_budget',
    ).catch((err: unknown) => logger.error('budget', 'Failed to post budget approval request', err));

    await this.stop();
  }

  // ---- Approval handlers ----

  async handleEditModeApproval(): Promise<void> {
    this.metadata.edit_allowed = true;
    this.debouncedSave();
    await appendAgentFinding(this.taskId, 'system', 'Edit mode approved by user', 'decision');
    await this.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
  }

  async handleEditModeDenial(): Promise<void> {
    await appendAgentFinding(this.taskId, 'system', 'Edit mode denied by user', 'decision');
    await this.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
  }

  async handleResearchBudgetApproval(): Promise<void> {
    this.metadata.research_budget_extra = (this.metadata.research_budget_extra ?? 0) + 5;
    this.budgets.researchRequestLimit = 5 + (this.metadata.research_budget_extra ?? 0);
    this.debouncedSave();
    await appendAgentFinding(
      this.taskId,
      'system',
      `Research budget extended by user (+5 requests, total extra: ${this.metadata.research_budget_extra})`,
      'decision',
    );
    await this.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
  }

  async handleResearchBudgetDenial(): Promise<void> {
    await appendAgentFinding(this.taskId, 'system', 'Additional research denied by user', 'decision');
    await this.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
  }

  // ---- Subtask budget methods ----

  checkSubtaskBudget(): { allowed: boolean; used: number; limit: number } {
    const used = this.metadata.subtask_ids?.length ?? 0;
    const limit = 10 + (this.metadata.subtask_budget_extra ?? 0);
    return { allowed: used < limit, used, limit };
  }

  async onSubtaskBudgetExceeded(): Promise<void> {
    const { used, limit } = this.checkSubtaskBudget();
    logger.warn('budget', `Subtask budget exceeded for task ${this.taskId} (${used}/${limit})`);

    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Subtask budget reached* (${used}/${limit} subtasks). Approve additional subtasks?`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Approve (+10)' },
            action_id: 'approve_subtask_budget',
            value: this.taskId,
            style: 'primary',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Deny' },
            action_id: 'deny_subtask_budget',
            value: this.taskId,
            style: 'danger',
          },
        ],
      },
    ];
    await this.postInteractiveToUser(
      `Subtask budget reached (${used}/${limit} subtasks)`,
      blocks,
      'subtask_budget',
    ).catch((err: unknown) => logger.error('budget', 'Failed to post subtask budget approval request', err));

    await this.stop();
  }

  async handleSubtaskBudgetApproval(): Promise<void> {
    this.metadata.subtask_budget_extra = (this.metadata.subtask_budget_extra ?? 0) + 10;
    this.debouncedSave();
    await appendAgentFinding(
      this.taskId,
      'system',
      `Subtask budget extended by user (+10 subtasks, total extra: ${this.metadata.subtask_budget_extra})`,
      'decision',
    );
    await this.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
  }

  async handleSubtaskBudgetDenial(): Promise<void> {
    await appendAgentFinding(this.taskId, 'system', 'Additional subtasks denied by user', 'decision');
    await this.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
  }

  // ---- Internal methods ----

  /**
   * Update an agent's active state and persist.
   */
  updateAgentState(agentName: AgentName | string, active: boolean, sessionId?: string): void {
    if (!active && getIsShuttingDown()) return;

    const name = agentName as AgentName;
    const agent = this.agentProcesses.get(name);

    // Idempotency: skip if agent is already in the requested state (no sessionId update needed)
    if (agent && agent.session.active === active && !sessionId) return;

    if (agent) {
      agent.updateSession(active, sessionId);

      // If agent was marked for deferred close (task completed/stopped),
      // close the SDK process on next tick so the Stop hook can finish cleanly.
      if (!active && agent.pendingClose) {
        setTimeout(() => agent.close(), 0);
      }
    }

    emitEvent(active ? 'agent:active' : 'agent:inactive', this.taskId, {}, name);
    this.debouncedSave();

    if (!active) {
      // Schedule idle check via legacy function
      // Pass a compat shim
      scheduleIdleCheck(this);
    }
  }

  /**
   * Ensure an agent is created and spawned.
   */
  private async ensureAgentSpawned(agentName: AgentName): Promise<void> {
    let agent = this.agentProcesses.get(agentName);

    if (!agent) {
      const def = this.team.find((d) => d.id === agentName);
      if (!def) {
        throw new Error(`Unknown agent: ${agentName}`);
      }
      agent = new Agent(def);
      this.agentProcesses.set(agentName, agent);
    }

    await agent.spawn(this);
  }

  /**
   * Activate the task — start timeout, mark in_progress.
   * Called lazily on first sendMessage().
   */
  private activate(): void {
    this.isActive = true;
    this.metadata.status = 'in_progress';
    activeTasks.set(this.taskId, this);
    this.startTaskTimeout();
    emitEvent('task:resumed', this.taskId);
    this.debouncedSave();
  }

  private startTaskTimeout(): void {
    this.taskTimeoutTimer = setInterval(async () => {
      const elapsed = Date.now() - this.budgets.taskStartTime.getTime();
      if (elapsed >= this.budgets.taskTimeoutMs) {
        logger.warn(
          'budget',
          `Task ${this.taskId} exceeded wall-clock timeout (${Math.round(elapsed / 60_000)}min)`,
        );
        const timeoutMessage = this.metadata.parent_task_id
          ? `Subtask timed out after ${Math.round(elapsed / 60_000)} minutes without completing. Partial findings (if any) are in the knowledge log.`
          : `⏱️ Task timed out after ${Math.round(elapsed / 60_000)} minutes. Stopping task.`;
        await this.postToUser(timeoutMessage)
          .catch((err: unknown) => logger.error('budget', 'Failed to post timeout message', err));
        await this.stop();
      }
    }, 60_000);
  }

  private clearTaskTimeout(): void {
    if (this.taskTimeoutTimer) {
      clearInterval(this.taskTimeoutTimer);
      this.taskTimeoutTimer = undefined;
    }
  }

  // Debounced save timer
  private saveTimer?: ReturnType<typeof setTimeout>;

  debouncedSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = undefined;
      try {
        // Sync sessions
        for (const [agentName, agent] of this.agentProcesses) {
          this.metadata.agent_sessions[agentName] = { ...agent.session };
        }
        this.metadata.updated_at = new Date().toISOString();
        await writeFile(
          getMetadataPath(this.taskId),
          JSON.stringify(this.metadata, null, 2),
        );
      } catch (err) {
        logger.error('task', `Failed to save task ${this.taskId}`, err);
      }
    }, 500);
  }

}

// ---- Cross-task message delivery ----

/**
 * Deliver a message to any task's agent. Follows the same pattern as
 * Slack (appendSlackMessage + sendMessage) and CLI (appendCliMessage + sendMessage):
 * 1. Log message to target task's knowledge log + emit event
 * 2. Load/reactivate task + send standard prompt to agent (agent reads knowledge log)
 */
export async function deliverMessage(
  taskId: string,
  message: string,
  source: string,
  targetAgent: AgentName = 'pm-agent',
): Promise<void> {
  await appendCrossTaskMessage(taskId, source, message, targetAgent);

  const task = activeTasks.get(taskId) ?? await Task.get(taskId);
  await task.sendMessage(AGENT_PROMPTS.existingTask, targetAgent);
}

// ---- Module-level accessor functions (backward compat) ----

export function isTaskActive(taskId: string): boolean {
  return activeTasks.has(taskId);
}

export function getActiveTaskIds(): string[] {
  return Array.from(activeTasks.keys());
}

export function getTask(taskId: string): Task | undefined {
  return activeTasks.get(taskId);
}
