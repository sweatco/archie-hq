import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { emitEvent } from '../system/event-bus.js';
import { SESSIONS_DIR } from '../system/workdir.js';
import { getArtifactsPath } from '../tasks/persistence.js';
import { profileWorkspaceRoot } from './config.js';
import type { TransferCommand } from './execution.js';
import {
  collectionName,
  createRepositoryArchive,
  extractRunnerArchive,
} from './transfer.js';
import type { RunnerLease, RunnerProfile } from './types.js';

interface WorkspaceHooks {
  transfer(lease: RunnerLease, profile: RunnerProfile, command: TransferCommand): Promise<void>;
  persist(taskId: string): Promise<void>;
  touch(lease: RunnerLease, profile: RunnerProfile): void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'runner';
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertDescendant(parent: string, child: string, message: string): void {
  const path = relative(parent, child);
  if (path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) throw new Error(message);
}

export function runnerRepositoryPath(profile: RunnerProfile, github: string): string {
  const components = github.split('/').map(sanitizeName);
  const leaf = components.pop() ?? 'repo';
  const digest = createHash('sha256').update(github).digest('hex').slice(0, 12);
  return posix.join(profileWorkspaceRoot(profile), 'workspace', ...components, `${leaf}-${digest}`);
}

export class RunnerWorkspace {
  constructor(private readonly hooks: WorkspaceHooks) {}

  async sync(
    lease: RunnerLease,
    profile: RunnerProfile,
    github: string,
    clonePath: string,
    signal?: AbortSignal,
  ): Promise<{ lease: RunnerLease; remotePath: string; bytes: number; files: number }> {
    const archive = await createRepositoryArchive(clonePath, profile.maxUploadBytes);
    const remotePath = runnerRepositoryPath(profile, github);
    const staging = `${remotePath}.staging-${randomUUID().slice(0, 8)}`;
    const previous = `${remotePath}.previous`;
    const script = [
      'set -eu',
      `mkdir -p ${shellQuote(posix.dirname(remotePath))}`,
      `rm -rf ${shellQuote(staging)} ${shellQuote(previous)}`,
      `mkdir -p ${shellQuote(staging)}`,
      `/usr/bin/tar -xpf - -C ${shellQuote(staging)}`,
      `[ ! -e ${shellQuote(remotePath)} ] || mv ${shellQuote(remotePath)} ${shellQuote(previous)}`,
      `mv ${shellQuote(staging)} ${shellQuote(remotePath)}`,
      `rm -rf ${shellQuote(previous)}`,
    ].join('\n');
    try {
      await this.hooks.transfer(lease, profile, {
        argv: ['/bin/sh', '-lc', script],
        stdin: archive.stream(),
        signal,
      });
      lease.syncedRepos[github] = { github, remotePath, syncedAt: nowIso() };
      this.hooks.touch(lease, profile);
      await this.hooks.persist(lease.taskId);
      emitEvent('runner:sync', lease.taskId, {
        leaseId: lease.id,
        profile: lease.profile,
        github,
        bytes: archive.size,
        files: archive.fileCount,
      }, lease.agentId);
      return { lease, remotePath, bytes: archive.size, files: archive.fileCount };
    } finally {
      await archive.cleanup();
    }
  }

  async collect(
    lease: RunnerLease,
    profile: RunnerProfile,
    github: string,
    paths: string[],
    signal?: AbortSignal,
  ): Promise<string> {
    const synced = lease.syncedRepos[github];
    if (!synced) throw new Error(`Repository ${github} has not been synced to runner profile ${lease.profile}`);
    const tempDir = await mkdtemp(join(tmpdir(), 'archie-runner-download-'));
    const archivePath = join(tempDir, 'artifacts.tar');
    const output = createWriteStream(archivePath, { mode: 0o600 });
    const outputDone = finished(output);
    void outputDone.catch(() => {});
    let bytes = 0;
    try {
      await this.hooks.transfer(lease, profile, {
        argv: ['/usr/bin/tar', '-cf', '-', '--', ...paths],
        cwd: synced.remotePath,
        onStdout: async (data) => {
          bytes += data.byteLength;
          if (bytes > profile.maxDownloadBytes) {
            throw new Error(`Collected archive exceeds the ${profile.maxDownloadBytes}-byte download limit`);
          }
          if (!output.write(data)) await Promise.race([once(output, 'drain'), outputDone]);
        },
        signal,
      });
      output.end();
      await outputDone;
      if ((await stat(archivePath)).size !== bytes) throw new Error('Collected archive was not written completely');

      const sessionsRoot = resolve(SESSIONS_DIR);
      const artifactsRoot = resolve(getArtifactsPath(lease.taskId));
      assertDescendant(sessionsRoot, artifactsRoot, 'Runner artifacts path escapes the sessions directory');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(lease.id)) {
        throw new Error(`Invalid runner lease id: ${lease.id}`);
      }
      const parent = resolve(artifactsRoot, 'runners', lease.id);
      assertDescendant(artifactsRoot, parent, 'Runner lease path escapes the task artifacts directory');
      await mkdir(parent, { recursive: true });
      const destination = resolve(parent, collectionName());
      assertDescendant(parent, destination, 'Runner collection path escapes the lease directory');
      await extractRunnerArchive(archivePath, destination, parent, profile.maxDownloadBytes);

      this.hooks.touch(lease, profile);
      await this.hooks.persist(lease.taskId);
      emitEvent('runner:artifacts', lease.taskId, {
        leaseId: lease.id,
        profile: lease.profile,
        github,
        paths,
        bytes,
        destination,
      }, lease.agentId);
      return destination;
    } finally {
      output.destroy();
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
