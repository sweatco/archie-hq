/**
 * Unit tests for the web-artifacts pointer layer.
 *
 * Covers the security-relevant render pipeline (AC4), taskId-free public
 * identity across tasks (AC3), in-place update semantics (AC2 core), and
 * external-id parsing.
 *
 * The pointer store (`WEB_ARTIFACTS_DIR`) and the snapshot substrate
 * (`getArtifactsPath`) are redirected at temp directories via mutable module
 * bindings referenced lazily from the mock factories.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

let tempDir: string;
let webArtifactsDir: string;
let tasksRoot: string;

vi.mock('../../system/workdir.js', () => ({
  get WEB_ARTIFACTS_DIR() {
    return webArtifactsDir;
  },
}));

vi.mock('../../tasks/persistence.js', () => ({
  getArtifactsPath: (taskId: string) => join(tasksRoot, taskId, 'shared', 'artifacts'),
}));

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  publishWebArtifact,
  updateWebArtifact,
  resolveWebArtifact,
  renderMarkdownArtifact,
  parseExternalId,
} from '../web-artifacts.js';

/** Write a source markdown file and return its absolute path. */
async function writeSource(name: string, content: string): Promise<string> {
  const path = join(tempDir, name);
  await writeFile(path, content, 'utf-8');
  return path;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'archie-web-artifacts-'));
  webArtifactsDir = join(tempDir, 'web-artifacts');
  tasksRoot = join(tempDir, 'tasks');
  await mkdir(tasksRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('renderMarkdownArtifact (AC4)', () => {
  it('neutralizes <script> tags', () => {
    const html = renderMarkdownArtifact('# Hi\n\n<script>alert(1)</script>\n');
    expect(html).not.toMatch(/<script/i);
  });

  it('does not emit a live <img> with an onerror handler', () => {
    const html = renderMarkdownArtifact('<img src=x onerror=alert(1)>\n');
    // html:false escapes the raw tag, so no <img> element (and thus no live
    // onerror attribute) survives into the output.
    expect(html).not.toMatch(/<img/i);
  });

  it('strips javascript: links', () => {
    const html = renderMarkdownArtifact('[click me](javascript:alert(1))\n');
    expect(html).not.toMatch(/href\s*=\s*["']?javascript:/i);
  });

  it('preserves headings, lists, and safe links', () => {
    const html = renderMarkdownArtifact(
      '# Title\n\n- one\n- two\n\n[example](https://example.com)\n',
    );
    expect(html).toMatch(/<h1[^>]*>Title<\/h1>/);
    expect(html).toMatch(/<ul>/);
    expect(html).toMatch(/<li>one<\/li>/);
    expect(html).toMatch(/<a[^>]*href="https:\/\/example\.com"[^>]*>example<\/a>/);
  });
});

describe('publishWebArtifact (AC3)', () => {
  it('yields distinct external ids that do not encode the taskId', async () => {
    const taskA = 'task-alpha-111';
    const taskB = 'task-beta-222';
    const srcA = await writeSource('a.md', '# A\n');
    const srcB = await writeSource('b.md', '# B\n');

    const a = await publishWebArtifact({
      taskId: taskA,
      resolvedSourcePath: srcA,
      sourceFilename: 'a.md',
    });
    const b = await publishWebArtifact({
      taskId: taskB,
      resolvedSourcePath: srcB,
      sourceFilename: 'b.md',
    });

    expect(a.externalId).not.toBe(b.externalId);
    // The public identity (id → `/a/<id>` URL) must not carry the taskId.
    expect(a.externalId).not.toContain(taskA);
    expect(b.externalId).not.toContain(taskB);
    expect(`/a/${a.externalId}`).not.toContain(taskA);
    expect(`/a/${b.externalId}`).not.toContain(taskB);

    // Snapshots land under each producing task's substrate.
    expect(a.snapshotPath).toContain(join(taskA, 'shared', 'artifacts'));
    expect(b.snapshotPath).toContain(join(taskB, 'shared', 'artifacts'));
  });
});

describe('updateWebArtifact (AC2 core)', () => {
  it('keeps the external id and advances the snapshot path + updatedAt', async () => {
    const taskId = 'task-update-1';
    const v1 = await writeSource('doc.md', '# Version 1\n');
    const published = await publishWebArtifact({
      taskId,
      resolvedSourcePath: v1,
      sourceFilename: 'doc.md',
    });
    const before = await resolveWebArtifact(published.externalId);
    expect(before).not.toBeNull();

    // Different content → a new immutable snapshot alongside the old one.
    const v2 = await writeSource('doc2.md', '# Version 2 — different\n');
    const updated = await updateWebArtifact({
      externalId: published.externalId,
      taskId,
      resolvedSourcePath: v2,
    });

    expect(updated.externalId).toBe(published.externalId);
    expect(updated.snapshotPath).not.toBe(before!.snapshotPath);
    expect(
      new Date(updated.updatedAt).getTime() >= new Date(before!.createdAt).getTime(),
    ).toBe(true);

    // Both snapshots persist (immutable substrate) and the pointer now points
    // at the newer one.
    const artifactsDir = join(tasksRoot, taskId, 'shared', 'artifacts');
    const files = await readdir(artifactsDir);
    expect(files.length).toBe(2);

    const reloaded = await resolveWebArtifact(published.externalId);
    expect(reloaded!.snapshotPath).toBe(updated.snapshotPath);
  });

  it('refuses to update from a different task', async () => {
    const src = await writeSource('owned.md', '# Owned\n');
    const published = await publishWebArtifact({
      taskId: 'owner-task',
      resolvedSourcePath: src,
      sourceFilename: 'owned.md',
    });
    const other = await writeSource('other.md', '# Other\n');

    await expect(
      updateWebArtifact({
        externalId: published.externalId,
        taskId: 'intruder-task',
        resolvedSourcePath: other,
      }),
    ).rejects.toThrow(/different task/i);
  });

  it('throws a clear error for an unknown external id', async () => {
    const src = await writeSource('x.md', '# X\n');
    await expect(
      updateWebArtifact({
        externalId: randomUUID(),
        taskId: 'any-task',
        resolvedSourcePath: src,
      }),
    ).rejects.toThrow(/unknown web artifact/i);
  });
});

describe('parseExternalId', () => {
  it('accepts a raw id', () => {
    const id = randomUUID();
    expect(parseExternalId(id)).toBe(id);
  });

  it('accepts a /a/<id> path', () => {
    const id = randomUUID();
    expect(parseExternalId(`/a/${id}`)).toBe(id);
  });

  it('extracts the id from a /a/<id>/source path and a full URL', () => {
    const id = randomUUID();
    expect(parseExternalId(`/a/${id}/source`)).toBe(id);
    expect(parseExternalId(`https://archie.example.com/a/${id}`)).toBe(id);
  });

  it('returns null for malformed input', () => {
    expect(parseExternalId('not-a-uuid')).toBeNull();
    expect(parseExternalId('/a/../etc/passwd')).toBeNull();
    expect(parseExternalId('')).toBeNull();
  });
});
