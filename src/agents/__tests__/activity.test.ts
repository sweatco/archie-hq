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

  it('maps repo / PR tools', () => {
    expect(deriveActivity('mcp__repo-tools__create_pull_request', {}, sub)).toBe('opening a pull request');
    expect(deriveActivity('mcp__repo-tools__push_branch', {}, sub)).toBe('pushing the changes');
    expect(deriveActivity('mcp__repo-tools__get_pr', {}, sub)).toBe('reviewing the backend PR');
    expect(deriveActivity('mcp__repo-tools__merge_pull_request', {}, sub)).toBe('merging the changes');
  });

  it('maps external integrations by the system involved', () => {
    expect(deriveActivity('mcp__rollbar__list_items', {}, sub)).toBe('checking the error reports');
    expect(
      deriveActivity('mcp__atlassian-rovo-mcp__search', {}, { isPm: false, editMode: false, domain: 'QA' }),
    ).toBe('checking Jira');
    expect(
      deriveActivity('mcp__monday__create_item', {}, { isPm: false, editMode: false, domain: 'ops' }),
    ).toBe('updating the board');
  });

  it('hides internal coordination + user comms (those are plumbing, not work)', () => {
    expect(deriveActivity('mcp__comms-tools__post_to_user', {}, pm)).toBeNull();
    expect(deriveActivity('mcp__agent-tools__send_message_to_agent', {}, pm)).toBeNull();
    expect(deriveActivity('mcp__orchestration-tools__assign_task_owner', {}, pm)).toBeNull();
    expect(deriveActivity('mcp__scheduling-tools__set_reminder', {}, pm)).toBeNull();
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
    expect(deriveActivityFromEvent(event, sub)).toBe('opening a pull request');
  });

  it('returns null for non-assistant events and plain-string content', () => {
    expect(deriveActivityFromEvent({ type: 'result' }, sub)).toBeNull();
    expect(deriveActivityFromEvent({ type: 'assistant', message: { content: 'hi' } }, sub)).toBeNull();
    expect(deriveActivityFromEvent(null, sub)).toBeNull();
  });
});
