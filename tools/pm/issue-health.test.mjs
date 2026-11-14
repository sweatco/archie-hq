// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateHealthReport, readRepositoryPages, renderIssueHealth } from './issue-health.mjs';

const now = new Date('2026-11-11T09:00:00Z');
const issue = (overrides = {}) => ({
  number: 1,
  title: 'An issue',
  state: 'open',
  labels: [],
  assignees: [],
  milestone: null,
  updated_at: '2026-11-10T09:00:00Z',
  ...overrides,
});
const render = (issues, pulls = []) =>
  renderIssueHealth({
    repository: 'sweatco/archie-hq',
    projectUrl: 'https://github.com/orgs/sweatco/projects/16',
    issues,
    pulls,
    now,
  });

test('counts issues separately from REST pull-request rows and reports explicit attention only', () => {
  const output = render(
    [
      issue({ labels: [{ name: 'pm:decision' }] }),
      issue({ number: 2, labels: ['pm:blocked'] }),
      issue({ number: 3, pull_request: {} }),
      issue({ number: 4, state: 'closed' }),
    ],
    [issue({ number: 3, draft: true })],
  );
  assert.match(output, /2 open issues; 1 open PRs \(1 drafts\)/);
  assert.match(output, /1 need a decision; 1 are marked blocked/);
  assert.doesNotMatch(output, /issues\/3|issues\/4/);
});

test('old unassigned work remains a triage signal without becoming blocked or abandoned', () => {
  const output = render([issue({ updated_at: '2026-07-01T09:00:00Z' })]);
  assert.match(output, /0 need a decision; 0 are marked blocked/);
  assert.match(output, /1 have not been updated for at least 30 days/);
  assert.match(output, /age alone does not mean abandoned/);
});

test('escapes untrusted titles and preserves unknown dates without dumping bodies', () => {
  const output = render([
    issue({ title: '<script>|[link]\nnext', body: 'PRIVATE SENTINEL', updated_at: 'invalid' }),
  ]);
  assert.match(output, /\\<script\\>\\\|\\\[link\\\] next/);
  assert.match(output, /Unknown/);
  assert.doesNotMatch(output, /PRIVATE SENTINEL/);
});

test('reads every GitHub page using argument arrays and fails on an API error object', () => {
  let called;
  const result = readRepositoryPages('sweatco/archie-hq', 'issues', (command, args) => {
    called = { command, args };
    return JSON.stringify([[issue()], [issue({ number: 2 })]]);
  });
  assert.equal(result.length, 2);
  assert.equal(called.command, 'gh');
  assert.deepEqual(called.args.slice(-2), ['--paginate', '--slurp']);
  assert.throws(
    () => readRepositoryPages('sweatco/archie-hq', 'issues', () => '{"message":"denied"}'),
    /Expected paginated/,
  );
});

test('the default Actions report reads repository records without accessing Project fields', () => {
  const calls = [];
  const report = generateHealthReport(
    { repository: 'sweatco/archie-hq', url: 'https://github.com/orgs/sweatco/projects/16' },
    {
      env: { GITHUB_ACTIONS: 'true' },
      run(command, args) {
        calls.push(args);
        assert.equal(command, 'gh');
        assert.deepEqual(args.slice(0, 3), ['api', '--method', 'GET']);
        return JSON.stringify([args[3].includes('/issues?') ? [issue()] : []]);
      },
    },
  );
  assert.equal(calls.length, 2);
  assert.match(report, /1 open issues; 0 open PRs/);
  assert.doesNotMatch(report, /## Project consistency audit/);
});

test('requesting a Project audit in Actions fails before any audit API calls', () => {
  let called = false;
  assert.throws(
    () =>
      generateHealthReport(
        {},
        {
          includeProject: true,
          env: { GITHUB_ACTIONS: 'true' },
          run() {
            called = true;
          },
        },
      ),
    /on-demand local checks/,
  );
  assert.equal(called, false);
});
