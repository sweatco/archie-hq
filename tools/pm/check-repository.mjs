// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryName = 'sweatco/archie-hq';
const repositoryId = 1120227357;
const canonicalOrigin =
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)sweatco\/archie-hq(?:\.git)?\/?$/i;

export function checkRepository({ run = execFileSync, env = process.env } = {}) {
  if (
    env.GITHUB_ACTIONS === 'true' &&
    (env.GITHUB_REPOSITORY !== repositoryName || env.GITHUB_REPOSITORY_ID !== String(repositoryId))
  ) {
    throw new Error('Archie PM automation is restricted to the canonical GitHub repository');
  }

  const options = { encoding: 'utf8' };
  const origin = run('git', ['remote', 'get-url', 'origin'], options).trim();
  if (!canonicalOrigin.test(origin)) {
    throw new Error('Archie PM requires a canonical origin; fork or unknown checkout is blocked');
  }

  const repository = JSON.parse(run('gh', ['api', `repos/${repositoryName}`], options));
  if (
    repository.id !== repositoryId ||
    repository.full_name !== repositoryName ||
    repository.fork !== false
  ) {
    throw new Error('GitHub did not verify the canonical non-fork Archie repository');
  }
  return { id: repository.id, full_name: repository.full_name, fork: repository.fork };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.stdout.write(`${JSON.stringify(checkRepository())}\n`);
}
