/**
 * Task Class
 *
 * The central unit of work. Owns agents, metadata, budgets, lifecycle.
 * Created via Task.createFromSlackThread() or Task.get().
 *
 * Implementation filled in at Step 6.
 */

import { mkdir, writeFile, symlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { AgentName, SlackThread, TaskMetadata } from '../types/task.js';
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
  ensureSessionsDir,
  generateTaskId,
  getSharedPath,
  getMemoryPath,
  getKnowledgeLogPath,
} from '../system/task-manager.js';
import { getPluginsWithPmSkills } from '../system/plugin-loader.js';
import { getIsShuttingDown } from '../system/server.js';
import { scheduleIdleCheck } from '../system/task-recovery.js';
import { scanAgentDefs } from '../agents/registry.js';
import { postToSlack, postInteractiveToSlack, hasInteractiveCallback } from '../slack/callbacks.js';
import { AGENT_PROMPTS } from '../agents/prompts.js';
import { logger } from '../system/logger.js';

// ---- Global state ----

export const activeTasks = new Map<string, Task>();

// ---- Task class ----

export class Task {
  readonly taskId: string;
  metadata: TaskMetadata;
  readonly agents: Map<AgentName, Agent> = new Map();
  team: AgentDef[];
  budgets: TaskBudgets;
  isActive: boolean = true;
  lastActivity: Date = new Date();
  recoveryAttempts: number = 0;
  timeoutInterval?: ReturnType<typeof setInterval>;

  private constructor(taskId: string, metadata: TaskMetadata, team: AgentDef[]) {
    this.taskId = taskId;
    this.metadata = metadata;
    this.team = team;
    this.budgets = {
      researchRequestCount: metadata.research_request_count ?? 0,
      researchRequestLimit: 5 + (metadata.research_budget_extra ?? 0),
      interAgentMessageCount: 0,
      interAgentMessageLimit: 100,
      taskStartTime: new Date(),
      taskTimeoutMs: 1_800_000, // 30 minutes
    };
  }

  // ---- Static factory methods ----

  /**
   * Create a new task from a Slack thread.
   * Sets up disk structure, registers in activeTasks.
   */
  static async createFromSlackThread(slackThread: SlackThread): Promise<Task> {
    await ensureSessionsDir();

    const taskId = generateTaskId();
    const sharedPath = getSharedPath(taskId);

    // Create task directory structure
    await mkdir(sharedPath, { recursive: true });
    await mkdir(getMemoryPath(taskId), { recursive: true });

    // Symlink PM skills from all loaded plugins into task shared folder
    const skillsTarget = join(sharedPath, '.claude', 'skills');
    await mkdir(join(sharedPath, '.claude'), { recursive: true });

    for (const plugin of getPluginsWithPmSkills()) {
      for (const skill of plugin.pmSkills) {
        const target = join(skillsTarget, skill.namespacedName);
        if (!existsSync(target)) {
          await mkdir(skillsTarget, { recursive: true });
          await symlink(skill.sourcePath, target);
        }
      }
    }

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
      slack_threads: [slackThread],
      agent_sessions: {},
      repositories,
      status: 'in_progress',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await writeFile(getMetadataPath(taskId), JSON.stringify(metadata, null, 2));
    await writeFile(getKnowledgeLogPath(taskId), '');

    logger.system(`Created task ${taskId}`);

    const task = new Task(taskId, metadata, team);
    task.startTimeoutInterval();
    activeTasks.set(taskId, task);
    return task;
  }

  /**
   * Load (or return cached) a task by ID.
   */
  static async get(taskId: string): Promise<Task> {
    const existing = activeTasks.get(taskId);
    if (existing) return existing;

    const metadata = await loadMetadata(taskId);
    if (!metadata) {
      throw new Error(`Task ${taskId} not found`);
    }

    metadata.status = 'in_progress';
    const team = scanAgentDefs();
    const task = new Task(taskId, metadata, team);

    task.startTimeoutInterval();
    activeTasks.set(taskId, task);
    return task;
  }

  // ---- Public methods ----

