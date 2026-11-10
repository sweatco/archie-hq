// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repository = fileURLToPath(new URL('../../', import.meta.url));
let workspace = '';

function writeFixture(path: string, content: string): void {
  const destination = join(workspace, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function runTool(entrypoint: string, args: string[]) {
  const result = spawnSync(
    process.execPath,
    [join(repository, 'node_modules', entrypoint), ...args],
    {
      cwd: workspace,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      timeout: 20_000,
    },
  );
  if (result.error) throw result.error;
  return result;
}

function lint(...args: string[]) {
  return runTool('oxlint/bin/oxlint', ['--format', 'json', ...(args.length ? args : ['.'])]);
}

function format(...args: string[]) {
  return runTool('prettier/bin/prettier.cjs', args);
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'archie-quality-'));
  for (const config of ['.oxlintrc.json', '.prettierrc.json', '.prettierignore']) {
    copyFileSync(join(repository, config), join(workspace, config));
  }
  // Resolve the real installed library types without copying credentials or runtime state.
  symlinkSync(join(repository, 'node_modules'), join(workspace, 'node_modules'), 'dir');
  writeFixture('package.json', '{"type":"module"}\n');
  writeFixture(
    'tsconfig.json',
    JSON.stringify({
      extends: join(repository, 'tsconfig.json'),
      compilerOptions: { rootDir: '.', noEmit: true, types: ['node'] },
      include: ['src/**/*'],
    }),
  );
  for (const directory of ['tools', 'scripts']) {
    const project = `${directory}/tsconfig.json`;
    writeFixture(project, readFileSync(join(repository, project), 'utf8'));
  }
});

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = '';
});

