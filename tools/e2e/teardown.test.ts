import { describe, it, expect } from 'vitest';
import { evalComposeArgs } from './eval-profile.js';
import { parseArgs, parseComposePs, runTeardown, teardownTarget } from './teardown.js';
import type { ExecResult } from './exec.js';

describe('parseComposePs', () => {
  it('treats empty output as clean', () => {
    expect(parseComposePs('')).toEqual({ ok: true, containers: [] });
    expect(parseComposePs('\n  \n')).toEqual({ ok: true, containers: [] });
  });

  it('parses NDJSON output (one object per line)', () => {
    const out = '{"Name":"archie-hq-archie-1","Service":"archie","State":"running"}\n';
    expect(parseComposePs(out)).toEqual({
      ok: true,
      containers: [{ name: 'archie-hq-archie-1', service: 'archie', state: 'running' }],
    });
  });

  it('parses array-shaped output', () => {
    const out = JSON.stringify([
      { Name: 'archie-hq-archie-1', Service: 'archie', State: 'exited' },
      { Name: 'archie-hq-db-1', Service: 'db', State: 'running' },
    ]);
    const r = parseComposePs(out);
    expect(r.ok).toBe(true);
    expect(r.ok && r.containers.map((c) => c.service)).toEqual(['archie', 'db']);
  });

  it('reports a clear error for a malformed line', () => {
    const r = parseComposePs('{"Name":"x","Service":"archie"}\nnot-json-at-all\n');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('malformed compose ps JSON line: not-json-at-all');
  });

  it('reports a clear error for a non-object entry', () => {
    const r = parseComposePs('[42]');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('expected an object');
  });
});

// ---- Orchestration ----

function fakeExec(script: (cmd: string, args: string[]) => ExecResult) {
  const calls: string[][] = [];
  const exec = async (cmd: string, args: string[]): Promise<ExecResult> => {
    calls.push([cmd, ...args]);
    return script(cmd, args);
  };
  return { exec, calls };
}

const io = () => {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    log: (l: string) => void logs.push(l),
    error: (l: string) => void errors.push(l),
    logs,
    errors,
  };
};

describe('parseArgs', () => {
  it('accepts no arguments or --profile eval, and nothing else', () => {
    expect(parseArgs([])).toEqual({});
    expect(parseArgs(['--profile', 'eval'])).toEqual({ profile: 'eval' });
    expect(parseArgs(['--profile=eval'])).toEqual({ profile: 'eval' });
    expect(() => parseArgs(['--profile', 'prod'])).toThrow(/unknown arguments/);
    expect(() => parseArgs(['--force'])).toThrow(/unknown arguments/);
  });
});

describe('teardownTarget', () => {
  const repo = '/repos/archie-hq';
  const downCall = async (profile: 'eval' | undefined) => {
    const { exec, calls } = fakeExec(() => ({ code: 0, stdout: '', stderr: '' }));
    const target = teardownTarget(profile, repo);
    await runTeardown(exec, io(), target.composeArgs, target.downFlags);
    return calls[0];
  };

  it('leaves the default profile’s teardown a plain `docker compose down`', async () => {
    expect(teardownTarget(undefined, repo)).toEqual({ composeArgs: [], downFlags: [] });
    expect(await downCall(undefined)).toEqual(['docker', 'compose', 'down']);
  });

  it('removes the eval project’s volumes with its containers', async () => {
    expect(await downCall('eval')).toEqual([
      'docker',
      'compose',
      ...evalComposeArgs(repo),
      'down',
      '--volumes',
    ]);
  });
});

describe('runTeardown', () => {
  it('targets the given compose project and files for both down and the survivor check', async () => {
    const { exec, calls } = fakeExec(() => ({ code: 0, stdout: '', stderr: '' }));
    const code = await runTeardown(exec, io(), ['-p', 'feat-eval', '-f', 'a.yml'], ['--volumes']);
    expect(code).toBe(0);
    expect(calls.map((c) => c.join(' '))).toEqual([
      'docker compose -p feat-eval -f a.yml down --volumes',
      'docker compose -p feat-eval -f a.yml ps --all --format json',
    ]);
  });

  it('clean teardown prints an evidence-suitable confirmation and returns zero', async () => {
    const { exec, calls } = fakeExec((_cmd, args) =>
      args.includes('down')
        ? { code: 0, stdout: '', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    );
    const out = io();
    const code = await runTeardown(exec, out);
    expect(code).toBe(0);
    expect(out.logs.join('\n')).toContain('Teardown clean');
    expect(calls.map((c) => c.join(' '))).toEqual([
      'docker compose down',
      'docker compose ps --all --format json',
    ]);
  });

  it('names each survivor and returns non-zero', async () => {
    const { exec } = fakeExec((_cmd, args) =>
      args.includes('ps')
        ? {
            code: 0,
            stdout: '{"Name":"archie-hq-archie-1","Service":"archie","State":"exited"}\n',
            stderr: '',
          }
        : { code: 0, stdout: '', stderr: '' },
    );
    const out = io();
    const code = await runTeardown(exec, out);
    expect(code).toBe(1);
    expect(out.errors.join('\n')).toContain('archie-hq-archie-1');
    expect(out.errors.join('\n')).toContain('state=exited');
  });

  it('a failed compose down surfaces its stderr and returns non-zero', async () => {
    const { exec, calls } = fakeExec((_cmd, args) =>
      args.includes('down')
        ? { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' }
        : { code: 0, stdout: '', stderr: '' },
    );
    const out = io();
    const code = await runTeardown(exec, out);
    expect(code).toBe(1);
    expect(out.errors.join('\n')).toContain('Cannot connect to the Docker daemon');
    expect(calls).toHaveLength(1); // no ps after a failed down
  });

  it('an unverifiable ps (malformed output) is a failure, not a silent pass', async () => {
    const { exec } = fakeExec((_cmd, args) =>
      args.includes('ps')
        ? { code: 0, stdout: 'garbage', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    );
    const out = io();
    const code = await runTeardown(exec, out);
    expect(code).toBe(1);
    expect(out.errors.join('\n')).toContain('could not verify teardown');
  });
});
