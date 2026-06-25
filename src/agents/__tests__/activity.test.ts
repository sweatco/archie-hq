/**
 * Unit tests for the Slack status activity engine.
 *
 * Covers the two product rules: domain labels never leak agent identity, and
 * tool calls map to natural first-person fragments (with internal coordination
 * deliberately hidden).
 */

import { describe, it, expect } from 'vitest';
import type { AgentDef } from '../../types/agent.js';
import { agentDomainLabel, deriveActivity, deriveActivityFromEvent } from '../activity.js';

function def(partial: Partial<AgentDef>): AgentDef {
  return {
    id: 'x-agent',
    key: 'x',
    role: '',
    expertise: '',
    pluginName: 'p',
    visibility: 'global',
    ...partial,
  } as AgentDef;
}

describe('agentDomainLabel', () => {
  it('uses the key for engineering-style domain keys', () => {
    expect(agentDomainLabel(def({ key: 'mobile', pluginName: 'engineering' }))).toBe('mobile');
    expect(agentDomainLabel(def({ key: 'backend', pluginName: 'engineering' }))).toBe('backend');
    expect(agentDomainLabel(def({ key: 'infrastructure', pluginName: 'engineering' }))).toBe('infrastructure');
  });

  it('falls back to a cleaned plugin name for role-style keys', () => {
    expect(agentDomainLabel(def({ key: 'copywriter', pluginName: 'marketing' }))).toBe('marketing');
    expect(agentDomainLabel(def({ key: 'tov-reviewer', pluginName: 'marketing' }))).toBe('marketing');
    expect(agentDomainLabel(def({ key: 'qa-analyst', pluginName: 'qa' }))).toBe('QA');
    expect(agentDomainLabel(def({ key: 'data-analyst', pluginName: 'data-analytics' }))).toBe('data');
  });

  it('prefers an explicit statusLabel over any derivation', () => {
    expect(
      agentDomainLabel(def({ key: 'tov-reviewer', pluginName: 'marketing', statusLabel: 'the brand voice' })),
    ).toBe('the brand voice');
  });

  it('returns empty for the PM (it speaks for the whole team)', () => {
    expect(agentDomainLabel(def({ key: 'pm', isPm: true, pluginName: 'pm' }))).toBe('');
  });
});

