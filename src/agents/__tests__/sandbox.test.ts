/**
 * Sandbox config + policy-tier tests.
 *
 * These pin the SHAPE of what we hand the SDK. They cannot prove the CLI
 * actually enforces it — that regressed once with the config unchanged (CLI
 * 2.1.156 → 2.1.157) and no unit test could have caught it. The live boundary
 * assertion lives in tools/e2e/egress-check.ts; this file guards the wiring
 * those live checks depend on.
 */

import { afterEach, describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSandboxConfig,
  buildManagedNetworkPolicy,
  buildPackageManagerCacheEnv,
  buildRepoGrants,
  createFilesystemGuardHooks,
  createPmOnlyToolGuardHooks,
  PM_ONLY_MCP_SERVERS,
  TRUSTED_PACKAGE_REGISTRY_DOMAINS,
  type SandboxOptions,
} from '../sandbox.js';
import { CACHES_DIR, REPOS_DIR } from '../../system/workdir.js';
import { getReposPath } from '../../tasks/persistence.js';

const base: SandboxOptions = {
  cwd: '/workdir/sessions/task-1/workspace',
  allowReadPaths: ['/workdir/sessions/task-1/workspace'],
  allowWritePaths: ['/workdir/sessions/task-1/workspace'],
};

describe('buildManagedNetworkPolicy', () => {
  it('denies all egress when no domains are allowed', () => {
    expect(buildManagedNetworkPolicy(base).sandbox.network.allowedDomains).toEqual([]);
  });

  it('carries the allowlist it was given', () => {
    const policy = buildManagedNetworkPolicy({
      ...base,
      allowedNetworkDomains: [...TRUSTED_PACKAGE_REGISTRY_DOMAINS],
    });
    expect(policy.sandbox.network.allowedDomains).toEqual([
      'registry.npmjs.org',
      'registry.yarnpkg.com',
    ]);
  });

  it('always sets allowManagedDomainsOnly — the allowlist is not enforced without it', () => {
    // Verified empirically: with this flag absent the policy tier has no effect
    // and Bash reaches any host, even under an explicit allowlist.
    expect(buildManagedNetworkPolicy(base).sandbox.network.allowManagedDomainsOnly).toBe(true);
    expect(
      buildManagedNetworkPolicy({ ...base, allowedNetworkDomains: ['example.invalid'] }).sandbox
        .network.allowManagedDomainsOnly,
    ).toBe(true);
  });

  it('agrees with buildSandboxConfig on the domain list, so the two tiers cannot drift', () => {
    const opts: SandboxOptions = { ...base, allowedNetworkDomains: ['sheets.googleapis.com'] };
    expect(buildManagedNetworkPolicy(opts).sandbox.network.allowedDomains).toEqual(
      buildSandboxConfig(opts).network.allowedDomains,
    );
  });
});

describe('filesystem guard symlinks', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'archie-guard-'));
    directories.push(root);
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(join(outside, 'secret'), 'private');
    const opts: SandboxOptions = {
      cwd: workspace,
      allowReadPaths: [workspace],
      allowWritePaths: [workspace],
      denyWritePaths: [join(workspace, 'protected')],
    };
    const check = async (tool_name: string, file_path: string) => {
      const hook = createFilesystemGuardHooks(opts)[0].hooks[0];
      const result = await hook({
        hook_event_name: 'PreToolUse',
        session_id: 'test',
        cwd: workspace,
        transcript_path: '',
        tool_use_id: 'test',
        tool_name,
        tool_input: { file_path },
      }, undefined, { signal: new AbortController().signal });
      return 'hookSpecificOutput' in result ? result.hookSpecificOutput : undefined;
    };
    return { workspace, outside, opts, check };
  }

  it('denies reads, writes and new files through escaping and dangling symlinks', async () => {
    const { workspace, outside, check } = await fixture();
    await symlink(outside, join(workspace, 'escape'));
    await symlink(join(outside, 'missing'), join(workspace, 'dangling'));
    for (const [tool, path] of [['Read', 'escape/secret'], ['Write', 'escape/new/file'], ['Write', 'dangling'], ['Grep', 'escape']]) {
      expect(await check(tool, path)).toMatchObject({ permissionDecision: 'deny' });
    }
  });

  it('denies aliases to protected files and resolves .. after symlinks', async () => {
    const { workspace, outside, check } = await fixture();
    await writeFile(join(workspace, 'protected'), 'settings');
    await symlink('protected', join(workspace, 'alias'));
    await mkdir(join(outside, 'child'));
    await symlink(join(outside, 'child'), join(workspace, 'escape'));
    expect(await check('Write', 'alias')).toMatchObject({ permissionDecision: 'deny' });
    expect(await check('Read', 'escape/../secret')).toMatchObject({ permissionDecision: 'deny' });
  });

  it('allows declared skill symlinks and new files in writable directories', async () => {
    const { workspace, outside, opts, check } = await fixture();
    opts.allowReadPaths.push(outside);
    await symlink(outside, join(workspace, 'skill'));
    expect(await check('Read', 'skill/secret')).toBeUndefined();
    expect(await check('Write', 'new/directory/file')).toBeUndefined();
    expect(await check('Write', 'skill/new')).toMatchObject({ permissionDecision: 'deny' });
  });
});

