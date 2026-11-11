// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
    if (input?.hook_event_name !== 'Stop' || typeof input.stop_hook_active !== 'boolean') {
      throw new Error('Expected Stop hook input');
    }
  } catch {
    return { systemMessage: 'Invalid quality hook input; no checks were run.' };
  }
  if (input.permission_mode === 'plan') return {};

  let failure;
  try {
    const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    }).trim();
    // Archie's runtime sessions inherit project hooks inside the ignored workdir.
    const location = spawnSync('git', ['check-ignore', '--quiet', '--no-index', '--', cwd], {
      cwd: root,
      timeout: 10_000,
    });
    if (location.status === 0) return {};
    if (location.status !== 1) throw new Error('Could not check the hook working directory');

    const failures = [];
    for (const script of ['lint', 'format:check']) {
      const result = spawnSync('npm', ['run', script], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      });
      if (result.status === 0) continue;
      const output = [
        result.error?.message,
        result.signal ? `Terminated by ${result.signal}` : `Exit status: ${result.status}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join('\n');
      failures.push(`npm run ${script}\n${output.slice(-4000)}`);
    }
    failure = failures.join('\n\n');
  } catch (error) {
    failure = `Quality checks could not run: ${String(error).slice(-4000)}`;
  }
  if (!failure) return {};
  if (input.stop_hook_active) {
    return {
      systemMessage: `Quality checks still failed; automatic retry is exhausted.\n${failure}`,
    };
  }
  return {
    decision: 'block',
    reason: `Fix the lint/format failures before finishing. Preserve unrelated edits and report failures outside this task as blockers. Do not relax rules or add suppressions.\n${failure}`,
  };
}

process.stdout.write(`${JSON.stringify(main())}\n`);
