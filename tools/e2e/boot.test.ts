import { describe, it, expect } from 'vitest';
import {
  archieContainerState,
  decidePortAction,
  isConnectionRefused,
  looksLikeArchie,
  parseArgs,
  preflight,
  renderDiagnostics,
  runBoot,
  waitForHealth,
  type BootDeps,
  type WaitDeps,
} from './boot.js';
import type { ExecResult } from './exec.js';

// Deterministic clock: sleep advances virtual time instead of waiting on a real timer.
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

const RUNNING_PS = '{"Name":"archie-hq-archie-1","Service":"archie","State":"running"}';
const EXITED_PS = '{"Name":"archie-hq-archie-1","Service":"archie","State":"exited","ExitCode":1}';

function healthDeps(overrides: Partial<WaitDeps>): WaitDeps {
  return {
    fetchHealth: async () => ({ status: 200, body: '{"status":"ok"}' }),
    readPs: async () => RUNNING_PS,
    ...fakeClock(),
    ...overrides,
  };
}

describe('waitForHealth', () => {
  it('returns healthy immediately when /health is already 200', async () => {
    let fetches = 0;
    const r = await waitForHealth(
      healthDeps({
        fetchHealth: async () => {
          fetches++;
          return { status: 200, body: '{"status":"ok","activeTasks":0}' };
        },
      }),
      { timeoutSeconds: 600 },
    );
    expect(r).toEqual({ kind: 'healthy', body: '{"status":"ok","activeTasks":0}' });
    expect(fetches).toBe(1);
  });

  it('keeps polling until /health turns 200', async () => {
    let fetches = 0;
    const r = await waitForHealth(
      healthDeps({
        fetchHealth: async () => {
          fetches++;
          if (fetches < 4) throw new Error('ECONNREFUSED');
          return { status: 200, body: '{"status":"ok"}' };
        },
      }),
      { timeoutSeconds: 600, pollIntervalMs: 5000 },
    );
    expect(r.kind).toBe('healthy');
    expect(fetches).toBe(4);
  });

  it('fails fast when the archie container exits, long before the cap', async () => {
    const clock = fakeClock();
    let tick = 0;
    const r = await waitForHealth(
      healthDeps({
        fetchHealth: async () => {
          throw new Error('ECONNREFUSED');
        },
        readPs: async () => (++tick < 3 ? RUNNING_PS : EXITED_PS),
        ...clock,
      }),
      { timeoutSeconds: 600, pollIntervalMs: 5000 },
    );
    expect(r.kind).toBe('container_exited');
    expect(r.kind === 'container_exited' && r.detail).toContain('exited');
    expect(clock.now()).toBeLessThan(600_000); // fail-fast, not cap exhaustion
  });

  it('fails fast on a restart-looping container', async () => {
    const r = await waitForHealth(
      healthDeps({
        fetchHealth: async () => {
          throw new Error('ECONNREFUSED');
        },
        readPs: async () => '{"Service":"archie","State":"restarting"}',
      }),
      { timeoutSeconds: 600 },
    );
    expect(r.kind).toBe('container_exited');
    expect(r.kind === 'container_exited' && r.detail).toContain('restarting');
  });

  it('fails fast when the archie container disappears from compose ps', async () => {
    const r = await waitForHealth(
      healthDeps({
        fetchHealth: async () => {
          throw new Error('ECONNREFUSED');
        },
        readPs: async () => '',
      }),
      { timeoutSeconds: 600 },
    );
    expect(r.kind).toBe('container_exited');
    expect(r.kind === 'container_exited' && r.detail).toContain('not present');
  });

  it('gives up at the cap with the last failure detail', async () => {
    const clock = fakeClock();
    const r = await waitForHealth(
      healthDeps({
        fetchHealth: async () => ({ status: 503, body: '{"status":"shutting_down"}' }),
        ...clock,
      }),
      { timeoutSeconds: 30, pollIntervalMs: 5000 },
    );
    expect(r.kind).toBe('timeout');
    expect(r.kind === 'timeout' && r.detail).toContain('30s');
    expect(r.kind === 'timeout' && r.detail).toContain('503');
    expect(clock.now()).toBeGreaterThanOrEqual(30_000);
  });

  it('skips the container check when compose ps itself fails, instead of misreporting', async () => {
    let fetches = 0;
    const r = await waitForHealth(
      healthDeps({
        fetchHealth: async () => {
          fetches++;
          if (fetches < 2) throw new Error('ECONNREFUSED');
          return { status: 200, body: '{"status":"ok"}' };
        },
        readPs: async () => {
          throw new Error('docker daemon unreachable');
        },
      }),
      { timeoutSeconds: 600 },
    );
    expect(r.kind).toBe('healthy');
  });
});

