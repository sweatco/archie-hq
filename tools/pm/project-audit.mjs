// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';

const query = `query ProjectAudit($owner: String!, $number: Int!, $cursor: String) {
  organization(login: $owner) {
    projectV2(number: $number) {
      id number url
      statusField: field(name: "Status") {
        ... on ProjectV2SingleSelectField { name options { name } }
      }
      initiativeField: field(name: "Initiative") {
        ... on ProjectV2SingleSelectField { name options { name } }
      }
      items(first: 100, after: $cursor) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes {
          id type isArchived
          status: fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
          initiative: fieldValueByName(name: "Initiative") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
          content {
            ... on Issue {
              number title url state stateReason
              repository { nameWithOwner }
              assignees(first: 1) { totalCount }
              labels(first: 100) { nodes { name } }
            }
            ... on PullRequest {
              number title url state
              repository { nameWithOwner }
              assignees(first: 1) { totalCount }
              labels(first: 100) { nodes { name } }
            }
          }
        }
      }
    }
  }
}`;

export function readProject(config, { run = execFileSync, env = process.env } = {}) {
  if (env.GITHUB_ACTIONS === 'true') {
    throw new Error(
      'Project audits are on-demand local checks; scheduled reports use repository data only',
    );
  }
  const items = [];
  const seen = new Set();
  const cursors = new Set();
  let cursor = null;
  let project;
  do {
    const result = JSON.parse(
      run('gh', ['api', 'graphql', '--input', '-'], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env,
        input: JSON.stringify({
          query,
          variables: { owner: config.owner, number: config.number, cursor },
        }),
      }),
    );
    if (result.errors?.length)
      throw new Error('Project audit query failed; check GitHub CLI Project access');
    const page = result.data?.organization?.projectV2;
    if (
      !page ||
      page.id !== config.id ||
      page.number !== config.number ||
      page.url !== config.url
    ) {
      throw new Error('Project audit could not verify the configured Project identity and access');
    }
    if (
      !Array.isArray(page.statusField?.options) ||
      !Array.isArray(page.initiativeField?.options) ||
      !Array.isArray(page.items?.nodes) ||
      typeof page.items.pageInfo?.hasNextPage !== 'boolean'
    ) {
      throw new Error('Project audit requires visible Status and Initiative fields and item data');
    }
    project ??= page;
    if (page.items.totalCount !== project.items.totalCount) {
      throw new Error('Project membership changed during pagination; retry the audit');
    }
    for (const item of page.items.nodes) {
      if (!item?.id || seen.has(item.id))
        throw new Error('Project audit received missing or duplicate items');
      seen.add(item.id);
      items.push(item);
    }
    if (!page.items.pageInfo?.hasNextPage) break;
    cursor = page.items.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor)) throw new Error('Project audit pagination did not advance');
    cursors.add(cursor);
  } while (true);
  if (items.length !== project.items.totalCount)
    throw new Error('Project audit received an incomplete item inventory');
  return { ...project, items };
}

