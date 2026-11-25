/** Read-only: the sandbox's egress proxy injects this token into any request an agent sends to api.github.com. */

import type { Endpoints } from '@octokit/types';

export type InstallationPermissions = NonNullable<
  Endpoints['POST /app/installations/{installation_id}/access_tokens']['parameters']['permissions']
>;

const REQUIRED_READ_PERMISSIONS: InstallationPermissions = {
  metadata: 'read',
  contents: 'read',
  pull_requests: 'read',
  checks: 'read',
  statuses: 'read',
  actions: 'read',
};

/** Optional for the App (docs/guides/github-setup.md). */
const OPTIONAL_READ_PERMISSIONS = ['security_events', 'issues'] as const;

export function sandboxReadPermissions(granted: InstallationPermissions): InstallationPermissions {
  const permissions: InstallationPermissions = { ...REQUIRED_READ_PERMISSIONS };
  for (const name of OPTIONAL_READ_PERMISSIONS) {
    if (granted[name]) permissions[name] = 'read';
  }
  return permissions;
}
