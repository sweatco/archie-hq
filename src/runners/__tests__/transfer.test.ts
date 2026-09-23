import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { create, extract } from 'tar';
import { assertRelativeRunnerPath, createRepositoryArchive, extractRunnerArchive } from '../transfer.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runner transfers', () => {
  it('rejects absolute paths and traversal', () => {
    expect(() => assertRelativeRunnerPath('/tmp/file')).toThrow(/relative/);
    expect(() => assertRelativeRunnerPath('../file')).toThrow(/relative/);
    expect(assertRelativeRunnerPath('./build/result.xcresult')).toBe('build/result.xcresult');
  });

  it('archives tracked and unignored files while excluding ignored files and .git', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'archie-runner-repo-'));
    const output = await mkdtemp(join(tmpdir(), 'archie-runner-extract-'));
    tempDirs.push(repo, output);
    await execFileAsync('git', ['init'], { cwd: repo });
    await writeFile(join(repo, 'tracked.txt'), 'tracked');
    await writeFile(join(repo, 'untracked.txt'), 'untracked');
    await writeFile(join(repo, 'ignored.log'), 'ignored');
    await writeFile(join(repo, 'deleted.txt'), 'deleted');
    await writeFile(join(repo, '.gitignore'), '*.log\n');
    await execFileAsync('git', ['add', 'tracked.txt', 'deleted.txt'], { cwd: repo });
    await unlink(join(repo, 'deleted.txt'));

    const archive = await createRepositoryArchive(repo, 1024 * 1024);
    await extract({ cwd: output, file: archive.path });
    expect(await readFile(join(output, 'tracked.txt'), 'utf8')).toBe('tracked');
    expect(await readFile(join(output, 'untracked.txt'), 'utf8')).toBe('untracked');
    expect(existsSync(join(output, 'ignored.log'))).toBe(false);
    expect(existsSync(join(output, 'deleted.txt'))).toBe(false);
    expect(existsSync(join(output, '.git'))).toBe(false);
    await archive.cleanup();
  });

  it('rejects archive symlinks that escape the collection directory', async () => {
    const source = await mkdtemp(join(tmpdir(), 'archie-runner-malicious-'));
    const parent = await mkdtemp(join(tmpdir(), 'archie-runner-collect-'));
    tempDirs.push(source, parent);
    await mkdir(join(source, 'nested'));
    await symlink('../../../outside', join(source, 'nested', 'escape'));
    const archive = join(source, 'bad.tar');
    await create({ cwd: source, file: archive }, ['nested']);
    await expect(extractRunnerArchive(archive, join(parent, 'output'), parent, 1024 * 1024)).rejects.toThrow(/Unsafe symbolic link/);
  });

  it('does not read tracked files through a replaced directory symlink', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'archie-runner-replaced-'));
    const outside = await mkdtemp(join(tmpdir(), 'archie-runner-private-'));
    tempDirs.push(repo, outside);
    await execFileAsync('git', ['init', '-q'], { cwd: repo });
    await mkdir(join(repo, 'nested'));
    await writeFile(join(repo, 'nested', 'secret.txt'), 'tracked');
    await execFileAsync('git', ['add', 'nested/secret.txt'], { cwd: repo });
    await writeFile(join(outside, 'secret.txt'), 'host secret');
    await rm(join(repo, 'nested'), { recursive: true });
    await symlink(outside, join(repo, 'nested'));

    await expect(createRepositoryArchive(repo, 1024 * 1024)).rejects.toThrow(/symbolic link/);
  });

  it('archives a literal @ filename without interpreting it as another archive', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'archie-runner-at-file-'));
    const output = await mkdtemp(join(tmpdir(), 'archie-runner-at-output-'));
    tempDirs.push(repo, output);
    await execFileAsync('git', ['init', '-q'], { cwd: repo });
    await writeFile(join(repo, '@notes'), 'literal file');

    const archive = await createRepositoryArchive(repo, 1024 * 1024);
    try {
      await extract({ cwd: output, file: archive.path });
      expect(await readFile(join(output, '@notes'), 'utf8')).toBe('literal file');
    } finally {
      await archive.cleanup();
    }
  });

  it('rejects a destination outside its allowed root', async () => {
    const source = await mkdtemp(join(tmpdir(), 'archie-runner-source-'));
    const allowed = await mkdtemp(join(tmpdir(), 'archie-runner-allowed-'));
    const outside = await mkdtemp(join(tmpdir(), 'archie-runner-outside-'));
    tempDirs.push(source, allowed, outside);
    await writeFile(join(source, 'artifact.txt'), 'artifact');
    const archive = join(source, 'artifact.tar');
    await create({ cwd: source, file: archive }, ['artifact.txt']);

    await expect(extractRunnerArchive(archive, join(outside, 'output'), allowed, 1024 * 1024)).rejects.toThrow(/allowed root/);
  });
});
