// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TaskMetadata } from '../types/task.js';

export interface PreparedTaskInput {
  taskId: string; correlation: string; version: string; actor: string; brief: string;
  destination: { channel: string; thread: string; name: string };
}

export interface ApprovedTaskRuntime {
  prepare(input: PreparedTaskInput): Promise<void>;
  start(taskId: string): Promise<void>;
  read(taskId: string): Promise<TaskMetadata | null>;
}

// Task creation is reachable only through the owner-approval handoff. Importing
// the observer or running collection/reflection does not load the task runtime.
export const ordinaryTasks: ApprovedTaskRuntime = {
  async prepare(input) {
    const { Task } = await import('../tasks/task.js');
    await Task.prepare(input);
  },
  async start(taskId) {
    const { Task } = await import('../tasks/task.js');
    await (await Task.get(taskId)).startPrepared();
  },
  async read(taskId) {
    const { loadMetadata } = await import('../tasks/persistence.js');
    return loadMetadata(taskId);
  },
};

export function taskRuntimeState(metadata: TaskMetadata | null): string {
  if (!metadata) return 'not created';
  if (metadata.status === 'preparing') return 'preparing';
  if (metadata.waiting_for) return `waiting: ${metadata.waiting_for}; outcome unverified`;
  if (metadata.pending_merge_approval || metadata.pending_tool_approval) return 'awaiting approval; outcome unverified';
  if (metadata.status === 'completed') return 'parked or awaiting the user; outcome unverified';
  if (metadata.status === 'stopped') return 'stopped; outcome unverified';
  return 'running; outcome unverified';
}
