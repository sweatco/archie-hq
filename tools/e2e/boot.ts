/**
 * archie-e2e boot — start a live Archie instance from the current checkout and wait for health.
 *
 * Usage: npx tsx tools/e2e/boot.ts [--timeout-seconds N]
 *
 * Strict fail-fast sequence (each step gates the next):
 *   1. Preflight: .env exists at the repo root and ANTHROPIC_API_KEY is non-empty.
 *      Failure exits non-zero naming the missing item — no compose invocation at all.
 *   2. Port preflight: probe the target port BEFORE any compose invocation.
 *      Free → proceed. Held by this project's own archie → `docker compose down`
 *      first (a running instance may be stale code; the harness never reuses —
 *      it always boots fresh from the current checkout). Held by anything else
 *      (a foreign archie from another worktree, some unrelated service) → pick a
 *      free port and boot there, leaving the squatter untouched.
 *   3. `docker compose up --build -d` with the exit code trapped: a non-zero exit
 *      prints diagnostics (compose ps + 100-line log tail) and exits non-zero
 *      BEFORE a single /health poll. PORT and GIT_SHA are passed in the compose
 *      environment (compose makes both authoritative inside the container).
 *   4. Bounded /health poll every 5s (default cap 600s, override --timeout-seconds
 *      or E2E_BOOT_TIMEOUT_SECONDS), failing fast if the archie container exits
 *      or restart-loops instead of waiting out the cap.
 *   5. Checkout attestation: /health must report the GIT_SHA the boot passed —
 *      positive proof the healthy instance runs the code under test, not a
 *      stale build or someone else's checkout.
 *
 * On success the boot prints `ARCHIE_URL=http://localhost:<port>` — export it
 * before driving the archie-debug MCP so both target the same instance
 * (mandatory when the port was auto-picked).
 *
 * Pure cores (preflight, waitForHealth, archieContainerState, looksLikeArchie,
 * decidePortAction, renderDiagnostics, runBoot) take injected deps and are
 * unit-tested with fakes; main wires real ones.
 */

import { readFileSync } from 'fs';
import { createServer, type AddressInfo } from 'net';
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

// ---- Port preflight (pure cores) ----

/**
 * Does an HTTP response body look like Archie's /health payload?
 * Archie answers with JSON carrying a string `status` and numeric `activeTasks`
 * (200 when up, 503 while shutting down) — nothing else on our ports does.
 */
export function looksLikeArchie(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return false;
    const o = parsed as Record<string, unknown>;
    return typeof o['status'] === 'string' && typeof o['activeTasks'] === 'number';
  } catch {
    return false;
  }
}

export type PortProbe =
  | { kind: 'free' } // connection refused — nothing listens
  | { kind: 'archie' } // an Archie /health answered
  | { kind: 'other' }; // something answered (or held the socket) that isn't Archie

export type PortAction =
  | 'proceed' // port is free — boot on it
  | 'recreate' // our own project holds it — compose down, then boot on it (never reuse: running code may be stale)
  | 'relocate'; // a foreign process holds it — pick a free port, leave the squatter untouched

/**
 * Decide what to do with the target port before any compose invocation.
 * `archieInProject` is whether `docker compose ps` (this project) shows the
 * archie service — distinguishes our own instance (safe to tear down and
 * rebuild) from a foreign one (another worktree's project; not ours to stop).
 */
