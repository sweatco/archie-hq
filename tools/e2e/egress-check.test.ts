import { describe, it, expect } from 'vitest';
import { parseProbeOutput, decideEgress, runEgressCheck, type ProbeVerdicts } from './egress-check.js';
import type { ExecFn, ExecResult } from './exec.js';

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });

const PS_RUNNING = JSON.stringify([
  { Name: 'archie-hq-archie-1', Service: 'archie', State: 'running' },
]);

const PROBE_PASS = [
  'CLI_VERSION=2.1.220',
  'EGRESS_DENIED_HOST=blocked',
  'EGRESS_ALLOWED_HOST=reachable',
  'EGRESS_PKG_INSTALL=ok',
].join('\n');

function makeIo() {
  const logs: string[] = [];
  const errors: string[] = [];
  return { io: { log: (l: string) => logs.push(l), error: (l: string) => errors.push(l) }, logs, errors };
}

/** Fake docker: compose ps → running, cp → ok, exec → the given probe output. */
function fakeExec(probeOutput: string, overrides: Partial<Record<string, ExecResult>> = {}): ExecFn {
  return async (_cmd, args) => {
    if (args[0] === 'compose' && args[1] === 'ps') return overrides.ps ?? ok(PS_RUNNING);
    if (args[0] === 'cp') return overrides.cp ?? ok('');
    if (args[0] === 'exec') return overrides.exec ?? ok(probeOutput);
    return ok('');
  };
}

describe('parseProbeOutput', () => {
  it('reads both verdicts and the CLI version', () => {
    expect(parseProbeOutput(PROBE_PASS)).toEqual<ProbeVerdicts>({
      cliVersion: '2.1.220',
      deniedHost: 'blocked',
      allowedHost: 'reachable',
      packageInstall: 'ok',
    });
  });

  it('reports unknown rather than guessing when a line is missing', () => {
    const v = parseProbeOutput('CLI_VERSION=2.1.220\nEGRESS_DENIED_HOST=blocked');
    expect(v.allowedHost).toBe('unknown');
  });

  it('does not match verdict lines embedded in other text', () => {
    // The probe echoes the agent transcript after its verdicts; a curl command
    // quoted there must not be mistaken for a verdict.
    const v = parseProbeOutput('EGRESS_DENIED_HOST=blocked\n---- agent transcript ----\nEGRESS_ALLOWED_HOST=reachable is what we want');
    expect(v.allowedHost).toBe('unknown');
  });
});

describe('decideEgress', () => {
  it('passes only when the filter discriminates in both directions', () => {
    expect(decideEgress({ cliVersion: 'x', deniedHost: 'blocked', allowedHost: 'reachable', packageInstall: 'ok' }).pass).toBe(true);
  });

  it('fails when a non-allowlisted host is reachable — the regression this guards', () => {
    const d = decideEgress({ cliVersion: 'x', deniedHost: 'reachable', allowedHost: 'reachable', packageInstall: 'ok' });
    expect(d.pass).toBe(false);
    expect(d.reasons.join(' ')).toMatch(/NOT on the allowlist was reachable/);
  });

  it('fails when all egress is broken instead of filtered', () => {
    const d = decideEgress({ cliVersion: 'x', deniedHost: 'blocked', allowedHost: 'blocked', packageInstall: 'failed' });
    expect(d.pass).toBe(false);
    expect(d.reasons.join(' ')).toMatch(/egress is broken rather than filtered/);
  });

  it('treats unknown as failure, never as a pass', () => {
    expect(decideEgress({ cliVersion: 'x', deniedHost: 'unknown', allowedHost: 'unknown', packageInstall: 'unknown' }).pass).toBe(false);
  });

  it('fails when the boundary holds but npm install is broken', () => {
    // A correct allowlist that no package manager can use is not a pass — this is
    // the EROFS-on-read-only-$HOME failure the cache redirection fixes.
    const d = decideEgress({ cliVersion: 'x', deniedHost: 'blocked', allowedHost: 'reachable', packageInstall: 'failed' });
    expect(d.pass).toBe(false);
    expect(d.reasons.join(' ')).toMatch(/npm install` failed inside the sandbox/);
  });
});

describe('runEgressCheck', () => {
  it('exits 0 and says so when the boundary holds', async () => {
    const { io, logs } = makeIo();
    expect(await runEgressCheck(fakeExec(PROBE_PASS), io)).toBe(0);
    expect(logs.join('\n')).toMatch(/Egress check passed/);
  });

  it('exits 1 and prints the probe output when egress is open', async () => {
    const { io, errors } = makeIo();
    const open = 'CLI_VERSION=2.1.220\nEGRESS_DENIED_HOST=reachable\nEGRESS_ALLOWED_HOST=reachable\nEGRESS_PKG_INSTALL=ok';
    expect(await runEgressCheck(fakeExec(open), io)).toBe(1);
    expect(errors.join('\n')).toMatch(/EGRESS CHECK FAILED/);
    expect(errors.join('\n')).toMatch(/EGRESS_DENIED_HOST=reachable/);
  });

  it('fails clearly when no instance is running', async () => {
    const { io, errors } = makeIo();
    const code = await runEgressCheck(fakeExec(PROBE_PASS, { ps: ok('[]') }), io);
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/no running "archie" container/);
  });

  it('fails when the probe cannot be copied in', async () => {
    const { io, errors } = makeIo();
    const cpFail: ExecResult = { code: 1, stdout: '', stderr: 'no such container' };
    expect(await runEgressCheck(fakeExec(PROBE_PASS, { cp: cpFail }), io)).toBe(1);
    expect(errors.join('\n')).toMatch(/failed to copy the probe/);
  });

  it('does not pass a crashed probe just because it printed nothing', async () => {
    const { io } = makeIo();
    const crashed: ExecResult = { code: 1, stdout: '', stderr: 'SyntaxError' };
    expect(await runEgressCheck(fakeExec('', { exec: crashed }), io)).toBe(1);
  });
});
