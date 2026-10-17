/**
 * Unit tests for `excludeSandboxArtifacts`, against real git repos.
 *
 * The hazard being locked in: Claude Code's sandbox mounts `/dev/null` over harness paths it
 * expects to own, and for a path that does not exist it first creates a placeholder file to mount
 * onto — in a task clone, that is a CUSTOMER's working tree. The placeholder outlives the command
 * as an untracked entry, and `git add -A` commits it. `docs/architecture/security.md` claimed this
 * was already excluded; it was not.
 *
 * Assertions go through `git check-ignore` and `git add -A` rather than reading the file back,
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

const HEADER = '# --- Archie: Claude Code sandbox artifacts (managed) ---';

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

async function writeFileAt(relPath: string, contents = ''): Promise<void> {
  const full = path.join(repoPath, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, contents);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-exclude-'));
  repoPath = path.join(tmpDir, 'clone');
  await execFileAsync('git', ['init', '-q', '-b', 'main', repoPath]);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('excludeSandboxArtifacts', () => {
  it('hides the sandbox placeholders from git so `git add -A` cannot commit them', async () => {
    await excludeSandboxArtifacts(repoPath, tmpDir);

    for (const artifact of [
      '.mcp.json',
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
      // Empty, like the mount-point placeholder the sandbox leaves on disk.
      await writeFileAt(artifact);
      expect(await isIgnored(artifact), `${artifact} should be ignored`).toBe(true);
    }

    // The real regression test: a routine add-everything must stage nothing.
    await git(['add', '-A']);
    expect(await git(['diff', '--cached', '--name-only'])).toBe('');
  });

  it('keeps an untracked .mcp.json placeholder out of a commit alongside real work', async () => {
    // The shape observed on 2026-10-16 in a sweatcoin-infrastructure clone: a repo that does not
    // track `.mcp.json`, a placeholder for it in the root, and an agent committing its change.
    await writeFileAt('README.md', 'base\n');
    await git(['add', 'README.md']);
    await git(['commit', '-q', '-m', 'base']);

    await excludeSandboxArtifacts(repoPath, tmpDir);
    await writeFileAt('.mcp.json');
    await writeFileAt('README.md', 'base\nedited\n');

    await git(['add', '-A']);
    expect(await git(['diff', '--cached', '--name-only'])).toBe('README.md');
  });

  it('leaves tracked .mcp.json and .claude/settings.json alone — exclusion must not hide real repo content', async () => {
    // Several of the repos Archie works on genuinely commit these. Hiding their changes would be a
    // worse bug than the one being fixed, so lock in that exclusion only affects UNTRACKED entries.
    await writeFileAt('.mcp.json', '{"mcpServers":{}}');
    await writeFileAt('.claude/settings.json', '{"real":true}');
    await git(['add', '-f', '.mcp.json', '.claude/settings.json']);
    await git(['commit', '-q', '-m', 'add project config']);

    await excludeSandboxArtifacts(repoPath, tmpDir);

    await writeFileAt('.mcp.json', '{"mcpServers":{"x":{}}}');
    await writeFileAt('.claude/settings.json', '{"real":true,"edited":true}');
    const status = await git(['status', '--porcelain']);
    expect(status).toContain('.mcp.json');
    expect(status).toContain('.claude/settings.json');
  });

  it('does not touch unrelated repo content', async () => {
    await excludeSandboxArtifacts(repoPath, tmpDir);

    await writeFileAt('src/index.ts');
    await writeFileAt('.claude/skills/thing/SKILL.md');
    await writeFileAt('CLAUDE.md');
    await writeFileAt('.gitmodules');
    await writeFileAt('config/.mcp.json');

    expect(await isIgnored('src/index.ts')).toBe(false);
    expect(await isIgnored('.claude/skills/thing/SKILL.md')).toBe(false);
    expect(await isIgnored('CLAUDE.md')).toBe(false);
    expect(await isIgnored('.gitmodules')).toBe(false);
    // Patterns are anchored to the clone root; a nested file of the same name is real content.
    expect(await isIgnored('config/.mcp.json')).toBe(false);
  });

  it('is idempotent — repeated mounts do not duplicate the block', async () => {
    await excludeSandboxArtifacts(repoPath, tmpDir);
    await excludeSandboxArtifacts(repoPath, tmpDir);
    await excludeSandboxArtifacts(repoPath, tmpDir);

    const contents = await fs.readFile(path.join(repoPath, '.git', 'info', 'exclude'), 'utf8');
    expect(contents.split(HEADER).length - 1).toBe(1);
  });

  it('rewrites an outdated managed block in place', async () => {
    // A clone that got an earlier version of the list picks up the current one on its next mount.
    const excludePath = path.join(repoPath, '.git', 'info', 'exclude');
    await fs.writeFile(excludePath, `/mine\n${HEADER}\n/.claude/settings.json\n# --- end Archie ---\n/also-mine\n`);

    await excludeSandboxArtifacts(repoPath, tmpDir);

    const contents = await fs.readFile(excludePath, 'utf8');
    expect(contents.split(HEADER).length - 1).toBe(1);
    expect(contents.startsWith('/mine\n')).toBe(true);
    expect(contents.endsWith('/also-mine\n')).toBe(true);
    await writeFileAt('.mcp.json');
    expect(await isIgnored('.mcp.json')).toBe(true);
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

  it('does not throw when the clone is missing', async () => {
    // Best-effort by design: a mount must not fail because this could not be written.
    await expect(excludeSandboxArtifacts(path.join(tmpDir, 'does-not-exist'), tmpDir)).resolves.toBeUndefined();
  });
});

// ---- Path containment (CodeQL js/path-injection) ----
//
// `clonePath` is a recorded `clone_path` or one built from the identifier a model passed to
// `mount_repo`. Unvalidated, the `writeFile` at the end is an arbitrary-file-overwrite primitive.
// Every case asserts the would-be victim is byte-for-byte untouched.

describe('excludeSandboxArtifacts path containment', () => {
  /** A git-shaped directory outside the allowed root whose exclude file must never be written. */
  async function makeOutsideTarget(): Promise<string> {
    const outside = path.join(tmpDir, 'outside');
    await fs.mkdir(path.join(outside, '.git', 'info'), { recursive: true });
    await fs.writeFile(path.join(outside, '.git', 'info', 'exclude'), 'ORIGINAL');
    return outside;
  }

  async function makeAllowedRoot(): Promise<string> {
    const allowedRoot = path.join(tmpDir, 'allowed');
    await fs.mkdir(allowedRoot, { recursive: true });
    return allowedRoot;
  }

  const outsideExclude = () => fs.readFile(path.join(tmpDir, 'outside', '.git', 'info', 'exclude'), 'utf8');

  it('refuses a clone path that escapes the allowed root via ..', async () => {
    await makeOutsideTarget();
    const allowedRoot = await makeAllowedRoot();

    // The classic traversal: an identifier carrying `..` segments.
    await excludeSandboxArtifacts(path.join(allowedRoot, '..', 'outside'), allowedRoot);

    expect(await outsideExclude()).toBe('ORIGINAL');
  });

  it('refuses an unnormalised path string that resolves outside the root', async () => {
    await makeOutsideTarget();
    const allowedRoot = await makeAllowedRoot();

    await excludeSandboxArtifacts(`${allowedRoot}/../outside`, allowedRoot);

    expect(await outsideExclude()).toBe('ORIGINAL');
  });

  it('refuses an absolute clone path outside the allowed root', async () => {
    const outside = await makeOutsideTarget();
    const allowedRoot = await makeAllowedRoot();

    await excludeSandboxArtifacts(outside, allowedRoot);

    expect(await outsideExclude()).toBe('ORIGINAL');
  });

  it('refuses a sibling directory that merely shares the root as a string prefix', async () => {
    // `/x/allowed-evil` starts with `/x/allowed` — the separator in the prefix test is what stops it.
    const allowedRoot = await makeAllowedRoot();
    const sibling = `${allowedRoot}-evil`;
    await fs.mkdir(path.join(sibling, '.git', 'info'), { recursive: true });
    await fs.writeFile(path.join(sibling, '.git', 'info', 'exclude'), 'ORIGINAL');

    await excludeSandboxArtifacts(sibling, allowedRoot);

    expect(await fs.readFile(path.join(sibling, '.git', 'info', 'exclude'), 'utf8')).toBe('ORIGINAL');
  });

  it('refuses the allowed root itself — a clone always sits beneath it', async () => {
    await execFileAsync('git', ['init', '-q', tmpDir]);
    const excludePath = path.join(tmpDir, '.git', 'info', 'exclude');
    await fs.writeFile(excludePath, 'ORIGINAL');

    await excludeSandboxArtifacts(tmpDir, tmpDir);

    expect(await fs.readFile(excludePath, 'utf8')).toBe('ORIGINAL');
  });

  it('refuses when the clone path is a symlink pointing outside the allowed root', async () => {
    // Lexical checks pass here; only canonicalising the path catches it.
    const outside = await makeOutsideTarget();
    const allowedRoot = await makeAllowedRoot();
    const link = path.join(allowedRoot, 'looks-legit');
    await fs.symlink(outside, link);

    await excludeSandboxArtifacts(link, allowedRoot);

    expect(await outsideExclude()).toBe('ORIGINAL');
  });

  it('refuses when .git is a symlink escaping the clone', async () => {
    const outside = await makeOutsideTarget();
    await fs.rm(path.join(repoPath, '.git'), { recursive: true, force: true });
    await fs.symlink(path.join(outside, '.git'), path.join(repoPath, '.git'));

    await excludeSandboxArtifacts(repoPath, tmpDir);

    expect(await outsideExclude()).toBe('ORIGINAL');
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

  it('refuses a directory that is not a git clone, and creates nothing in it', async () => {
    const notARepo = path.join(tmpDir, 'not-a-repo');
    await fs.mkdir(notARepo, { recursive: true });

    await excludeSandboxArtifacts(notARepo, tmpDir);

    await expect(fs.stat(path.join(notARepo, '.git'))).rejects.toThrow();
  });

  it('rejects a syntactically escaping path before touching the filesystem', async () => {
    // The lexical check runs first, so a path that escapes the root on its face is refused before
    // any stat or mkdir — observable as nothing being created anywhere.
    const allowedRoot = await makeAllowedRoot();

    await expect(
      excludeSandboxArtifacts(path.join(allowedRoot, '..', 'nope', 'also-missing'), allowedRoot),
    ).resolves.toBeUndefined();
    await expect(fs.stat(path.join(tmpDir, 'nope'))).rejects.toThrow();
  });

  it('still works for a legitimate clone under the allowed root', async () => {
    // The guards must not be so strict that the real case stops working.
    await excludeSandboxArtifacts(repoPath, tmpDir);

    await writeFileAt('.mcp.json');
    expect(await isIgnored('.mcp.json')).toBe(true);
  });
});