export function decidePortAction(probe: PortProbe, archieInProject: boolean): PortAction {
  if (probe.kind === 'free') return 'proceed';
  if (probe.kind === 'archie' && archieInProject) return 'recreate';
  return 'relocate';
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
  /**
   * Commit SHA the instance must attest to via /health `git_sha` (the boot
   * passes the same value to compose as GIT_SHA). When set, a healthy instance
   * reporting anything else fails the boot — proof against stale builds and
   * wrong-checkout instances.
   */
  expectedSha?: string;
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
    if (opts.expectedSha) {
      let reported: string | null = null;
      try {
        const parsed = JSON.parse(outcome.body) as Record<string, unknown>;
        reported = typeof parsed['git_sha'] === 'string' ? parsed['git_sha'] : null;
      } catch {
        // fall through to the mismatch error with reported=null
      }
      if (reported !== opts.expectedSha) {
        deps.error(
          `Boot failed (attestation): /health reports git_sha=${reported ?? '(none)'}, expected ${opts.expectedSha} — ` +
            'the healthy instance is not running the code under test (stale build or another checkout).',
        );
        deps.error(await collectDiagnostics(deps.exec));
        return 1;
      }
      deps.log(`Attested: instance runs ${opts.expectedSha}`);
    }
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

/** Probe the target /health and classify what holds the port (impure; main only). */
async function probePort(baseUrl: string): Promise<PortProbe> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    return looksLikeArchie(await res.text()) ? { kind: 'archie' } : { kind: 'other' };
  } catch (err) {
    // Connection refused = nothing listens. Anything else responded, hung, or
    // held the socket without speaking HTTP — treat as occupied.
    const code = (err as { cause?: { code?: string } }).cause?.code;
    return code === 'ECONNREFUSED' ? { kind: 'free' } : { kind: 'other' };
  }
}

/** Ask the OS for a free TCP port (impure; main only). */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
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

  // Checkout attestation value: the compose environment carries it into the
  // container and /health reports it back. `-dirty` marks an unclean tree.
  const hostExec = makeExec({ cwd: repoRoot });
  let expectedSha: string | undefined;
  {
    const rev = await hostExec('git', ['rev-parse', 'HEAD']);
    if (rev.code === 0 && rev.stdout.trim()) {
      const status = await hostExec('git', ['status', '--porcelain']);
      expectedSha = rev.stdout.trim() + (status.code === 0 && status.stdout.trim() ? '-dirty' : '');
    } else {
      console.error('warning: git rev-parse failed — booting without checkout attestation');
    }
  }

  // Port preflight — before any compose invocation.
  let baseUrl = resolveBaseUrl(process.env, dotenvText);
  let port = new URL(baseUrl).port || '3000';
  const probe = await probePort(baseUrl);
  if (probe.kind !== 'free') {
    const ps = await hostExec('docker', ['compose', 'ps', '--format', 'json']);
    const action = decidePortAction(probe, ps.code === 0 && archieContainerState(ps.stdout).found);
    if (action === 'recreate') {
      console.log(`Port ${port} is held by this project's own archie — tearing it down to boot fresh from the current checkout ...`);
      const down = await hostExec('docker', ['compose', 'down']);
      if (down.code !== 0) {
        console.error(`docker compose down failed (exit ${down.code}): ${down.stderr.trim()}`);
        process.exit(1);
      }
    } else {
      port = String(await pickFreePort());
      baseUrl = `http://localhost:${port}`;
      console.log(
        `Port ${new URL(resolveBaseUrl(process.env, dotenvText)).port || '3000'} is taken by a ${
          probe.kind === 'archie' ? 'foreign archie instance' : 'non-archie process'
        } — relocating to free port ${port}.`,
      );
    }
  }

  // PORT + GIT_SHA ride the compose environment: PORT drives both the mapping
  // and the app's listen port; GIT_SHA lands in /health for the attestation.
  const composeEnv: Record<string, string> = { PORT: port };
  if (expectedSha) composeEnv.GIT_SHA = expectedSha;

  const code = await runBoot(
    {
      exec: makeExec({ cwd: repoRoot, env: composeEnv }),
      execBuild: makeExec({ cwd: repoRoot, echo: true, env: composeEnv }),
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
    { baseUrl, timeoutSeconds, expectedSha },
  );
  if (code === 0) {
    // Export line for the driver: the archie-debug MCP resolves ARCHIE_URL
    // first, so this keeps it on the same instance (mandatory when relocated).
    console.log(`ARCHIE_URL=${baseUrl}`);
  }
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
