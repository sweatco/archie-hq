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
import { cleanSlackText, getSlackFileInfo, fetchSlackFileBody, type SlackFileInfo } from './client.js';
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
    // The converter emits mentions in native Slack syntax; resolve them to the
    // `<@ID:Real Name>` / `#<ID:name>` form the rest of the system uses, so a
    // canvas that tags a person or a channel reads as that person or channel
    // rather than as an opaque id. Best-effort: a resolver failure (uninitialised
    // client, rate limit, missing scope) must degrade to raw ids, never lose the
    // whole canvas body.
    let resolved = markdown;
    try {
      resolved = await cleanSlackText(markdown);
    } catch (err) {
      logger.warn('canvas-read', `Mention resolution failed for canvas ${fileId}, keeping raw ids: ${err}`);
    }
    return { markdown: resolved, fileIds, title: fi.title ?? '', creator: fi.user ?? '', updatedTs: fi.updated ?? 0 };
  } catch (err) {
    logger.warn('canvas-read', `Failed to read canvas ${fileId}: ${err}`);
    return null;
  }
}
