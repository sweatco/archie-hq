/**
 * Tests for `assertReadable`'s scope rule.
 *
 * The load-bearing case: a path granted through `allowWritePaths` alone is NOT readable
 * here, even though the OS sandbox and the PreToolUse guard both treat writable as
 * readable. That asymmetry is why a path agents produce shareable output in has to be in
 * both lists.
 *
 * Real directories and files throughout, because `assertInsideRoots` calls `realpath`;
 * the roots are resolved too, since macOS `mkdtemp` returns a path under the `/var`
 * symlink.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SandboxOptions } from '../sandbox.js';
import { assertReadable } from '../artifacts.js';

let root: string;
let writeOnlyDir: string;
let readableDir: string;
let outsideDir: string;
let writeOnlyFile: string;
let readableFile: string;
let outsideFile: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'archie-artifacts-')));
  writeOnlyDir = join(root, 'triggers-data', 'trg-20260817-1200-abc123');
  readableDir = join(root, 'workspace');
  outsideDir = join(root, 'elsewhere');
  for (const dir of [writeOnlyDir, readableDir, outsideDir]) {
    mkdirSync(dir, { recursive: true });
  }
  writeOnlyFile = join(writeOnlyDir, 'report.md');
  readableFile = join(readableDir, 'notes.md');
  outsideFile = join(outsideDir, 'secret.md');
  for (const file of [writeOnlyFile, readableFile, outsideFile]) {
    writeFileSync(file, 'x');
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function sandbox(overrides: Partial<SandboxOptions> = {}): SandboxOptions {
  return {
    cwd: readableDir,
    allowReadPaths: [readableDir],
    allowWritePaths: [writeOnlyDir],
    ...overrides,
  };
}

describe('assertReadable', () => {
  it('throws for a file under a root listed only in allowWritePaths', async () => {
    // Writable is not sufficient here, unlike at the sandbox and guard layers — so an
    // agent can write into a write-only path and then be refused when it tries to
    // share_artifact the result. CACHES_DIR is granted write-only and lives with that.
    await expect(assertReadable(writeOnlyFile, sandbox())).rejects.toThrow(
      /outside your readable sandbox/,
    );
  });

  it('resolves a file under a root in allowReadPaths', async () => {
    await expect(assertReadable(readableFile, sandbox())).resolves.toBe(readableFile);
  });

  it('throws for a file under neither root', async () => {
    await expect(assertReadable(outsideFile, sandbox())).rejects.toThrow(
      /outside your readable sandbox/,
    );
  });

  it('handles allowWritePaths being undefined', async () => {
    const readOnly = sandbox({ allowWritePaths: undefined });
    await expect(assertReadable(readableFile, readOnly)).resolves.toBe(readableFile);
  });
});
