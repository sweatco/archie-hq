import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RunnerCommandResult } from '../types.js';
import { canaryCommands, finishCommand } from './orchard-canary-helpers.js';

function page(overrides: Partial<RunnerCommandResult> = {}): RunnerCommandResult {
  return { execId: 'exec-1', state: 'running', stdout: '', stderr: '', truncated: false, cursor: 0, hasMore: false, ...overrides };
}

const endpoints = ['https://public.example.test', 'http://192.0.2.1', 'http://[::1]'];

describe('Orchard canary execution', () => {
  it('polls asynchronous commands and drains terminal pages, preserving all output', async () => {
    const poll = vi.fn()
      .mockResolvedValueOnce(page({ state: 'completed', exitCode: 0, stdout: 'connect', cursor: 2, hasMore: true }))
      .mockResolvedValueOnce(page({ state: 'completed', exitCode: 0, stdout: 'ed', stderr: 'warning', cursor: 3 }));
    const result = await finishCommand(Promise.resolve(page({ stdout: 're', cursor: 1 })), poll);
    expect(result).toMatchObject({ state: 'completed', exitCode: 0, stdout: 'reconnected', stderr: 'warning', cursor: 3 });
    expect(poll.mock.calls).toEqual([['exec-1', 1], ['exec-1', 2]]);
  });

  it('accepts immediately completed commands without polling', async () => {
    const poll = vi.fn();
    const result = await finishCommand(Promise.resolve(page({ state: 'completed', exitCode: 0 })), poll);
    expect(result.exitCode).toBe(0);
    expect(poll).not.toHaveBeenCalled();
  });

  it('bounds a hanging poll', async () => {
    vi.useFakeTimers();
    try {
      const result = finishCommand(Promise.resolve(page()), () => new Promise(() => {}), 100);
      const rejection = expect(result).rejects.toThrow('polling timed out');
      await vi.advanceTimersByTimeAsync(100);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps truncation visible across pages', async () => {
    const result = await finishCommand(Promise.resolve(page({ truncated: true })), async () => page({ state: 'completed', exitCode: 0 }));
    expect(result.truncated).toBe(true);
  });
});

describe('Orchard canary isolation', () => {
  it('always appends mandatory isolation assertions to a custom workload', () => {
    const workload = [['custom-tool', 'arg']];
    const commands = canaryCommands(workload, endpoints);
    expect(commands).toHaveLength(4);
    expect(commands[0]).toEqual(workload[0]);
    expect(commands[1]).toEqual(['/usr/bin/curl', '-fsS', '--max-time', '15', '--', endpoints[0]]);
    expect(commands.slice(2).map((command) => command.at(-1))).toEqual(endpoints.slice(1));
  });

  it('rejects malformed endpoints and workloads before provisioning', () => {
    expect(() => canaryCommands([], ['file:///etc/passwd', ...endpoints.slice(1)])).toThrow('HTTP(S)');
    expect(() => canaryCommands([], ['invalid', ...endpoints.slice(1)])).toThrow();
    expect(() => canaryCommands([], [endpoints[0], 'http://host.example.test', endpoints[2]])).toThrow('literal IP address');
    expect(() => canaryCommands([], [endpoints[0], endpoints[1], 'http://ipv6.example.test'])).toThrow('literal IPv6 address');
    expect(() => canaryCommands([], [endpoints[0], endpoints[1], 'http://127.0.0.1'])).toThrow('literal IPv6 address');
    expect(() => canaryCommands([[]], endpoints)).toThrow('nonempty string argv');
  });

  it('uses literal endpoint argv and only accepts connect failure/timeout as isolation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'archie-canary-shell-'));
    try {
      const stub = join(dir, 'curl');
      const argvLog = join(dir, 'argv');
      const marker = join(dir, 'injected');
      await writeFile(stub, '#!/bin/sh\nprintf "%s\\n" "$@" > "$CANARY_ARGV_LOG"\nprintf "%s" "$CANARY_REMOTE_IP"\nexit "$CANARY_CURL_STATUS"\n', { mode: 0o700 });
      const endpoint = `http://192.0.2.1/$(touch ${marker})`;
      const command = canaryCommands([], [endpoints[0], endpoint, endpoints[2]])[1];
      for (const status of [0, 3, 6, 7, 22, 28, 127]) {
        const result = spawnSync(command[0], [command[1], command[2].replace('/usr/bin/curl', stub), ...command.slice(3)], {
          env: { ...process.env, CANARY_ARGV_LOG: argvLog, CANARY_CURL_STATUS: String(status), CANARY_REMOTE_IP: '' },
        });
        expect(result.status, `curl exit ${status}`).toBe([7, 28].includes(status) ? 0 : 1);
        expect(await readFile(argvLog, 'utf8')).toContain(endpoint);
      }
      const connectedTimeout = spawnSync(command[0], [command[1], command[2].replace('/usr/bin/curl', stub), ...command.slice(3)], {
        env: { ...process.env, CANARY_ARGV_LOG: argvLog, CANARY_CURL_STATUS: '28', CANARY_REMOTE_IP: '127.0.0.1' },
      });
      expect(connectedTimeout.status).toBe(1);
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
