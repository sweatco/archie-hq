/**
 * archie-e2e boot — start a live Archie instance from the current checkout and wait for health.
 *
 * Usage: npx tsx tools/e2e/boot.ts [--timeout-seconds N]
 *
 * Strict fail-fast sequence (each step gates the next):
 *   1. Preflight: .env exists at the repo root and ANTHROPIC_API_KEY is non-empty.
 *      Failure exits non-zero naming the missing item — no compose invocation at all.
 *   2. `docker compose up --build -d` with the exit code trapped: a non-zero exit
 *      prints diagnostics (compose ps + 100-line log tail) and exits non-zero
 *      BEFORE a single /health poll.
 *   3. Bounded /health poll every 5s (default cap 600s, override --timeout-seconds
 *      or E2E_BOOT_TIMEOUT_SECONDS), failing fast if the archie container exits
 *      or restart-loops instead of waiting out the cap.
 *
 * Pure cores (preflight, waitForHealth, archieContainerState, renderDiagnostics,
 * runBoot) take injected deps and are unit-tested with fakes; main wires real ones.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { resolveBaseUrl, resolveTimeoutSeconds } from './config.js';
import { makeExec, type ExecFn } from './exec.js';

export const DEFAULT_BOOT_TIMEOUT_SECONDS = 600;
const DEFAULT_POLL_INTERVAL_MS = 5000;

// ---- Preflight (pure) ----

/** Validate boot preconditions from already-read inputs. Returns human-readable errors, empty when OK. */
export function preflight(dotenvText: string | undefined): string[] {
  if (dotenvText === undefined) {
    return ['.env not found at the repo root — copy .env.example and set ANTHROPIC_API_KEY'];
  }
  const m = dotenvText.match(/^\s*ANTHROPIC_API_KEY\s*=\s*["']?([^\s"'#]+)/m);
  if (!m) {
    return ['ANTHROPIC_API_KEY is missing or empty in .env'];
  }
  return [];
}

// ---- Container state (pure) ----

/** Container states that mean the archie service will never serve /health without intervention. */
const FAILED_STATES = new Set(['exited', 'dead', 'restarting']);

export interface ArchieContainerState {
  found: boolean;
  state?: string;
}

/**
 * Extract the `archie` service state from `docker compose ps --format json` output.
 * Tolerates both the array shape and NDJSON (one object per line); unparseable
 * output reads as "not found" — boot treats that as best-effort, not fatal parse errors.
 * (teardown.ts owns the strict full-list parser; this is a boot-local minimal probe.)
 */
export function archieContainerState(psOutput: string): ArchieContainerState {
  const trimmed = psOutput.trim();
  if (!trimmed) return { found: false };

  const entries: unknown[] = [];
  if (trimmed.startsWith('[')) {
    try {
      const arr: unknown = JSON.parse(trimmed);
      if (Array.isArray(arr)) entries.push(...(arr as unknown[]));
    } catch {
      return { found: false };
    }
  } else {
    for (const line of trimmed.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip unparseable lines — best-effort probe
      }
    }
  }

  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const o = entry as Record<string, unknown>;
    const service = typeof o['Service'] === 'string' ? o['Service'] : undefined;
    const name = typeof o['Name'] === 'string' ? o['Name'] : undefined;
    if (service === 'archie' || (service === undefined && name?.includes('archie'))) {
      const state = typeof o['State'] === 'string' ? o['State'].toLowerCase() : undefined;
      return { found: true, state };
    }
  }
  return { found: false };
}

// ---- Health wait (pure core, injected deps) ----

export interface HealthProbe {
  status: number;
  body: string;
}