describe('buildPackageManagerCacheEnv', () => {
  it('moves npm and yarn caches off the read-only $HOME', () => {
    const env = buildPackageManagerCacheEnv();
    expect(env.npm_config_cache).toBe(`${CACHES_DIR}/npm`);
    expect(env.YARN_CACHE_FOLDER).toBe(`${CACHES_DIR}/yarn`);
  });

  it('redirects yarn 4 global folder and Corepack home, not just the cache', () => {
    // Yarn Berry creates $HOME/.yarn at startup before touching the project, so a
    // redirected cache alone leaves it dying on ENOENT (observed with the mobile
    // repo's pinned yarn 4.12.0). Corepack fetches pinned releases into
    // COREPACK_HOME, which is unwritable for the same reason.
    const env = buildPackageManagerCacheEnv();
    expect(env.YARN_GLOBAL_FOLDER).toBe(`${CACHES_DIR}/yarn-global`);
    expect(env.COREPACK_HOME).toBe(`${CACHES_DIR}/corepack`);
  });

  it('shares one cache across agents and tasks rather than scoping it per workspace', () => {
    // The regression this guards: caches used to live at
    // `<task>/agents/<agent>/.cache`, so every task re-downloaded the same bytes
    // and kept them forever — 697 per-task caches, ~285 GB, never reclaimed. The
    // paths are constants now precisely so no caller can reintroduce that.
    const env = buildPackageManagerCacheEnv();
    expect(env).toEqual(buildPackageManagerCacheEnv());
    for (const value of Object.values(env)) {
      expect(value.startsWith(`${CACHES_DIR}/`)).toBe(true);
      expect(value).not.toContain('/sessions/');
    }
  });

  it('takes no arguments, so a cache cannot be scoped to a caller-supplied path', () => {
    expect(buildPackageManagerCacheEnv.length).toBe(0);
  });
});

describe('buildSandboxConfig', () => {
  it('fails closed when the sandbox is unavailable instead of running unsandboxed', () => {
    expect(buildSandboxConfig(base).failIfUnavailable).toBe(true);
  });

  it('keeps the sandbox enabled and refuses unsandboxed escapes', () => {
    const cfg = buildSandboxConfig(base);
    expect(cfg.enabled).toBe(true);
    expect(cfg.allowUnsandboxedCommands).toBe(false);
  });

  it('defaults to network deny-all', () => {
    expect(buildSandboxConfig(base).network.allowedDomains).toEqual([]);
  });
});

describe('buildRepoGrants', () => {
  const TASK = 'task-20260910-1200-abc123';
  const taskRepos = getReposPath(TASK);

  it('grants the task repos DIRECTORY, not the clones that exist right now', () => {
    // The regression: the grants used to be enumerated from
    // `metadata.repositories`, which is empty at spawn because nothing is cloned
    // until the PM calls `mount_repo`. The sandbox is frozen at spawn, so the
    // first mount landed somewhere the session could not read and the PM had to
    // be respawned to open the file it had just cloned. A directory grant is
    // what makes a mid-session mount reachable.
    for (const editAllowed of [false, true]) {
      expect(buildRepoGrants(TASK, editAllowed).read).toContain(taskRepos);
    }
  });

  it('makes the task clones writable exactly when edit mode is approved', () => {
    expect(buildRepoGrants(TASK, false).write).toEqual([]);
    expect(buildRepoGrants(TASK, false).denyWrite).toContain(taskRepos);

    expect(buildRepoGrants(TASK, true).write).toContain(taskRepos);
    expect(buildRepoGrants(TASK, true).denyWrite).not.toContain(taskRepos);
  });

  it('keeps the base clone cache readable and unwritable in BOTH modes', () => {
    // Readable because task clones are `git clone --shared` and borrow its
    // objects for their whole life; never writable because one task rewriting a
    // base clone corrupts every other task sharing it.
    for (const editAllowed of [false, true]) {
      const grants = buildRepoGrants(TASK, editAllowed);
      expect(grants.read).toContain(REPOS_DIR);
      expect(grants.write).not.toContain(REPOS_DIR);
      expect(grants.denyWrite).toContain(REPOS_DIR);
    }
  });

  it('scopes the writable grant to this task — another task\'s clones are not under it', () => {
    const other = getReposPath('task-20260910-1200-other0');
    expect(buildRepoGrants(TASK, true).write).not.toContain(other);
    expect(other.startsWith(taskRepos)).toBe(false);
  });
});

describe('createPmOnlyToolGuardHooks', () => {
  const hook = createPmOnlyToolGuardHooks()[0].hooks[0];
  // The SDK's HookJSONOutput union has no `hookSpecificOutput` on its async
  // arm, so narrow to the deny shape the filesystem guard already returns.
  const call = (tool_name: string, agent_id?: string) =>
    hook({ tool_name, tool_input: {}, ...(agent_id ? { agent_id } : {}) } as never, undefined, {
      signal: new AbortController().signal,
    }) as Promise<{
      continue?: boolean;
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    }>;

  it('denies every PM-only server when the call comes from a subagent', async () => {
    // The live regression: a general-purpose worker called post_to_user and
    // messaged the user directly, bypassing the PM. `agent_id` is the SDK's
    // only reliable subagent marker (agent_type also fires on --agent main
    // threads).
    for (const tool of [
      'mcp__comms-tools__post_to_user',
      'mcp__orchestration-tools__report_completion',
      'mcp__scheduling-tools__set_reminder',
    ]) {
      const out = await call(tool, 'agent_abc');
      expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('PM-only tool');
    }
  });

  it('leaves a subagent its investigation tools', async () => {
    // Workers exist to read code and research. Denying repo-tools here would
    // make the guard useless in exchange for the invariant it protects.
    for (const tool of [
      'mcp__repo-tools__mount_repo',
      'mcp__research-tools__web_research',
      'mcp__file-bridge__send_file',
      'mcp__notion__search',
      'Read',
    ]) {
      expect(await call(tool, 'agent_abc')).toEqual({ continue: true });
    }
  });

  it('never fires on the main thread, where these tools are the PM\'s own', async () => {
    for (const server of PM_ONLY_MCP_SERVERS) {
      expect(await call(`mcp__${server}__anything`)).toEqual({ continue: true });
    }
  });
});