describe('quality checks through the installed CLIs', () => {
  it('checks both TypeScript and TSX instead of silently skipping either', () => {
    writeFixture('src/plain.ts', 'export const value: any = 1;\n');
    writeFixture('src/cli/view.tsx', 'export const view: any = <span />;\n');
    const result = lint();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('src/plain.ts');
    expect(result.stdout).toContain('src/cli/view.tsx');
    expect(result.stdout).toContain('typescript(no-explicit-any)');
  });

  it('rejects a bare void promise and accepts owned rejection handling in every typed scope', () => {
    for (const directory of ['src', 'tools', 'scripts']) {
      writeFixture(`${directory}/promise.ts`, 'void Promise.resolve(1);\nexport {};\n');
      const unhandled = lint(`${directory}/promise.ts`);
      expect(unhandled.status).toBe(1);
      expect(unhandled.stdout).toContain('typescript(no-floating-promises)');
      writeFixture(
        `${directory}/promise.ts`,
        'void Promise.resolve(1).catch(() => undefined);\nexport {};\n',
      );
      expect(lint(`${directory}/promise.ts`).status).toBe(0);
    }
  });

  it('permits console only in the logger and standalone tooling', () => {
    writeFixture('src/system/logger.ts', "console.log('owned output');\nexport {};\n");
    writeFixture('tools/output.ts', "console.log('tool output');\nexport {};\n");
    const permitted = lint();
    expect(permitted.status, permitted.stdout + permitted.stderr).toBe(0);
    writeFixture('src/other.ts', "console.log('unowned output');\nexport {};\n");
    const result = lint();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('eslint(no-console)');
  });

  it('rejects focused tests and conditional React hooks', () => {
    writeFixture(
      'src/example.test.ts',
      "import { expect, test } from 'vitest';\ntest.only('focused', () => { expect(1).toBe(1); });\n",
    );
    writeFixture(
      'src/cli/view.tsx',
      "import { useState } from 'react';\nexport function View({ enabled }: { enabled: boolean }) { if (enabled) useState(0); return null; }\n",
    );
    const result = lint();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('no-focused-tests');
    expect(result.stdout).toContain('rules-of-hooks');
  });

  it('accepts Vitest diagnostic messages but rejects assertions without a matcher', () => {
    writeFixture(
      'src/example.test.ts',
      "import { expect, test } from 'vitest';\ntest('valid', () => { expect(1, 'diagnostic message').toBe(1); });\n",
    );
    expect(lint().status).toBe(0);
    writeFixture(
      'src/example.test.ts',
      "import { expect, test } from 'vitest';\ntest('incomplete', () => { expect(1); });\n",
    );
    const incomplete = lint();
    expect(incomplete.status).toBe(1);
    expect(incomplete.stdout).toContain('valid-expect');
  });

  it('rejects runtime cycles while permitting type-only relationships', () => {
    writeFixture('src/a.ts', "import { b } from './b.js';\nexport function a() { return b; }\n");
    writeFixture('src/b.ts', "import { a } from './a.js';\nexport function b() { return a; }\n");
    const cyclic = lint();
    expect(cyclic.status).toBe(1);
    expect(cyclic.stdout).toContain('import(no-cycle)');
    writeFixture(
      'src/a.ts',
      "import type { B } from './b.js';\nexport interface A { other?: B }\n",
    );
    writeFixture(
      'src/b.ts',
      "import type { A } from './a.js';\nexport interface B { other?: A }\n",
    );
    expect(lint().status).toBe(0);
  });

  it('fails unused disable directives', () => {
    writeFixture(
      'src/clean.ts',
      '// oxlint-disable-next-line typescript/no-explicit-any -- unnecessary exception\nexport const value = 1;\n',
    );
    expect(lint().status).toBe(1);
  });

  it('keeps normal lint read-only and rejects debt above its allowance or stale allowances', () => {
    writeFixture('src/debt.ts', 'export const debt: any = 1;\n');
    expect(lint('--suppress-all', '.').status).toBe(0);
    const baselinePath = join(workspace, 'oxlint-suppressions.json');
    const baseline = readFileSync(baselinePath, 'utf8');
    expect(lint().status).toBe(0);
    expect(readFileSync(baselinePath, 'utf8')).toBe(baseline);

    writeFixture('src/debt.ts', 'export const debt: any = 1;\nexport const extraDebt: any = 2;\n');
    expect(lint().status).toBe(1);
    expect(readFileSync(baselinePath, 'utf8')).toBe(baseline);
    expect(lint('--prune-suppressions', '.').status).toBe(1);
    expect(readFileSync(baselinePath, 'utf8')).toBe(baseline);

    writeFixture('src/debt.ts', 'export const debt = 1;\n');
    const stale = lint();
    expect(stale.status).toBe(1);
    expect(stale.stdout).toContain('--prune-suppressions');
    expect(lint('--prune-suppressions', '.').status).toBe(0);
    expect(lint().status).toBe(0);
  });

  it('formats idempotently without changing excluded prompts, skills, output or historical evidence', () => {
    writeFixture('src/value.ts', 'export const value={label:"hello"};\n');
    const excluded = [
      'prompts/pm-agent.md',
      'core-plugin/skills/example/SKILL.md',
      'docs/plans/historical.md',
      'dist/generated.ts',
      'package-lock.json',
      'oxlint-suppressions.json',
      'CHANGELOG.md',
    ];
    const original = 'intentionally   unformatted\n  preserve these bytes\n';
    for (const path of excluded) writeFixture(path, original);
    expect(format('--check', '.').status).toBe(1);
    expect(format('--write', '.').status).toBe(0);
    const formatted = readFileSync(join(workspace, 'src/value.ts'), 'utf8');
    expect(formatted).toBe("export const value = { label: 'hello' };\n");
    expect(format('--write', '.').status).toBe(0);
    expect(readFileSync(join(workspace, 'src/value.ts'), 'utf8')).toBe(formatted);
    expect(format('--check', '.').status).toBe(0);
    for (const path of excluded) expect(readFileSync(join(workspace, path), 'utf8')).toBe(original);
  });
});
