/**
 * Core skill mounting manifest tests.
 *
 * These pin the two things the manifest decides: which core skills a track mounts, and how a plugin's own skills combine with them (order, shadowing, what counts as a skill dir). The symlink-vendored and colliding-name cases don't exist in the real tree, so fixtures under os.tmpdir() are the only way to prove them — nothing here writes inside the repo.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, existsSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { CORE_SKILL_MOUNTS, resolveSkillPaths, findUnmountedCoreSkills, mountedSkillNames, coreSkillPaths } from '../core-skills.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The module deliberately does not export its CORE_SKILLS_DIR, so recompute it here: src/agents/__tests__ -> repo root -> skills.
const REPO_SKILLS_DIR = join(__dirname, '..', '..', '..', 'skills');

let root: string;
/** A plugin skills dir with the shapes we care about: two plain dirs, a symlink to a dir, a dangling symlink, and a stray file. */
let fixtureDir: string;
/** A second plugin skills dir whose entry name collides with a core skill. */
let collidingDir: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'core-skills-test-'));

  fixtureDir = join(root, 'plugin-skills');
  mkdirSync(join(fixtureDir, 'alpha-skill'), { recursive: true });
  mkdirSync(join(fixtureDir, 'beta-skill'), { recursive: true });
  writeFileSync(join(fixtureDir, '.DS_Store'), 'stray');

  // A skill vendored as a submodule and exposed via a symlink, plus a link whose target never existed.
  const vendored = join(root, 'vendored', 'data-context');
  mkdirSync(vendored, { recursive: true });
  symlinkSync(vendored, join(fixtureDir, 'linked-skill'));
  symlinkSync(join(root, 'nowhere-at-all'), join(fixtureDir, 'dangling-skill'));

  collidingDir = join(root, 'colliding-skills');
  mkdirSync(join(collidingDir, 'triggers'), { recursive: true });
  mkdirSync(join(collidingDir, 'zeta-skill'), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('CORE_SKILL_MOUNTS', () => {
  it('mounts all five core skills on the PM and trigger-task alone on the other tracks', () => {
    expect(CORE_SKILL_MOUNTS.pm).toEqual([
      'channel-canvas',
      'self-awareness',
      'thread-conduct',
      'triggers',
      'trigger-task',
    ]);
    expect(CORE_SKILL_MOUNTS.repo).toEqual(['trigger-task']);
    expect(CORE_SKILL_MOUNTS.plain).toEqual(['trigger-task']);
  });

  it('names only skills that actually exist under the repo skills dir', () => {
    for (const [track, names] of Object.entries(CORE_SKILL_MOUNTS)) {
      for (const name of names) {
        const path = join(REPO_SKILLS_DIR, name);
        expect(existsSync(path), `${track} mounts missing skill ${name}`).toBe(true);
        expect(statSync(path).isDirectory(), `${track} mounts non-dir ${name}`).toBe(true);
      }
    }
  });
});

describe('resolveSkillPaths', () => {
  it('puts the plugin entries before the core entries on the pm track', () => {
    const paths = resolveSkillPaths('pm', fixtureDir);
    // Assert on the unsorted array — the order IS the shadowing rule.
    expect(paths).toEqual([
      join(fixtureDir, 'alpha-skill'),
      join(fixtureDir, 'beta-skill'),
      join(fixtureDir, 'linked-skill'),
      join(REPO_SKILLS_DIR, 'channel-canvas'),
      join(REPO_SKILLS_DIR, 'self-awareness'),
      join(REPO_SKILLS_DIR, 'thread-conduct'),
      join(REPO_SKILLS_DIR, 'triggers'),
      join(REPO_SKILLS_DIR, 'trigger-task'),
    ]);
  });

  it('gives the repo and plain tracks the plugin entries plus their own track\'s core entries', () => {
    const pluginEntries = [
      join(fixtureDir, 'alpha-skill'),
      join(fixtureDir, 'beta-skill'),
      join(fixtureDir, 'linked-skill'),
    ];
    // Derived from the manifest rather than spelled out, so these two tracks gaining a core skill does not need an edit here — what is pinned is that they get their track's entries and nothing from another track's.
    const coreEntries = (track: 'repo' | 'plain'): string[] => CORE_SKILL_MOUNTS[track].map((name) => join(REPO_SKILLS_DIR, name));
    expect(resolveSkillPaths('repo', fixtureDir)).toEqual([...pluginEntries, ...coreEntries('repo')]);
    expect(resolveSkillPaths('plain', fixtureDir)).toEqual([...pluginEntries, ...coreEntries('plain')]);
  });

  it('lets a plugin skill shadow a core skill of the same name, exactly once', () => {
    const paths = resolveSkillPaths('pm', collidingDir);
    const triggers = paths.filter((p) => basename(p) === 'triggers');
    expect(triggers).toEqual([join(collidingDir, 'triggers')]);
    expect(paths).not.toContain(join(REPO_SKILLS_DIR, 'triggers'));
    // The other four core skills still mount.
    expect(paths.map((p) => basename(p))).toEqual([
      'triggers',
      'zeta-skill',
      'channel-canvas',
      'self-awareness',
      'thread-conduct',
      'trigger-task',
    ]);
  });

  it('includes a symlink to a directory, and excludes a dangling symlink and a plain file', () => {
    const paths = resolveSkillPaths('plain', fixtureDir);
    expect(paths).toContain(join(fixtureDir, 'linked-skill'));
    expect(paths).not.toContain(join(fixtureDir, 'dangling-skill'));
    expect(paths).not.toContain(join(fixtureDir, '.DS_Store'));
  });

  it('returns just the track\'s core entries when there is no plugin path', () => {
    expect(resolveSkillPaths('repo')).toEqual([join(REPO_SKILLS_DIR, 'trigger-task')]);
  });

  it('derives the boot banner name list, symlinked skills included', () => {
    // Calls the same exported helper the boot banner calls, so the two cannot drift. No symlinked skill exists in the real tree, so only a fixture can prove one survives the derivation.
    expect(mountedSkillNames(resolveSkillPaths('plain', fixtureDir))).toEqual([
      'alpha-skill',
      'beta-skill',
      'linked-skill',
      'trigger-task',
    ]);
  });
});

describe('mountedSkillNames', () => {
  it('sorts basenames and tolerates an absent list', () => {
    expect(mountedSkillNames(['/x/zeta', '/y/alpha'])).toEqual(['alpha', 'zeta']);
    expect(mountedSkillNames()).toEqual([]);
  });
});

describe('findUnmountedCoreSkills', () => {
  it('finds no core skill that ships without a track mounting it', () => {
    expect(findUnmountedCoreSkills()).toEqual([]);
  });

  // The positive case is what actually guards the boot warning: without it the whole function could be replaced by `return []` with every other test still green. The real skills dir has nothing unmounted, so it takes a fixture standing in for it.
  it('names every shipped skill directory that no track mounts', () => {
    expect(findUnmountedCoreSkills(fixtureDir)).toEqual([
      'alpha-skill',
      'beta-skill',
      'linked-skill',
    ]);
  });

  it('does not name a directory the manifest does mount', () => {
    // collidingDir holds `triggers` (mounted by the pm track) and `zeta-skill` (mounted by nobody).
    expect(findUnmountedCoreSkills(collidingDir)).toEqual(['zeta-skill']);
  });

  it('reports nothing when the skills directory is absent, as in an image built without it', () => {
    expect(findUnmountedCoreSkills(join(root, 'no-such-dir'))).toEqual([]);
  });
});

describe('coreSkillPaths', () => {
  // The grant these feed is a read grant, so a filter that is too loose widens what an
  // agent can read and a filter that is too tight breaks reading a skill it mounted.

  it('keeps the core skills a track mounts and drops the plugin ones', () => {
    // resolveSkillPaths returns both kinds interleaved; only the core half needs a grant.
    const mounted = resolveSkillPaths('pm', fixtureDir);
    const core = coreSkillPaths(mounted);
    expect(core.every((p) => p.startsWith(REPO_SKILLS_DIR + '/'))).toBe(true);
    expect(core.map((p) => basename(p)).sort()).toEqual([...CORE_SKILL_MOUNTS.pm].sort());
    expect(core).not.toContain(join(fixtureDir, 'alpha-skill'));
  });

  it('grants only what was mounted, not the whole core skills dir', () => {
    const one = join(REPO_SKILLS_DIR, CORE_SKILL_MOUNTS.pm[0]);
    expect(coreSkillPaths([one])).toEqual([one]);
    expect(coreSkillPaths([one])).not.toContain(REPO_SKILLS_DIR);
  });

  it('excludes the core skills dir itself, so a sibling prefix cannot sneak in', () => {
    // `<root>/skills-extra` shares the string prefix `<root>/skills` — matching on the
    // separator is what stops it from being treated as a core skill.
    expect(coreSkillPaths([root, join(root, 'skills-extra', 'x')], join(root, 'skills'))).toEqual([]);
    expect(coreSkillPaths([join(root, 'skills')], join(root, 'skills'))).toEqual([]);
  });

  it('normalises before comparing, so an unresolved path still matches', () => {
    const p = join(root, 'skills', '..', 'skills', 'a');
    expect(coreSkillPaths([p], join(root, 'skills'))).toEqual([p]);
  });

  it('tolerates an agent with no skills at all', () => {
    expect(coreSkillPaths()).toEqual([]);
    expect(coreSkillPaths([])).toEqual([]);
  });
});
