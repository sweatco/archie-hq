// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditProject, readProject, renderProjectAudit } from './project-audit.mjs';

const config = {
  owner: 'sweatco',
  repository: 'sweatco/archie-hq',
  number: 16,
  id: 'project-16',
  url: 'https://github.com/orgs/sweatco/projects/16',
};
const issue = (number, overrides = {}) => ({
  id: `item-${number}`,
  type: 'ISSUE',
  isArchived: false,
  status: { name: 'Backlog' },
  initiative: { name: 'Memory' },
  content: {
    number,
    title: 'A tracked record',
    url: `https://github.com/sweatco/archie-hq/issues/${number}`,
    state: 'OPEN',
    stateReason: null,
    repository: { nameWithOwner: config.repository },
    assignees: { totalCount: 1 },
    labels: { nodes: [] },
  },
  ...overrides,
});
const project = (items = []) => ({
  id: config.id,
  number: config.number,
  url: config.url,
  statusField: {
    name: 'Status',
    options: ['Backlog', 'Ready', 'In progress', 'Review', 'Done'].map((name) => ({ name })),
  },
  initiativeField: { name: 'Initiative', options: [{ name: 'Memory' }] },
  items,
});
const response = (items, { total = items.length, next = false, cursor = null } = {}) => ({
  data: {
    organization: {
      projectV2: {
        ...project(),
        items: {
          nodes: items,
          totalCount: total,
          pageInfo: { hasNextPage: next, endCursor: cursor },
        },
      },
    },
  },
});

test('reads every Project page through local CLI authentication and query-only operations', () => {
  const calls = [];
  const env = { GH_TOKEN: 'local-cli-credential' };
  const pages = [
    response([issue(1)], { total: 2, next: true, cursor: 'page-2' }),
    response([issue(2)], { total: 2 }),
  ];
  const result = readProject(config, {
    env,
    run(command, args, options) {
      const input = JSON.parse(options.input);
      calls.push(input.variables.cursor);
      assert.equal(command, 'gh');
      assert.deepEqual(args, ['api', 'graphql', '--input', '-']);
      assert.match(input.query, /^query ProjectAudit/);
      assert.doesNotMatch(input.query, /mutation|\bbody\b/);
      assert.equal(options.env, env);
      return JSON.stringify(pages.shift());
    },
  });
  assert.deepEqual(calls, [null, 'page-2']);
  assert.equal(result.items.length, 2);
  assert.equal(env.GH_TOKEN, 'local-cli-credential');
});

test('Actions cannot run the on-demand Project reader', () => {
  let called = false;
  assert.throws(
    () =>
      readProject(config, {
        env: { GITHUB_ACTIONS: 'true', GH_TOKEN: 'repository-reader' },
        run() {
          called = true;
        },
      }),
    /on-demand local checks/,
  );
  assert.equal(called, false);
});

test('missing permissions, wrong Project identity, and missing fields fail the audit', () => {
  const wrong = response([]);
  wrong.data.organization.projectV2.id = 'other-project';
  const missingField = response([]);
  missingField.data.organization.projectV2.statusField = null;
  for (const data of [
    { errors: [{ message: 'Forbidden' }] },
    { data: { organization: { projectV2: null } } },
    wrong,
    missingField,
  ]) {
    assert.throws(
      () => readProject(config, { env: {}, run: () => JSON.stringify(data) }),
      /Project audit/,
    );
  }
});

test('partial, duplicated, or stalled pagination cannot appear as a complete audit', () => {
  const incomplete = response([], { total: 1 });
  const duplicate = [
    response([issue(1)], { total: 2, next: true, cursor: 'next' }),
    response([issue(1)], { total: 2 }),
  ];
  const stalled = response([issue(1)], { total: 2, next: true });
  for (const pages of [[incomplete], duplicate, [stalled]]) {
    assert.throws(
      () => readProject(config, { env: {}, run: () => JSON.stringify(pages.shift()) }),
      /Project audit/,
    );
  }
});

test('finds explicit stage, ownership, flag, and repository contradictions', () => {
  const ready = issue(1, { status: { name: 'Ready' } });
  ready.content.assignees.totalCount = 0;
  ready.content.labels.nodes = [{ name: 'pm:blocked' }];
  const doneOpen = issue(2, { status: { name: 'Done' } });
  const completed = issue(3);
  completed.content.state = 'CLOSED';
  completed.content.stateReason = 'COMPLETED';
  const cancelled = issue(4, { status: { name: 'Done' } });
  cancelled.content.state = 'CLOSED';
  cancelled.content.stateReason = 'NOT_PLANNED';
  const parked = issue(5, { status: { name: 'In progress' } });
  parked.content.labels.nodes = [{ name: 'pm:parked' }];
  const merged = issue(6, { type: 'PULL_REQUEST' });
  merged.content.state = 'MERGED';
  const foreign = issue(7);
  foreign.content.repository.nameWithOwner = 'someone/fork';
  const unset = issue(8, { status: null });
  const findings = auditProject(
    project([ready, doneOpen, completed, cancelled, parked, merged, foreign, unset]),
    config.repository,
  ).findings;
  assert.equal(findings.length, 8);
  assert.match(findings[0].problems.join(' '), /owner.*blocker/);
  assert.match(findings[6].problems.join(' '), /another repository/);
  assert.match(findings[7].problems.join(' '), /Status is unset/);
});

test('keeps deferred classification and PR intake as coverage notes, with safe output', () => {
  const tracked = issue(1, { initiative: null });
  tracked.content.title = '<script>|[link]\nnew';
  const report = renderProjectAudit({
    project: project([tracked]),
    repository: config.repository,
    issues: [
      { number: 1, state: 'open' },
      { number: 2, state: 'open' },
    ],
    pulls: [{ number: 3, state: 'open' }],
  });
  assert.match(report, /1 visible active records have no Initiative/);
  assert.match(report, /1 open issues and 1 open PRs are outside/);
  assert.match(report, /coverage notes, not automatic intake requests/);
  assert.match(report, /No rule mismatches/);
  assert.match(report, /\\<script\\>\\\|\\\[link\\\] new/);
  assert.doesNotMatch(report, /<script>/);
});

test('exposes hidden-content limits and excludes drafts and archived records from stage review', () => {
  const archived = issue(1, { isArchived: true, status: { name: 'Done' } });
  const hidden = { id: 'hidden', type: 'REDACTED', content: null };
  const draft = { id: 'draft', type: 'DRAFT_ISSUE', content: {} };
  const result = auditProject(project([archived, hidden, draft]), config.repository);
  assert.equal(result.findings.length, 0);
  assert.equal(result.coverage.unreadable, 1);
  assert.equal(result.coverage.drafts, 1);
  const report = renderProjectAudit({
    project: project([archived, hidden, draft]),
    repository: config.repository,
    issues: [],
    pulls: [],
  });
  assert.match(report, /INCOMPLETE: 1 items/);
});

test('a merged PR in Review is consistent, while an unmerged closed PR needs disposition', () => {
  const merged = issue(1, { type: 'PULL_REQUEST', status: { name: 'Review' } });
  merged.content.state = 'MERGED';
  const closed = issue(2, { type: 'PULL_REQUEST', status: { name: 'In progress' } });
  closed.content.state = 'CLOSED';
  const before = JSON.stringify([merged, closed]);
  const { findings } = auditProject(project([merged, closed]), config.repository);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].item.content.number, 2);
  assert.equal(JSON.stringify([merged, closed]), before);
});
