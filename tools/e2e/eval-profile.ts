/**
 * archie-e2e eval profile — a hermetic instance for behaviour evals.
 *
 * Used by `boot.ts --profile eval` and `teardown.ts --profile eval`.
 *
 * The default profile shares the main checkout's workdir, claude-data, secrets
 * and .env, Slack tokens included. That suits lifecycle checks against real
 * integrations, but an eval must start every run, on every ref, from the same
 * known state. An eval instance instead gets:
 *   - `eval-instance/` in this checkout, created fresh by boot and deleted by
 *     teardown: an empty `workdir/`, `claude-data/.claude.json` containing
 *     `{}`, and an empty `secrets/`;
 *   - ANTHROPIC_API_KEY and PORT, passed to compose through the process
 *     environment and never written to disk, so a failed boot or teardown
 *     leaves no key behind; every other setting is the engine default;
 *   - this checkout's `examples/plugins` mounted read-only as the plugins
 *     directory;
 *   - no host SSH agent;
 *   - its own compose project (`<checkout>-<path hash>-eval`), so it never
 *     replaces a default-profile instance, or the eval instance of another
 *     checkout with the same directory name.
 *
 * `docker-compose.eval.yml` does the mounting. Before compose up, boot resolves
 * the merged config with `docker compose config` and refuses to start when a
 * credential-like variable, or a mount outside this checkout or of its shared
 * workdir/claude-data/secrets, got through. The guarantee rests on what compose
 * will run, not on what the overlay intends.
 *
 * Pure cores (evalProjectName, resolveModelKey, needsOpenModes,
 * readEffectiveSettings, findIsolationViolations, renderEffectiveSettings) are
 * unit-tested; prepareEvalInstance is tested against a temporary directory.
 */

import { createHash } from 'crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { basename, isAbsolute, join, relative, resolve } from 'path';
import { parse as parseDotenv } from 'dotenv';
import type { EnvLike } from './config.js';
import type { ExecFn } from './exec.js';
import { choosePort, mainCheckoutFrom } from './prepare-worktree.js';

/** Instance state directory, relative to the checkout root. Gitignored and dockerignored. */
export const EVAL_DIR = 'eval-instance';
const EVAL_COMPOSE_FILE = 'tools/e2e/docker-compose.eval.yml';
const MODEL_KEY = 'ANTHROPIC_API_KEY';
/** The container's user (Dockerfile.dev `useradd -u 1001`); the entrypoint drops to it. */
const CONTAINER_UID = 1001;
/** Claude Code strips ANTHROPIC_API_KEY from subprocess environments, so sandboxes and CI pass it under this name. */
const MODEL_KEY_ENV = 'E2E_ANTHROPIC_API_KEY';

/**
 * The checkout's directory name, a hash of its real path, and `-eval`, normalised
 * the way compose requires (lowercase letters, digits, `_` and `-`, starting with
 * a letter or digit). The hash keeps `base/archie-hq` and `candidate/archie-hq`
 * apart, so a paired run's second `compose up` cannot replace the first instance;
 * the name keeps `docker ps` readable. Boot and teardown derive it the same way.
 */
export function evalProjectName(
  repoRoot: string,
  realpath: (path: string) => string = hostRealpath,
): string {
  // Both parts come from the real path, so any spelling of the checkout's path gives one name.
  const real = realpath(repoRoot);
  const base = basename(real)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[_-]+/, '');
  const pathHash = createHash('sha256').update(real).digest('hex').slice(0, 8);
  return `${base || 'archie'}-${pathHash}-eval`;
}

/** Global `docker compose` arguments that select the eval project and overlay; commands run from the repo root. */
export function evalComposeArgs(repoRoot: string): string[] {
  return ['-p', evalProjectName(repoRoot), '-f', 'docker-compose.yml', '-f', EVAL_COMPOSE_FILE];
}

/**
 * Extra `docker compose down` flags for the eval project. `--volumes` also removes the
 * container's anonymous `/app/node_modules` volume, which nothing reuses once the container is
 * gone; without it, every eval instance leaves one behind. The project declares no named volumes.
 */
export const EVAL_DOWN_FLAGS: readonly string[] = ['--volumes'];

// ---- Model key (pure) ----

export interface ModelKeySources {
  env: EnvLike;
  /** This checkout's own `.env`, when present. */
  checkoutDotenv?: string;
  /** The main checkout's `.env`, when this checkout is a worktree. */
  mainDotenv?: string;
}

