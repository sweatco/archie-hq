/**
 * Slack Callbacks — process-wide registry
 *
 * server.ts calls setSlackCallbacks() once at startup.
 * Tools and task methods import postToSlack/postInteractiveToSlack directly.
 */

import { logger } from '../../system/logger.js';

type PostFn = (taskId: string, message: string) => Promise<void>;
type PostInteractiveFn = (taskId: string, text: string, blocks: unknown[]) => Promise<void>;

let postCallback: PostFn | null = null;
let postInteractiveCallback: PostInteractiveFn | null = null;

export function setSlackCallbacks(
  postFn: PostFn,
  postInteractiveFn?: PostInteractiveFn,
): void {
  postCallback = postFn;
  if (postInteractiveFn) {
    postInteractiveCallback = postInteractiveFn;
  }
}

export async function postToSlack(taskId: string, message: string): Promise<void> {
  if (postCallback) {
    await postCallback(taskId, message);
  } else {
    logger.slack(`POST: ${message}`);
  }
}

export async function postInteractiveToSlack(
  taskId: string,
  text: string,
  blocks: unknown[],
): Promise<void> {
  if (postInteractiveCallback) {
    await postInteractiveCallback(taskId, text, blocks);
  } else if (postCallback) {
    await postCallback(taskId, `${text}\n\n(Interactive buttons not available)`);
  } else {
    logger.slack(`POST (interactive): ${text}`);
  }
}

export function hasInteractiveCallback(): boolean {
  return postInteractiveCallback !== null;
}