export interface WaitDeps {
  /** Probe GET /health. May reject on network errors — treated as not-ready. */
  fetchHealth: () => Promise<HealthProbe>;
  /** Raw `docker compose ps --format json` output. May reject — the check is skipped that tick. */
  readPs: () => Promise<string>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface WaitOpts {
  timeoutSeconds?: number;
  pollIntervalMs?: number;
}

export type WaitOutcome =
  | { kind: 'healthy'; body: string }
  | { kind: 'container_exited'; detail: string }
  | { kind: 'timeout'; detail: string };

/** Poll /health until 200, failing fast on a dead/looping archie container, giving up at the cap. */
export async function waitForHealth(deps: WaitDeps, opts: WaitOpts = {}): Promise<WaitOutcome> {
  const timeoutSeconds = opts.timeoutSeconds ?? DEFAULT_BOOT_TIMEOUT_SECONDS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = deps.now() + timeoutSeconds * 1000;
  let lastDetail = 'no /health response yet';

  for (;;) {
    try {
      const probe = await deps.fetchHealth();
      if (probe.status === 200) return { kind: 'healthy', body: probe.body };
      lastDetail = `GET /health -> ${probe.status}${probe.body ? ` ${probe.body}` : ''}`;
    } catch (err) {
      lastDetail = `GET /health failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    let psOutput: string | undefined;
    try {
      psOutput = await deps.readPs();
    } catch {
      // ps itself failed — skip the container check this tick rather than misreport
    }
    if (psOutput !== undefined) {
      const archie = archieContainerState(psOutput);
      if (!archie.found) {
        return { kind: 'container_exited', detail: 'archie container not present in `docker compose ps` output' };
      }
      if (archie.state && FAILED_STATES.has(archie.state)) {
        return { kind: 'container_exited', detail: `archie container state is "${archie.state}"` };
      }
    }

    if (deps.now() >= deadline) {
      return { kind: 'timeout', detail: `/health did not return 200 within ${timeoutSeconds}s (last: ${lastDetail})` };
    }
    await deps.sleep(pollIntervalMs);
  }
}

// ---- Diagnostics (pure) ----

/** Render the failure diagnostics block from injected strings (compose ps table + log tail). */
export function renderDiagnostics(psOutput: string, logTail: string): string {
  return [
    '--- diagnostics: docker compose ps ---',
    psOutput.trim() || '(no output)',
    '--- diagnostics: archie logs (last 100 lines) ---',
    logTail.trim() || '(no output)',
    '--- end diagnostics ---',
  ].join('\n');
}

// ---- Orchestration (pure core over injected deps) ----

export interface BootDeps {
  /** Quiet exec for compose ps / logs (diagnostics, health-poll container checks). */
  exec: ExecFn;
  /** Exec for the long-running `compose up --build -d` (main passes an echoing variant). Defaults to `exec`. */
  execBuild?: ExecFn;
  fetchHealth: () => Promise<HealthProbe>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  error: (line: string) => void;
}

export interface BootOpts {
  baseUrl: string;
  timeoutSeconds: number;
  pollIntervalMs?: number;
}

async function collectDiagnostics(exec: ExecFn): Promise<string> {
  const ps = await exec('docker', ['compose', 'ps']);
  const logs = await exec('docker', ['compose', 'logs', '--no-color', '--tail=100', 'archie']);
  return renderDiagnostics(ps.stdout || ps.stderr, logs.stdout || logs.stderr);
}

/**
 * Compose-up with the exit code trapped, then (and only then) the bounded health poll.
 * A failed compose-up returns before a single /health fetch. Returns the process exit code.
 */
export async function runBoot(deps: BootDeps, opts: BootOpts): Promise<number> {
  const execBuild = deps.execBuild ?? deps.exec;

  deps.log(`Booting archie via \`docker compose up --build -d\` (target ${opts.baseUrl}) ...`);
  const up = await execBuild('docker', ['compose', 'up', '--build', '-d']);
  if (up.code !== 0) {
    deps.error(`docker compose up --build -d failed with exit code ${up.code}`);
    if (up.stderr.trim()) deps.error(up.stderr.trim());
    deps.error(await collectDiagnostics(deps.exec));
    return 1;
  }

  deps.log(`Compose up succeeded — polling ${opts.baseUrl}/health (cap ${opts.timeoutSeconds}s) ...`);
  const outcome = await waitForHealth(
    {
      fetchHealth: deps.fetchHealth,
      readPs: async () => {
        // The exec wrapper never rejects, so a failed ps must be surfaced as a rejection here:
        // waitForHealth then skips the container check that tick instead of misreading empty
        // stdout as "archie container gone" and aborting a boot that was about to succeed.
        const ps = await deps.exec('docker', ['compose', 'ps', '--format', 'json']);
        if (ps.code !== 0) {
          throw new Error(`docker compose ps failed (exit ${ps.code}): ${ps.stderr.trim() || '(no stderr)'}`);
        }
        return ps.stdout;
      },
      now: deps.now,
      sleep: deps.sleep,
    },
    { timeoutSeconds: opts.timeoutSeconds, pollIntervalMs: opts.pollIntervalMs },
  );

  if (outcome.kind === 'healthy') {
    deps.log(`Healthy: ${opts.baseUrl}`);
    deps.log(`/health body: ${outcome.body}`);
    return 0;
  }
  deps.error(`Boot failed (${outcome.kind}): ${outcome.detail}`);
  deps.error(await collectDiagnostics(deps.exec));
  return 1;
}

// ---- CLI main ----

/** Exported for tests. Throws on unknown arguments and on flags missing their value. */
export function parseArgs(argv: string[]): { timeoutFlag?: string } {
  const result: { timeoutFlag?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--timeout-seconds') {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error('--timeout-seconds requires a value (usage: npx tsx tools/e2e/boot.ts [--timeout-seconds N])');
      }
      result.timeoutFlag = value;
    } else if (arg.startsWith('--timeout-seconds=')) {
      result.timeoutFlag = arg.slice('--timeout-seconds='.length);
    } else {
      throw new Error(`unknown argument: ${arg} (usage: npx tsx tools/e2e/boot.ts [--timeout-seconds N])`);
    }
  }
  return result;
}

async function main(): Promise<void> {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

  let timeoutFlag: string | undefined;
  let timeoutSeconds: number;
  try {
    timeoutFlag = parseArgs(process.argv.slice(2)).timeoutFlag;
    timeoutSeconds = resolveTimeoutSeconds(
      timeoutFlag,
      process.env.E2E_BOOT_TIMEOUT_SECONDS,
      DEFAULT_BOOT_TIMEOUT_SECONDS,
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

  // Preflight — mandatory, before any compose invocation.
  let dotenvText: string | undefined;
  try {
    dotenvText = readFileSync(join(repoRoot, '.env'), 'utf-8');
  } catch {
    dotenvText = undefined;
  }
  const errors = preflight(dotenvText);
  if (errors.length > 0) {
    for (const e of errors) console.error(`preflight failed: ${e}`);
    process.exit(1);
  }

  const baseUrl = resolveBaseUrl(process.env, dotenvText);
  const code = await runBoot(
    {
      exec: makeExec({ cwd: repoRoot }),
      execBuild: makeExec({ cwd: repoRoot, echo: true }),
      fetchHealth: async () => {
        // Per-probe timeout so a wedged container can't stall a single fetch past the
        // overall cap (undici's default is ~300s); an abort is just a failed probe and
        // waitForHealth keeps polling until its own deadline.
        const probeTimeoutMs = Math.min(10_000, timeoutSeconds * 1000);
        const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(probeTimeoutMs) });
        return { status: res.status, body: await res.text() };
      },
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log: (line) => console.log(line),
      error: (line) => console.error(line),
    },
    { baseUrl, timeoutSeconds },
  );
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
