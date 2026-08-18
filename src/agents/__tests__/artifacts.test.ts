/**
 * Tests for `assertReadable`'s scope rule.
 *
 * The load-bearing case is that a path granted through `allowWritePaths` alone is
 * NOT readable here, even though the OS sandbox and the PreToolUse guard both
 * treat writable as readable (see the read check in `createFilesystemGuardHooks`,
 * src/agents/sandbox.ts). That asymmetry is the reason a path agents are expected
 * to produce shareable output in has to be granted in both lists — which is what
 * `grantTriggerDataAccess` does for a trigger's directory. `CACHES_DIR` is granted
 * write-only and lives with the consequence: its files cannot be shared through
 * the artifact tools.
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
  it('throws for a file under a root listed only in allowWritePaths', async () => {
    // Writable is NOT sufficient here, and this is the constraint that decides how
    // a read-write path must be granted. The OS sandbox and the PreToolUse read
    // check both treat writable as readable, but this helper validates against
    // allowReadPaths alone — so an agent can write a file into a write-only path
    // and then be refused when it tries to share_artifact the result.
    //
    // That is why a trigger's persistent directory is granted in BOTH lists (see
    // grantTriggerDataAccess) rather than write-only. CACHES_DIR, the shared
    // package-manager cache, is granted write-only and does hit this: its files
    // cannot be shared through the artifact tools. Nobody has needed to, so it
    // stands as a documented limitation rather than a bug.
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
