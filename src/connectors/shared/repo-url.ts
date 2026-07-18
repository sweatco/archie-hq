/**
 * Host-neutral repo URL + label helpers. Reads REPO_HOST / GITLAB_BASE_URL from
 * the environment directly (NOT via system/backends.ts) so low-level modules
 * (repo-clone, workdir, persistence) can use it without an import cycle. Mirrors
 * each host's cloneUrl() logic.
 */

export function repoHostKind(): 'github' | 'gitlab' {
  return (process.env.REPO_HOST ?? 'github').trim().toLowerCase() === 'gitlab' ? 'gitlab' : 'github';
}

/** Prefix for knowledge-log event destinations, e.g. `github:` / `gitlab:`. */
export function repoEventPrefix(): 'github' | 'gitlab' {
  return repoHostKind();
}

/**
 * Build a clone URL for the given repo, respecting REPO_HOST.
 * - GitHub (default): https://github.com/<repo>.git
 * - GitLab: <GITLAB_BASE_URL>/<repo>.git
 */
export function repoCloneUrl(repo: string): string {
  if (repoHostKind() === 'gitlab') {
    const base = (process.env.GITLAB_BASE_URL ?? '').replace(/\/+$/, '');
    return `${base}/${repo}.git`;
  }
  return `https://github.com/${repo}.git`;
}

/**
 * The bot git identity for the active repo host, used to set the local git
 * `user.name`/`user.email` (the committer) so pushes satisfy host push rules
 * that require the committer email to be the token account's verified email.
 * - GitLab: GITLAB_BOT_NAME / GITLAB_BOT_EMAIL (must match the token account's
 *   verified/commit email, e.g. a `project_*_bot_*@noreply.<host>` address).
 * - GitHub: derived from the App id/slug (mirrors getGitHubAppIdentity()).
 * Returns null when the active host's identity env is not configured.
 */
export function repoBotIdentity(): { name: string; email: string } | null {
  if (repoHostKind() === 'gitlab') {
    const name = process.env.GITLAB_BOT_NAME;
    const email = process.env.GITLAB_BOT_EMAIL;
    return name && email ? { name, email } : null;
  }
  const appId = process.env.GITHUB_APP_ID;
  const appSlug = process.env.GITHUB_APP_SLUG;
  if (!appId || !appSlug) return null;
  return { name: `${appSlug}[bot]`, email: `${appId}+${appSlug}[bot]@users.noreply.github.com` };
}