export type ModelKeyResult =
  { ok: true; key: string; source: string } | { ok: false; error: string };

/**
 * Find the model key: `E2E_ANTHROPIC_API_KEY` in the environment, then
 * ANTHROPIC_API_KEY in this checkout's `.env`, then in the main checkout's.
 * Only that one value is read; nothing else in either file is used.
 */
export function resolveModelKey(sources: ModelKeySources): ModelKeyResult {
  const candidates: { source: string; value: string | undefined }[] = [
    { source: `${MODEL_KEY_ENV} environment variable`, value: sources.env[MODEL_KEY_ENV] },
    { source: 'this checkout’s .env', value: dotenvValue(sources.checkoutDotenv, MODEL_KEY) },
    { source: 'the main checkout’s .env', value: dotenvValue(sources.mainDotenv, MODEL_KEY) },
  ];
  const found = candidates.find((c) => c.value);
  if (!found?.value) {
    return {
      ok: false,
      error: `no ${MODEL_KEY} found — set ${MODEL_KEY_ENV}, or put ${MODEL_KEY} in this checkout's or the main checkout's .env`,
    };
  }
  // Whitespace or quotes mean a mangled copy; failing here beats an auth error after a long build.
  if (!/^[A-Za-z0-9._-]+$/.test(found.value)) {
    return {
      ok: false,
      error: `${MODEL_KEY} from ${found.source} has characters a model key never contains — refusing to use it`,
    };
  }
  return { ok: true, key: found.value, source: found.source };
}

function dotenvValue(text: string | undefined, name: string): string | undefined {
  if (text === undefined) return undefined;
  return parseDotenv(text)[name]?.trim() || undefined;
}

// ---- Host ownership (pure) ----

export interface HostIdentity {
  platform: NodeJS.Platform;
  /** Undefined where the platform has no uids (Windows). */
  uid?: number;
}

/**
 * Must the instance directories be opened up for the container's user? On native
 * Linux a bind mount keeps host ownership, so a directory the host user created
 * is read-only to uid 1001 unless the two match. Docker Desktop on macOS maps
 * ownership itself and needs nothing.
 */
export function needsOpenModes(host: HostIdentity): boolean {
  return host.platform === 'linux' && host.uid !== CONTAINER_UID;
}

// ---- Instance directory (disk) ----

export interface EvalPrepareInput {
  repoRoot: string;
  /** Main checkout path when `repoRoot` is a worktree; its `.env` is read for the model key only. */
  mainCheckout?: string;
  env: EnvLike;
  /** Defaults to this process's platform and uid. */
  host?: HostIdentity;
}

export type EvalPrepareResult =
  { ok: true; key: string; keySource: string } | { ok: false; error: string };

/**
 * Create `eval-instance/` from nothing and return the model key for the compose
 * environment. Writes only inside the directory, never the key, creates no
 * symlinks, and reads the main checkout's `.env` without changing anything
 * there. Refuses when the directory already exists: it may hold sessions from a
 * previous run, and deleting them is teardown's job, not boot's.
 */
export function prepareEvalInstance(input: EvalPrepareInput): EvalPrepareResult {
  const root = join(input.repoRoot, EVAL_DIR);
  if (pathExists(root)) {
    return {
      ok: false,
      error:
        `${EVAL_DIR}/ already exists — a previous eval instance was not torn down. ` +
        'Copy out anything you need, then run `npx tsx tools/e2e/teardown.ts --profile eval`, which deletes it.',
    };
  }

  const key = resolveModelKey({
    env: input.env,
    checkoutDotenv: readOptional(join(input.repoRoot, '.env')),
    mainDotenv: input.mainCheckout ? readOptional(join(input.mainCheckout, '.env')) : undefined,
  });
  if (!key.ok) return key;

  // Pre-create the plugins mountpoint: on Linux, Docker would otherwise create it as root,
  // and teardown could not delete it.
  mkdirSync(join(root, 'workdir', 'plugins'), { recursive: true });
  mkdirSync(join(root, 'claude-data'));
  mkdirSync(join(root, 'secrets'));
  writeFileSync(join(root, 'claude-data', '.claude.json'), '{}\n');

  const host = input.host ?? { platform: process.platform, uid: process.getuid?.() };
  if (needsOpenModes(host)) {
    // The container's user owns nothing here, so it writes through the "other" bits. Closing
    // eval-instance/ itself keeps other host users out: the container reaches the inner
    // directories through their bind mounts, never through this one.
    for (const dir of ['workdir', 'claude-data', 'secrets']) chmodSync(join(root, dir), 0o777);
    chmodSync(join(root, 'claude-data', '.claude.json'), 0o666);
    chmodSync(root, 0o700);
  }
  return { ok: true, key: key.key, keySource: key.source };
}

