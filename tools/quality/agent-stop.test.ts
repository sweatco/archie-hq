// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const decisionSchema = z.object({
  decision: z.literal('block').optional(),
  reason: z.string().optional(),
  systemMessage: z.string().optional(),
});
const configSchema = z.object({
  hooks: z.object({
    Stop: z.array(
      z.object({
        hooks: z.array(
          z.object({
            type: z.literal('command'),
            command: z.string(),
            timeout: z.number(),
          }),
        ),
      }),
    ),
  }),
});
let workspace: string;
let commands: string;

function writeFixture(path: string, content: string) {
  const file = join(workspace, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function runHook(input: Record<string, unknown> = {}, env = process.env, command?: string) {
  const result = spawnSync(
    command ? '/bin/sh' : process.execPath,
    command ? ['-c', command] : [join(workspace, 'tools/quality/agent-stop.mjs')],
    {
      cwd: join(workspace, 'src'),
      input: JSON.stringify({
        hook_event_name: 'Stop',
        cwd: workspace,
        stop_hook_active: false,
        ...input,
      }),
      env,
      encoding: 'utf8',
      timeout: 20_000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return decisionSchema.parse(JSON.parse(result.stdout));
}

function recordingNpm(fail = '') {
  writeFileSync(
    join(commands, 'npm'),
    `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.QUALITY_HOOK_TEST_CALLS, process.cwd() + ' ' + process.argv.slice(2).join(' ') + '\\n');
if (process.argv[3] === process.env.QUALITY_HOOK_TEST_FAIL) {
  process.stderr.write('fixture failure\\n');
  process.exitCode = 1;
}
`,
    { mode: 0o755 },
  );
  return {
    ...process.env,
    PATH: `${commands}:${process.env.PATH}`,
    QUALITY_HOOK_TEST_CALLS: join(commands, 'calls'),
    QUALITY_HOOK_TEST_FAIL: fail,
  };
}

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'archie agent hooks ')));
  commands = mkdtempSync(join(tmpdir(), 'archie-hook-commands-'));
  execFileSync('git', ['init', '--quiet'], { cwd: workspace });
  for (const path of [
    '.gitignore',
    '.prettierignore',
    '.prettierrc.json',
    '.oxlintrc.json',
    'tools/quality/agent-stop.mjs',
  ]) {
    const file = join(workspace, path);
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(join(repository, path), file);
  }
  symlinkSync(join(repository, 'node_modules'), join(workspace, 'node_modules'), 'dir');
  writeFixture(
    'package.json',
    JSON.stringify({
      type: 'module',
      scripts: { lint: 'oxlint .', 'format:check': 'prettier --check .' },
    }),
  );
  writeFixture(
    'tsconfig.json',
    JSON.stringify({
      extends: join(repository, 'tsconfig.json'),
      compilerOptions: { rootDir: '.', noEmit: true, types: ['node'] },
      include: ['src/**/*'],
    }),
  );
  writeFixture('src/base.ts', 'export const value = 1;\n');
  execFileSync(
    process.execPath,
    [join(repository, 'node_modules/prettier/bin/prettier.cjs'), '--write', '.'],
    {
      cwd: workspace,
      stdio: 'pipe',
    },
  );
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(commands, { recursive: true, force: true });
});

describe('agent completion quality hook', () => {
  it('runs both project checks on every stop, including unchanged work, from the Git root', () => {
    const env = recordingNpm();
    expect(runHook({ cwd: join(workspace, 'src') }, env)).toEqual({});
    expect(runHook({}, env)).toEqual({});
    expect(readFileSync(join(commands, 'calls'), 'utf8').split('\n').filter(Boolean)).toEqual([
      `${workspace} run lint`,
      `${workspace} run format:check`,
      `${workspace} run lint`,
      `${workspace} run format:check`,
    ]);
  });

  it('skips plan mode and ignored runtime working directories', () => {
    const env = recordingNpm('lint');
    expect(runHook({ permission_mode: 'plan' }, env)).toEqual({});
    const cwd = join(workspace, 'workdir/sessions/task-1/agents/pm');
    mkdirSync(cwd, { recursive: true });
    expect(runHook({ cwd }, env)).toEqual({});
    expect(() => readFileSync(join(commands, 'calls'))).toThrow();
  });

  it.each(['lint', 'format:check'])('reports %s failures and still runs both checks', (script) => {
    const result = runHook({}, recordingNpm(script));
    expect(result.decision).toBe('block');
    expect(result.reason).toContain(`npm run ${script}\n`);
    expect(result.reason).toContain('fixture failure');
    expect(readFileSync(join(commands, 'calls'), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('reruns checks after a continuation and warns instead of continuing indefinitely', () => {
    const env = recordingNpm('lint');
    expect(runHook({}, env).decision).toBe('block');
    const retry = runHook({ stop_hook_active: true }, env);
    expect(retry.decision).toBeUndefined();
    expect(retry.systemMessage).toContain('automatic retry is exhausted');
    expect(readFileSync(join(commands, 'calls'), 'utf8').trim().split('\n')).toHaveLength(4);
    expect(runHook({ stop_hook_active: true }, recordingNpm())).toEqual({});
  });

  it('returns real lint and formatter diagnostics without rewriting source', () => {
    const content = 'export const value:any={label:"hello"};\n';
    writeFixture('src/bad.ts', content);
    const result = runHook();
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('no-explicit-any');
    expect(result.reason).toContain('npm run format:check');
    expect(readFileSync(join(workspace, 'src/bad.ts'), 'utf8')).toBe(content);
  });

  it('reports missing dependencies without an endless retry', () => {
    unlinkSync(join(workspace, 'node_modules'));
    expect(runHook().decision).toBe('block');
    const retry = runHook({ stop_hook_active: true });
    expect(retry.decision).toBeUndefined();
    expect(retry.systemMessage).toContain('npm run lint');
  });

  it.each([{ hook_event_name: 'PostToolUse' }, { stop_hook_active: 'true' }])(
    'warns on malformed lifecycle input: %j',
    (input) => {
      const result = runHook(input);
      expect(result.decision).toBeUndefined();
      expect(result.systemMessage).toContain('Invalid quality hook input');
    },
  );

  it.each(['.claude/settings.json', '.codex/hooks.json'])(
    'runs the configured %s command from a subdirectory with spaces in its root',
    (path) => {
      const config = configSchema.parse(JSON.parse(readFileSync(join(repository, path), 'utf8')));
      const command = config.hooks.Stop[0].hooks[0].command;
      expect(
        runHook({ cwd: join(workspace, 'src') }, recordingNpm('lint'), command).reason,
      ).toContain('fixture failure');
    },
  );
});
