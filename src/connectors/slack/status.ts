/**
 * Slack renderer for the live status indicator.
 *
 * The status string itself is composed surface-agnostically by
 * `TaskStatusController` (src/tasks/status.ts) and gated by `isStatusEnabled()`;
 * this module only renders it to Slack. It wraps `assistant.threads.setStatus` —
 * the ephemeral "<App Name> is …" loading line — the progress sibling of
 * `setTitle` (see title.ts): same `assistant.threads.*` accessor, same
 * `channel_id` + `thread_ts`. Slack auto-prepends the app name, so `status` is a
 * verb fragment ("is digging into the backend…"); an empty string clears the
 * indicator. Slack also clears it automatically when the app posts a reply, and
 * after a built-in ~2-minute timeout.
 *
 * Best-effort: errors — and an uninitialised client (e.g. CLI-only runs) — are
 * logged and swallowed so a failed status update never breaks the work it
 * describes. Honours Slack dry-run.
 *
 * Scope: since the 2026-03 platform change, `setStatus` accepts `chat:write`
 * and works in regular channel threads as well as DM/assistant threads, so it is
 * set on every linked Slack thread; any thread that rejects it is swallowed.
 *
 * Required Slack scope: `assistant:write` or `chat:write` (both present in the
 * manifest). The Agents & AI Apps feature toggle must be enabled on the bot.
 *
 * Rotating loading messages: alongside the single `status` line ("Archie is …"),
 * `setStatus` accepts an optional `loading_messages` array (≤10 strings) that
 * Slack rotates client-side beneath the status. The engine holds none of these:
 * the phrases are deployer-specific branding and come from the plugins branding
 * config (`getStatusLoadingMessages()`), so the open-source engine ships no
 * Sweatcoin content and the phrases hot-reload with the plugins repo. We attach
 * them on every non-clearing update; when the config is empty we send no
 * `loading_messages` at all. It is Slack-specific and so handled here rather than
 * in the surface-agnostic composer (src/tasks/status.ts); the CLI ignores it.
 * Whether it fully supersedes Slack's own auto-rotated phrases is unconfirmed and
 * to be validated post-deploy.
 */

import { getSlackClient, isSlackDryRun } from './client.js';
import { getStatusLoadingMessages } from '../../system/branding.js';
import { logger } from '../../system/logger.js';

/**
 * Set (or, with an empty string, clear) the loading status on a Slack thread.
 * Never throws.
 *
 * On a non-clearing update we also send the branded `loading_messages` (from the
 * plugins branding config) so Slack rotates those phrases beneath the line. On a
 * clear (empty `status`), or when no phrases are configured, we omit them.
 */
export async function setSlackThreadStatus(
  channel_id: string,
  thread_ts: string,
  status: string,
): Promise<void> {
  if (isSlackDryRun()) {
    logger.debug('slack-status', `[DRY RUN] setStatus ${channel_id}/${thread_ts} — "${status}"`);
    return;
  }
  try {
    const client = getSlackClient();
    const loadingMessages = status ? getStatusLoadingMessages() : [];
    await client.assistant.threads.setStatus({
      channel_id,
      thread_ts,
      status,
      ...(loadingMessages.length ? { loading_messages: loadingMessages } : {}),
    });
  } catch (err) {
    logger.warn('slack-status', `setStatus failed for ${channel_id}/${thread_ts}: ${err}`);
  }
}
