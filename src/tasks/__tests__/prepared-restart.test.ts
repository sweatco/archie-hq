// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('prepared task process restarts', () => {
  it('keeps one identity across exits after the first metadata write and before activation acknowledgement', () => {
    const root = mkdtempSync(join(tmpdir(), 'archie-prepared-restart-'));
    const input = { taskId: 'task-20261021-1000-restart', correlation: 'initiative:release', version: 'v1', actor: 'U_OWNER',
      brief: 'Owner-approved scoped proposal; normal task budgets and existing external-action approvals apply.',
      destination: { channel: 'D_OWNER', thread: '1792490400.000001', name: 'Owner proposal' } };
    const environment = { ...process.env, ARCHIE_WORKDIR: root, ARCHIE_MEMORY: 'false', ARCHIE_PLUGINS: '', SLACK_DRY_RUN: 'true',
      ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: '' };
    const imports = `const { Task } = await import(${JSON.stringify(resolve('src/tasks/task.ts'))}); const input = ${JSON.stringify(input)};`;
    const run = (code: string) => spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { env: environment, encoding: 'utf8', timeout: 20_000 });
    const metadata = () => JSON.parse(readFileSync(join(root, 'sessions', input.taskId, 'shared/metadata.json'), 'utf8'));
    try {
      mkdirSync(root, { recursive: true });
      symlinkSync(resolve('examples/plugins'), join(root, 'plugins'));
      const first = run(`import fs from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module';
        const rename = fs.rename; fs.rename = async (...args) => { await rename(...args); if (String(args[1]).endsWith('/metadata.json')) process.exit(37); };
        syncBuiltinESMExports(); ${imports} await Task.prepare(input);`);
      expect(first.stderr).not.toContain('Error:');
      expect(first.status).toBe(37);
      expect(metadata()).toMatchObject({ status: 'preparing', approved_start: { correlation: input.correlation, phase: 'prepared', brief: input.brief }, memory_destination: { channel_id: 'D_OWNER' } });
      const second = run(`${imports} const task = await Task.prepare(input);
        const { recoverActiveTasks } = await import(${JSON.stringify(resolve('src/tasks/recovery.ts'))});
        await recoverActiveTasks(); if (task.metadata.status !== 'preparing') process.exit(1);`);
      expect(second.status, second.stderr).toBe(0);
      const third = run(`${imports} const task = await Task.prepare(input); task.deliver = async () => process.exit(39); await task.startPrepared();`);
      expect(third.status, third.stderr).toBe(39);
      expect(metadata()).toMatchObject({ status: 'in_progress', approved_start: { phase: 'ready', correlation: input.correlation, brief: input.brief } });
      const fourth = run(`${imports} const task = await Task.prepare(input); if (await task.startPrepared()) process.exit(1);`);
      expect(fourth.status, fourth.stderr).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
});
