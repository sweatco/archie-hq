import { execFile } from 'child_process';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { promisify } from 'util';
import { afterEach, describe, expect, it } from 'vitest';
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
