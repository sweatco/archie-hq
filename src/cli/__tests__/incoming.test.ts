// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The `incoming` command as an operator runs it: a separate process with its own environment.
 * What each subcommand does is covered in `src/incoming/__tests__/operator.test.ts`; these cases
 * pin what the entry file adds: exit codes and the order of its checks.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../incoming.ts', import.meta.url));

let root: string;

function incoming(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ARCHIE_WORKDIR: join(root, 'workdir'),
      ARCHIE_SECRETS_DIR: join(root, 'secrets'),
      ARCHIE_SECRETS_KEY: randomBytes(32).toString('base64'),
      ARCHIE_PUBLIC_URL: 'https://archie.example.test',
      ARCHIE_INCOMING_EVENTS: 'on',
      ...env,
    },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'archie-incoming-cli-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

it('creates an input and a later run lists it', () => {
  const created = incoming(['create']);
  const id = /Created input (\S+)/.exec(created.stdout)?.[1] ?? 'none';

  expect(created.status).toBe(0);
  expect(created.stdout).toContain(`https://archie.example.test/webhooks/incoming/${id}`);
  expect(created.stdout).not.toContain('Note:');

  const listed = incoming(['list'], { ARCHIE_INCOMING_EVENTS: '' });
  expect(listed.status).toBe(0);
  expect(listed.stdout).toContain(id);
  expect(listed.stdout).toContain('Note: ARCHIE_INCOMING_EVENTS is not on');
}, 30_000);

it.each([
  [
    'an unknown flag value',
    ['create'],
    { ARCHIE_INCOMING_EVENTS: 'true' },
    /must be "off" or "on"/,
  ],
  ['a missing vault key', ['create'], { ARCHIE_SECRETS_KEY: '' }, /ARCHIE_SECRETS_KEY/],
  ['a mistyped command', ['crate'], {}, /Unknown command: crate/],
])(
  'refuses %s before creating anything',
  (_name, args, env, message) => {
    const refused = incoming(args, env);

    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(message);
    expect(refused.stdout).not.toContain('Secret:');
    expect(existsSync(join(root, 'workdir'))).toBe(false);
    expect(existsSync(join(root, 'secrets'))).toBe(false);
  },
  30_000,
);

it('prints its usage with exit 0 when asked and exit 1 when given nothing', () => {
  const asked = incoming(['--help']);
  const nothing = incoming([]);

  expect(asked.status).toBe(0);
  expect(nothing.status).toBe(1);
  expect(asked.stdout).toContain('npm run incoming -- create');
  expect(nothing.stdout).toBe(asked.stdout);
}, 30_000);
