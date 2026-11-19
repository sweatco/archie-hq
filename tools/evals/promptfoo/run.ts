/**
 * Run `promptfoo eval` with everything it writes kept in a private directory
 * outside the repository:
 *
 *   npx tsx tools/evals/promptfoo/run.ts --data-dir <private-dir> <config.yaml> [-- <eval options>]
 *
 * Results, the results database, cache and logs go under <private-dir>.
 * Telemetry, update checks and sharing are off, and outbound HTTP from
 * promptfoo is sent to a closed local port: with telemetry disabled promptfoo
 * 0.125.1 still posts a "telemetry disabled" event, and the replay provider
 * needs no network. After the run, any file created or changed under the
 * repository fails it.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { lstat, mkdir, readdir, realpath } from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

const USAGE =
  'Usage: npx tsx tools/evals/promptfoo/run.ts --data-dir <private-dir> <config.yaml> [-- <promptfoo eval options>]';

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(PACKAGE_DIR, '..', '..', '..');
const PROMPTFOO_BIN = join(PACKAGE_DIR, 'node_modules', '.bin', 'promptfoo');

/** Nothing listens here, so a proxied request fails at once. */
const CLOSED_PROXY = 'http://127.0.0.1:9';

/** Exit code when the run wrote inside the repository. */
const EXIT_REPO_WRITE = 3;

/**
 * Kernels stamp files from a coarse clock that can trail Date.now() by a few
 * milliseconds, so the scan starts a little before the run to keep an early
 * write from being missed.
 */
const CLOCK_SLACK_MS = 100;

interface Invocation {
  dataDir: string;
  configPath: string;
  evalArgs: string[];
}

export function parseInvocation(argv: string[]): Invocation {
  const separator = argv.indexOf('--');
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const evalArgs = separator === -1 ? [] : argv.slice(separator + 1);

  const { values, positionals } = parseArgs({
    args: own,
    allowPositionals: true,
    options: { 'data-dir': { type: 'string' } },
  });
  const dataDir = values['data-dir'];
  if (!dataDir) throw new Error('--data-dir is required');
  const [configPath, ...extra] = positionals;
  if (!configPath || extra.length > 0) throw new Error('expected exactly one config file');
  if (evalArgs.some((arg) => arg === '--share' || arg.startsWith('--share='))) {
    throw new Error('sharing is not allowed');
  }
  return { dataDir: resolve(dataDir), configPath: resolve(configPath), evalArgs };
}

/** Environment that keeps promptfoo's state in `dataDir` and its traffic local. */
export function buildPromptfooEnv(
  base: NodeJS.ProcessEnv,
  dataDir: string,
): Record<string, string | undefined> {
  const promptfooDir = join(dataDir, 'promptfoo');
  return {
    ...base,
    PROMPTFOO_CONFIG_DIR: promptfooDir,
    PROMPTFOO_CACHE_PATH: join(promptfooDir, 'cache'),
    PROMPTFOO_LOG_DIR: join(promptfooDir, 'logs'),
    PROMPTFOO_DISABLE_TELEMETRY: '1',
    PROMPTFOO_DISABLE_UPDATE: '1',
    PROMPTFOO_DISABLE_SHARING: '1',
    HTTP_PROXY: CLOSED_PROXY,
    HTTPS_PROXY: CLOSED_PROXY,
    ALL_PROXY: CLOSED_PROXY,
    http_proxy: CLOSED_PROXY,
    https_proxy: CLOSED_PROXY,
    all_proxy: CLOSED_PROXY,
    NO_PROXY: '',
    no_proxy: '',
  };
}

export function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/**
 * Files under `root` (outside .git) created, modified or re-stamped at or
 * after `sinceMs`. It compares ctime, which every content or metadata change
 * sets to now and `utimes` cannot move back: mtime can be backdated, and so
 * can birth time on macOS, which follows a backdated mtime.
 */
export async function findFilesWrittenSince(root: string, sinceMs: number): Promise<string[]> {
  const written: string[] = [];
  const pending = [root];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.git') pending.push(path);
        continue;
      }
      const { ctimeMs } = await lstat(path);
      if (ctimeMs >= sinceMs) written.push(relative(root, path));
    }
  }
  return written.sort();
}

async function main(): Promise<number> {
  let invocation: Invocation;
  try {
    invocation = parseInvocation(process.argv.slice(2));
  } catch (error) {
    console.error(`run: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  const { dataDir, configPath, evalArgs } = invocation;

  if (!existsSync(PROMPTFOO_BIN)) {
    console.error('run: promptfoo is not installed; run `npm ci --prefix tools/evals/promptfoo`');
    return 2;
  }
  const repoRoot = await realpath(REPO_ROOT);
  // Checked before creating the directory, then again once symlinks can be resolved.
  const outside = `run: --data-dir must be outside the repository (${repoRoot})`;
  if (isInside(repoRoot, dataDir)) {
    console.error(outside);
    return 2;
  }
  await mkdir(dataDir, { recursive: true });
  if (isInside(repoRoot, await realpath(dataDir))) {
    console.error(outside);
    return 2;
  }

  const startedMs = Date.now();
  const stamp = new Date(startedMs).toISOString().replace(/[:.]/g, '-');
  const resultsPath = join(dataDir, `results-${stamp}.json`);
  const exitCode = await runPromptfoo(
    [
      'eval',
      '--config',
      configPath,
      '--output',
      resultsPath,
      '--no-share',
      '--no-progress-bar',
      ...evalArgs,
    ],
    { cwd: dirname(configPath), env: buildPromptfooEnv(process.env, dataDir) },
  );

  const written = await findFilesWrittenSince(repoRoot, startedMs - CLOCK_SLACK_MS);
  if (written.length > 0) {
    console.error('run: FAIL — the run wrote inside the repository:');
    for (const path of written) console.error(`  ${path}`);
    return EXIT_REPO_WRITE;
  }
  console.error(`run: results in ${resultsPath}; nothing written inside the repository`);
  return exitCode;
}

/** Paths in a config resolve against its directory, so promptfoo runs from there. */
function runPromptfoo(
  args: string[],
  options: { cwd: string; env: Record<string, string | undefined> },
): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(PROMPTFOO_BIN, args, { ...options, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => resolveExit(code ?? 1));
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`run: ERROR — ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
