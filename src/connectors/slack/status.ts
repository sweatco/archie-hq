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
 * Slack rotates client-side beneath the status. We attach a fixed, branded set
 * (`STATUS_LOADING_MESSAGES`) on every non-clearing update so the wait reads as
 * Archie rather than Slack's generic loading text. It is Slack-specific and so
 * lives here rather than in the surface-agnostic composer (src/tasks/status.ts);
 * the CLI surface ignores it. Whether it fully supersedes Slack's own
 * auto-rotated phrases is unconfirmed and to be validated post-deploy.
 */

import { getSlackClient, isSlackDryRun } from './client.js';
import { logger } from '../../system/logger.js';

/**
 * Branded rotating loading phrases shown beneath the "Archie is …" status line.
 * Slack accepts at most 10 and rotates them client-side; order is preserved.
 */
export const STATUS_LOADING_MESSAGES: readonly string[] = [
  'Still computing: when lambo?',
  'Thinking at 10,000 steps/min',
  'Lacing up the neurons',
  'Crunching numbers, not abs',
  "Step aside, I'm computing",
  'Brain fully deployed',
  'On it like a 10k streak',
  'Walking through the data',
  'Assembling the answer',
  'Streaking through the data',
];

/**
 * Set (or, with an empty string, clear) the loading status on a Slack thread.
 * Never throws.
 *
 * On a non-clearing update we also send the branded `loading_messages` so Slack
 * rotates Archie's own phrases beneath the line. On a clear (empty `status`) we
 * omit them — there is nothing to rotate.
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
    await client.assistant.threads.setStatus({
      channel_id,
      thread_ts,
      status,
      ...(status ? { loading_messages: [...STATUS_LOADING_MESSAGES] } : {}),
    });
  } catch (err) {
    logger.warn('slack-status', `setStatus failed for ${channel_id}/${thread_ts}: ${err}`);
  }
}
