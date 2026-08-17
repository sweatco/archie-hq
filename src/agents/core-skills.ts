/**
 * Core skill mounting manifest.
 *
 * One place that answers "which of archie-hq's own skills does this agent track mount?", and one resolver that turns that answer plus a plugin's skills directory into the ordered list of skill directories to mount.
 *
 * Imports only from node's fs/path/url on purpose: registry.ts and spawn.ts are both future callers, so importing either here would close an import cycle.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
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
 * The single declaration of which core skills each track mounts. It encodes today's mapping exactly — all four on the PM, nothing on the others — so behavior is unchanged.
 *
 * This mapping is intentionally a hardcoded constant — NOT plugin- or PM-settable — so the set of skills an agent track mounts can't be widened from a hot-reloaded plugins change or a compromised orchestrator.
 *
 * Sandbox limit: adding a core skill to another track makes it loadable through the `Skill` and `Read` tools — the PreToolUse guard resolves the raw tool-input path with `resolve(cwd, rawPath)` and never calls `realpath` (`src/agents/sandbox.ts:231`), `READ_TOOLS` is only `{Read, Glob, Grep}` so `Skill` is never seen (`src/agents/sandbox.ts:181`), and the workspace is in `allowReadPaths` on every track (`src/agents/spawn.ts:326`). It does NOT make the files readable from `Bash`: bwrap resolves symlinks and `/app` is hardcoded in `denyRead` (`src/agents/sandbox.ts:83`).
 *
 * Content limit: all four core skills are written in the PM's voice and instruct PM-only MCP tools (`post_to_channel`, `mute_channel`, `read_thread`, `fetch_slack_reference`, `propose_trigger`) that are attached only inside the `isPmAgent(def)` branch at `src/agents/spawn.ts:412-414`; `skills/self-awareness/SKILL.md:53` even describes itself as a built-in PM skill. So giving one of them a new audience needs prompt and tool work too, not just a line here.
 */
export const CORE_SKILL_MOUNTS: Record<AgentTrack, string[]> = {
  pm: ['channel-canvas', 'self-awareness', 'thread-conduct', 'triggers'],
  repo: [],
  plain: [],
};

/**
 * Mount real skill dirs AND symlinks that resolve to a dir. A skill can be vendored as a git submodule and exposed via a symlink (e.g. the data-analytics data-context); readdir's Dirent.isDirectory() is false for a symlink, so stat-follow to classify it. A dangling link is skipped. The filter also excludes stray files such as the `.DS_Store` that is present in `workdir/plugins/pm/skills`.
 */
function isSkillDir(parentDir: string, entry: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(join(parentDir, entry.name)).isDirectory();
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
    // The existence check preserves the guard at `src/agents/registry.ts:416`, which exists because the prod image only has `/app/skills` when `Dockerfile.prod` copied it.
    if (existsSync(corePath)) paths.push(corePath);
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
 * The sorted names of directories directly under the core skills dir that appear in no `CORE_SKILL_MOUNTS` value — a core skill that ships but no track mounts, which is dead weight nobody can load. Empty when the core skills dir is absent (the prod-image case above).
 */
export function findUnmountedCoreSkills(): string[] {
  if (!existsSync(CORE_SKILLS_DIR)) return [];

  const mounted = new Set(Object.values(CORE_SKILL_MOUNTS).flat());
  const unmounted: string[] = [];
  for (const entry of readdirSync(CORE_SKILLS_DIR, { withFileTypes: true })) {
    if (!isSkillDir(CORE_SKILLS_DIR, entry)) continue;
    if (!mounted.has(entry.name)) unmounted.push(entry.name);
  }
  return unmounted.sort();
}
