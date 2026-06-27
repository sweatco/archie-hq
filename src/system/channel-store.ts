/**
 * Channel-level store — per-channel state that outlives any single task.
 *
 * Lives at `$ARCHIE_WORKDIR/slack/channels/<channelId>.json` (namespaced under
 * `slack/` so other messaging platforms can keep sibling stores later). It is
 * workdir-level, NOT per-task, because:
 *   - `member_joined_channel` can fire when no task exists, and
 *   - announce-once must dedup across every task in the channel.
 *
 * Writes go through `updateChannelStore`, which serialises read→modify→write
 * per channel via an in-process mutex. A plain atomic write is not enough —
 * concurrent fire-and-forget Slack events would otherwise lose updates (e.g.
 * drop the `announced` flag and double-announce). The persisted `announced`
 * map is authoritative: in-process caches are empty after a restart, but the
 * store survives, so a restart never re-announces.
 */
import { join } from 'path';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile, rename } from 'fs/promises';
import { WORKDIR } from './workdir.js';
import { logger } from './logger.js';

/** Directory holding per-channel JSON stores for Slack. */
export const SLACK_CHANNELS_DIR = join(WORKDIR, 'slack', 'channels');

/** One adopted (internal-creator) project-context canvas in a channel. */
export interface ChannelCanvasEntry {
  file_id: string;
  title: string;
  creator: string;     // Slack user id of the canvas creator
  external: boolean;   // creator is outside the home workspace (kept false here — externals aren't stored as canvases)
  updatedTs: number;   // files.info.updated — drives change detection
  markdown: string;    // converted canvas body
  fileIds: string[];   // referenced file ids extracted during conversion
}

export interface ChannelStore {
  canvases: ChannelCanvasEntry[];
  /** file_id → true once an adopt/ignore announcement has been posted. */
  announced: Record<string, true>;
  /** Epoch ms of the last canvas scan — used for a short refresh TTL. */
  checkedAt: number;
}

function emptyStore(): ChannelStore {
  return { canvases: [], announced: {}, checkedAt: 0 };
}

function storePath(channelId: string): string {
  return join(SLACK_CHANNELS_DIR, `${channelId}.json`);
}

export async function loadChannelStore(channelId: string): Promise<ChannelStore | null> {
  const p = storePath(channelId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, 'utf-8')) as ChannelStore;
  } catch (err) {
    logger.warn('channel-store', `Failed to parse store for ${channelId}: ${err}`);
    return null;
  }
}

async function writeChannelStore(channelId: string, data: ChannelStore): Promise<void> {
  await mkdir(SLACK_CHANNELS_DIR, { recursive: true });
  const p = storePath(channelId);
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, p); // atomic replace
}

// ---- per-channel serialisation (single-flight read→modify→write) ----
const locks = new Map<string, Promise<unknown>>();

/** Run `fn` after any in-flight work for this channel, serialising per channel. */
function withChannelLock<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(channelId) ?? Promise.resolve();
  // Run fn regardless of whether the previous op resolved or rejected.
  const next = prev.then(fn, fn);
  // Store a never-rejecting tail so a failure doesn't poison the chain.
  locks.set(channelId, next.then(() => {}, () => {}));
  return next;
}

/**
 * Read the channel store, apply `fn`, and persist the result — atomically with
 * respect to other callers for the same channel. `fn` may mutate the passed
 * store in place and return it, return a fresh store, or return void (in which
 * case the passed store is persisted).
 */
export async function updateChannelStore(
  channelId: string,
  fn: (store: ChannelStore) => ChannelStore | void | Promise<ChannelStore | void>,
): Promise<ChannelStore> {
  return withChannelLock(channelId, async () => {
    const current = (await loadChannelStore(channelId)) ?? emptyStore();
    const result = await fn(current);
    const next = (result ?? current) as ChannelStore;
    await writeChannelStore(channelId, next);
    return next;
  });
}
