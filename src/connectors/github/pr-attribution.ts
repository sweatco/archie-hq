/**
 * The one line Archie stamps onto every PR body it opens: who opened it, for whom.
 *
 * GitHub sets a PR's author from the credential that creates it, with no field to
 * override it — an installation token always yields `<app-slug>[bot]`. So a PR
 * Archie opens for someone can never *be* theirs on GitHub, and the only place
 * their name can appear is the body. That was left to the model, which named the
 * Slack requester in prose or not at all — so the human behind a PR was
 * recoverable only by opening a commit and reading its author.
 *
 * Composed here instead, in `create_pull_request`, so it can't be reworded,
 * forgotten, or lost to an `update_pr` that rewrites the body.
 *
 * The human named is whoever approved edit mode, which is also who the commits are
 * authored as (`buildCommitAuthorEnv`) — so the PR names exactly whoever
 * `git blame` will name. Their Slack display name is used as-is.
 */

/**
 * Marks the injected line so a re-injection replaces it rather than stacking a
 * second copy. An HTML comment: invisible in rendered Markdown, and preserved
 * verbatim through GitHub's API round-trip.
 */
export const ATTRIBUTION_MARKER = '<!-- archie-attribution -->';

/**
 * The marker and the blockquote lines under it. Matches the whole quote rather
 * than one line because the alert syntax spans two (`> [!NOTE]` then the text).
 */
const LINE_RE = new RegExp(`${ATTRIBUTION_MARKER}\\n(?:>[^\\n]*\\n?)*\\n*`, 'g');

/** Drop a previously stamped line, so a rewrite starts clean. Exported for `update_pr`. */
export function stripAttribution(body: string): string {
  return body.replace(LINE_RE, '').trim();
}

/**
 * Put the attribution above the description — that's where "whose PR is this?"
 * gets asked, and GitHub shows a body's opening lines in timelines and previews.
 *
 * Rendered as a GitHub Alert (`> [!NOTE]`), which draws a coloured box with an
 * icon. That is the only way to make a line visually prominent here: GitHub
 * sanitizes `style` attributes and CSS out of PR bodies, so alerts, blockquotes,
 * headings and tables are the whole palette. GitHub prints its own "Note" label
 * above the text and it cannot be renamed or removed.
 *
 * `humanName` is null when no approver was recorded (CLI approvals, pre-feature
 * tasks): the line still names Archie, but nothing invents a human. `mention` is
 * null only when no identity is configured, leaving the body as the agent wrote it.
 */
export function buildAttributedBody(
  body: string,
  humanName: string | null,
  mention: string | null,
): string {
  const prose = stripAttribution(body);
  if (!mention) return prose;

  const line = humanName
    ? `Opened by ${mention} on behalf of **${humanName}**.`
    : `Opened by ${mention}.`;
  const alert = `${ATTRIBUTION_MARKER}\n> [!NOTE]\n> ${line}`;
  return [alert, prose].filter(Boolean).join('\n\n');
}
