/**
 * Read a Slack canvas as markdown — the bot-token primitive.
 *
 * A canvas is read as a FILE: files.info → url_private_download → bot Bearer
 * GET → HTML → markdown (+ extracted referenced file ids). Kept in its own leaf
 * module (depends only on the Slack client + the pure converter) so consumers
 * like the PM fetch tool can use it without pulling in the channel store or the
 * announce/refresh orchestration.
 */
import { logger } from '../../system/logger.js';
import { getSlackFileInfo, fetchSlackFileBody, type SlackFileInfo } from './client.js';
import { canvasHtmlToMarkdown } from './canvas-markdown.js';

export interface CanvasRead {
  markdown: string;
  fileIds: string[];
  title: string;
  creator: string;
  updatedTs: number;
}

/**
 * Read a canvas file as markdown + referenced file ids. Pass `info` to reuse an
 * already-fetched `files.info` result and avoid a second call. Returns null on
 * failure.
 */
export async function readCanvas(fileId: string, info?: SlackFileInfo | null): Promise<CanvasRead | null> {
  const fi = info ?? (await getSlackFileInfo(fileId));
  const url = fi?.url_private_download || fi?.url_private;
  if (!fi || !url) return null;
  try {
    const html = await fetchSlackFileBody(url);
    const { markdown, fileIds } = canvasHtmlToMarkdown(html);
    return { markdown, fileIds, title: fi.title ?? '', creator: fi.user ?? '', updatedTs: fi.updated ?? 0 };
  } catch (err) {
    logger.warn('canvas-read', `Failed to read canvas ${fileId}: ${err}`);
    return null;
  }
}
