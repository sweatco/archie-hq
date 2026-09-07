import { dirname, isAbsolute, resolve, normalize } from 'path';
import { lstat, readlink } from 'node:fs/promises';
import type { HookCallbackMatcher, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { CACHES_DIR } from '../system/workdir.js';

export interface SandboxOptions {
  cwd: string;
  allowReadPaths: string[];
  allowWritePaths?: string[];
  denyWritePaths?: string[];
  denyReadPaths?: string[];
  allowedNetworkDomains?: string[];
}

export const TRUSTED_PACKAGE_REGISTRY_DOMAINS = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
];

export function buildSandboxConfig(opts: SandboxOptions) {
  return {
    enabled: true,
    // The SDK otherwise falls back to unsandboxed execution.
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    filesystem: {
      // Callers deny WORKDIR broadly, then allowRead/allowWrite specific subdirs.
      denyRead: ['/app', '/home/archie/.claude', ...(opts.denyReadPaths || [])],
      allowRead: ['/home/archie/.claude/shell-snapshots', ...new Set(opts.allowReadPaths)],
      allowWrite: ['/tmp', ...(opts.allowWritePaths || [])],
      ...(opts.denyWritePaths && opts.denyWritePaths.length > 0
        ? { denyWrite: opts.denyWritePaths }
        : {}),
    },
    network: {
      allowedDomains: opts.allowedNetworkDomains ?? [],
    },
  };
}

// bypassPermissions ignores the sandbox allowlist unless managed policy enforces it.
export function buildManagedNetworkPolicy(opts: SandboxOptions) {
  return {
    sandbox: {
      network: {
        allowedDomains: opts.allowedNetworkDomains ?? [],
        allowManagedDomainsOnly: true,
      },
    },
  };
}

export function buildPackageManagerCacheEnv(): Record<string, string> {
  return {
    npm_config_cache: resolve(CACHES_DIR, 'npm'),
    YARN_CACHE_FOLDER: resolve(CACHES_DIR, 'yarn'),
    YARN_GLOBAL_FOLDER: resolve(CACHES_DIR, 'yarn-global'),
    COREPACK_HOME: resolve(CACHES_DIR, 'corepack'),
  };
}

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const WRITE_TOOLS = new Set(['Write', 'Edit']);

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

async function resolveGuardPath(path: string): Promise<string> {
  const parts = path.split('/');
  let current = '/';
  let links = 0;
  while (parts.length > 0) {
    const part = parts.shift()!;
    if (!part || part === '.') continue;
    if (part === '..') {
      current = dirname(current);
      continue;
    }
    const next = resolve(current, part);
    const entry = await lstat(next).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (entry?.isSymbolicLink()) {
      if (++links > 40) throw new Error('Too many symbolic links');
      const target = await readlink(next);
      if (isAbsolute(target)) current = '/';
      parts.unshift(...target.split('/'));
    } else {
      current = next;
    }
  }
  return current;
}

export function createFilesystemGuardHooks(opts: SandboxOptions): HookCallbackMatcher[] {
  let roots: Promise<{ read: string[]; write: string[]; protected: string[] }> | undefined;
  return [{
    hooks: [async (input: any) => {
      const { tool_name, tool_input } = input;
      if (!READ_TOOLS.has(tool_name) && !WRITE_TOOLS.has(tool_name)) {
        return { continue: true };
      }
      const rawPath = tool_input?.file_path ?? tool_input?.path ?? '.';
      if (typeof rawPath !== 'string' || rawPath.includes('\0')) return deny('Invalid filesystem path');
      try {
        roots ??= Promise.all([
          Promise.all([...opts.allowReadPaths, ...(opts.allowWritePaths ?? [])].map(resolveGuardPath)),
          Promise.all((opts.allowWritePaths ?? []).map(resolveGuardPath)),
          Promise.all((opts.denyWritePaths ?? []).map(resolveGuardPath)),
        ]).then(([read, write, protectedPaths]) => ({ read, write, protected: protectedPaths }));
        const allowed = await roots;
        // Keep .. until after symlink resolution, and resolve missing write targets too.
        const path = await resolveGuardPath(isAbsolute(rawPath) ? rawPath : `${opts.cwd}/${rawPath}`);
        if (READ_TOOLS.has(tool_name)) {
          if (!isUnderAny(path, allowed.read)) return deny(`Read denied: ${path} is outside allowed paths`);
        } else {
          if (!isUnderAny(path, allowed.write)) return deny(`Write denied: ${path} is outside allowed paths`);
          if (isUnderAny(path, allowed.protected) || isUnderAny(resolve(opts.cwd, rawPath), opts.denyWritePaths ?? [])) {
            return deny(`Write denied: ${path} is in a protected path`);
          }
        }
      } catch {
        return deny('Cannot safely resolve filesystem path');
      }
      return { continue: true };
    }],
  }];
}