describe('archieContainerState', () => {
  it('parses NDJSON compose ps output', () => {
    const out = `${'{"Service":"other","State":"running"}'}\n${RUNNING_PS}\n`;
    expect(archieContainerState(out)).toEqual({ found: true, state: 'running', publishedPorts: [] });
  });

  it('parses array-shaped compose ps output', () => {
    const out = JSON.stringify([{ Service: 'archie', State: 'Exited' }]);
    expect(archieContainerState(out)).toEqual({ found: true, state: 'exited', publishedPorts: [] });
  });

  it('reports not-found for empty or unrelated output', () => {
    expect(archieContainerState('')).toEqual({ found: false, publishedPorts: [] });
    expect(archieContainerState('{"Service":"db","State":"running"}')).toEqual({ found: false, publishedPorts: [] });
  });
});

describe('renderDiagnostics', () => {
  it('renders the compose ps table and the log tail', () => {
    const block = renderDiagnostics('NAME  STATE\narchie  Exited (1)', 'boom: missing env\nstack...');
    expect(block).toContain('docker compose ps');
    expect(block).toContain('archie  Exited (1)');
    expect(block).toContain('last 100 lines');
    expect(block).toContain('boom: missing env');
  });

  it('marks empty sections instead of rendering blanks', () => {
    expect(renderDiagnostics('', '')).toContain('(no output)');
  });
});

describe('parseArgs', () => {
  it('accepts both flag forms', () => {
    expect(parseArgs(['--timeout-seconds', '120'])).toEqual({ timeoutFlag: '120' });
    expect(parseArgs(['--timeout-seconds=120'])).toEqual({ timeoutFlag: '120' });
    expect(parseArgs([])).toEqual({});
  });

  it('rejects --timeout-seconds without a value instead of silently ignoring it', () => {
    expect(() => parseArgs(['--timeout-seconds'])).toThrow(/--timeout-seconds requires a value/);
  });

  it('rejects unknown arguments', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument: --bogus/);
  });
});

describe('preflight', () => {
  it('fails when .env is absent', () => {
    expect(preflight(undefined).join()).toContain('.env not found');
  });

  it('fails when ANTHROPIC_API_KEY is missing or empty', () => {
    expect(preflight('PORT=3000\n').join()).toContain('ANTHROPIC_API_KEY');
    expect(preflight('ANTHROPIC_API_KEY=\n').join()).toContain('ANTHROPIC_API_KEY');
  });

  it('passes with a non-empty key', () => {
    expect(preflight('ANTHROPIC_API_KEY=sk-ant-xxx\nPORT=3000\n')).toEqual([]);
  });
});

// ---- Orchestration: compose-up failure never reaches the health poll ----

function fakeExec(script: (cmd: string, args: string[]) => ExecResult) {
  const calls: string[][] = [];
  const exec = async (cmd: string, args: string[]): Promise<ExecResult> => {
    calls.push([cmd, ...args]);
    return script(cmd, args);
  };
  return { exec, calls };
}

function bootDeps(overrides: Partial<BootDeps>): BootDeps & { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    exec: async () => ({ code: 0, stdout: RUNNING_PS, stderr: '' }),
    fetchHealth: async () => ({ status: 200, body: '{"status":"ok"}' }),
    ...fakeClock(),
    log: (l: string) => void logs.push(l),
    error: (l: string) => void errors.push(l),
    logs,
    errors,
    ...overrides,
  };
}

describe('looksLikeArchie', () => {
  it('accepts the /health payload shape (200 and shutting_down alike)', () => {
    expect(looksLikeArchie('{"status":"ok","activeTasks":0}')).toBe(true);
    expect(looksLikeArchie('{"status":"shutting_down","activeTasks":2,"git_sha":"abc"}')).toBe(true);
  });

  it('rejects non-Archie responses', () => {
    expect(looksLikeArchie('')).toBe(false);
    expect(looksLikeArchie('<html>It works!</html>')).toBe(false);
    expect(looksLikeArchie('{"status":"ok"}')).toBe(false); // no activeTasks — some other JSON service
    expect(looksLikeArchie('{"activeTasks":0}')).toBe(false);
    expect(looksLikeArchie('null')).toBe(false);
  });
});

