/**
 * Agent Class
 *
 * Each agent owns its runtime state: definition, message queue, SDK handle, session.
 * Created lazily by Task on first message to that agent.
 * Spawned by spawnAgent() from spawn.ts.
 */

import type { AgentDef, AgentHandle, McpToolMeta } from '../types/agent.js';
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
   * Per-tool metadata reported by this agent's connected MCP servers (from the
   * SDK `mcpServerStatus()` snapshot at turn start), keyed by the namespaced
   * tool name `mcp__<server>__<tool>`. Used to phrase the Slack status line from
   * server-reported `readOnly` annotations + names — no per-integration map.
   */
  mcpTools?: Map<string, McpToolMeta>;
  /**
   * Sandbox config for this agent (read/write paths, network rules).
   * Populated by `spawnAgent` after the per-track sandbox is computed. Used by
   * in-process tools (e.g. `share_artifact`, `post_to_user` artifact_paths) to
   * validate that a path the agent passes points inside its allowed area —
   * keeping a single source of truth instead of duplicating per-tool path lists.
   */
  sandbox?: SandboxOptions;

  /**
   * A task teardown (complete/stop) deferred until this agent's current turn
   * ends. The spawn loop runs it when it sees the SDK `result` event, so the
   * triggering tool's response and the Stop hook's control round-trip both
   * finish over an open input stream. Tearing down mid-turn closes the stream
   * while a hook is still doing its control round-trip, which the SDK surfaces
   * as a "stream closed" error. Set via `deferTeardown`.
   */
  private _pendingTeardown?: () => Promise<void>;

  constructor(def: AgentDef) {
    this.def = def;
    this.queue = new MessageQueue();
    this.session = { active: false };
  }

  /**
   * Defer a task teardown (e.g. `task.complete()` / `task.stop()`) until this
   * agent's current turn ends — see {@link pendingTeardown}. First request wins;
   * later calls in the same turn are ignored, so a tool that fires twice can't
   * trigger a double teardown or duplicate side-effects.
   */
  deferTeardown(action: () => Promise<void>): void {
    this._pendingTeardown ??= action;
  }

  /**
   * The teardown queued by {@link deferTeardown}, run by the spawn loop once the
   * SDK emits this turn's `result` event. Undefined when nothing is pending.
   */
  get pendingTeardown(): (() => Promise<void>) | undefined {
    return this._pendingTeardown;
  }

  /**
   * Drop any queued teardown. Called at the start of each spawn so a flag armed
   * in a previous run on this reused Agent object (tasks park via `complete()`
   * and reopen onto the same agents) can't fire against the next run.
   */
  clearPendingTeardown(): void {
    this._pendingTeardown = undefined;
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

    // Wire crash detection: when the SDK iterator exits, mark inactive.
    if (this.handle) {
      this.handle.running.then(() => {
        task.updateAgentState(this.def.id, false);
      });
    }

    // Persist (participant added, repo agent may have mutated attached repos)
    task.debouncedSave();

    // Log
    if (hadSession && this.session.session_id) {
      logger.system(`Resumed ${this.def.id} for task ${task.taskId} (session: ${this.session.session_id})`);
    } else {
      logger.system(`Spawned ${this.def.id} for task ${task.taskId}`);
    }
  }
}
