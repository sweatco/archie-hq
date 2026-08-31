/**
 * Unit tests for `excludeSandboxArtifacts`, against real git repos.
 *
 * The hazard being locked in: Claude Code mounts `/dev/null` over the harness paths it expects to
 * own inside whatever directory an agent works in. In a repo agent's clone those mounts leave
 * character devices behind as untracked entries in a CUSTOMER's working tree, and `git add -A`
 * commits them. `docs/architecture/security.md` claimed this was already excluded; it was not.
 *
 * Assertions go through `git check-ignore` and `git status` rather than reading the file back,
 * because what matters is whether git actually hides the path — not whether we wrote a line.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { excludeSandboxArtifacts } from '../repo-clone.js';

const execFileAsync = promisify(execFile);

let tmpDir: string;
let repoPath: string;

async function git(args: string[], cwd = repoPath): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

/** True when git ignores the path (i.e. `check-ignore` matches it). */
async function isIgnored(relPath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['check-ignore', '-q', relPath], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

async function writeFileAt(relPath: string, contents = 'x'): Promise<void> {
  const full = path.join(repoPath, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, contents);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-exclude-'));
  repoPath = path.join(tmpDir, 'clone');
  await execFileAsync('git', ['init', '-b', 'main', repoPath]);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('excludeSandboxArtifacts', () => {
  it('hides the sandbox artifacts from git so `git add -A` cannot commit them', async () => {
    await excludeSandboxArtifacts(repoPath);

    for (const artifact of [
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.claude/launch.json',
      '.claude/loop.md',
      '.claude/scheduled_tasks.json',
      '.claude/hooks',
      '.claude/workflows',
      '.claude/routines',
      '.claude/output-styles',
      '.claude/.cc-writes',
    ]) {
      await writeFileAt(artifact);
      expect(await isIgnored(artifact), `${artifact} should be ignored`).toBe(true);
    }

    // The real regression test: a routine add-everything must stage nothing.
    await git(['add', '-A']);
    expect(await git(['diff', '--cached', '--name-only'])).toBe('');
  });

  it('leaves a tracked .claude/settings.json alone — exclusion must not hide real repo content', async () => {
    // sweatcoin-mobile genuinely commits this file. Hiding its changes would be a worse bug than
    // the one being fixed, so lock in that exclusion only ever affects UNTRACKED entries.
    await writeFileAt('.claude/settings.json', '{"real":true}');
    await git(['add', '-f', '.claude/settings.json']);
    await git(['commit', '-m', 'add project settings']);

    await excludeSandboxArtifacts(repoPath);

    await writeFileAt('.claude/settings.json', '{"real":true,"edited":true}');
    expect(await git(['status', '--porcelain'])).toContain('.claude/settings.json');
  });

  it('does not touch unrelated repo content', async () => {
    await excludeSandboxArtifacts(repoPath);

    await writeFileAt('src/index.ts');
    await writeFileAt('.claude/skills/thing/SKILL.md');
    await writeFileAt('CLAUDE.md');

    expect(await isIgnored('src/index.ts')).toBe(false);
    expect(await isIgnored('.claude/skills/thing/SKILL.md')).toBe(false);
    expect(await isIgnored('CLAUDE.md')).toBe(false);
  });

  it('is idempotent — repeated spawns do not duplicate the block', async () => {
    await excludeSandboxArtifacts(repoPath);
    await excludeSandboxArtifacts(repoPath);
    await excludeSandboxArtifacts(repoPath);

    const contents = await fs.readFile(path.join(repoPath, '.git', 'info', 'exclude'), 'utf8');
    const occurrences = contents.split('# --- Archie: Claude Code sandbox artifacts (managed) ---').length - 1;
    expect(occurrences).toBe(1);
  });

  it('preserves pre-existing exclude entries', async () => {
    const excludePath = path.join(repoPath, '.git', 'info', 'exclude');
    await fs.writeFile(excludePath, '# hand-written\n/scratch-notes.md\n');

    await excludeSandboxArtifacts(repoPath);

    const contents = await fs.readFile(excludePath, 'utf8');
    expect(contents).toContain('/scratch-notes.md');
    await writeFileAt('scratch-notes.md');
    expect(await isIgnored('scratch-notes.md')).toBe(true);
  });

  it('does not throw when the clone is unwritable or missing', async () => {
    // Best-effort by design: a spawn must not fail because this could not be written.
    await expect(excludeSandboxArtifacts(path.join(tmpDir, 'does-not-exist'))).resolves.toBeUndefined();
  });
});