describe('deriveActivity', () => {
  const sub = { isPm: false, editMode: true, domain: 'backend' };
  const pm = { isPm: true, editMode: false, domain: '' };

  it('maps code exploration to a domain phrase for a specialist', () => {
    expect(deriveActivity('Read', {}, sub)).toBe('digging into the backend');
    expect(deriveActivity('Grep', {}, sub)).toBe('digging into the backend');
    expect(deriveActivity('Glob', {}, sub)).toBe('digging into the backend');
  });

  it('maps edits to a change phrase', () => {
    expect(deriveActivity('Edit', {}, sub)).toBe('making changes to the backend');
    expect(deriveActivity('Write', {}, sub)).toBe('making changes to the backend');
  });

  it('keeps Bash domain-aware for specialists; bare only for the PM', () => {
    expect(deriveActivity('Bash', {}, { isPm: false, editMode: false, domain: 'backend' })).toBe('running some checks on the backend');
    expect(deriveActivity('Bash', {}, sub)).toBe('working on the backend'); // edit mode
    expect(deriveActivity('Bash', {}, pm)).toBe('running some checks');
  });

  it('maps repo / PR tools, domain-aware', () => {
    expect(deriveActivity('mcp__repo-tools__create_pull_request', {}, sub)).toBe('opening a backend pull request');
    expect(deriveActivity('mcp__repo-tools__push_branch', {}, sub)).toBe('pushing the backend changes');
    expect(deriveActivity('mcp__repo-tools__get_pr', {}, sub)).toBe('reviewing the backend PR');
    expect(deriveActivity('mcp__repo-tools__merge_pull_request', {}, sub)).toBe('merging the backend changes');
    expect(deriveActivity('mcp__repo-tools__update_pr', {}, sub)).toBe('updating the backend pull request');
  });

  it('keeps Skill domain-aware for specialists', () => {
    expect(deriveActivity('Skill', {}, sub)).toBe('getting up to speed on the backend');
    expect(deriveActivity('Skill', {}, pm)).toBe('getting up to speed');
  });

  it('phrases external integrations from the .mcp.json description, no map', () => {
    const descriptions = {
      rollbar: 'Rollbar — backend error tracking and exception monitoring',
      'atlassian-rovo-mcp': 'Jira & Confluence (Atlassian) — issues, tickets, sprints',
      monday: 'Monday.com — Campaign Management boards',
    };
    expect(deriveActivity('mcp__rollbar__list_items', {}, { ...sub, mcpDescriptions: descriptions })).toBe(
      'checking Rollbar',
    );
    expect(
      deriveActivity('mcp__atlassian-rovo-mcp__search', {}, { ...sub, mcpDescriptions: descriptions }),
    ).toBe('checking Jira & Confluence');
    expect(deriveActivity('mcp__monday__create_item', {}, { ...sub, mcpDescriptions: descriptions })).toBe(
      'checking Monday.com',
    );
  });

  it('uses the server-reported readOnly annotation to pick the verb', () => {
    const mcpTools = new Map([
      ['mcp__monday__create_item', { serverName: 'monday', readOnly: false }],
      ['mcp__monday__get_board', { serverName: 'monday', readOnly: true }],
    ]);
    const descriptions = { monday: 'Monday.com — Campaign Management boards' };
    const ctx = { ...sub, mcpDescriptions: descriptions, mcpTools };
    expect(deriveActivity('mcp__monday__create_item', {}, ctx)).toBe('updating Monday.com');
    expect(deriveActivity('mcp__monday__get_board', {}, ctx)).toBe('checking Monday.com');
  });

  it('falls back to the server self-name, then a cleaned server key', () => {
    // No description; server reports its own name.
    expect(
      deriveActivity('mcp__x__y', {}, { ...sub, mcpTools: new Map([['mcp__x__y', { serverName: 'Firebase' }]]) }),
    ).toBe('checking Firebase');
    // No description and no metadata at all → cleaned server slug.
    expect(deriveActivity('mcp__n8n-context-grabber__pull', {}, sub)).toBe('checking n8n');
  });

  it('surfaces inter-agent coordination + shared-log activity (domain-aware for specialists)', () => {
    expect(deriveActivity('mcp__agent-tools__send_message_to_agent', {}, pm)).toBe('coordinating');
    expect(deriveActivity('mcp__agent-tools__log_finding', {}, sub)).toBe('making a note on the backend');
    expect(deriveActivity('mcp__agent-tools__share_artifact', {}, sub)).toBe('writing up the backend');
    // PM (no domain) stays generic
    expect(deriveActivity('mcp__agent-tools__log_finding', {}, pm)).toBe('making a note');
  });

  it('reflects the delegation target by domain, single-persona', () => {
    const resolveAgentDomain = (id: string) =>
      ({ 'backend-agent': 'backend', 'pm-agent': '' } as Record<string, string>)[id];
    // PM delegates to a specialist → "turning to that area", never naming the agent
    expect(
      deriveActivity('mcp__agent-tools__send_message_to_agent', { target: 'backend-agent' }, { ...pm, resolveAgentDomain }),
    ).toBe('looking into the backend');
    // Reporting back to the coordinator (no domain) → generic
    expect(
      deriveActivity('mcp__agent-tools__send_message_to_agent', { target: 'pm-agent' }, { ...sub, resolveAgentDomain }),
    ).toBe('coordinating');
    // Unknown target → generic
    expect(
      deriveActivity('mcp__agent-tools__send_message_to_agent', { target: 'who-agent' }, { ...pm, resolveAgentDomain }),
    ).toBe('coordinating');
  });

  it('surfaces the user-meaningful PM comms / orchestration / scheduling actions', () => {
    expect(deriveActivity('mcp__comms-tools__find_slack_user', {}, pm)).toBe('looking someone up');
    expect(deriveActivity('mcp__comms-tools__find_slack_channel', {}, pm)).toBe('finding the right channel');
    expect(deriveActivity('mcp__orchestration-tools__get_agents_status', {}, pm)).toBe('checking on progress');
    expect(deriveActivity('mcp__orchestration-tools__launch_task', {}, pm)).toBe('kicking off a task');
    expect(deriveActivity('mcp__orchestration-tools__list_available_repos', {}, pm)).toBe('looking over the repos');
    expect(deriveActivity('mcp__orchestration-tools__spawn_repo_agent', {}, pm)).toBe('getting set up on a new repo');
    expect(deriveActivity('mcp__scheduling-tools__set_reminder', {}, pm)).toBe('setting a reminder');
  });

  it('hides the remaining plumbing', () => {
    expect(deriveActivity('mcp__comms-tools__post_to_user', {}, pm)).toBeNull();
    expect(deriveActivity('mcp__comms-tools__mute_channel', {}, pm)).toBeNull();
    expect(deriveActivity('mcp__orchestration-tools__assign_task_owner', {}, pm)).toBeNull();
    expect(deriveActivity('mcp__orchestration-tools__report_completion', {}, pm)).toBeNull();
    expect(deriveActivity('mcp__scheduling-tools__parse_datetime', {}, pm)).toBeNull();
  });

  it('gives the PM domain-free phrasing', () => {
    expect(deriveActivity('Read', {}, pm)).toBe('going through the details');
    expect(deriveActivity('mcp__research-tools__web_research', {}, pm)).toBe('researching');
  });
});

describe('deriveActivityFromEvent', () => {
  const sub = { isPm: false, editMode: false, domain: 'mobile' };

  it('returns the last surfaced tool phrase from an assistant event', () => {
    const event = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'thinking' },
          { type: 'tool_use', name: 'Read', input: {} },
          { type: 'tool_use', name: 'mcp__repo-tools__create_pull_request', input: {} },
        ],
      },
    };
    expect(deriveActivityFromEvent(event, sub)).toBe('opening a mobile pull request');
  });

  it('returns null for non-assistant events and plain-string content', () => {
    expect(deriveActivityFromEvent({ type: 'result' }, sub)).toBeNull();
    expect(deriveActivityFromEvent({ type: 'assistant', message: { content: 'hi' } }, sub)).toBeNull();
    expect(deriveActivityFromEvent(null, sub)).toBeNull();
  });
});
