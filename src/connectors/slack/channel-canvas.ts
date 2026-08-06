/**
 * Per-channel "Archie" canvas → PM project context.
 *
 * A canvas titled `Archie…` pinned as a channel tab becomes standing project
 * context for every task in that channel. We discover it via canvas tabs, read
 * it bot-token-only (as a file → HTML → markdown), gate on the creator being
 * internal, cache the result in the channel store, and inject it into the PM's
 * system prompt at spawn. Referenced files are pulled on demand by the PM.
 *
 * See docs/plans/20260627-channel-canvas-project-context.md.
 */
import { logger } from '../../system/logger.js';
import {
  getChannelCanvasTabs,
  getSlackFileInfo,
  getUserInfo,
  isExternalUser,
  postSlackMessage,
} from './client.js';
import { readCanvas } from './canvas-read.js';
import {
  loadChannelStore,
  updateChannelStore,
  type ChannelCanvasEntry,
} from '../../system/channel-store.js';
import type { TaskMetadata } from '../../types/task.js';

/** Canvas titles must start with this (case-insensitive) to be picked up. */
const ARCHIE_TITLE = /^archie/i;

/**
 * A canvas carries TWO independent names and either may be the one a channel
 * member edited:
 *
 *   - the **document title** (`files.info.title`), and
 *   - the **tab label** (`conversations.info` → `properties.tabs[].label`), which
 *     is what the channel header actually displays. Slack leaves it empty until
 *     someone renames the tab explicitly, then shows it in place of the title.
 *
 * Matching the document title alone made renaming the *visible* name a no-op —
 * observed live with a tab labelled `Archie — Test cavas (x)` whose document was
 * still `Test cavas`: the canvas was silently dropped from context. People rename
 * what they can see, so either name opting in is enough.
 *
 * The label wins for display when set, since that is the name the channel shows.
 */
function canvasNames(tabLabel: string | undefined, fileTitle: string | undefined): {
  display: string;
  matches: boolean;
} {
  const label = (tabLabel ?? '').trim();
  const title = (fileTitle ?? '').trim();
  return {
    display: label || title,
    matches: ARCHIE_TITLE.test(label) || ARCHIE_TITLE.test(title),
  };
}
/**
 * Refresh TTL: bound canvas API calls to ~once per minute per channel.
 *
 * Checked before any Slack call, so it cannot be conditioned on "did `updated`
 * change?" — learning that requires the `files.info` call the TTL exists to avoid.
 * A canvas edit or rename therefore lands on the first message after the window
 * expires, up to ~1min behind.
 *
 * Note this is not what protects against expensive work: the `updatedTs` comparison
 * below already skips downloading and converting canvas HTML when the body is
 * unchanged, and an unchanged canvas costs one `files.info` and nothing else.
 */
const CANVAS_TTL_MS = 60_000;

/**
 * Discover the channel's `Archie…` canvas tab(s), refresh the channel store if
 * anything changed, and announce adoption / ignore exactly once. Cheap to call
 * on every inbound channel event — a short TTL short-circuits repeat scans.
 *
 * All Slack reads happen outside the store lock; the lock only does the
 * in-memory merge + dedup + persist, so announce-once survives concurrent
 * fire-and-forget events.
 */
