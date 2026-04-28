/**
 * Agent Class
 *
 * Each agent owns its runtime state: definition, message queue, SDK handle, session.
 * Created lazily by Task on first message to that agent.
 * Spawned by spawnAgent() from spawn.ts.
 */

import type { AgentDef, AgentHandle } from '../types/agent.js';
import type { AgentName, AgentSessionState } from '../types/task.js';
import type { SandboxOptions } from './sandbox.js';
import { MessageQueue } from './message-queue.js';
import { spawnAgent } from './spawn.js';
import { logger } from '../system/logger.js';

export class Agent {
  readonly def: AgentDef;
  readonly queue: MessageQueue;
  handle?: AgentHandle;
  session: AgentSessionState;
  /**
   * Sandbox config for this agent (read/write paths, network rules).
   * Populated by `spawnAgent` after the per-track sandbox is computed. Used by
   * in-process tools (e.g. `share_artifact`, `post_to_user` artifact_paths) to
   * validate that a path the agent passes points inside its allowed area —
   * keeping a single source of truth instead of duplicating per-tool path lists.
   */
  sandbox?: SandboxOptions;

  constructor(def: AgentDef) {
    this.def = def;
    this.queue = new MessageQueue();
    this.session = { active: false };
  }

  /**
   * Add a message to this agent's queue
   */
  sendMessage(message: string, from?: string): void {
    this.queue.addMessage(message, from);
  }

  /**
   * Whether the agent's SDK process is currently running
   */
  get isRunning(): boolean {
    return this.handle?.isRunning ?? false;
  }

  /**
   * Deactivate the agent (mark session inactive).
   * Called internally by crash detection and task stop/complete.
   */
  deactivate(): void {
    this.session.active = false;
    this.session.last_activity = new Date().toISOString();
  }

  /**
   * Update session state (called when SDK reports session ID or activity)
   */
  updateSession(active: boolean, sessionId?: string): void {
    if (sessionId) {
      this.session.session_id = sessionId;
    }
    this.session.active = active;
    this.session.last_activity = new Date().toISOString();
  }

  /**
   * Spawn this agent for a task. Idempotent — no-op if already running.
   * Handles participant tracking, spawning, crash detection, persist, and logging.
   * Uses dynamic import to avoid circular dependency (agent.ts → spawn.ts → agent.ts).
   */
  async spawn(task: import('../tasks/task.js').Task): Promise<void> {
    if (this.isRunning) return;

    const agentName = this.def.id as AgentName;

    // Restore session from task metadata if we don't have one yet
    if (!this.session.session_id) {
      const entry = task.metadata.agent_sessions[agentName];
      if (entry) {
        this.session = typeof entry === 'string'
          ? { session_id: entry, active: false }
          : { ...entry, active: false };
      }
    }

    // Track participant
    if (!task.metadata.participants.includes(agentName)) {
      task.metadata.participants.push(agentName);
    }

    const hadSession = !!this.session.session_id;

    // Spawn the SDK process
    await spawnAgent(this, task);

    // Wire crash detection: when agent exits, mark inactive
    if (this.handle) {
      this.handle.running.then(() => {
        task.updateAgentState(this.def.id, false);
      });
    }

    // Persist (participant added, repo agent may have mutated worktree info)
    task.debouncedSave();

    // Log
    if (hadSession && this.session.session_id) {
      logger.system(`Resumed ${this.def.id} for task ${task.taskId} (session: ${this.session.session_id})`);
    } else {
      logger.system(`Spawned ${this.def.id} for task ${task.taskId}`);
    }
  }
}
