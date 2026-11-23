import { execFile } from 'child_process';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'fs/promises';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { promisify } from 'util';
import { afterEach, describe, expect, it } from 'vitest';
import { LIVE_SETTINGS_ENV, readLiveSettings, type LiveSettings } from './live-settings.js';
import { buildPromptfooEnv, findFilesWrittenSince, isInside, parseInvocation } from './run.js';

const execFileAsync = promisify(execFile);

const roots: string[] = [];

/** Kernels stamp files from a clock coarser than Date.now(); this outlasts its tick. */
function pauseLongerThanFileClock(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('parseInvocation', () => {
  it('splits its own options from the ones passed to promptfoo eval', () => {
    const invocation = parseInvocation([
      '--data-dir',
      '/private/evals',
      'config.yaml',
      '--',
      '--repeat',
      '3',
    ]);
    expect(invocation).toMatchObject({ dataDir: '/private/evals', evalArgs: ['--repeat', '3'] });
  });

  it('requires a data directory and refuses sharing', () => {
    expect(() => parseInvocation(['config.yaml'])).toThrow('--data-dir is required');
    expect(() => parseInvocation(['--data-dir', '/d', 'config.yaml', '--', '--share'])).toThrow(
      'sharing is not allowed',
    );
  });

  it('is not a live run without instances', () => {
    expect(parseInvocation(['--data-dir', '/d', 'config.yaml']).live).toBeUndefined();
  });

  it('reads the instances and the spend cap of a live run', () => {
    const { live } = parseInvocation([
      '--data-dir',
      '/d',
      '--instance',
      'base=http://localhost:3001,/runs/base',
      '--instance',
      'candidate=http://127.0.0.1:3002/,/runs/candidate',
      '--spend-cap-usd',
      '2.5',
      'config.yaml',
    ]);
    expect(live).toEqual({
      instances: {
        base: { url: 'http://localhost:3001', checkout: '/runs/base' },
        candidate: { url: 'http://127.0.0.1:3002', checkout: '/runs/candidate' },
      },
      spendCapUsd: 2.5,
    });
  });

  it('refuses a live run without a cap, a cap without a live run, and a repeated label', () => {
    const live = (...options: string[]) =>
      parseInvocation(['--data-dir', '/d', ...options, 'config.yaml']);
    const base = ['--instance', 'base=http://localhost:3001,/runs/base'];

    expect(() => live(...base)).toThrow('--instance needs --spend-cap-usd');
    expect(() => live('--spend-cap-usd', '2')).toThrow(
      '--spend-cap-usd needs at least one --instance',
    );
    expect(() => live(...base, ...base, '--spend-cap-usd', '2')).toThrow(
      'instance "base" is given twice',
    );
    expect(() => live(...base, '--spend-cap-usd', '0')).toThrow('a positive number of dollars');
  });

  it.each([
    'https://localhost:3001',
    'http://localhost',
    'http://example.com:3001',
    'http://localhost.example.com:3001',
    'http://user@localhost:3001',
    'http://localhost:3001/api',
    'localhost:3001',
  ])('refuses %s as an instance URL', (url) => {
    expect(() =>
      parseInvocation([
        '--data-dir',
        '/d',
        '--instance',
        `base=${url},/runs/base`,
        '--spend-cap-usd',
        '2',
        'config.yaml',
      ]),
    ).toThrow('instance URL must look like http://localhost:<port>');
  });
});

describe('buildPromptfooEnv', () => {
  it('keeps promptfoo state in the data directory and its traffic local', () => {
    const env = buildPromptfooEnv(
      { PATH: '/bin', PROMPTFOO_CACHE_PATH: '/repo/cache', NO_PROXY: '*' },
      '/private/evals',
    );
    expect(env).toMatchObject({
      PATH: '/bin',
      PROMPTFOO_CONFIG_DIR: '/private/evals/promptfoo',
      PROMPTFOO_CACHE_PATH: '/private/evals/promptfoo/cache',
      PROMPTFOO_LOG_DIR: '/private/evals/promptfoo/logs',
      PROMPTFOO_DISABLE_TELEMETRY: '1',
      PROMPTFOO_DISABLE_UPDATE: '1',
      PROMPTFOO_DISABLE_SHARING: '1',
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: '',
    });
  });

  it('exempts only the instances of a live run from the proxy and hands them to the providers', () => {
    const live: LiveSettings = {
      instances: {
        base: { url: 'http://localhost:3001', checkout: '/runs/base' },
        candidate: { url: 'http://127.0.0.1:3002', checkout: '/runs/candidate' },
      },
      spendCapUsd: 2,
    };
    const env = buildPromptfooEnv({ NO_PROXY: '*' }, '/private/evals', live);

    expect(env).toMatchObject({
      HTTP_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: 'localhost:3001,127.0.0.1:3002',
      no_proxy: 'localhost:3001,127.0.0.1:3002',
    });
    expect(readLiveSettings(env)).toEqual(live);
  });

  it('does not inherit live settings from the calling environment', () => {
    const env = buildPromptfooEnv({ [LIVE_SETTINGS_ENV]: '{"stale":true}' }, '/private/evals');
    expect(env[LIVE_SETTINGS_ENV]).toBeUndefined();
    expect(readLiveSettings(env)).toBeUndefined();
  });

  it("sends Node's built-in fetch, http and https clients to the closed proxy", async () => {
    let connections = 0;
    const server = createServer((_request, response) => response.end('ok'));
    server.on('connection', () => (connections += 1));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--eval', NETWORK_ATTEMPTS, String(port)],
        { env: buildPromptfooEnv({}, '/private/evals') },
      );

      expect(JSON.parse(stdout)).toEqual({
        fetch: 'ECONNREFUSED',
        'http.get': 'ECONNREFUSED',
        'https.get': 'ECONNREFUSED',
      });
      expect(connections).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('lets a live run reach its instance and nothing else on this machine', async () => {
    const listen = async () => {
      let connections = 0;
      const server = createServer((_request, response) => response.end('ok'));
      server.on('connection', () => (connections += 1));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      return { server, port, connections: () => connections };
    };
    const instance = await listen();
    const other = await listen();
    const live: LiveSettings = {
      instances: {
        base: { url: `http://127.0.0.1:${instance.port}`, checkout: '/runs/base' },
      },
      spendCapUsd: 1,
    };

    try {
      const attempt = async (port: number) => {
        const { stdout } = await execFileAsync(
          process.execPath,
          ['--eval', NETWORK_ATTEMPTS, String(port)],
          { env: buildPromptfooEnv({}, '/private/evals', live) },
        );
        return JSON.parse(stdout) as Record<string, string>;
      };

      expect(await attempt(instance.port)).toMatchObject({
        fetch: 'connected',
        'http.get': 'connected',
      });
      expect(await attempt(other.port)).toEqual({
        fetch: 'ECONNREFUSED',
        'http.get': 'ECONNREFUSED',
        'https.get': 'ECONNREFUSED',
      });
      expect(instance.connections()).toBeGreaterThan(0);
      expect(other.connections()).toBe(0);
    } finally {
      for (const { server } of [instance, other]) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    }
  });
});

/** Each client in turn against a local server, printing how each attempt ended. */
const NETWORK_ATTEMPTS = `
const http = require('node:http');
const https = require('node:https');
const target = '127.0.0.1:' + process.argv[1];
const get = (client, url) =>
  new Promise((resolve, reject) => {
    client.get(url, { rejectUnauthorized: false }, (res) => { res.resume(); resolve(); }).on('error', reject);
  });
const attempts = {
  fetch: () => fetch('http://' + target + '/'),
  'http.get': () => get(http, 'http://' + target + '/'),
  'https.get': () => get(https, 'https://' + target + '/'),
};
(async () => {
  const outcome = {};
  for (const [name, attempt] of Object.entries(attempts)) {
    outcome[name] = await attempt().then(
      () => 'connected',
      (error) => error.code ?? error.cause?.code ?? String(error),
    );
  }
  console.log(JSON.stringify(outcome));
})();
`;

describe('repository guards', () => {
  it('treats the root and its descendants as inside', () => {
    expect(isInside('/repo', '/repo')).toBe(true);
    expect(isInside('/repo', '/repo/tools/x')).toBe(true);
    expect(isInside('/repo', '/repository')).toBe(false);
    expect(isInside('/repo', '/private/evals')).toBe(false);
  });

  it('finds checkout files created, changed or backdated since a moment, except ignored ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evals-run-'));
    roots.push(root);
    const write = async (path: string, text: string) => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    };
    const git = (...args: string[]) => execFileAsync('git', args, { cwd: root });
    await git('init', '-q');
    await write('.gitignore', 'workdir/\n*.log\n');
    for (const path of ['untouched.txt', 'nested/changed.txt', 'gone/file.txt']) {
      await write(path, 'before');
    }
    await git('add', '.');
    await write('nested/untracked-untouched.txt', 'before');
    await mkdir(join(root, 'embedded'));
    await execFileAsync('git', ['init', '-q'], { cwd: join(root, 'embedded') });
    await pauseLongerThanFileClock();
    const since = Date.now();
    await pauseLongerThanFileClock();

    await write('nested/changed.txt', 'after');
    await write('nested/deep/new.json', '{}');
    // A copy that keeps its source's timestamps is still a write.
    await write('copied.txt', 'x');
    const past = new Date(since - 60_000);
    await utimes(join(root, 'copied.txt'), past, past);
    // Ignored paths, .git and a nested repository are not part of this checkout's files.
    await write('workdir/sessions/task/shared/events.jsonl', '{}');
    await write('debug.log', 'x');
    await write('.git/description', 'after');
    await write('embedded/state.json', '{}');
    // Listed by git as tracked, but gone with its directory by the time it is stat'ed.
    await rm(join(root, 'gone'), { recursive: true });

    expect(await findFilesWrittenSince(root, since)).toEqual([
      'copied.txt',
      'nested/changed.txt',
      'nested/deep/new.json',
    ]);
  });
});
