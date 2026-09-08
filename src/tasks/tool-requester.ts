// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TaskMetadata, SlackThread } from '../types/task.js';
import type { ToolRequester } from '../agents/tool-access.js';
import { randomUUID } from 'crypto';

/** Call only from the verified Slack event handler, at creation of a new task. */
export function requesterFromSlackEvent(thread: SlackThread, userId: string, messageTs: string, teamId: string | null): ToolRequester | undefined {
  const author = thread.messages.find((message) => message.ts === messageTs && message.user.id === userId)?.user;
  if (!teamId || !author || author.teamId !== teamId || author.isRestricted || author.isUltraRestricted || !/^[UW][A-Z0-9]+$/.test(userId)) return undefined;
  return { userId, teamId, channelId: thread.channel.id, messageTs, requestId: randomUUID() };
}

/**
 * A shared task is an authority boundary. Once another input author enters it,
 * never restore its original human's authority from a later reply or deletion.
 * Approval-only policies still work; requester policies require a fresh task.
 */
export function revokeToolRequester(metadata: TaskMetadata): void {
  delete metadata.tool_requester;
}

export function restrictToolRequesterToThread(metadata: TaskMetadata, thread: SlackThread, botUserId: string | null): void {
  const requester = metadata.tool_requester;
  if (!requester) return;
  if (thread.channel.id !== requester.channelId || thread.messages.some((message) => {
    const user = message.user;
    if (user.id === botUserId) return false;
    return user.id !== requester.userId || user.teamId !== requester.teamId ||
      user.isRestricted || user.isUltraRestricted;
  })) revokeToolRequester(metadata);
}

export function sameToolRequester(a: ToolRequester | undefined, b: ToolRequester | undefined): boolean {
  return !!a && !!b && a.requestId === b.requestId && a.userId === b.userId && a.teamId === b.teamId &&
    a.channelId === b.channelId && a.messageTs === b.messageTs;
}