/** Delete `eval-instance/`. A symlink in its place is removed, never followed. */
export function removeEvalInstance(repoRoot: string): 'removed' | 'absent' {
  const root = join(repoRoot, EVAL_DIR);
  if (!pathExists(root)) return 'absent';
  rmSync(root, { recursive: true, force: true });
  return 'removed';
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
}

export interface EvalIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

export type EvalPrepareOutcome =
  | {
      code: 0;
      keySource: string;
      port: string;
      /** Variables boot adds to the compose environment: the model key, which is never on disk. */
      composeEnv: Record<string, string>;
    }
  | { code: 1 };

/** Boot step 0 for the eval profile: locate the main checkout, pick a port, create the instance directory. */
export async function runEvalPrepare(
  repoRoot: string,
  exec: ExecFn,
  env: EnvLike,
  io: EvalIo,
  host?: HostIdentity,
): Promise<EvalPrepareOutcome> {
  const commonDir = await exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (commonDir.code !== 0) {
    io.error(
      `git rev-parse --git-common-dir failed (exit ${commonDir.code}): ${commonDir.stderr.trim() || '(no stderr)'}`,
    );
    return { code: 1 };
  }
  const where = mainCheckoutFrom(commonDir.stdout, repoRoot);
  const port = String(await choosePort());

  const prepared = prepareEvalInstance({
    repoRoot,
    mainCheckout: where.kind === 'worktree' ? where.main : undefined,
    env,
    host,
  });
  if (!prepared.ok) {
    io.error(`Cannot prepare the eval instance: ${prepared.error}`);
    return { code: 1 };
  }
  io.log(
    `Created ${EVAL_DIR}/ (fresh workdir, empty claude-data and secrets); ${MODEL_KEY} and PORT=${port} go to compose through the environment.`,
  );
  return {
    code: 0,
    keySource: prepared.keySource,
    port,
    composeEnv: { [MODEL_KEY]: prepared.key },
  };
}

// ---- Resolved compose config (pure) ----

export interface Mount {
  source: string;
  target: string;
  readOnly: boolean;
}

export interface EffectiveSettings {
  project: string;
  port?: string;
  /** Variable names only; values are never kept. */
  envKeys: string[];
  /** Bind mounts; named and anonymous volumes hold no host data and are left out. */
  mounts: Mount[];
}

/** Extract the archie service's settings from `docker compose config --format json`. */
export function readEffectiveSettings(
  configJson: string,
): { ok: true; settings: EffectiveSettings } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch (err) {
    return {
      ok: false,
      error: `docker compose config output is not JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const config = asRecord(parsed);
  const service = asRecord(asRecord(config?.['services'])?.['archie']);
  if (!config || !service) {
    return { ok: false, error: 'docker compose config output has no archie service' };
  }

  const environment = asRecord(service['environment']) ?? {};
  const mounts: Mount[] = [];
  for (const entry of asArray(service['volumes'])) {
    const volume = asRecord(entry);
    if (volume?.['type'] !== 'bind') continue;
    mounts.push({
      source: String(volume['source']),
      target: String(volume['target']),
      readOnly: volume['read_only'] === true,
    });
  }
  const firstPort = asRecord(asArray(service['ports'])[0]);
  const published = firstPort?.['published'];

  return {
    ok: true,
    settings: {
      project: typeof config['name'] === 'string' ? config['name'] : '(unknown)',
      port: published === undefined ? undefined : String(published),
      envKeys: Object.keys(environment).sort(),
      mounts,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** Does this variable name look like it carries a credential? Slack and GitHub settings always count. */
export function isCredentialName(name: string): boolean {
  return (
    /^(SLACK|GITHUB|GH)_/i.test(name) ||
    /(^|_)(TOKEN|SECRET|PASSWORD|KEY|CREDENTIALS?)(_|$)/i.test(name)
  );
}

/** Checkout paths that the default profile shares with the main checkout. */
const SHARED_STATE = ['workdir', 'claude-data', 'secrets', '.env'];

/**
 * Why the resolved config is not hermetic; empty when it is. `realpath` resolves
 * symlinks on the host (a worktree's `workdir` may link to the main checkout's).
 */
export function findIsolationViolations(
  settings: EffectiveSettings,
  repoRoot: string,
  realpath: (path: string) => string,
): string[] {
  const violations: string[] = [];
  for (const key of settings.envKeys) {
    if (key !== MODEL_KEY && isCredentialName(key)) {
      violations.push(`the container environment carries ${key}`);
    }
  }

  const root = realpath(repoRoot);
  for (const mount of settings.mounts) {
    const source = realpath(mount.source);
    const inside = relative(root, source);
    if (inside.startsWith('..') || isAbsolute(inside)) {
      violations.push(
        `${mount.source} -> ${mount.target} mounts a host path outside this checkout (resolves to ${source})`,
      );
    } else if (inside === '') {
      violations.push(`${mount.source} -> ${mount.target} mounts the whole checkout`);
    } else if (
      SHARED_STATE.some((shared) => inside === shared || inside.startsWith(`${shared}/`))
    ) {
      violations.push(
        `${mount.source} -> ${mount.target} mounts the checkout's shared ${inside.split('/')[0]}`,
      );
    }
  }
  return violations;
}

