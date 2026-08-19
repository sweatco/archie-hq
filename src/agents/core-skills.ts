/**
 * Core skill mounting manifest.
 *
 * One place that answers "which of archie-hq's own skills does this agent track mount?", and one resolver that turns that answer plus a plugin's skills directory into the ordered list of skill directories to mount.
 *
 * Imports only from node's fs/path/url on purpose. Its callers are `src/agents/registry.ts` (which builds every agent def's `skillPaths`) and `src/index.ts` (the boot banner and the unmounted-core-skill warning); importing back into the registry from here would close an import cycle.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, basename, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Built-in PM skills shipped with archie-hq (resolved relative to this file: src/agents -> skills). This module sits at the same directory depth as registry.ts (`src/agents/`, compiling to `dist/agents/`), so the `'..', '..'` expression resolves to `<repo root>/skills` unchanged.
const CORE_SKILLS_DIR = join(__dirname, '..', '..', 'skills');

/**
 * The three cases the two existing predicates already distinguish: `isPmAgent(def)` is `def.isPm === true` and `isRepoAgent(def)` is `def.repo != null` (both at `src/types/agent.ts:249-264`), with a plain plugin agent being the negation of both.
 *
 * No track is stored on the agent definition; each construction site passes the literal it already branches on.
 */
export type AgentTrack = 'pm' | 'repo' | 'plain';

/**
 * The single declaration of which core skills each track mounts. Read the constant below for the current mapping rather than trusting a summary here; what is worth knowing is the shape — most core skills are written for the PM and mount on `pm` alone, while a skill describing something every agent gets (such as a trigger-fired task's directory) mounts on every track.
 *
 * This mapping is intentionally a hardcoded constant rather than configuration: no plugin manifest, no hot-reloaded plugins change and no instruction to the orchestrator can widen the set of skills a track mounts, because there is no code path that reads this from anywhere but here. (It is a plain object, so it is mutable in-process like `TRUSTED_PACKAGE_REGISTRY_DOMAINS` at `src/agents/sandbox.ts:48`; the guarantee is about where the values come from, not about runtime immutability.)
 *
 * Sandbox: reading a mounted skill's *files* needs a read grant, because their real path is under `/app`, which `buildSandboxConfig` hardcodes into `denyRead` — spawn grants the dirs each agent actually mounts (see {@link coreSkillPaths}). Loading is unaffected either way: `Skill` is in neither the guard's `READ_TOOLS` nor its `WRITE_TOOLS`, and the CLI reads the file in-process, outside bubblewrap.
 *
 * Content limit: a PM-voiced skill instructs tools attached only inside the `isPmAgent(def)` branch of `spawnAgent` — `post_to_channel`, `mute_channel`, `read_thread`, `fetch_slack_reference`, `report_completion` — so giving one a new audience needs prompt and tool work too, not just a line here. A skill on `repo` or `plain` has to be written for that audience from the start: track-neutral, naming no MCP tool, assuming no channel and no users.
 */
export const CORE_SKILL_MOUNTS: Record<AgentTrack, string[]> = {
  pm: ['channel-canvas', 'self-awareness', 'thread-conduct', 'triggers', 'trigger-task'],
  repo: ['trigger-task'],
  plain: ['trigger-task'],
};

/**
 * Mount real skill dirs AND symlinks that resolve to a dir. A skill can be vendored as a git submodule and exposed via a symlink (e.g. the data-analytics data-context); readdir's Dirent.isDirectory() is false for a symlink, so stat-follow to classify it. A dangling link is skipped. The filter also excludes stray files such as the `.DS_Store` that is present in `workdir/plugins/pm/skills`.
 */
function isSkillDir(parentDir: string, entry: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }): boolean {
  // A plain directory needs no syscall; anything else is decided by following the path.
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  return isSkillPath(join(parentDir, entry.name));
}

/**
 * The same rule as {@link isSkillDir}, applied to a path rather than a directory entry — used for core skills, which the manifest names rather than the filesystem enumerating. `statSync` follows symlinks, so a real directory and a symlink resolving to one both pass, while a regular file fails and a dangling link throws and is skipped.
 */
