/**
 * archie-e2e egress check — assert the sandbox network boundary on a live instance.
 *
 * Usage: npx tsx tools/e2e/egress-check.ts        (requires a booted instance)
 *
 * Why this is a live check and not a unit test: the outbound allowlist is
 * enforced by the Claude CLI, not by our code. It silently stopped being
 * enforced between CLI 2.1.156 and 2.1.157 — our config never changed, so no
 * assertion over config shape could have noticed. Archie picked the change up
 * transitively in a lockfile refresh (commit 0c1383a, 2026-06-13) and ran with
 * unrestricted agent egress for six weeks. This check is the tripwire: it drives
 * a real sandboxed agent and asserts what it can and cannot reach.
 *
 * Both directions are asserted. A host off the allowlist must be blocked, and a
 * host on it must be reachable — otherwise "all egress broken" would pass as
 * secure and quietly break `npm install` in edit mode.
 *
 * Pure core: parseProbeOutput + decideEgress, unit-tested. The CLI main only
 * does docker plumbing.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { makeExec, type ExecFn } from './exec.js';
import { parseComposePs } from './teardown.js';

const PROBE_LOCAL = 'tools/e2e/egress-probe.mts';
const PROBE_REMOTE = '/tmp/egress-probe.mts';
const SERVICE = 'archie';

// ---- Probe output parsing (pure) ----

export type Reachability = 'blocked' | 'reachable' | 'unknown';

export interface ProbeVerdicts {
  cliVersion: string;
  deniedHost: Reachability;
  allowedHost: Reachability;
  /** Whether `npm install` actually completes — the allowlist is useless if it doesn't. */
  packageInstall: 'ok' | 'failed' | 'unknown';
  /** Whether the sandbox proxy reached Yarn Berry's own config keys (BASH_ENV wiring). */
  yarnProxy: 'mapped' | 'unset';
}

function readReachability(output: string, key: string): Reachability {
  const m = output.match(new RegExp(`^${key}=(blocked|reachable|unknown)$`, 'm'));
  return m ? (m[1] as Reachability) : 'unknown';
}

/**
 * Extract the probe's verdict lines. A missing or unparseable line yields
 * 'unknown', which decideEgress treats as a failure — never as a pass.
 */
export function parseProbeOutput(output: string): ProbeVerdicts {
  const version = output.match(/^CLI_VERSION=(.+)$/m);
  const pkg = output.match(/^EGRESS_PKG_INSTALL=(ok|failed|unknown)$/m);
  return {
    cliVersion: version ? version[1].trim() : 'unknown',
    deniedHost: readReachability(output, 'EGRESS_DENIED_HOST'),
    allowedHost: readReachability(output, 'EGRESS_ALLOWED_HOST'),
    packageInstall: pkg ? (pkg[1] as ProbeVerdicts['packageInstall']) : 'unknown',
    yarnProxy: /^EGRESS_YARN_PROXY=mapped$/m.test(output) ? 'mapped' : 'unset',
  };
}

export interface EgressDecision {
  pass: boolean;
  reasons: string[];
}

/** The boundary holds only when the filter discriminates in both directions. */
export function decideEgress(v: ProbeVerdicts): EgressDecision {
  const reasons: string[] = [];
  if (v.deniedHost !== 'blocked') {
    reasons.push(
      v.deniedHost === 'reachable'
        ? 'a host that is NOT on the allowlist was reachable from sandboxed Bash — the egress allowlist is not being enforced'
        : 'could not determine whether a non-allowlisted host was blocked (probe output unreadable)',
    );
  }
  if (v.allowedHost !== 'reachable') {
    reasons.push(
      v.allowedHost === 'blocked'
        ? 'a host ON the allowlist was blocked — egress is broken rather than filtered (this breaks npm/yarn in edit mode)'
        : 'could not determine whether an allowlisted host was reachable (probe output unreadable)',
    );
  }
  if (v.yarnProxy !== 'mapped') {
    reasons.push(
      'the sandbox proxy did not reach Yarn Berry\'s config keys (YARN_HTTPS_PROXY unset) — check BASH_ENV and scripts/sandbox-shell-env.sh; yarn 2+ ignores HTTPS_PROXY and will fail DNS resolution',
    );
  }
  if (v.packageInstall !== 'ok') {
    reasons.push(
      v.packageInstall === 'failed'
        ? '`npm install` failed inside the sandbox — check the package-manager cache redirection (a read-only $HOME makes installs fail with EROFS even when the registry is allowlisted)'
        : 'could not determine whether `npm install` works inside the sandbox (probe output unreadable)',
    );
  }
  return { pass: reasons.length === 0, reasons };
}

// ---- Orchestration (core over injected deps) ----

export interface EgressCheckIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

/** Resolve the running container name for the archie service. */
async function resolveContainer(exec: ExecFn): Promise<{ name: string } | { error: string }> {
  const ps = await exec('docker', ['compose', 'ps', '--format', 'json']);
  if (ps.code !== 0) {
    return { error: `docker compose ps failed with exit code ${ps.code}: ${ps.stderr.trim()}` };
  }
  const parsed = parseComposePs(ps.stdout);
  if (!parsed.ok) return { error: `could not read compose ps output: ${parsed.error}` };
  const container = parsed.containers.find((c) => c.service === SERVICE);
  if (!container) {
    return { error: `no running "${SERVICE}" container — boot an instance first (npx tsx tools/e2e/boot.ts)` };
  }
  return { name: container.name };
}

/** Copy the probe in, run it, assert both directions. Returns the process exit code. */
export async function runEgressCheck(exec: ExecFn, io: EgressCheckIo): Promise<number> {
  const container = await resolveContainer(exec);
  if ('error' in container) {
    io.error(`Egress check could not start: ${container.error}`);
    return 1;
  }

  const cp = await exec('docker', ['cp', PROBE_LOCAL, `${container.name}:${PROBE_REMOTE}`]);
  if (cp.code !== 0) {
    io.error(`failed to copy the probe into ${container.name}: ${cp.stderr.trim()}`);
    return 1;
  }

  io.log(`Running egress probe in ${container.name} (spawns one throwaway sandboxed agent) ...`);
  const run = await exec('docker', [
    'exec', '-u', 'archie', '-w', '/app', container.name,
    'bash', '-lc', `mkdir -p /tmp/egress-check-ws && npx tsx ${PROBE_REMOTE}`,
  ]);
  const output = `${run.stdout}\n${run.stderr}`;

  const verdicts = parseProbeOutput(output);
  const decision = decideEgress(verdicts);

  io.log(`CLI version in the instance: ${verdicts.cliVersion}`);
  io.log(`  non-allowlisted host: ${verdicts.deniedHost} (expected blocked)`);
  io.log(`  allowlisted host:     ${verdicts.allowedHost} (expected reachable)`);
  io.log(`  npm install:          ${verdicts.packageInstall} (expected ok)`);
  io.log(`  yarn berry proxy:     ${verdicts.yarnProxy} (expected mapped)`);

  if (!decision.pass) {
    io.error('EGRESS CHECK FAILED — the documented network boundary does not hold:');
    for (const r of decision.reasons) io.error(`  - ${r}`);
    io.error('Probe output follows:');
    io.error(output.trim());
    if (run.code !== 0) io.error(`(probe exited ${run.code})`);
    return 1;
  }

  io.log('Egress check passed: sandboxed Bash reaches allowlisted hosts only.');
  return 0;
}

// ---- CLI main ----

async function main(): Promise<void> {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const code = await runEgressCheck(makeExec({ cwd: repoRoot }), {
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  });
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
