/**
 * Unit tests for `configureGitIdentity`, against real git repos.
 *
 * Locks in the fix for a production incident: a hard kill mid-`git config`
 * orphans `.git/config.lock`, after which every later `git config` in that
 * clone fails — including on the next boot, which cost a task two of its agents
 * during startup recovery.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { configureGitIdentity, getArchieAttributionIdentity } from '../client.js';

const execFileAsync = promisify(execFile);

const APP_ID = '123456';
const APP_SLUG = 'archie-hq';
const BOT_NAME = `${APP_SLUG}[bot]`;
const BOT_EMAIL = `${APP_ID}+${APP_SLUG}[bot]@users.noreply.github.com`;

let tmpDir: string;
let repoPath: string;
let savedEnv: { id?: string; slug?: string; workdir?: string; login?: string; userId?: string; name?: string };

/**
 * Read a key from the repo's own config, or null when unset. Scoped to
 * `--local` so assertions can't be satisfied by the developer's global config.
 */
async function readConfig(cwd: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['config', '--local', '--get', key], { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

beforeEach(async () => {
  savedEnv = {
    id: process.env.GITHUB_APP_ID,
    slug: process.env.GITHUB_APP_SLUG,
    workdir: process.env.ARCHIE_WORKDIR,
    login: process.env.ARCHIE_GITHUB_LOGIN,
    userId: process.env.ARCHIE_GITHUB_USER_ID,
    name: process.env.ARCHIE_GITHUB_NAME,
  };
  process.env.GITHUB_APP_ID = APP_ID;
  process.env.GITHUB_APP_SLUG = APP_SLUG;
  // Each attribution test sets what it needs; start from unconfigured so a
  // developer's own .env can't satisfy an assertion.
  delete process.env.ARCHIE_GITHUB_LOGIN;
  delete process.env.ARCHIE_GITHUB_USER_ID;
  delete process.env.ARCHIE_GITHUB_NAME;

  // Lock cleanup is confined to the workdir, so the fixture repo lives inside
  // one — `tmpDir` stands in for ARCHIE_WORKDIR.
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'archie-git-identity-'));
  process.env.ARCHIE_WORKDIR = tmpDir;
  repoPath = path.join(tmpDir, 'repo');
  await fs.promises.mkdir(repoPath);
  await execFileAsync('git', ['init', '-q'], { cwd: repoPath });
});

