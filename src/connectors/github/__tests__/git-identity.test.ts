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
import { configureGitIdentity } from '../client.js';

const execFileAsync = promisify(execFile);

const APP_ID = '123456';
const APP_SLUG = 'archie-hq';
const BOT_NAME = `${APP_SLUG}[bot]`;
const BOT_EMAIL = `${APP_ID}+${APP_SLUG}[bot]@users.noreply.github.com`;

let tmpDir: string;
let repoPath: string;
let savedEnv: { id?: string; slug?: string; workdir?: string };

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
  };
  process.env.GITHUB_APP_ID = APP_ID;
  process.env.GITHUB_APP_SLUG = APP_SLUG;

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

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

describe('configureGitIdentity', () => {
  it('writes the bot identity into a fresh clone', async () => {
    const name = await configureGitIdentity(repoPath);

    expect(name).toBe(BOT_NAME);
    expect(await readConfig(repoPath, 'user.name')).toBe(BOT_NAME);
    expect(await readConfig(repoPath, 'user.email')).toBe(BOT_EMAIL);
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

  it('returns null and writes nothing when the app env is absent', async () => {
    delete process.env.GITHUB_APP_ID;

    expect(await configureGitIdentity(repoPath)).toBeNull();
    expect(await readConfig(repoPath, 'user.name')).toBeNull();
  });
});