export async function ensureChannelCanvas(channelId: string): Promise<void> {
  if (channelId.startsWith('D')) return;

  try {
    const pre = await loadChannelStore(channelId);
    if (pre && Date.now() - pre.checkedAt < CANVAS_TTL_MS) return;

    const tabs = await getChannelCanvasTabs(channelId);
    // null = the tab lookup failed. Reconciling against it would read as "every
    // canvas was removed" and blank the channel's standing context. Leave the store
    // untouched — `checkedAt` stays put too, so the next event retries immediately
    // rather than waiting out the TTL on stale data.
    if (tabs === null) return;

    type Resolved = { fileId: string; title: string; external: boolean; entry?: ChannelCanvasEntry };
    const resolved: Resolved[] = [];

    for (const tab of tabs) {
      const info = await getSlackFileInfo(tab.file_id);
      const { display: title, matches } = canvasNames(tab.title, info?.title);
      if (!info || !matches) continue;

      const creator = info.user ?? '';
      const updatedTs = info.updated ?? 0;
      const prevEntry = pre?.canvases.find((c) => c.file_id === tab.file_id);

      // Nothing about this canvas has changed since the last scan — reuse the stored
      // entry wholesale and make no further API calls, keeping a steady-state scan at
      // one `files.info` per tab. Requires the SAME creator as the classification we
      // stored: `files.info.user` is immutable for a file, so a mismatch means we are
      // not looking at what we vetted, and it falls through to a fresh check below.
      if (
        prevEntry &&
        prevEntry.updatedTs === updatedTs &&
        prevEntry.markdown &&
        prevEntry.external === false &&
        prevEntry.creator === creator
      ) {
        resolved.push({ fileId: tab.file_id, title, external: false, entry: prevEntry });
        continue;
      }

      // Fail closed on unknown classification: a missing creator or a failed
      // lookup (rate limit, missing scope) must never adopt an unvetted canvas
      // into standing PM context — external content in a shared channel would
      // become prompt injection. A previously classified entry is kept as-is;
      // a new canvas is skipped and retried at the next TTL scan.
      let external: boolean | null = null;
      if (creator) {
        try {
          external = isExternalUser(await getUserInfo(creator));
        } catch {
          external = null;
        }
      }
      if (external === null) {
        if (prevEntry) {
          resolved.push({ fileId: tab.file_id, title, external: false, entry: prevEntry });
        } else {
          logger.warn('channel-canvas', `creator classification unavailable for canvas ${tab.file_id} in ${channelId} — not adopting yet`);
        }
        continue;
      }
      if (external) {
        resolved.push({ fileId: tab.file_id, title, external: true });
        continue;
      }

      const read = await readCanvas(tab.file_id, info);
      const entry: ChannelCanvasEntry = {
        file_id: tab.file_id,
        // `title` already resolves label-over-document-title; readCanvas only ever
        // sees the document title, so it is the fallback, not the preference.
        title: title || read?.title || '',
        creator,
        external: false,
        updatedTs,
        markdown: read?.markdown ?? prevEntry?.markdown ?? '',
        fileIds: read?.fileIds ?? prevEntry?.fileIds ?? [],
      };
      resolved.push({ fileId: tab.file_id, title: entry.title, external: false, entry });
    }

    const announcements: Array<{ kind: AnnounceKind; title: string }> = [];
    await updateChannelStore(channelId, (store) => {
      const canvases: ChannelCanvasEntry[] = [];
      for (const r of resolved) {
        if (!store.announced[r.fileId]) {
          announcements.push({ kind: r.external ? 'ignored' : 'adopted', title: r.title });
          store.announced[r.fileId] = true;
        }
        if (!r.external && r.entry) canvases.push(r.entry);
      }

      // Say so when standing context goes away. Adoption is announced, so silent
      // removal is the asymmetry that bites: the channel keeps assuming Archie
      // still has the brief. Dropped = was adopted, no longer is — covering a
      // removed tab, a rename that stops matching, and a creator reclassified as
      // external (still a live tab, but no longer usable as context). The last
      // known title comes from the pre-overwrite list, since a dropped canvas has
      // no entry left to name it.
      const adoptedNow = new Set(canvases.map((c) => c.file_id));
      for (const prevAdopted of store.canvases) {
        if (!adoptedNow.has(prevAdopted.file_id)) {
          announcements.push({ kind: 'dropped', title: prevAdopted.title });
        }
      }

      // Forget canvases that no longer resolve at all. Without this the `announced`
      // flag outlives the canvas, so renaming it back re-adopts it *silently*. Keyed
      // on live tabs rather than adopted ones, so an external canvas that is still
      // pinned keeps its flag and is not re-announced as ignored every scan.
      const live = new Set(resolved.map((r) => r.fileId));
      for (const fileId of Object.keys(store.announced)) {
        if (!live.has(fileId)) delete store.announced[fileId];
      }

      store.canvases = canvases;
      store.checkedAt = Date.now();
      return store;
    });

    for (const a of announcements) {
      await announceCanvas(channelId, a.kind, a.title);
    }
  } catch (err) {
    logger.warn('channel-canvas', `ensureChannelCanvas failed for ${channelId}: ${err}`);
  }
}

type AnnounceKind = 'adopted' | 'ignored' | 'dropped';