describe('decidePortAction', () => {
  it('proceeds on a free port', () => {
    expect(decidePortAction({ kind: 'free' }, false)).toBe('proceed');
  });

  it("recreates when this project's own archie PUBLISHES the port (never reuse — code may be stale)", () => {
    expect(decidePortAction({ kind: 'archie' }, true)).toBe('recreate');
  });

  it('relocates when a foreign archie holds the port — even if our own archie runs elsewhere', () => {
    // ourArchieOnPort=false covers both "no archie of ours at all" and "ours
    // publishes a different port"; existence alone must not read as ownership.
    expect(decidePortAction({ kind: 'archie' }, false)).toBe('relocate');
  });

  it('relocates when a non-archie process holds the port', () => {
    expect(decidePortAction({ kind: 'other' }, false)).toBe('relocate');
    expect(decidePortAction({ kind: 'other' }, true)).toBe('relocate');
  });
});

describe('archieContainerState — published ports', () => {
  it('extracts PublishedPort (not TargetPort) and drops unpublished PublishedPort:0 entries', () => {
    // Real compose ps shape from a live relocated boot: the EXPOSEd-but-unpublished
    // target port shows up as PublishedPort:0 and must not count, and the
    // published entry's Target/Published ports differ so the extraction can't
    // read the wrong field.
    const ps =
      '{"Name":"archie-hq-archie-1","Service":"archie","State":"running","Publishers":[' +
      '{"URL":"","TargetPort":3000,"PublishedPort":0,"Protocol":"tcp"},' +
      '{"URL":"0.0.0.0","TargetPort":3000,"PublishedPort":53787,"Protocol":"tcp"}]}';
    expect(archieContainerState(ps)).toEqual({ found: true, state: 'running', publishedPorts: [53787] });
  });

  it('reads missing/empty Publishers as no published ports', () => {
    expect(archieContainerState(RUNNING_PS).publishedPorts).toEqual([]);
    const nullPub = '{"Service":"archie","State":"running","Publishers":null}';
    expect(archieContainerState(nullPub).publishedPorts).toEqual([]);
  });
});

describe('isConnectionRefused', () => {
  it('detects a plain ECONNREFUSED cause', () => {
    expect(isConnectionRefused(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe(true);
  });

  it('detects dual-stack AggregateError causes with no top-level code', () => {
    const cause = { errors: [{ code: 'ECONNREFUSED' }, { code: 'ECONNREFUSED' }] };
    expect(isConnectionRefused(Object.assign(new TypeError('fetch failed'), { cause }))).toBe(true);
  });

  it('does not classify timeouts, DNS failures, or aborts as refused', () => {
    expect(isConnectionRefused(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } }))).toBe(false);
    expect(isConnectionRefused(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }))).toBe(false);
    expect(isConnectionRefused(Object.assign(new TypeError('fetch failed'), { cause: { errors: [{ code: 'ETIMEDOUT' }] } }))).toBe(false);
    expect(isConnectionRefused(new DOMException('aborted', 'TimeoutError'))).toBe(false);
    expect(isConnectionRefused(new Error('anything'))).toBe(false);
  });
});