afterEach(async () => {
  if (savedEnv.id === undefined) delete process.env.GITHUB_APP_ID;
  else process.env.GITHUB_APP_ID = savedEnv.id;
  if (savedEnv.slug === undefined) delete process.env.GITHUB_APP_SLUG;
  else process.env.GITHUB_APP_SLUG = savedEnv.slug;
  if (savedEnv.workdir === undefined) delete process.env.ARCHIE_WORKDIR;
  else process.env.ARCHIE_WORKDIR = savedEnv.workdir;
  if (savedEnv.login === undefined) delete process.env.ARCHIE_GITHUB_LOGIN;
  else process.env.ARCHIE_GITHUB_LOGIN = savedEnv.login;
  if (savedEnv.userId === undefined) delete process.env.ARCHIE_GITHUB_USER_ID;
  else process.env.ARCHIE_GITHUB_USER_ID = savedEnv.userId;
  if (savedEnv.name === undefined) delete process.env.ARCHIE_GITHUB_NAME;
  else process.env.ARCHIE_GITHUB_NAME = savedEnv.name;

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

describe('configureGitIdentity', () => {
  it('writes the attribution account into a fresh clone', async () => {
    // The committer is Archie being *credited*, not Archie authenticating — push
    // auth is the installation token, and GitHub doesn't require the committer to
    // match the pusher. So this is the account, not the App bot whose synthetic
    // address resolves to nobody.
    process.env.ARCHIE_GITHUB_LOGIN = 'archie-hq';
    process.env.ARCHIE_GITHUB_USER_ID = '302249786';
    process.env.ARCHIE_GITHUB_NAME = 'Archie HQ';

    const name = await configureGitIdentity(repoPath);

    expect(name).toBe('Archie HQ');
    expect(await readConfig(repoPath, 'user.name')).toBe('Archie HQ');
    expect(await readConfig(repoPath, 'user.email')).toBe('302249786+archie-hq@users.noreply.github.com');
  });

  it('falls back to the bot identity when no account is configured', async () => {
    const name = await configureGitIdentity(repoPath);

    expect(name).toBe(BOT_NAME);
    expect(await readConfig(repoPath, 'user.name')).toBe(BOT_NAME);
    expect(await readConfig(repoPath, 'user.email')).toBe(BOT_EMAIL);
  });

  it('returns null and writes nothing when neither identity is configured', async () => {
    delete process.env.GITHUB_APP_ID;

    expect(await configureGitIdentity(repoPath)).toBeNull();
    expect(await readConfig(repoPath, 'user.name')).toBeNull();
  });

  it('drops a leftover config.lock and completes the write', async () => {
    const lockPath = path.join(repoPath, '.git', 'config.lock');
    await fs.promises.writeFile(lockPath, '', 'utf-8');

    await expect(configureGitIdentity(repoPath)).resolves.toBe(BOT_NAME);

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(await readConfig(repoPath, 'user.name')).toBe(BOT_NAME);
  });

  it('leaves a lock outside the workdir alone', async () => {
    const lockPath = path.join(repoPath, '.git', 'config.lock');
    await fs.promises.writeFile(lockPath, '', 'utf-8');
    // Repo paths originate in task/plugin input; one pointing out of the
    // workdir must not get a delete aimed at it.
    process.env.ARCHIE_WORKDIR = path.join(tmpDir, 'elsewhere');

    await expect(configureGitIdentity(repoPath)).rejects.toThrow(/could not lock config file/);

    expect(fs.existsSync(lockPath)).toBe(true);
  });
});

/**
 * The identity Archie is *credited* as, which is not the identity it acts as.
 *
 * The numeric prefix is the whole point: GitHub resolves
 * `<id>+<login>@users.noreply.github.com` by ID, and credits nobody when the ID
 * disagrees with the login. The bot form derives it from GITHUB_APP_ID, which is
 * not a user ID, so every Co-Authored-By line Archie wrote resolved to no account.
 */
describe('getArchieAttributionIdentity', () => {
  const USER_ID = '302249786';

  it('builds a noreply address from the account\'s user ID', () => {
    process.env.ARCHIE_GITHUB_LOGIN = 'archie-hq';
    process.env.ARCHIE_GITHUB_USER_ID = USER_ID;
    process.env.ARCHIE_GITHUB_NAME = 'Archie HQ';

    expect(getArchieAttributionIdentity()).toEqual({
      name: 'Archie HQ',
      email: `${USER_ID}+archie-hq@users.noreply.github.com`,
      mention: '@archie-hq',
    });
  });

  it('uses the login as the display name when no name is given', () => {
    process.env.ARCHIE_GITHUB_LOGIN = 'archie-hq';
    process.env.ARCHIE_GITHUB_USER_ID = USER_ID;

    expect(getArchieAttributionIdentity()?.name).toBe('archie-hq');
  });

  it('falls back to the App bot when the account is not configured', () => {
    // A deployment without the new vars keeps its prior behaviour rather than
    // losing the commit trailer altogether.
    expect(getArchieAttributionIdentity()).toEqual({
      name: BOT_NAME,
      email: BOT_EMAIL,
      mention: BOT_NAME,
    });
  });

  it('falls back to the bot rather than emitting an address with a non-numeric ID', () => {
    // An address built from a login-shaped "id" looks right and credits nobody —
    // exactly the silent failure this function exists to correct. Prefer the
    // fallback, which is at least visibly the bot.
    process.env.ARCHIE_GITHUB_LOGIN = 'archie-hq';
    process.env.ARCHIE_GITHUB_USER_ID = 'archie-hq';

    expect(getArchieAttributionIdentity()?.email).toBe(BOT_EMAIL);
  });

  it('falls back to the bot when the login is missing', () => {
    process.env.ARCHIE_GITHUB_USER_ID = USER_ID;

    expect(getArchieAttributionIdentity()?.email).toBe(BOT_EMAIL);
  });

  it('returns null when neither the account nor the App is configured', () => {
    delete process.env.GITHUB_APP_ID;

    expect(getArchieAttributionIdentity()).toBeNull();
  });
});
