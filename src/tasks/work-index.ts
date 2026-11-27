// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Work index: one row per task of a Slack conversation, kept in that conversation's channel store.
 *
 * Task metadata is authoritative. A row is a copy written on a task's state changes, so the whole index can be rebuilt from metadata.
 */
import type { SlackChannel, TaskMetadata, TaskStatus } from '../types/task.js';
import {
  loadChannelStore,
  updateChannelStore,
  type ChannelWorkRow,
} from '../system/channel-store.js';
import { activeTasks } from './active-tasks.js';
import { deriveTaskDestination } from './destination.js';
import { findTaskIdsByChannel, loadMetadata } from './persistence.js';

/** Rows kept per conversation. Older ones drop out of the index, not out of task metadata. */
export const WORK_INDEX_MAX_ROWS = 50;

const STATE_BY_STATUS: Record<TaskStatus, ChannelWorkRow['state']> = {
  preparing: 'working',
  in_progress: 'working',
  completed: 'waiting',
  stopped: 'stopped',
};

/** The row a task contributes to its conversation, or null while it has no thread there. */
export function workRowFromMetadata(
  metadata: TaskMetadata,
): { conversation: string; row: ChannelWorkRow } | null {
  const channels = metadata.channels ?? {};
  const destination =
    metadata.memory_destination ??
    deriveTaskDestination(channels, metadata.default_channel, metadata.home_channel?.channel_id);
  if (!destination) return null;

  const conversation = destination.channel_id;
  const threads = Object.entries(channels).filter(
    (entry): entry is [string, SlackChannel] =>
      entry[1].type === 'slack' && entry[1].channel_id === conversation,
  );
  const thread = (threads.find(([key]) => key === metadata.default_channel) ?? threads[0])?.[1];
  if (!thread) return null;

  return {
    conversation,
    row: {
      taskId: metadata.task_id,
      threadTs: thread.thread_id,
      title: metadata.title,
      state: STATE_BY_STATUS[metadata.status],
      requestedBy: metadata.requested_by?.name,
      updatedAt: metadata.updated_at,
      lastReply: metadata.last_reply,
    },
  };
}

function newestFirst(rows: ChannelWorkRow[]): ChannelWorkRow[] {
  return [...rows]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, WORK_INDEX_MAX_ROWS);
}

/** Write the task's current row into its conversation's index. */
export async function recordWorkRow(metadata: TaskMetadata): Promise<void> {
  const derived = workRowFromMetadata(metadata);
  if (!derived) return;
  await updateChannelStore(derived.conversation, (store) => {
    const others = (store.work ?? []).filter((row) => row.taskId !== derived.row.taskId);
    store.work = newestFirst([derived.row, ...others]);
  });
}

/** Replace a conversation's index with rows derived from the metadata of every task that lives there. */
export async function rebuildWorkIndex(channelId: string): Promise<ChannelWorkRow[]> {
  const store = await updateChannelStore(channelId, async (current) => {
    const rows: ChannelWorkRow[] = [];
    for (const taskId of await findTaskIdsByChannel(channelId)) {
      // A live task's metadata is ahead of its debounced copy on disk.
      const metadata = activeTasks.get(taskId)?.metadata ?? (await loadMetadata(taskId));
      const derived = metadata ? workRowFromMetadata(metadata) : null;
      if (derived?.conversation === channelId) rows.push(derived.row);
    }
    current.work = newestFirst(rows);
    current.workRebuiltAt = Date.now();
  });
  return store.work ?? [];
}

/** The conversation's rows, newest first. An index that was never rebuilt is rebuilt first, which backfills tasks older than the index. */
export async function loadWorkRows(channelId: string): Promise<ChannelWorkRow[]> {
  const store = await loadChannelStore(channelId);
  if (store?.workRebuiltAt) return store.work ?? [];
  return rebuildWorkIndex(channelId);
}
