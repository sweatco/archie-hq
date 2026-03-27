/**
 * Agent Sandbox Configuration
 *
 * Builds OS-level sandbox config (Bash tool) and PreToolUse hooks
 * (in-process tools) to enforce filesystem and network boundaries.
 *
 * Two enforcement layers from the same SandboxOptions:
 * 1. buildSandboxConfig()         → SDK sandbox (bubblewrap/sandbox-exec for Bash)
 * 2. createFilesystemGuardHooks() → PreToolUse hooks (Read, Write, Edit, Glob, Grep)
 */

import { resolve, normalize } from 'path';
import type { HookCallbackMatcher, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

// ---- Types ----

export interface SandboxOptions {
  /** Agent's working directory */
  cwd: string;
  /** Paths the agent can read (should include cwd) */
  allowReadPaths: string[];
  /** Paths the agent can write (default: none = read-only) */
  allowWritePaths?: string[];
  /** Paths to deny within allowWrite regions (e.g., cwd/.claude) */
  denyWritePaths?: string[];
  /** Domains Bash can reach (empty = deny all, default) */
  allowedNetworkDomains?: string[];
}

// ---- Sandbox config (OS-level, Bash only) ----

/**
 * Sandbox strategy:
 * - Reads: system paths open (Bash needs /bin, /usr, /etc, etc.).
 *   App code (/app) and workdir (/workdir) denied, then specific agent paths re-allowed.
 *   PreToolUse hooks enforce same read boundaries on in-process tools.
 * - Writes: deny-all by default, allowWrite for workspace + /tmp.
 *   denyWrite for protected paths within workspace (settings, skills).
 * - Network: deny-all by default from Bash.
 */
/**
 * IMPORTANT: allowRead and allowWrite must NOT overlap on the same path.
 * bwrap processes mounts sequentially: allowWrite creates a --bind (rw) mount,
 * then allowRead creates a --ro-bind mount on the same path, which OVERRIDES
 * the writable mount, downgrading it to read-only. If a path needs write access,
 * put it ONLY in allowWritePaths — writable bind mounts provide read access too.
 */
export function buildSandboxConfig(opts: SandboxOptions) {
  return {
    enabled: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    filesystem: {
      // NOTE: /workdir/sessions is intentionally NOT denied — denyRead on a parent
      // directory uses --tmpfs which destroys allowWrite --bind mounts on children
      // (bwrap mount ordering bug in sandbox-runtime). Sessions are readable from
      // Bash but PreToolUse hooks enforce read boundaries on Read/Glob/Grep tools.
      denyRead: ['/app', '/home/archie/.claude'],
      allowRead: [
        '/home/archie/.claude/shell-snapshots',
        ...new Set(opts.allowReadPaths),
      ],
      allowWrite: ['/tmp', ...(opts.allowWritePaths || [])],
      ...(opts.denyWritePaths && opts.denyWritePaths.length > 0
        ? { denyWrite: opts.denyWritePaths }
        : {}),
      allowGitConfig: true,
    },
    network: {
      allowedDomains: opts.allowedNetworkDomains ?? [],
    },
  };
}

// ---- PreToolUse hooks (in-process tools) ----

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const WRITE_TOOLS = new Set(['Write', 'Edit']);

/**
 * Check whether `target` path is under any of the `bases` directories.
 */
function isUnderAny(target: string, bases: string[]): boolean {
  const norm = normalize(target);
  return bases.some((b) => {
    const nb = normalize(b);
    return norm === nb || norm.startsWith(nb + '/');
  });
}

function deny(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Create PreToolUse hooks that enforce filesystem boundaries on
 * in-process tools (Read, Write, Edit, Glob, Grep).
 *
 * Returns a single matcher (no `matcher` field → fires on all tools)
 * that filters by tool_name inside the callback.
 */
export function createFilesystemGuardHooks(opts: SandboxOptions): HookCallbackMatcher[] {
  return [{
    hooks: [async (input: any) => {
      const { tool_name, tool_input } = input;

      if (!READ_TOOLS.has(tool_name) && !WRITE_TOOLS.has(tool_name)) {
        return { continue: true };
      }

      // Extract path from tool input
      let rawPath: string | undefined;
      if (tool_input && typeof tool_input === 'object') {
        if ('file_path' in tool_input) rawPath = tool_input.file_path as string;
        else if ('path' in tool_input) rawPath = tool_input.path as string;
      }

      // No path specified (Glob/Grep default to cwd) → allowed
      if (!rawPath) return { continue: true };

      // Resolve to absolute before checking
      const absPath = resolve(opts.cwd, rawPath);

      // Read check — allow if path is in allowRead OR allowWrite (writable implies readable)
      if (READ_TOOLS.has(tool_name)) {
        const canRead = isUnderAny(absPath, opts.allowReadPaths)
          || (opts.allowWritePaths && isUnderAny(absPath, opts.allowWritePaths));
        if (!canRead) {
          return deny(`Read denied: ${absPath} is outside allowed paths`);
        }
      }

      // Write check
      if (WRITE_TOOLS.has(tool_name)) {
        if (!opts.allowWritePaths || !isUnderAny(absPath, opts.allowWritePaths)) {
          return deny(`Write denied: ${absPath} is outside allowed paths`);
        }
        if (opts.denyWritePaths && isUnderAny(absPath, opts.denyWritePaths)) {
          return deny(`Write denied: ${absPath} is in a protected path`);
        }
      }

      return { continue: true };
    }],
  }];
}
