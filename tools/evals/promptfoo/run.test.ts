import { mkdir, mkdtemp, rm, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPromptfooEnv, findFilesWrittenSince, isInside, parseInvocation } from './run.js';

const roots: string[] = [];

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
      HTTPS_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: '',
    });
  });
});

describe('repository guards', () => {
  it('treats the root and its descendants as inside', () => {
    expect(isInside('/repo', '/repo')).toBe(true);
    expect(isInside('/repo', '/repo/tools/x')).toBe(true);
    expect(isInside('/repo', '/repository')).toBe(false);
    expect(isInside('/repo', '/private/evals')).toBe(false);
  });

  it('finds files created or changed since a moment, outside .git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evals-run-'));
    roots.push(root);
    await mkdir(join(root, 'nested', 'deep'), { recursive: true });
    await mkdir(join(root, '.git'));
    for (const path of ['old.txt', 'nested/changed.txt', '.git/index']) {
      await writeFile(join(root, path), 'x');
    }
    const past = new Date(Date.now() - 60_000);
    await utimes(join(root, 'old.txt'), past, past);
    const since = Date.now() - 30_000;
    await writeFile(join(root, 'nested', 'deep', 'new.json'), '{}');

    expect(await findFilesWrittenSince(root, since)).toEqual([
      'nested/changed.txt',
      'nested/deep/new.json',
    ]);
  });
});
