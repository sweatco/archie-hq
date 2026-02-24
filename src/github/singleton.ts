/**
 * GitHub Client Singleton
 *
 * Lazy-initialized, process-wide. Tools import getGitHubClient() directly.
 */

import { type GitHubClient, createGitHubClient } from './client.js';

let instance: GitHubClient | null | undefined = undefined;

export function getGitHubClient(): GitHubClient | null {
  if (instance === undefined) {
    instance = createGitHubClient();
  }
  return instance;
}
