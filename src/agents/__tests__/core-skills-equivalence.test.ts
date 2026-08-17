/**
 * Equivalence pin for the per-agent mounted skill set.
 *
 * This loads the real plugin tree off disk and asserts the mount set every agent def ends up with, so the `skillsPath`/`coreSkillsPath` → `skillPaths` refactor is provably behavior-preserving rather than only argued to be. It needs no `.env`, no secrets and no network: `initPlugins()` and `initRegistry()` are synchronous disk scans.
 *
 * The numbers 26 / 22 / 4 come from a baseline captured on the untouched branch before this change. A plugins-clone update can legitimately move 26 (the PM's total) and 22 (its plugin-sourced entries) — when the plugins repo gains or loses a PM skill, update those two together. The four core skill names and the two ordering/uniqueness invariants must NOT move: they are the behavior this file exists to protect.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join, dirname, basename, sep } from 'path';
import { fileURLToPath } from 'url';
import { initPlugins } from '../../system/plugin-loader.js';
import { PLUGINS_DIR } from '../../system/workdir.js';
import { initRegistry, getAllAgentDefs } from '../registry.js';
import type { AgentDef } from '../../types/agent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The module deliberately does not export its CORE_SKILLS_DIR, so recompute it here the way the sibling core-skills.test.ts does: src/agents/__tests__ -> repo root -> skills.
const REPO_SKILLS_DIR = join(__dirname, '..', '..', '..', 'skills');

const CORE_SKILL_NAMES = ['channel-canvas', 'self-awareness', 'thread-conduct', 'triggers'];

/** Baseline captured before the refactor: the PM mounts 22 plugin skills plus the 4 core skills. */
const PM_MOUNT_COUNT = 26;
const PM_PLUGIN_SOURCED = 22;
const PM_CORE_SOURCED = 4;

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
  pinned('gives exactly one PM def, mounting the baseline number of skills', () => {
    const pms = defs.filter((def) => def.isPm === true);
    expect(pms.map((def) => def.id)).toHaveLength(1);
    expect(mountedNames(pms[0])).toHaveLength(PM_MOUNT_COUNT);
  });

  pinned('mounts all four core skills on the PM, and splits its entries 22 plugin / 4 core', () => {
    const pm = defs.find((def) => def.isPm === true)!;
    const paths = pm.skillPaths ?? [];

    expect(mountedNames(pm)).toEqual(expect.arrayContaining(CORE_SKILL_NAMES));
    expect(paths.filter((p) => isUnder(p, REPO_SKILLS_DIR))).toHaveLength(PM_CORE_SOURCED);
    expect(paths.filter((p) => isUnder(p, PLUGINS_DIR))).toHaveLength(PM_PLUGIN_SOURCED);
  });

  pinned('mounts no core skill on any non-PM def', () => {
    for (const def of defs.filter((d) => d.isPm !== true)) {
      const fromCore = (def.skillPaths ?? []).filter((p) => isUnder(p, REPO_SKILLS_DIR));
      expect(fromCore, `${def.id} mounts core skills`).toEqual([]);
    }
  });

  pinned('never mounts two skills sharing a basename on the same def', () => {
    for (const def of defs) {
      const names = mountedNames(def);
      expect(new Set(names).size, `${def.id} has duplicate skill names: ${names.join(', ')}`).toBe(names.length);
    }
  });

  pinned('orders every core-sourced PM entry after every plugin-sourced one', () => {
    // This is the plugin-shadows-core rule, and it is invisible in the real tree today because no plugin skill collides with a core name — so this assertion is the only thing protecting it. Asserted on the UNSORTED list, because the order is the rule.
    const paths = (defs.find((def) => def.isPm === true)!.skillPaths ?? []);
    const lastPlugin = paths.reduce((acc, p, i) => (isUnder(p, PLUGINS_DIR) ? i : acc), -1);
    const firstCore = paths.findIndex((p) => isUnder(p, REPO_SKILLS_DIR));
    expect(lastPlugin).toBeGreaterThanOrEqual(0);
    expect(firstCore).toBeGreaterThan(lastPlugin);
  });
});