function isSkillPath(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The ordered, absolute list of skill directories an agent on `track` mounts: the plugin's own skills first, then this track's core skills.
 *
 * Deduplicated by `basename`, first occurrence winning. Plugin-first ordering IS the shadowing rule — a plugin skill shadows a core skill of the same name.
 */
export function resolveSkillPaths(track: AgentTrack, pluginSkillsPath?: string): string[] {
  const paths: string[] = [];

  if (pluginSkillsPath && existsSync(pluginSkillsPath)) {
    for (const entry of readdirSync(pluginSkillsPath, { withFileTypes: true })) {
      if (!isSkillDir(pluginSkillsPath, entry)) continue;
      paths.push(join(pluginSkillsPath, entry.name));
    }
  }

  for (const name of CORE_SKILL_MOUNTS[track]) {
    const corePath = join(CORE_SKILLS_DIR, name);
    // Classified the same way as a plugin entry, not merely existence-checked, so a manifest name that resolves to a regular file is skipped rather than symlinked as a bogus skill. This also subsumes the guard the registry used to carry before this manifest existed: the prod image only has `/app/skills` at all when `Dockerfile.prod` copied it, and in an image built without it every core path simply resolves to nothing.
    if (isSkillPath(corePath)) paths.push(corePath);
  }

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const path of paths) {
    const name = basename(path);
    if (seen.has(name)) continue;
    seen.add(name);
    deduped.push(path);
  }
  return deduped;
}

/**
 * The mounted skill names for an agent's ordered list, sorted. Shared by the boot banner's `skills:` line and by the tests, so the two cannot drift apart.
 *
 * Written as a wrapped callback rather than `map(basename)` on purpose: `Array#map` passes the index as `basename`'s `suffix` argument, which throws `ERR_INVALID_ARG_TYPE`.
 */
export function mountedSkillNames(skillPaths: string[] = []): string[] {
  return skillPaths.map((p) => basename(p)).sort();
}

/**
 * The subset of an agent's mounted skill paths whose real files live in archie-hq's
 * own `skills/` directory, rather than inside a plugin.
 *
 * Callers need this to grant read access to those files. Loading a skill is not what
 * needs the grant: `Skill` is in neither `READ_TOOLS` nor `WRITE_TOOLS`, so the
 * PreToolUse guard returns early without inspecting a path, and the CLI reads the
 * SKILL.md in-process, outside bubblewrap. Reading the skill's *file* is what needs it,
 * and measured inside the container (`bwrap` 0.11.0, target `/app/skills/triggers/SKILL.md`):
 *
 *   no grant, real path              Bash fail, Read fail
 *   no grant, workspace symlink      Bash fail, Read ok
 *   granted                          Bash ok,   Read ok
 *
 * So without a grant the file is unreachable from the shell by either route, and reachable
 * to `Read` only through the mount symlink — which works because the guard checks the raw
 * tool-input path without resolving it, while bwrap does resolve it and lands on `/app`,
 * which `buildSandboxConfig` denies. Plugin skills never depended on that: their real path
 * sits inside `def.pluginPath`, which is already granted.
 *
 * Only the skills an agent actually mounts are returned, so a track that mounts one core
 * skill does not gain read access to the ones it did not mount.
 *
 * `coreSkillsDir` exists for the same reason it does on {@link findUnmountedCoreSkills}:
 * `CORE_SKILLS_DIR` is module-private, so a test needs an injection point. Production
 * callers pass nothing.
 */
export function coreSkillPaths(skillPaths: string[] = [], coreSkillsDir: string = CORE_SKILLS_DIR): string[] {
  const base = resolve(coreSkillsDir);
  return skillPaths.filter((p) => resolve(p).startsWith(base + sep));
}

/**
 * The sorted names of directories directly under the core skills dir that appear in no `CORE_SKILL_MOUNTS` value — a core skill that ships but no track mounts, which is dead weight nobody can load. Empty when the core skills dir is absent (the prod-image case above).
 *
 * `coreSkillsDir` exists only so a test can point this at a fixture: `CORE_SKILLS_DIR` is module-private and the real tree has nothing unmounted, so without an injection point the only assertable case is the empty one — and a function that can be replaced by `return []` with every test still green is not actually guarded. Production callers pass nothing.
 */
export function findUnmountedCoreSkills(coreSkillsDir: string = CORE_SKILLS_DIR): string[] {
  if (!existsSync(coreSkillsDir)) return [];

  const mounted = new Set(Object.values(CORE_SKILL_MOUNTS).flat());
  const unmounted: string[] = [];
  for (const entry of readdirSync(coreSkillsDir, { withFileTypes: true })) {
    if (!isSkillDir(coreSkillsDir, entry)) continue;
    if (!mounted.has(entry.name)) unmounted.push(entry.name);
  }
  return unmounted.sort();
}