function escapeCell(value) {
  return String(value)
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\\`*_[\]<>|]/g, '\\$&');
}

export function auditProject(project, repository) {
  const stages = new Set(['Backlog', 'Ready', 'In progress', 'Review', 'Done']);
  const initiatives = new Set(project.initiativeField.options.map((option) => option.name));
  const findings = [];
  const coverage = { archived: 0, drafts: 0, unreadable: 0, unclassified: 0 };
  const tracked = { issues: new Set(), pulls: new Set() };
  const rows = [];
  for (const item of project.items) {
    const content = item.content;
    const status = item.status?.name;
    const initiative = item.initiative?.name;
    const problems = [];
    if (item.isArchived) coverage.archived++;
    if (item.type === 'DRAFT_ISSUE') {
      coverage.drafts++;
      continue;
    }
    if (!content?.repository) {
      coverage.unreadable++;
      continue;
    }
    if (content.repository.nameWithOwner !== repository) {
      findings.push({
        item,
        problems: ['Record belongs to another repository; review Project scope'],
      });
      continue;
    }
    if (item.type === 'ISSUE') tracked.issues.add(content.number);
    else if (item.type === 'PULL_REQUEST') tracked.pulls.add(content.number);
    else {
      coverage.unreadable++;
      continue;
    }
    rows.push(item);
    if (item.isArchived) continue;
    if (!initiative) coverage.unclassified++;
    else if (!initiatives.has(initiative)) problems.push('Initiative is not a configured option');
    if (!status) problems.push('Status is unset');
    else if (!stages.has(status)) problems.push('Status is outside the agreed workflow');
    const labels = new Set(content.labels.nodes.map((label) => label.name));
    if (status === 'Ready' && content.assignees.totalCount === 0)
      problems.push('Ready requires an agreed owner');
    if (status === 'Ready' && labels.has('pm:blocked'))
      problems.push('Ready conflicts with an explicit blocker');
    if (['Ready', 'In progress', 'Review'].includes(status) && labels.has('pm:parked'))
      problems.push('Parked work is in an active stage');
    if (item.type === 'ISSUE') {
      if (content.state === 'OPEN' && status === 'Done')
        problems.push('Open issue is Done; check acceptance and approved closure');
      if (content.state === 'CLOSED' && content.stateReason === 'COMPLETED' && status !== 'Done')
        problems.push('Completed issue is not Done; reconcile acceptance and stage');
      if (content.state === 'CLOSED' && content.stateReason !== 'COMPLETED' && status === 'Done')
        problems.push('Issue closed without completion is Done; review disposition');
    } else {
      if (content.state === 'MERGED' && !['Review', 'Done'].includes(status))
        problems.push('Merged PR has not reached Review or Done');
      if (content.state === 'CLOSED' && ['Ready', 'In progress', 'Review', 'Done'].includes(status))
        problems.push('Unmerged closed PR retains a delivery stage; review disposition');
    }
    if (problems.length) findings.push({ item, problems });
  }
  return { findings, coverage, tracked, rows };
}

export function renderProjectAudit({ project, repository, issues, pulls }) {
  const { findings, coverage, tracked, rows } = auditProject(project, repository);
  const outsideIssues = issues.filter(
    (issue) => !issue.pull_request && issue.state === 'open' && !tracked.issues.has(issue.number),
  ).length;
  const outsidePulls = pulls.filter(
    (pull) => pull.state === 'open' && !tracked.pulls.has(pull.number),
  ).length;
  const output = [
    '',
    '## Project consistency audit',
    '',
    `Read [Project #${project.number}](${project.url}): ${project.items.length} items, including ${coverage.archived} archived and ${coverage.drafts} draft items.`,
    '',
    `${coverage.unclassified} visible active records have no Initiative. ${outsideIssues} open issues and ${outsidePulls} open PRs are outside the Project. These are coverage notes, not automatic intake requests; PR intake is maintainer-controlled and the historical backfill remains unapproved.`,
    '',
    coverage.unreadable
      ? `INCOMPLETE: ${coverage.unreadable} items have hidden or unsupported content. Findings cover visible records only.`
      : 'No returned issue/PR content is hidden. Archived items and Project drafts are excluded from stage comparisons.',
    '',
    'These checks identify records for review; they do not prove accepted scope, maintainer intake approval, human acceptance, or deployment. No records are changed.',
    '',
    '### Records to reconcile',
    '',
  ];
  if (!findings.length) output.push('No rule mismatches found among visible active records.');
  for (const { item, problems } of findings) {
    const content = item.content;
    output.push(
      `- ${item.type === 'PULL_REQUEST' ? 'PR' : 'Issue'} #${content.number} — ${escapeCell(content.title)}: ${problems.join('; ')}.`,
    );
  }
  output.push(
    '',
    '### Project inventory',
    '',
    '| Record | Status | Initiative | Archived |',
    '|---|---|---|---|',
  );
  for (const item of rows) {
    const content = item.content;
    const kind = item.type === 'PULL_REQUEST' ? 'PR' : 'Issue';
    output.push(
      `| [${kind} #${content.number}](${content.url}) ${escapeCell(content.title)} | ${escapeCell(item.status?.name ?? 'Unset')} | ${escapeCell(item.initiative?.name ?? 'Unclassified')} | ${item.isArchived ? 'Yes' : 'No'} |`,
    );
  }
  return `${output.join('\n')}\n`;
}
