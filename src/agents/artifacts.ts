/**
 * Artifact Sharing
 *
 * Helpers backing the `share_artifact` tool and the `artifact_paths` parameter
 * on `post_to_user`. Agents call into these from their tool handlers, which run
 * in the Node process — bypassing the per-agent OS sandbox while still enforcing
 * the same read-scope rules (so agents cannot publish files they could not have
 * read in the first place).
 *
 * Storage layout: `<task>/shared/artifacts/<basename>.<8hex>.<ext>` (flat).
 * Same content + same basename+ext is deduped: re-sharing returns the existing
 * path. New content alongside an existing basename creates a new versioned file
 * — version history is preserved for free.
 */

import { mkdir, copyFile, readFile, readdir, realpath } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { join, basename, extname, sep, isAbsolute } from 'path';
import type { SandboxOptions } from './sandbox.js';
import { getArtifactsPath } from '../tasks/persistence.js';

/**
 * Resolve `inputPath` to an absolute, real (symlink-followed) path that lives
 * inside the sandbox's read scope. Throws on any rule violation.
 *
 * Companion to a future `assertWritable` (sandbox.allowWritePaths) — the pair
 * keeps the call sites readable while sharing the same root-validation logic.
 */
export async function assertReadable(
  inputPath: string,
  sandbox: SandboxOptions,
): Promise<string> {
  return assertInsideRoots(inputPath, sandbox.allowReadPaths, 'readable');
}

async function assertInsideRoots(
  inputPath: string,
  roots: readonly string[],
  scope: 'readable' | 'writable',
): Promise<string> {
  if (!inputPath) {
    throw new Error('Path is required.');
  }
  if (!isAbsolute(inputPath)) {
    throw new Error(`Path must be absolute: ${inputPath}`);
  }
  let resolved: string;
  try {
    resolved = await realpath(inputPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot access path: ${reason}`);
  }
  const allowed = roots.some((root) => isPathInside(resolved, root));
  if (!allowed) {
    throw new Error(
      `Path is outside your ${scope} sandbox: ${inputPath} (resolved to ${resolved}).`,
    );
  }
  return resolved;
}

/**
 * Copy `sourcePath` into the task's shared artifacts folder, deduping by
 * content hash within the same basename+extension. Returns the absolute target
 * path and whether an existing artifact was reused.
 */
export async function copyArtifactToShared(
  taskId: string,
  sourcePath: string,
): Promise<{ artifactPath: string; reused: boolean }> {
  const artifactsDir = getArtifactsPath(taskId);
  if (!existsSync(artifactsDir)) {
    await mkdir(artifactsDir, { recursive: true });
  }

  const ext = extname(sourcePath);
  const stem = basename(sourcePath, ext);
  const sourceHash = await hashFile(sourcePath);

  // Look for an existing `<stem>.<hex>.<ext>` whose content already matches.
  const existing = await findExistingArtifact(artifactsDir, stem, ext, sourceHash);
  if (existing) {
    return { artifactPath: existing, reused: true };
  }

  const versionTag = randomUUID().replace(/-/g, '').slice(0, 8);
  const targetName = ext ? `${stem}.${versionTag}${ext}` : `${stem}.${versionTag}`;
  const targetPath = join(artifactsDir, targetName);
  await copyFile(sourcePath, targetPath);
  return { artifactPath: targetPath, reused: false };
}

async function hashFile(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}

async function findExistingArtifact(
  dir: string,
  stem: string,
  ext: string,
  hash: string,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  // Match `<stem>.<anything>.<ext>` (or `<stem>.<anything>` when no ext).
  const prefix = `${stem}.`;
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    if (ext) {
      if (!name.endsWith(ext)) continue;
    } else {
      // No-ext artifact: skip names that contain a dot beyond the version tag.
      const middle = name.slice(prefix.length);
      if (middle.includes('.')) continue;
    }
    const candidate = join(dir, name);
    if ((await hashFile(candidate)) === hash) {
      return candidate;
    }
  }
  return null;
}

function isPathInside(child: string, parent: string): boolean {
  const c = child.endsWith(sep) ? child : child + sep;
  const p = parent.endsWith(sep) ? parent : parent + sep;
  return c.startsWith(p);
}