  /**
   * Send a message to an agent (default: PM).
   * Creates agent lazily on first message, spawns if not running.
   */
  async sendMessage(message: string, agentName: AgentName = 'pm-agent'): Promise<void> {
    await this.ensureAgentSpawned(agentName);
    const agent = this.agents.get(agentName);
    if (!agent) {
      throw new Error(`No agent ${agentName} after spawn`);
    }
    agent.queue.addMessage(message);
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
    this.clearTimeout();

    // Deactivate all agents
    for (const [agentName] of this.agents) {
      this.updateAgentState(agentName, false);
    }

    // Stop all queues
    for (const a of this.agents.values()) {
      a.queue.stop();
    }

    // Final write
    this.metadata.status = 'stopped';
    await this.save(true);

    activeTasks.delete(this.taskId);
    logger.system(`Task ${this.taskId} stopped`);
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
    this.clearTimeout();

    for (const [agentName] of this.agents) {
      this.updateAgentState(agentName, false);
    }

    for (const a of this.agents.values()) {
      a.queue.stop();
    }

    this.metadata.status = 'completed';
    await this.save(true);

    activeTasks.delete(this.taskId);
    logger.system(`Task ${this.taskId} completed`);
  }

  /**
   * Get status of all spawned agents.
   */
  getAgentStatus(): { agent: string; active: boolean; last_activity?: string }[] {
    const statuses: { agent: string; active: boolean; last_activity?: string }[] = [];
    for (const [agentName, agent] of this.agents) {
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
    for (const [agentName, agent] of this.agents) {
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
      postToSlack(
        this.taskId,
        `⚠️ Inter-agent message limit exceeded (${this.budgets.interAgentMessageCount}/${this.budgets.interAgentMessageLimit}).`,
      ).catch((err: unknown) => logger.error('budget', 'Failed to post message limit warning', err));
    }

    await appendAgentFinding(this.taskId, fromAgent, `→ ${target}: ${message}`, 'decision');

    if (!this.isActive) {
      logger.warn('task', `Task ${this.taskId} is inactive but ${fromAgent} is sending message`);
      return 'Task is inactive, message logged to knowledge.log.';
    }

    const alreadyRunning = this.agents.get(target)?.isRunning ?? false;
    await this.ensureAgentSpawned(target);
    const targetAgent = this.agents.get(target);
    if (!targetAgent) {
      throw new Error(`No agent ${target} after spawn`);
    }
    targetAgent.queue.addMessage(message, fromAgent);
    if (alreadyRunning) {
      logger.system(`Message from ${fromAgent} queued to running ${target}: "${message.slice(0, 100)}"`);
    }

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

    if (hasInteractiveCallback()) {
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
      await postInteractiveToSlack(
        this.taskId,
        `Research budget reached (${this.budgets.researchRequestCount}/${this.budgets.researchRequestLimit} requests)`,
        blocks,
      ).catch((err: unknown) => logger.error('budget', 'Failed to post budget approval request', err));
    } else {
      await postToSlack(
        this.taskId,
        `Research budget reached (${this.budgets.researchRequestCount}/${this.budgets.researchRequestLimit} requests). Stopping task.`,
      ).catch((err: unknown) => logger.error('budget', 'Failed to post budget message', err));
    }

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

  // ---- Internal methods ----

  /**
   * Update an agent's active state and persist.
   */
  updateAgentState(agentName: AgentName | string, active: boolean, sessionId?: string): void {
    if (!active && getIsShuttingDown()) return;

    const name = agentName as AgentName;
    const agent = this.agents.get(name);
    if (agent) {
      agent.updateSession(active, sessionId);
    }

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
    let agent = this.agents.get(agentName);

    if (!agent) {
      const def = this.team.find((d) => d.id === agentName);
      if (!def) {
        throw new Error(`Unknown agent: ${agentName}`);
      }
      agent = new Agent(def);
      this.agents.set(agentName, agent);
    }

    await agent.spawn(this);
  }

  private startTimeoutInterval(): void {
    this.timeoutInterval = setInterval(async () => {
      const elapsed = Date.now() - this.budgets.taskStartTime.getTime();
      if (elapsed >= this.budgets.taskTimeoutMs) {
        logger.warn(
          'budget',
          `Task ${this.taskId} exceeded wall-clock timeout (${Math.round(elapsed / 60_000)}min)`,
        );
        await postToSlack(
          this.taskId,
          `⏱️ Task timed out after ${Math.round(elapsed / 60_000)} minutes. Stopping task.`,
        ).catch((err: unknown) => logger.error('budget', 'Failed to post timeout message', err));
        await this.stop();
      }
    }, 60_000);
  }

  private clearTimeout(): void {
    if (this.timeoutInterval) {
      clearInterval(this.timeoutInterval);
      this.timeoutInterval = undefined;
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
        for (const [agentName, agent] of this.agents) {
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
