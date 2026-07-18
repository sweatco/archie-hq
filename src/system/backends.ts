/**
 * Backend resolver. Resolves REPO_HOST env into a concrete
 * repo-host factory + capabilities. REPO_HOST resolves to `github` (default)
 * or `gitlab`; the resolver exists so call sites stay agnostic to which host
 * is active. Fails fast with actionable messages at boot.
 */

import type { RepoHost } from '../ports/repo-host.js';
import { getGitHubClient } from '../connectors/github/client.js';
import { GitLabHost } from '../connectors/gitlab/client.js';
import { logger } from './logger.js';

export type RepoHostKind = 'github' | 'gitlab';

const SUPPORTED_REPO_HOSTS: RepoHostKind[] = ['github', 'gitlab'];

export function resolveRepoHostKind(): RepoHostKind {
  const raw = (process.env.REPO_HOST ?? 'github').trim().toLowerCase();
  return raw as RepoHostKind;
}

export function getBackendMatrix(): { repoHost: string } {
  return { repoHost: resolveRepoHostKind() };
}

const REQUIRED_GITLAB_ENV = ['GITLAB_BASE_URL', 'GITLAB_TOKEN', 'GITLAB_WEBHOOK_SECRET'] as const;

function assertGitLabEnv(): void {
  const missing = REQUIRED_GITLAB_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`REPO_HOST=gitlab requires ${missing.join(', ')} to be set.`);
  }
}

/**
 * Validate the selected backend is supported in this build. Throw with an
 * actionable message otherwise. Call once at boot (see index.ts).
 */
export function assertBackendConfig(): void {
  const host = resolveRepoHostKind();
  if (!SUPPORTED_REPO_HOSTS.includes(host)) {
    throw new Error(`REPO_HOST="${host}" is invalid. Supported values: ${SUPPORTED_REPO_HOSTS.join(', ')}.`);
  }
  if (host === 'gitlab') assertGitLabEnv();
}

let gitlabSingleton: GitLabHost | null = null;
export function getGitLabHost(): GitLabHost {
  if (!gitlabSingleton) gitlabSingleton = new GitLabHost();
  return gitlabSingleton;
}

/**
 * The active RepoHost, or null when the host is unconfigured (e.g. GitHub App
 * env absent — mirrors getGitHubClient() returning null; callers already handle
 * a null host by disabling PR tools).
 */
export function getRepoHost(): RepoHost | null {
  const host = resolveRepoHostKind();
  switch (host) {
    case 'github':
      return getGitHubClient();
    case 'gitlab':
      return getGitLabHost();
    default:
      // Unsupported hosts are rejected by assertBackendConfig() at boot; return
      // null defensively so a mis-sequenced call can't crash.
      logger.warn('backends', `getRepoHost() called for unsupported host "${host}"`);
      return null;
  }
}