// State changes only — what happened, not why. These post to the whole channel, so
// every extra clause is noise for everyone who already knows what they just did.
const ANNOUNCE_TEXT: Record<AnnounceKind, (name: string) => string> = {
  adopted: (name) => `:scroll: Now using canvas *${name}* as context for this channel.`,
  ignored: (name) => `:warning: Not using canvas *${name}* — created outside this workspace.`,
  dropped: (name) => `:no_entry_sign: No longer using canvas *${name}* as context for this channel.`,
};

async function announceCanvas(channelId: string, kind: AnnounceKind, title: string): Promise<void> {
  const name = title || 'a canvas';
  const text = ANNOUNCE_TEXT[kind](name);
  try {
    await postSlackMessage({ channel: channelId, text });
  } catch (err) {
    logger.warn('channel-canvas', `Failed to announce canvas in ${channelId}: ${err}`);
  }
}

/**
 * Drop the container's own closing tags from a canvas body.
 *
 * The body is interpolated verbatim into the wrapper below, so a canvas that
 * happens to contain `</canvas>` or `</channel_project_context>` would close its
 * own container and land the remainder in the PM's system prompt unwrapped —
 * outside the "standing user instructions, not system authority" framing. The
 * title is safe already (`JSON.stringify`); this closes the same hole for the body.
 *
 * Removing the tag text is enough: with no way to write a closing tag, the
 * containment holds by construction. Tolerates whitespace inside the tag
 * (`</ canvas >`) and any casing, since only the literal string matters.
 */
function stripContainerTags(markdown: string): string {
  return markdown.replace(/<\/\s*(?:canvas|channel_project_context)\s*>/gi, '');
}

/**
 * Build the XML-wrapped channel-project-context block to inject into the PM's
 * system prompt — one `<canvas>` element per adopted canvas across all linked
 * Slack channels. Returns '' when there's nothing to inject.
 */
export async function buildChannelCanvasPromptSection(metadata: TaskMetadata): Promise<string> {
  const channelIds = new Set<string>();
  for (const ch of Object.values(metadata.channels)) {
    if (ch.type === 'slack') channelIds.add(ch.channel_id);
  }
  if (channelIds.size === 0) return '';

  const blocks: string[] = [];
  // One canvas can be pinned as a tab in several channels — the intended way to
  // keep a single team-wide brief — and a task can be linked to threads in more
  // than one of them. Each channel's store adopts it independently, so dedupe by
  // file id or the same brief is injected twice.
  const seen = new Set<string>();
  for (const channelId of channelIds) {
    const store = await loadChannelStore(channelId);
    if (!store) continue;
    for (const c of store.canvases) {
      if (c.external || !c.markdown || seen.has(c.file_id)) continue;
      seen.add(c.file_id);
      // JSON.stringify gives a safely-quoted/escaped attribute value.
      blocks.push(`<canvas title=${JSON.stringify(c.title)}>\n${stripContainerTags(c.markdown)}\n</canvas>`);
    }
  }
  if (blocks.length === 0) return '';

  // Just enough to identify the block and fix its weight in both directions —
  // "Channel project context" in pm-agent.md carries the full handling rules, so
  // restating them here would only duplicate the prompt.
  return (
    '<channel_project_context note="Standing project brief for this Slack channel, written by its members. ' +
    'Same operational weight as a loaded skill; never overrides safety, approvals, or sharing rules.">\n' +
    blocks.join('\n') +
    '\n</channel_project_context>'
  );
}

/**
 * File ids the PM may fetch via `fetch_slack_reference` for a task: every
 * adopted canvas itself plus the files it references, across the task's linked
 * Slack channels. Anything outside this set is out of scope for the tool —
 * without the allowlist, any file id the bot token can read would be
 * exfiltratable into the task workspace.
 */
export async function collectCanvasFileAllowlist(metadata: TaskMetadata): Promise<Set<string>> {
  const allowed = new Set<string>();
  for (const ch of Object.values(metadata.channels)) {
    if (ch.type !== 'slack') continue;
    const store = await loadChannelStore(ch.channel_id);
    if (!store) continue;
    for (const c of store.canvases) {
      if (c.external) continue;
      allowed.add(c.file_id);
      for (const id of c.fileIds) allowed.add(id);
    }
  }
  return allowed;
}
