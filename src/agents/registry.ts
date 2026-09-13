/**
 * PM Agent Definition
 *
 * One task runs one agent — the PM — and its definition is engine-owned and
 * static apart from two things read from the plugins repo root: the MCP servers
 * of `.mcp.json` (all of them attach to the session) and the network allowlist
 * of `archie.json`. Everything a plugin contributes — skills, agents, commands,
 * hooks — is loaded natively by the SDK from the plugin directories, so nothing
 * here scans a plugin's contents any more.
 *
 * Built fresh on every task start/restart, so a plugins-repo change is picked
 * up by the next task without a restart.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import type { AgentDef } from '../types/agent.js';
import { getRootMcpConfig, getArchieConfig } from '../system/plugin-loader.js';
import { PLUGINS_DIR } from '../system/workdir.js';
import { logger } from '../system/logger.js';
import { deniedToolNames } from './tool-approval-gate.js';

// ---- Engine constants ----
//
// The PM's model and effort are engine-owned, not plugin-owned. The defaults
// below are exactly what the `pm` plugin overlay resolved to (`model: opus`,
// `effort: medium`); a deployment can override either from `pm.md` at the
// plugins repo root, and an operator from the environment.
//
// Max mode gets the upgrade the REPO AGENTS carried before, because the PM now
// does the work they used to: max mode is what a user reaches for when the
// default run was not good enough, and leaving the PM on its normal model made
// the approval a no-op for exactly the coding and investigation work the
// upgrade exists for.

const DEFAULT_PM_MODEL = 'opus';
const DEFAULT_PM_EFFORT = 'medium';
const DEFAULT_PM_MAX_MODEL = 'claude-fable-5-1';
const DEFAULT_PM_MAX_EFFORT = 'high';

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

function asEffort(value: string): AgentDef['effort'] {
  if ((EFFORT_LEVELS as readonly string[]).includes(value)) return value as AgentDef['effort'];
  logger.warn('registry', `Unknown PM effort "${value}" — falling back to 'high'`);
  return 'high';
}

// ---- Deployment overlay (`pm.md` at the plugins repo root) ----

/** The PM overlay a deployment writes at the plugins repo root. Every field optional; an absent file yields an all-empty overlay. */
export interface PmOverlay {
  model?: string;
  effort?: AgentDef['effort'];
  maxMode?: { model?: string; effort?: AgentDef['effort'] };
  /** The Markdown below the frontmatter, appended to the PM's system prompt as `# Deployment context`. */
  body: string;
}

const EMPTY_OVERLAY: PmOverlay = { body: '' };

/** One frontmatter value, kept only if it is a non-empty string. */
function overlayString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** One frontmatter effort, kept only if it names a real level — an unknown one is ignored so the next source down decides, rather than silently pinning the PM to a fallback. */
function overlayEffort(value: unknown, where: string): AgentDef['effort'] | undefined {
  const raw = overlayString(value);
  if (!raw) return undefined;
  if ((EFFORT_LEVELS as readonly string[]).includes(raw)) return raw as AgentDef['effort'];
  logger.warn('registry', `pm.md: unknown ${where} "${raw}" — ignoring it`);
  return undefined;
}

/**
 * Read `pm.md` from the plugins repo root: optional `model` / `effort` /
 * `maxMode` frontmatter, and a Markdown body describing what this deployment is.
 *
 * Read on every call rather than cached, which is what makes it behave like the
 * rest of the plugins repo: the file is re-read when the next task builds its PM
 * definition and spawns, so an edit lands without restarting the engine.
 *
 * A missing file is a no-op. Frontmatter that does not parse is a warning and
 * the whole file is treated as body — an operator's prose is worth more than a
 * YAML nicety, and dropping the file silently is the one outcome that leaves
 * nobody able to tell why nothing changed.
 */
export function readPmOverlay(): PmOverlay {
  const path = join(PLUGINS_DIR, 'pm.md');
  if (!existsSync(path)) return EMPTY_OVERLAY;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    logger.warn('registry', `Could not read ${path} — ignoring the PM overlay`, error);
    return EMPTY_OVERLAY;
  }

  let parsed: { data: Record<string, unknown>; content: string };
  try {
    const file = matter(raw);
    parsed = { data: file.data as Record<string, unknown>, content: file.content };
  } catch (error) {
    logger.warn('registry', `pm.md: frontmatter did not parse — using the file as body only`, error);
    return { body: raw.trim() };
  }

  const maxMode = parsed.data.maxMode;
  const max = maxMode && typeof maxMode === 'object' && !Array.isArray(maxMode)
    ? (maxMode as Record<string, unknown>)
    : {};
  const model = overlayString(parsed.data.model);
  const effort = overlayEffort(parsed.data.effort, 'effort');
  const overlay: PmOverlay = {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    body: parsed.content.trim(),
  };
  const maxModel = overlayString(max.model);
  const maxEffort = overlayEffort(max.effort, 'maxMode.effort');
  if (maxModel || maxEffort) {
    overlay.maxMode = { ...(maxModel ? { model: maxModel } : {}), ...(maxEffort ? { effort: maxEffort } : {}) };
  }
  return overlay;
}

