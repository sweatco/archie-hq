/**
 * Tests for `assertReadable`'s scope rule.
 *
 * The load-bearing case is (a): a path granted through `allowWritePaths` alone —
 * which the persistent per-trigger directory is the first of — must resolve, so
 * an agent can `share_artifact` a file it just legitimately wrote. That mirrors
 * the OS-level PreToolUse guard, where writable already implies readable
 * (src/agents/sandbox.ts:236-237).
 *
 * Real directories and real files throughout, because `assertInsideRoots` calls
 * `realpath` and throws `Cannot access path` on anything that isn't on disk. The
 * roots are pushed through `realpath` too: on macOS `mkdtemp` hands back a path
 * under `/var`, which is a symlink to `/private/var`, so an unresolved root would
 * never contain the resolved file.
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
  it('resolves a file under a root listed only in allowWritePaths', async () => {
    // The trigger directory's shape: writable, absent from allowReadPaths.
    await expect(assertReadable(writeOnlyFile, sandbox())).resolves.toBe(writeOnlyFile);
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
