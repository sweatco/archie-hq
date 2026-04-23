/**
 * Task launch — start a new independent task from within an existing one.
 *
 * The new task starts with zero channels. Its PM must pick a destination
 * (via post_to_user target.new_dm / new_thread) or complete silently.
 */

import { Task } from './task.js';
import { appendLaunchMessage } from './persistence.js';
import { AGENT_PROMPTS } from '../agents/prompts.js';

export async function launchTask(
  originatingTask: Task,
  prompt: string,
  reason: string,
): Promise<{ newTaskId: string; notifiedInChannel: boolean }> {
  if (Object.keys(originatingTask.metadata.channels).length === 0) {
    throw new Error(
      'Cannot launch a new task — this task has no linked channel to report back through. ' +
      'Open a channel first via post_to_user(target.new_dm/new_thread), or handle the work inline.'
    );
  }

  const newTask = await Task.create();

  await appendLaunchMessage(newTask.taskId, originatingTask.taskId, reason, prompt);
  await newTask.sendMessage(AGENT_PROMPTS.newTask);

  const hasDefault = !!originatingTask.metadata.default_channel;
  if (hasDefault) {
    await originatingTask.postToUser(
      `Launched task \`${newTask.taskId}\` — ${reason}`,
      'system',
    );
  }

  return { newTaskId: newTask.taskId, notifiedInChannel: hasDefault };
}