// ---- Module state ----

let pmDef: AgentDef | undefined;

/**
 * Append the deployment's own description — the body of `pm.md` — to the PM's
 * system prompt, under a final `# Deployment context` heading.
 *
 * Last of the prompt's dynamic sections (see spawn.ts) and read at spawn time,
 * so an edit in the plugins repo reaches the next task without a restart.
 * Returns the prompt untouched when there is no file or no body, which is the
 * whole of the missing-file behaviour.
 */
export function appendDeploymentContext(systemPrompt: string): string {
  const { body } = readPmOverlay();
  if (body) {
    return `${systemPrompt}\n\n# Deployment context\n\n${body}`;
  } else {
    return systemPrompt;
  }
}

// ---- Public API ----

/**
 * Initialize the registry. Must be called after initPlugins().
 * Rebuilds the PM definition from the current plugin state.
 */
export function initRegistry(): void {
  pmDef = buildPmDef();
}

/**
 * The PM AgentDef, built fresh from the current plugins-repo state. Used on
 * every task start/restart so a resumed task picks up config changes.
 */
export function scanPmDef(): AgentDef {
  return buildPmDef();
}

/**
 * The cached PM AgentDef. Built lazily if `initRegistry()` has not run (tests,
 * and any path that reaches an agent before startup finishes).
 */
export function getPmDef(): AgentDef {
  pmDef ??= buildPmDef();
  return pmDef;
}

/**
 * Every AgentDef the engine knows about — the PM, and only the PM. Retained as
 * a list so startup logging and any roster consumer keeps working.
 */
export function getAllAgentDefs(): AgentDef[] {
  return [getPmDef()];
}

/**
 * Test-only: override the cached PM definition. Do not call from production code.
 */
export function __setPmDefForTesting(def: AgentDef | undefined): void {
  pmDef = def;
}

/**
 * Merge policy for a repo: may Archie merge its PRs without asking the user?
 *
 * Declared per repo in the plugins repo's root `archie.json`
 * (`repos["owner/repo"].autoMerge`). Strict-boolean, so a repo that is absent,
 * or whose flag is anything but the literal `true`, goes through the existing
 * user-approval gate on every merge.
 */
export function isAutoMergeRepo(github: string): boolean {
  return getArchieConfig().repos[github]?.autoMerge === true;
}

// ---- Internal helpers ----

/**
 * The PM definition: static identity and model, plus the two things the
 * plugins repo root still decides.
 *
 * MCP is engine-owned and session-wide. Every server in `.mcp.json` attaches,
 * carrying its own `archie` policy with it, and those policies are unioned into
 * one session policy — `deny` tiers become `disallowedTools` here, `ask` tiers
 * attach the PreToolUse approval gate in `spawn.ts`. There is no per-agent
 * subsetting left to do: there is only one agent.
 */
function buildPmDef(): AgentDef {
  const rootMcp = getRootMcpConfig();
  const denied = deniedToolNames(rootMcp.policies);

  // Precedence: the environment wins over `pm.md`, `pm.md` wins over the
  // built-in defaults. An operator setting ARCHIE_PM_* on the process is making
  // a deployment-time decision about THIS instance, and it has to survive
  // whatever the plugins repo happens to say.
  const overlay = readPmOverlay();
  const model = process.env.ARCHIE_PM_MODEL?.trim() || overlay.model || DEFAULT_PM_MODEL;
  const effort = process.env.ARCHIE_PM_EFFORT?.trim() || overlay.effort || DEFAULT_PM_EFFORT;
  const maxModel = process.env.ARCHIE_PM_MAX_MODEL?.trim() || overlay.maxMode?.model || DEFAULT_PM_MAX_MODEL;
  const maxEffort = process.env.ARCHIE_PM_MAX_EFFORT?.trim() || overlay.maxMode?.effort || DEFAULT_PM_MAX_EFFORT;

  return {
    id: 'pm-agent',
    key: 'pm',
    role: 'Project Manager',
    expertise: 'Task management, coordination, user communication',
    model,
    effort: asEffort(effort),
    maxMode: { model: maxModel, effort: asEffort(maxEffort) },
    isPm: true,
    pluginName: 'core',
    visibility: 'global',
    mcpServers: rootMcp.servers,
    mcpDescriptions: rootMcp.descriptions,
    ...(Object.keys(rootMcp.policies).length > 0 ? { mcpPolicy: rootMcp.policies } : {}),
    ...(denied.length > 0 ? { disallowedTools: denied } : {}),
    allowedNetworkDomains: getArchieConfig().allowedNetworkDomains,
  };
}