describe('runBoot — orchestration ordering', () => {
  it('a failed compose-up prints diagnostics and returns non-zero with ZERO /health fetches', async () => {
    let fetches = 0;
    const { exec, calls } = fakeExec((_cmd, args) =>
      args.includes('up')
        ? { code: 1, stdout: '', stderr: 'build failed: bad Dockerfile' }
        : { code: 0, stdout: args.includes('logs') ? 'error: cannot start' : 'NAME STATE', stderr: '' },
    );
    const deps = bootDeps({
      exec,
      fetchHealth: async () => {
        fetches++;
        return { status: 200, body: 'ok' };
      },
    });

    const code = await runBoot(deps, { baseUrl: 'http://localhost:3000', timeoutSeconds: 600 });

    expect(code).toBe(1);
    expect(fetches).toBe(0); // never entered the poll loop
    expect(deps.errors.join('\n')).toContain('build failed: bad Dockerfile');
    expect(deps.errors.join('\n')).toContain('docker compose ps'); // diagnostics block rendered
    // diagnostics used ps + logs, in that order, after the failed up
    const commands = calls.map((c) => c.join(' '));
    expect(commands[0]).toBe('docker compose up --build -d');
    expect(commands).toContain('docker compose ps');
    expect(commands.some((c) => c.includes('logs --no-color --tail=100 archie'))).toBe(true);
  });

  it('a successful compose-up proceeds to a healthy poll and returns zero', async () => {
    const { exec } = fakeExec((_cmd, args) =>
      args.includes('up') ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: RUNNING_PS, stderr: '' },
    );
    const deps = bootDeps({ exec });

    const code = await runBoot(deps, { baseUrl: 'http://localhost:3000', timeoutSeconds: 600 });

    expect(code).toBe(0);
    expect(deps.logs.join('\n')).toContain('http://localhost:3000');
    expect(deps.logs.join('\n')).toContain('{"status":"ok"}');
  });

  it('attestation: a healthy instance reporting the expected git_sha passes', async () => {
    const { exec } = fakeExec((_cmd, args) =>
      args.includes('up') ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: RUNNING_PS, stderr: '' },
    );
    const deps = bootDeps({
      exec,
      fetchHealth: async () => ({ status: 200, body: '{"status":"ok","activeTasks":0,"git_sha":"abc123"}' }),
    });

    const code = await runBoot(deps, { baseUrl: 'http://localhost:3000', timeoutSeconds: 600, expectedSha: 'abc123' });

    expect(code).toBe(0);
    expect(deps.logs.join('\n')).toContain('Attested: instance composed from abc123');
  });

  it('attestation: a healthy instance reporting a DIFFERENT git_sha fails the boot with diagnostics', async () => {
    const { exec } = fakeExec((_cmd, args) =>
      args.includes('up') ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: RUNNING_PS, stderr: '' },
    );
    const deps = bootDeps({
      exec,
      fetchHealth: async () => ({ status: 200, body: '{"status":"ok","activeTasks":0,"git_sha":"stale99"}' }),
    });

    const code = await runBoot(deps, { baseUrl: 'http://localhost:3000', timeoutSeconds: 600, expectedSha: 'abc123' });

    expect(code).toBe(1);
    expect(deps.errors.join('\n')).toContain('git_sha=stale99');
    expect(deps.errors.join('\n')).toContain('expected abc123');
    expect(deps.errors.join('\n')).toContain('docker compose ps'); // diagnostics block rendered
  });

  it('attestation: a healthy instance with NO git_sha in /health fails when a SHA is expected', async () => {
    const { exec } = fakeExec((_cmd, args) =>
      args.includes('up') ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: RUNNING_PS, stderr: '' },
    );
    const deps = bootDeps({
      exec,
      fetchHealth: async () => ({ status: 200, body: '{"status":"ok","activeTasks":0}' }),
    });

    const code = await runBoot(deps, { baseUrl: 'http://localhost:3000', timeoutSeconds: 600, expectedSha: 'abc123' });

    expect(code).toBe(1);
    expect(deps.errors.join('\n')).toContain('git_sha=(none)');
  });

  it('a transient compose ps failure (non-zero exit, empty stdout) skips the container check instead of aborting', async () => {
    // Regression: readPs is wired over the never-rejecting exec wrapper. A failed ps resolves
    // {code:1, stdout:''} — which must NOT be misread as "archie container gone" and abort a
    // boot whose /health was about to turn 200.
    let fetches = 0;
    const { exec } = fakeExec((_cmd, args) => {
      if (args.includes('up')) return { code: 0, stdout: '', stderr: '' };
      return { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' }; // every ps fails
    });
    const deps = bootDeps({
      exec,
      fetchHealth: async () => {
        fetches++;
        if (fetches < 3) throw new Error('ECONNREFUSED');
        return { status: 200, body: '{"status":"ok"}' };
      },
    });

    const code = await runBoot(deps, { baseUrl: 'http://localhost:3000', timeoutSeconds: 600 });

    expect(code).toBe(0); // boot survived the flaky ps and reached healthy
    expect(fetches).toBe(3);
  });

  it('a poll-phase failure prints the diagnostics block and returns non-zero', async () => {
    const { exec } = fakeExec((_cmd, args) => {
      if (args.includes('up')) return { code: 0, stdout: '', stderr: '' };
      if (args.includes('logs')) return { code: 0, stdout: 'crash: missing plugin', stderr: '' };
      return { code: 0, stdout: EXITED_PS, stderr: '' };
    });
    const deps = bootDeps({
      exec,
      fetchHealth: async () => {
        throw new Error('ECONNREFUSED');
      },
    });

    const code = await runBoot(deps, { baseUrl: 'http://localhost:3000', timeoutSeconds: 600 });

    expect(code).toBe(1);
    expect(deps.errors.join('\n')).toContain('container_exited');
    expect(deps.errors.join('\n')).toContain('crash: missing plugin');
  });
});
