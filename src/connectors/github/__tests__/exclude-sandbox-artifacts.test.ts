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
    await excludeSandboxArtifacts(repoPath, tmpDir);

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

    await excludeSandboxArtifacts(repoPath, tmpDir);

    await writeFileAt('.claude/settings.json', '{"real":true,"edited":true}');
    expect(await git(['status', '--porcelain'])).toContain('.claude/settings.json');
  });

  it('does not touch unrelated repo content', async () => {
    await excludeSandboxArtifacts(repoPath, tmpDir);

    await writeFileAt('src/index.ts');
    await writeFileAt('.claude/skills/thing/SKILL.md');
    await writeFileAt('CLAUDE.md');

    expect(await isIgnored('src/index.ts')).toBe(false);
    expect(await isIgnored('.claude/skills/thing/SKILL.md')).toBe(false);
    expect(await isIgnored('CLAUDE.md')).toBe(false);
  });

  it('is idempotent — repeated spawns do not duplicate the block', async () => {
    await excludeSandboxArtifacts(repoPath, tmpDir);
    await excludeSandboxArtifacts(repoPath, tmpDir);
    await excludeSandboxArtifacts(repoPath, tmpDir);

    const contents = await fs.readFile(path.join(repoPath, '.git', 'info', 'exclude'), 'utf8');
    const occurrences = contents.split('# --- Archie: Claude Code sandbox artifacts (managed) ---').length - 1;
    expect(occurrences).toBe(1);
  });

  it('preserves pre-existing exclude entries', async () => {
    const excludePath = path.join(repoPath, '.git', 'info', 'exclude');
    await fs.writeFile(excludePath, '# hand-written\n/scratch-notes.md\n');

    await excludeSandboxArtifacts(repoPath, tmpDir);

    const contents = await fs.readFile(excludePath, 'utf8');
    expect(contents).toContain('/scratch-notes.md');
    await writeFileAt('scratch-notes.md');
    expect(await isIgnored('scratch-notes.md')).toBe(true);
  });

  it('does not throw when the clone is unwritable or missing', async () => {
    // Best-effort by design: a spawn must not fail because this could not be written.
    await expect(excludeSandboxArtifacts(path.join(tmpDir, 'does-not-exist'), tmpDir)).resolves.toBeUndefined();
  });
});

// ---- Path containment (CodeQL js/path-injection, alerts 133-135) ----
//
// `clonePath` reaches this function from an agent's repo attachment, which for a PM-spawned dynamic
// agent derives from an `owner/name` identifier that came from a human's message. Unvalidated, the
// `writeFile` at the end is an arbitrary-file-overwrite primitive. These lock the anchor.

describe('excludeSandboxArtifacts path containment', () => {
  /** A file outside the allowed root that must never be written to. */
  async function makeOutsideTarget(): Promise<string> {
    const outside = path.join(tmpDir, 'outside');
    await fs.mkdir(path.join(outside, '.git', 'info'), { recursive: true });
    await fs.writeFile(path.join(outside, '.git', 'info', 'exclude'), 'ORIGINAL');
    return outside;
  }

  it('refuses a clone path that escapes the allowed root via ..', async () => {
    const outside = await makeOutsideTarget();
    const allowedRoot = path.join(tmpDir, 'allowed');
    await fs.mkdir(allowedRoot, { recursive: true });

    // The classic traversal: an identifier carrying `..` segments.
    const traversal = path.join(allowedRoot, '..', 'outside');
    await excludeSandboxArtifacts(traversal, allowedRoot);

    expect(await fs.readFile(path.join(outside, '.git', 'info', 'exclude'), 'utf8')).toBe('ORIGINAL');
  });

  it('refuses an absolute clone path outside the allowed root', async () => {
    const outside = await makeOutsideTarget();
    const allowedRoot = path.join(tmpDir, 'allowed');
    await fs.mkdir(allowedRoot, { recursive: true });

    await excludeSandboxArtifacts(outside, allowedRoot);

    expect(await fs.readFile(path.join(outside, '.git', 'info', 'exclude'), 'utf8')).toBe('ORIGINAL');
  });

  it('refuses when the clone path is a symlink pointing outside the allowed root', async () => {
    // String-prefix checks pass here; only canonicalising the path catches it.
    const outside = await makeOutsideTarget();
    const allowedRoot = path.join(tmpDir, 'allowed');
    await fs.mkdir(allowedRoot, { recursive: true });
    const link = path.join(allowedRoot, 'looks-legit');
    await fs.symlink(outside, link);

    await excludeSandboxArtifacts(link, allowedRoot);

    expect(await fs.readFile(path.join(outside, '.git', 'info', 'exclude'), 'utf8')).toBe('ORIGINAL');
  });

  it('refuses when .git/info is a symlink escaping the clone', async () => {
    const escapeTarget = path.join(tmpDir, 'escape');
    await fs.mkdir(escapeTarget, { recursive: true });
    await fs.writeFile(path.join(escapeTarget, 'exclude'), 'ORIGINAL');

    await fs.rm(path.join(repoPath, '.git', 'info'), { recursive: true, force: true });
    await fs.symlink(escapeTarget, path.join(repoPath, '.git', 'info'));

    await excludeSandboxArtifacts(repoPath, tmpDir);

    expect(await fs.readFile(path.join(escapeTarget, 'exclude'), 'utf8')).toBe('ORIGINAL');
  });

  it('refuses to write through a symlinked exclude file', async () => {
    const victim = path.join(tmpDir, 'victim.txt');
    await fs.writeFile(victim, 'ORIGINAL');

    const excludePath = path.join(repoPath, '.git', 'info', 'exclude');
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    await fs.rm(excludePath, { force: true });
    await fs.symlink(victim, excludePath);

    await excludeSandboxArtifacts(repoPath, tmpDir);

    expect(await fs.readFile(victim, 'utf8')).toBe('ORIGINAL');
  });

  it('refuses a directory that is not a git clone', async () => {
    const notARepo = path.join(tmpDir, 'not-a-repo');
    await fs.mkdir(notARepo, { recursive: true });

    await excludeSandboxArtifacts(notARepo, tmpDir);

    await expect(fs.stat(path.join(notARepo, '.git'))).rejects.toThrow();
  });

  it('still works for a legitimate clone under the allowed root', async () => {
    // The guards must not be so strict that the real case stops working.
    await excludeSandboxArtifacts(repoPath, tmpDir);

    await writeFileAt('.claude/settings.local.json');
    expect(await isIgnored('.claude/settings.local.json')).toBe(true);
  });
});
