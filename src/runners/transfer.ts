import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { create, extract, list } from 'tar';

export interface RepositoryArchive {
  path: string;
  size: number;
  fileCount: number;
  stream(): AsyncIterable<Uint8Array>;
  cleanup(): Promise<void>;
}

export function assertRelativeRunnerPath(value: string): string {
  if (!value || /[\0-\x1f\x7f]/.test(value) || isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
    throw new Error(`Runner path must be relative and may not contain '..': ${value}`);
  }
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function collectGitFiles(cwd: string): Promise<string[]> {
  return new Promise((resolveFiles, reject) => {
    const child = spawn('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 64 * 1024 * 1024) child.kill('SIGKILL');
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code !== 0) {
        reject(new Error(`git ls-files failed${signal ? ` (${signal})` : ''}: ${Buffer.concat(stderr).toString('utf8').trim()}`));
        return;
      }
      const data = Buffer.concat(stdout);
      const files = data.subarray(0, data.length > 0 && data[data.length - 1] === 0 ? -1 : undefined)
        .toString('utf8')
        .split('\0')
        .filter(Boolean)
        .map(assertRelativeRunnerPath);
      resolveFiles(files);
    });
  });
}

export async function createRepositoryArchive(cwd: string, maxBytes: number): Promise<RepositoryArchive> {
  const candidates = await collectGitFiles(cwd);
  if (candidates.length > 100000) throw new Error('Repository snapshot exceeds the 100000-file limit');
  const files: string[] = [];
  let sourceBytes = 0;
  for (const file of candidates) {
    const source = resolve(cwd, file);
    if (!source.startsWith(`${resolve(cwd)}${sep}`)) throw new Error(`Repository path escapes clone: ${file}`);
    const entry = await lstat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!entry || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    files.push(file);
    sourceBytes += entry.size;
    if (sourceBytes > maxBytes) throw new Error(`Repository snapshot exceeds the ${maxBytes}-byte upload limit`);
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'archie-runner-upload-'));
  const archivePath = join(tempDir, 'repo.tar');
  try {
    await create({ cwd, file: archivePath, portable: true, noMtime: true, noDirRecurse: true }, files);
    const archiveSize = (await stat(archivePath)).size;
    if (archiveSize > maxBytes) throw new Error(`Repository archive exceeds the ${maxBytes}-byte upload limit`);
    return {
      path: archivePath,
      size: archiveSize,
      fileCount: files.length,
      stream: () => createReadStream(archivePath),
      cleanup: () => rm(tempDir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function safeArchivePath(value: string): string | null {
  const normalized = posix.normalize(value.replaceAll('\\', '/')).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

export async function extractRunnerArchive(archivePath: string, destination: string, maxBytes: number): Promise<void> {
  let expandedBytes = 0;
  let entries = 0;
  let unsafe: string | undefined;
  await list({
    file: archivePath,
    onReadEntry: (entry) => {
      entries += 1;
      if (entries > 10000) unsafe ??= 'Collected archive exceeds the 10000-entry limit';
      const path = safeArchivePath(entry.path);
      if (!path) unsafe ??= `Unsafe archive path: ${entry.path}`;
      if (entry.type === 'Link') unsafe ??= `Hard links are not accepted: ${entry.path}`;
      if (!['File', 'Directory', 'SymbolicLink'].includes(entry.type)) unsafe ??= `Unsupported archive entry type ${entry.type}: ${entry.path}`;
      if (entry.type === 'SymbolicLink') {
        const link = entry.linkpath ? entry.linkpath.replaceAll('\\', '/') : '';
        const resolved = safeArchivePath(posix.join(posix.dirname(path ?? ''), link));
        if (!link || posix.isAbsolute(link) || !resolved) unsafe ??= `Unsafe symbolic link: ${entry.path}`;
      }
      expandedBytes += entry.size;
      if (expandedBytes > maxBytes) unsafe ??= `Collected artifacts exceed the ${maxBytes}-byte download limit`;
    },
  });
  if (unsafe) throw new Error(unsafe);

  await mkdir(destination, { recursive: false });
  await extract({ cwd: destination, file: archivePath, strict: true, preservePaths: false, noMtime: true });
}

export function collectionName(): string {
  return `${Date.now()}-${randomUUID()}`;
}
