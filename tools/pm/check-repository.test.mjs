// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRepository } from './check-repository.mjs';

const canonical = { id: 1120227357, full_name: 'sweatco/archie-hq', fork: false };

function callsFor(origin, repository = canonical) {
  const calls = [];
  return {
    calls,
    run(command, args) {
      calls.push({ command, args });
      if (command === 'git') return origin;
      if (command === 'gh') return JSON.stringify(repository);
      throw new Error(`Unexpected command: ${command}`);
    },
  };
}

test('verifies canonical SSH and HTTPS origins against GitHub repository metadata', () => {
  for (const origin of [
    'git@github.com:sweatco/archie-hq.git',
    'https://github.com/sweatco/archie-hq',
    'ssh://git@github.com/sweatco/archie-hq.git',
  ]) {
    const probe = callsFor(origin);
    assert.deepEqual(checkRepository({ run: probe.run, env: {} }), canonical);
    assert.deepEqual(probe.calls, [
      { command: 'git', args: ['remote', 'get-url', 'origin'] },
      { command: 'gh', args: ['api', 'repos/sweatco/archie-hq'] },
    ]);
  }
});

test('blocks forks, local paths, and lookalike origins before any GitHub access', () => {
  for (const origin of [
    'git@github.com:someone/archie-hq.git',
    'https://github.com/sweatco/archie-hq-fork.git',
    'https://github.com.evil.example/sweatco/archie-hq.git',
    'https://github.com/sweatco/archie-hq.git/extra',
    '/tmp/archie-hq',
    '',
  ]) {
    const probe = callsFor(origin);
    assert.throws(() => checkRepository({ run: probe.run, env: {} }), /fork or unknown/);
    assert.equal(probe.calls.length, 1);
  }
});

test('blocks fork Actions context even when origin and copied config point upstream', () => {
  for (const env of [
    { GITHUB_REPOSITORY: 'someone/archie-hq', GITHUB_REPOSITORY_ID: '99' },
    { GITHUB_REPOSITORY: canonical.full_name, GITHUB_REPOSITORY_ID: '99' },
    { GITHUB_REPOSITORY: canonical.full_name },
  ]) {
    const probe = callsFor('git@github.com:sweatco/archie-hq.git');
    assert.throws(
      () => checkRepository({ run: probe.run, env: { ...env, GITHUB_ACTIONS: 'true' } }),
      /restricted to the canonical/,
    );
    assert.equal(probe.calls.length, 0);
  }
});

test('fails closed on replaced, forked, or incomplete repository identity', () => {
  for (const repository of [
    { ...canonical, id: 99 },
    { ...canonical, fork: true },
    { ...canonical, full_name: 'someone/archie-hq' },
    {},
  ]) {
    const probe = callsFor('git@github.com:sweatco/archie-hq.git', repository);
    assert.throws(() => checkRepository({ run: probe.run, env: {} }), /did not verify/);
  }
});

test('propagates missing origin and API failures instead of permitting a write', () => {
  for (const failingCommand of ['git', 'gh']) {
    const run = (command) => {
      if (command === failingCommand) throw new Error('Unavailable');
      return 'git@github.com:sweatco/archie-hq.git';
    };
    assert.throws(() => checkRepository({ run, env: {} }), /Unavailable/);
  }
});