/** The boot output's statement of what the instance runs with. Variable values are never printed. */
export function renderEffectiveSettings(
  settings: EffectiveSettings,
  repoRoot: string,
  keySource: string | undefined,
): string[] {
  const shown = (path: string) => {
    const inside = relative(repoRoot, path);
    return inside.startsWith('..') || isAbsolute(inside) ? path : inside;
  };
  const credentials = settings.envKeys.filter(isCredentialName);
  const slackOrGithub = credentials.filter((k) => /^(SLACK|GITHUB|GH)_/i.test(k));
  const plugins = settings.mounts.find((m) => m.target === '/workdir/plugins');
  const workdir = settings.mounts.find((m) => m.target === '/workdir');
  const sshAgent = settings.mounts.some((m) => m.source.includes('ssh-auth.sock'));

  const credentialList = credentials.map((k) =>
    k === MODEL_KEY && keySource ? `${k} (from ${keySource})` : k,
  );
  return [
    'Eval profile — effective settings (resolved by `docker compose config`):',
    `  compose project:          ${settings.project}`,
    `  port:                     ${settings.port ?? '(none published)'}`,
    `  credentials (names only): ${credentialList.join(', ') || '(none)'}`,
    `  Slack/GitHub credentials: ${slackOrGithub.join(', ') || 'none'}`,
    `  host SSH agent:           ${sshAgent ? 'mounted' : 'not mounted'}`,
    `  plugins:                  ${plugins ? `${shown(plugins.source)} -> ${plugins.target}${plugins.readOnly ? ' (read-only)' : ''}` : '(not mounted)'}`,
    `  workdir:                  ${workdir ? `${shown(workdir.source)} -> ${workdir.target}` : '(not mounted)'}`,
    `  environment:              ${settings.envKeys.join(', ')}`,
  ];
}

/** Host-side realpath that tolerates sources compose would create on first mount. */
export function hostRealpath(path: string): string {
  return existsSync(path) ? realpathSync.native(path) : resolve(path);
}

/**
 * Boot step before compose up: resolve the merged config, print the effective
 * settings and refuse to start a non-hermetic instance. `exec` must carry the
 * compose environment (PORT, GIT_SHA, the model key) the boot will use.
 */
export async function checkEvalCompose(
  exec: ExecFn,
  repoRoot: string,
  keySource: string | undefined,
  io: EvalIo,
): Promise<number> {
  const config = await exec('docker', [
    'compose',
    ...evalComposeArgs(repoRoot),
    'config',
    '--format',
    'json',
  ]);
  if (config.code !== 0) {
    io.error(`docker compose config failed (exit ${config.code}): ${config.stderr.trim()}`);
    return 1;
  }
  const read = readEffectiveSettings(config.stdout);
  if (!read.ok) {
    io.error(read.error);
    return 1;
  }
  for (const line of renderEffectiveSettings(read.settings, repoRoot, keySource)) io.log(line);

  const violations = findIsolationViolations(read.settings, repoRoot, hostRealpath);
  if (violations.length > 0) {
    io.error('Refusing to boot: the eval instance would not be hermetic —');
    for (const v of violations) io.error(`  - ${v}`);
    return 1;
  }
  return 0;
}
