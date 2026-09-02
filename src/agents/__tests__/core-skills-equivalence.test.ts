/**
 * Equivalence pin for the per-agent mounted skill set.
 *
 * This loads the real plugin tree off disk and asserts the mount set every agent def ends up with, so the `skillsPath`/`coreSkillsPath` → `skillPaths` refactor is provably behavior-preserving rather than only argued to be. It needs no `.env`, no secrets and no network: `initPlugins()` and `initRegistry()` are synchronous disk scans.
 *
 * IMPORTANT — this file does not run in CI, and a green CI is therefore not evidence that equivalence holds. `PLUGINS_DIR` is `<cwd>/workdir/plugins`, `workdir/` is gitignored, and `.github/workflows/ci.yml` checks out only archie-hq, so every test here skips there. It is a developer-machine pin, meaningful only with an archie-plugins clone present. The behavior rules it covers — plugin-first ordering, basename dedupe, symlink classification — are also covered by fixtures in the sibling core-skills.test.ts, which DOES run in CI; that file is the real regression net.
 *
 * Counts are derived rather than hard-coded, because the PM's totals are owned by the separately versioned archie-plugins repo. What is pinned are the invariants that hold whatever that clone contains: the core skill names, plugin-before-core ordering, basename uniqueness, and that every def's core-sourced mounts are exactly its own track's manifest entry.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join, dirname, basename, sep } from 'path';
import { fileURLToPath } from 'url';
import { initPlugins } from '../../system/plugin-loader.js';
import { PLUGINS_DIR } from '../../system/workdir.js';
import { initRegistry, getAllAgentDefs } from '../registry.js';
import { CORE_SKILL_MOUNTS } from '../core-skills.js';
import type { AgentDef } from '../../types/agent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The module deliberately does not export its CORE_SKILLS_DIR, so recompute it here the way the sibling core-skills.test.ts does: src/agents/__tests__ -> repo root -> skills.
const REPO_SKILLS_DIR = join(__dirname, '..', '..', '..', 'skills');

const CORE_SKILL_NAMES = ['channel-canvas', 'self-awareness', 'thread-conduct', 'triggers', 'trigger-task', 'recall-meetings'];

const pluginsDirExists = existsSync(PLUGINS_DIR);

let defs: AgentDef[] = [];
if (pluginsDirExists) {
  initPlugins();
  initRegistry();
  defs = getAllAgentDefs();
}

/**
 * Why this guard exists: `PLUGINS_DIR` is derived from `process.cwd()` unless `ARCHIE_WORKDIR` is set (src/system/workdir.ts:27,30), and `scanPlugins()` returns `[]` *silently* when the tree is absent instead of throwing (src/system/plugin-loader.ts:191-193). So a checkout without a plugins clone would leave a PM-only registry and every assertion below would pass while measuring nothing. Skipping loudly beats a green run over an empty tree.
 */
const skipReason = !pluginsDirExists
  ? `plugins tree absent at ${PLUGINS_DIR} — nothing to compare against the captured baseline`
  : defs.length < 2
    ? `registry produced only ${defs.length} agent def(s), so the plugin tree did not load — asserting here would pin nothing`
    : null;

/** Registers the test, or skips it with the reason spelled out in its name. */
function pinned(name: string, body: () => void): void {
  if (skipReason) {
    it.skip(`${name} [skipped: ${skipReason}]`, body);
    return;
  }
  it(name, body);
}

/** The mounted skill names for a def, in mount order. Wrapped callback, not `map(basename)` — Array#map passes the index as basename's `suffix` argument, which throws ERR_INVALID_ARG_TYPE. */
function mountedNames(def: AgentDef): string[] {
  return (def.skillPaths ?? []).map((p) => basename(p));
}

const isUnder = (path: string, dir: string): boolean => path.startsWith(dir + sep);

describe('mounted skill sets match the pre-refactor baseline', () => {
  pinned('gives exactly one PM def, and every entry it mounts comes from one of the two sources', () => {
    const pms = defs.filter((def) => def.isPm === true);
    expect(pms.map((def) => def.id)).toHaveLength(1);

    // Deliberately not a hard-coded 26: that total is owned by the separately versioned archie-plugins repo, so pinning it would break this suite from a change made elsewhere. What must hold is that the total is exactly the two sources and nothing else.
    const paths = pms[0].skillPaths ?? [];
    const fromPlugins = paths.filter((p) => isUnder(p, PLUGINS_DIR));
    const fromCore = paths.filter((p) => isUnder(p, REPO_SKILLS_DIR));
    expect(fromPlugins.length + fromCore.length).toBe(paths.length);
    expect(fromPlugins.length).toBeGreaterThan(0);
  });

  pinned('mounts exactly the pm track\'s core skills on the PM, and no others', () => {
    const pm = defs.find((def) => def.isPm === true)!;
    const paths = pm.skillPaths ?? [];

    expect(mountedNames(pm)).toEqual(expect.arrayContaining(CORE_SKILL_NAMES));
    // Derived from the manifest rather than written as 4, so adding a core skill to the pm track updates this expectation automatically instead of failing here.
    expect(paths.filter((p) => isUnder(p, REPO_SKILLS_DIR))).toHaveLength(CORE_SKILL_MOUNTS.pm.length);
  });

  pinned('mounts exactly its own track\'s core skills on every non-PM def', () => {
    for (const def of defs.filter((d) => d.isPm !== true)) {
      // The tracks as core-skills.ts defines them: repo access attached → repo, neither that nor isPm → plain.
      const track = def.repo != null ? 'repo' : 'plain';
      const fromCore = (def.skillPaths ?? []).filter((p) => isUnder(p, REPO_SKILLS_DIR));
      // Derived from the manifest, so mounting another core skill on a non-PM track does not need an edit here. It pins that each non-PM def resolves exactly its own track's entries off the real tree — a manifest name resolving to nothing fails, as does a plugin skill colliding on a core basename. It does not pin that the manifest names are the right ones (same constant), nor catch a repo↔plain swap while those arrays are identical; the literal expectation in core-skills.test.ts is that guard.
      expect(fromCore.map((p) => basename(p)), `${def.id} does not mount its ${track} track core skills`).toEqual(CORE_SKILL_MOUNTS[track]);
    }
  });

  pinned('never mounts two skills sharing a basename on the same def', () => {
    // Cannot fail against today's tree — no plugin skill collides with a core name, so removing the dedupe entirely would leave this green. It is here as a real-tree invariant that would catch a future collision; the falsifiable proof of the dedupe itself is the fixture test in core-skills.test.ts.
    for (const def of defs) {
      const names = mountedNames(def);
      expect(new Set(names).size, `${def.id} has duplicate skill names: ${names.join(', ')}`).toBe(names.length);
    }
  });

  pinned('orders every core-sourced PM entry after every plugin-sourced one', () => {
    // This is the plugin-shadows-core rule. Unlike the dedupe assertion above it does bite against the real tree: reversing the two source blocks in resolveSkillPaths puts firstCore before lastPlugin and fails here. Asserted on the UNSORTED list, because the order is the rule.
    const paths = (defs.find((def) => def.isPm === true)!.skillPaths ?? []);
    const lastPlugin = paths.reduce((acc, p, i) => (isUnder(p, PLUGINS_DIR) ? i : acc), -1);
    const firstCore = paths.findIndex((p) => isUnder(p, REPO_SKILLS_DIR));
    expect(lastPlugin).toBeGreaterThanOrEqual(0);
    expect(firstCore).toBeGreaterThan(lastPlugin);
  });
});
