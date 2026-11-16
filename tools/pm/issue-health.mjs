// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { checkRepository } from './check-repository.mjs';
import { readProject, renderProjectAudit } from './project-audit.mjs';

const attentionLabels = ['pm:decision', 'pm:blocked', 'pm:parked'];

function escapeCell(value) {
  return String(value)
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\\`*_[\]<>|]/g, '\\$&');
}

function ageInDays(updatedAt, now) {
  const updated = Date.parse(updatedAt);
  return Number.isFinite(updated) ? Math.max(0, Math.floor((now - updated) / 86_400_000)) : null;
}

function issueAttention(issue) {
  const labels = issue.labels.map((label) => (typeof label === 'string' ? label : label.name));
  return attentionLabels.filter((label) => labels.includes(label));
}

export function renderIssueHealth({ repository, projectUrl, issues, pulls, now = new Date() }) {
  const openIssues = issues.filter((issue) => !issue.pull_request && issue.state === 'open');
  const openPulls = pulls.filter((pull) => pull.state === 'open');
  const unassigned = openIssues.filter((issue) => issue.assignees.length === 0);
  const withoutMilestone = openIssues.filter((issue) => !issue.milestone);
  const decisions = openIssues.filter((issue) => issueAttention(issue).includes('pm:decision'));
  const blocked = openIssues.filter((issue) => issueAttention(issue).includes('pm:blocked'));
  const aging = openIssues.filter((issue) => (ageInDays(issue.updated_at, now) ?? 0) >= 30);
  const rows = [
    '# Archie issue health',
    '',
    `As of ${now.toISOString()}. Repository: ${repository}. [Project](${projectUrl}).`,
    '',
    `${openIssues.length} open issues; ${openPulls.length} open PRs (${openPulls.filter((pull) => pull.draft).length} drafts).`,
    '',
    `Explicit flags: ${decisions.length} need a decision; ${blocked.length} are marked blocked.`,
    '',
    `Triage signals: ${unassigned.length} issues have no assignee, ${withoutMilestone.length} have no milestone, and ${aging.length} have not been updated for at least 30 days. Backlog items may legitimately have no owner or milestone; age alone does not mean abandoned.`,
    '',
    'This inventory covers repository records. An on-demand Project audit is included only with --project. The report does not infer acceptance or priorities, change records, or close stale issues.',
    '',
    '## Decisions and blockers',
    '',
  ];
  const waiting = openIssues.filter((issue) =>
    issueAttention(issue).some((label) => label !== 'pm:parked'),
  );
  if (waiting.length === 0) rows.push('No open issues carry an explicit decision or blocker flag.');
  for (const issue of waiting) {
    rows.push(
      `- [#${issue.number}](https://github.com/${repository}/issues/${issue.number}) ${escapeCell(issue.title)} — ${issueAttention(issue).join(', ')}.`,
    );
  }
  rows.push(
    '',
    '## Open issue inventory',
    '',
    '| Issue | Owner | Milestone | Attention | Last update |',
    '|---|---|---|---|---|',
  );
  for (const issue of openIssues.toSorted((a, b) => a.number - b.number)) {
    const age = ageInDays(issue.updated_at, now);
    rows.push(
      `| [#${issue.number}](https://github.com/${repository}/issues/${issue.number}) ${escapeCell(issue.title)} | ${issue.assignees.map((user) => escapeCell(user.login)).join(', ') || 'Unassigned'} | ${issue.milestone ? escapeCell(issue.milestone.title) : 'None'} | ${issueAttention(issue).join(', ') || '—'} | ${age === null ? 'Unknown' : `${age} days ago`} |`,
    );
  }
  rows.push('', '## Open PR inventory', '', '| PR | State | Last update |', '|---|---|---|');
  for (const pull of openPulls.toSorted((a, b) => a.number - b.number)) {
    const age = ageInDays(pull.updated_at, now);
    rows.push(
      `| [#${pull.number}](https://github.com/${repository}/pull/${pull.number}) ${escapeCell(pull.title)} | ${pull.draft ? 'Draft' : 'Open for review'} | ${age === null ? 'Unknown' : `${age} days ago`} |`,
    );
  }
  return `${rows.join('\n')}\n`;
}

export function readRepositoryPages(repository, resource, run = execFileSync) {
  const result = run(
    'gh',
    [
      'api',
      '--method',
      'GET',
      `repos/${repository}/${resource}?state=open&per_page=100`,
      '--paginate',
      '--slurp',
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  const pages = JSON.parse(result);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error(`Expected paginated ${resource} arrays from GitHub`);
  }
  return pages.flat();
}

export function generateHealthReport(
  config,
  { includeProject = false, run = execFileSync, env = process.env } = {},
) {
  const project = includeProject ? readProject(config, { run, env }) : null;
  const issues = readRepositoryPages(config.repository, 'issues', run);
  const pulls = readRepositoryPages(config.repository, 'pulls', run);
  const input = {
    repository: config.repository,
    projectUrl: config.url,
    issues,
    pulls,
  };
  let report = renderIssueHealth(input);
  if (project) report += renderProjectAudit({ ...input, project });
  return report;
}

function main() {
  const { values } = parseArgs({
    options: { output: { type: 'string' }, project: { type: 'boolean', default: false } },
  });
  const repository = checkRepository();
  const config = JSON.parse(
    readFileSync(new URL('../../.github/project.json', import.meta.url), 'utf8'),
  );
  if (config.repository !== repository.full_name) {
    throw new Error('Project health target must match the verified canonical repository');
  }
  const report = generateHealthReport(config, { includeProject: values.project });
  if (values.output) writeFileSync(values.output, report);
  else process.stdout.write(report);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
