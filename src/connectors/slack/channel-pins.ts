/**
 * Per-channel pinned messages and files → standing agent context.
 *
 * What a channel pins is a standing signal about that channel in the same way the `Archie…` canvas is, but a much noisier one: nobody writes a pin for Archie, pins accumulate for years, and anyone in the channel can add one. So this scans them into a one-line INDEX rather than a brief — each item summarised to a single line, both principals (whoever wrote it and whoever pinned it) gated as internal, the result cached in the channel store and injected into the agent's system prompt at spawn. Unlike the canvas it never announces anything: adopting a canvas changes what Archie knows, whereas a pin index is passive.
 *
 * See docs/plans/20260809-channel-pinned-messages-context.md.
 */
import { logger } from '../../system/logger.js';
import { getUserInfo, isExternalUser, listChannelPins } from './client.js';
import {
  loadChannelStore,
  updateChannelStore,
  type ChannelPinEntry,
} from '../../system/channel-store.js';
import { digestOf, normalisePinText, summarisePinText } from './pin-summary.js';

/**
 * Refresh TTL: bound `pins.list` to ~once per minute per channel, mirroring the canvas scan. A newly pinned message therefore lands on the first message after the window expires, up to ~1min behind.
 */
const PINS_TTL_MS = 60_000;

/**
 * How many pins reach the prompt. Channels that have been pinning for years hold hundreds; the newest 25 is what a reader would actually scan, and the count of what was dropped is disclosed in the block rather than hidden.
 */
const MAX_INDEXED_PINS = 25;

/**
 * Rescan the channel's pins and refresh the channel store. Cheap to call on every inbound channel event — a short TTL short-circuits repeat scans, and an unchanged pin reuses its stored summary, so a steady-state scan costs one `pins.list` and nothing else.
 *
 * Runs on the Slack event path, so it must never throw.
 */
export async function ensureChannelPins(channelId: string): Promise<void> {
  if (channelId.startsWith('D')) return;

  try {
    const pre = await loadChannelStore(channelId);
    if (pre && Date.now() - (pre.pinsCheckedAt ?? 0) < PINS_TTL_MS) return;

    const items = await listChannelPins(channelId);
    // null = the pins lookup failed. Reconciling against it would read as "every pin
    // was removed" and blank the channel's standing index. Leave the store untouched —
    // `pinsCheckedAt` stays put too, so the next event retries immediately rather than
    // waiting out the TTL on stale data.
    if (items === null) return;

    const total = items.length;
    const kept = [...items].sort((a, b) => b.pinnedAt - a.pinnedAt).slice(0, MAX_INDEXED_PINS);

    // Memoised per scan: a channel where one person pinned everything costs a single
    // `users.info`, not one per pin. Scoped to this scan rather than the module, so a
    // reclassified user is picked up on the next one.
    const principals = new Map<string, { external: boolean; realName: string } | null>();
    const classify = async (userId: string): Promise<{ external: boolean; realName: string } | null> => {
      if (!userId) return null;
      const hit = principals.get(userId);
      if (hit !== undefined) return hit;
      let resolved: { external: boolean; realName: string } | null = null;
      try {
        const info = await getUserInfo(userId);
        resolved = { external: isExternalUser(info), realName: info.realName };
      } catch {
        resolved = null;
      }
      principals.set(userId, resolved);
      return resolved;
    };

    const entries: ChannelPinEntry[] = [];
    for (const item of kept) {
      const key = (item.kind === 'message' ? item.messageTs : item.fileId) ?? '';
      const authorId = (item.kind === 'message' ? item.author : item.fileUser) ?? '';
      const prior = pre?.pins?.find((p) => p.key === key);

      // Two principals, not one: the person who wrote the pinned thing and the person
      // who pinned it. Either being external is enough to drop the item — a shared
      // channel lets an outsider both author content and elevate someone else's into
      // standing context.
      const author = await classify(authorId);
      const pinner = await classify(item.pinnedBy);

      if (author?.external || pinner?.external) continue;

      // Fail closed on unknown classification: a missing user id or a failed lookup
      // (rate limit, missing scope) must never adopt an unvetted pin into standing
      // agent context — content from outside the workspace in a shared channel would
      // become prompt injection. An already-vetted entry is kept as-is; a new pin is
      // skipped and retried at the next TTL scan.
      if (author === null || pinner === null) {
        if (prior) {
          entries.push(prior);
        } else {
          logger.warn('channel-pins', `principal classification unavailable for pin ${key} in ${channelId} — not adopting yet`);
        }
        continue;
      }

      const sourceText = (item.kind === 'message' ? item.text : item.fileName) ?? '';
      const digest = digestOf(normalisePinText(sourceText));

      // Same text as last scan → same one-liner, and no model call. This is what keeps
      // a steady-state scan free: the digest changes only when the pin itself was
      // edited, so an edited pin is re-summarised exactly once.
      let summary: string;
      let summarySource: 'verbatim' | 'model';
      if (prior && prior.digest === digest) {
        summary = prior.summary;
        summarySource = prior.summarySource;
      } else {
        const summarised = await summarisePinText(sourceText);
        summary = summarised.summary;
        summarySource = summarised.source;
      }

      entries.push({
        kind: item.kind,
        key,
        pinnedAt: item.pinnedAt,
        pinnedBy: item.pinnedBy,
        authorName: author.realName || authorId,
        // A Slack message ts is a decimal epoch-seconds string; a file carries its own
        // creation time.
        postedAt: item.kind === 'message' ? Number(item.messageTs) : (item.fileCreated ?? 0),
        summary,
        summarySource,
        digest,
        ...(item.kind === 'file' ? { fileId: item.fileId } : {}),
        ...(item.permalink ? { permalink: item.permalink } : {}),
      });
    }

    // Wholesale replacement, deliberately: `store.pins` is what this scan derived, never
    // a merge with the previous list, so an unpinned item is simply absent and vanishes
    // from the index on the next scan — no separate removal bookkeeping to get wrong.
    // The revive-a-prior-entry path above cannot resurrect one, since it only ever fires
    // for an item Slack still reports and whose principals could not be classified this
    // time. The one path that preserves a removed pin is the `items === null` return
    // above, which leaves the store untouched entirely — a failed lookup must not read
    // as "everything was unpinned".
    await updateChannelStore(channelId, (store) => {
      store.pins = entries;
      store.pinsCheckedAt = Date.now();
      store.pinsTotal = total;
      return store;
    });
  } catch (err) {
    logger.warn('channel-pins', `ensureChannelPins failed for ${channelId}: ${err}`);
  }
}
