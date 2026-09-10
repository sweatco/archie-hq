/**
 * Unit tests for the Slack status activity engine.
 *
 * Covers the product rule: tool calls map to natural first-person fragments,
 * with the plumbing deliberately hidden. There is one persona and one agent, so
 * no phrase ever names a worker or reveals that anything was delegated.
 */

import { describe, it, expect } from 'vitest';
import { deriveActivity, deriveActivityFromEvent } from '../activity.js';

describe('deriveActivity', () => {
  const ctx = {};

  it('maps code exploration to a reading phrase', () => {
    expect(deriveActivity('Read', {}, ctx)).toBe('going through the details');
    expect(deriveActivity('Grep', {}, ctx)).toBe('going through the details');
    expect(deriveActivity('Glob', {}, ctx)).toBe('going through the details');
  });

  it('maps edits to a change phrase', () => {
    expect(deriveActivity('Edit', {}, ctx)).toBe('drafting changes');
    expect(deriveActivity('Write', {}, ctx)).toBe('drafting changes');
  });

  it('maps Bash and Skill', () => {
    expect(deriveActivity('Bash', {}, ctx)).toBe('running some checks');
    expect(deriveActivity('Skill', {}, ctx)).toBe('getting up to speed');
  });

  it('maps delegation under both names the SDK has used for it', () => {
    expect(deriveActivity('Agent', {}, ctx)).toBe('working through this');
    expect(deriveActivity('Task', {}, ctx)).toBe('working through this');
  });

  it('maps repo / PR tools', () => {
    expect(deriveActivity('mcp__repo-tools__create_pull_request', {}, ctx)).toBe('opening a pull request');
    expect(deriveActivity('mcp__repo-tools__push_branch', {}, ctx)).toBe('pushing the changes');
    expect(deriveActivity('mcp__repo-tools__get_pr', {}, ctx)).toBe('reviewing the pull request');
    expect(deriveActivity('mcp__repo-tools__merge_pull_request', {}, ctx)).toBe('merging the changes');
    expect(deriveActivity('mcp__repo-tools__update_pr', {}, ctx)).toBe('updating the pull request');
  });

  it('phrases external integrations from the .mcp.json description, no map', () => {
    const mcpDescriptions = {
      rollbar: 'Rollbar — backend error tracking and exception monitoring',
      'atlassian-rovo-mcp': 'Jira & Confluence (Atlassian) — issues, tickets, sprints',
      monday: 'Monday.com — Campaign Management boards',
    };
    expect(deriveActivity('mcp__rollbar__list_items', {}, { mcpDescriptions })).toBe('checking Rollbar');
    expect(deriveActivity('mcp__atlassian-rovo-mcp__search', {}, { mcpDescriptions })).toBe(
      'checking Jira & Confluence',
    );
    expect(deriveActivity('mcp__monday__create_item', {}, { mcpDescriptions })).toBe('checking Monday.com');
  });

  it('uses the server-reported readOnly annotation to pick the verb', () => {
    const mcpTools = new Map([
      ['mcp__monday__create_item', { serverName: 'monday', readOnly: false }],
      ['mcp__monday__get_board', { serverName: 'monday', readOnly: true }],
    ]);
    const c = { mcpDescriptions: { monday: 'Monday.com — Campaign Management boards' }, mcpTools };
    expect(deriveActivity('mcp__monday__create_item', {}, c)).toBe('updating Monday.com');
    expect(deriveActivity('mcp__monday__get_board', {}, c)).toBe('checking Monday.com');
  });

  it('falls back to the server self-name, then a cleaned server key', () => {
    // No description; server reports its own name.
    expect(
      deriveActivity('mcp__x__y', {}, { mcpTools: new Map([['mcp__x__y', { serverName: 'Firebase' }]]) }),
    ).toBe('checking Firebase');
    // No description and no metadata at all → cleaned server slug.
    expect(deriveActivity('mcp__n8n-context-grabber__pull', {}, ctx)).toBe('checking n8n');
  });

  it('surfaces the user-meaningful comms / orchestration / scheduling actions', () => {
    expect(deriveActivity('mcp__comms-tools__find_slack_user', {}, ctx)).toBe('looking someone up');
    expect(deriveActivity('mcp__comms-tools__find_slack_channel', {}, ctx)).toBe('finding the right channel');
    expect(deriveActivity('mcp__comms-tools__list_channels', {}, ctx)).toBe('looking over the channels');
    expect(deriveActivity('mcp__comms-tools__read_channel_history', {}, ctx)).toBe('catching up on a channel');
    expect(deriveActivity('mcp__comms-tools__read_thread', {}, ctx)).toBe('reading a thread');
    expect(deriveActivity('mcp__orchestration-tools__list_available_repos', {}, ctx)).toBe('looking over the repos');
    // A cold clone runs for minutes; a blank status line there reads as a stall.
    expect(deriveActivity('mcp__orchestration-tools__mount_repo', { github: 'org/backend' }, ctx)).toBe('mounting a repository');
    expect(deriveActivity('mcp__scheduling-tools__set_reminder', {}, ctx)).toBe('setting a reminder');
    expect(deriveActivity('mcp__research-tools__web_research', {}, ctx)).toBe('researching');
  });

  it('hides the remaining plumbing', () => {
    expect(deriveActivity('mcp__comms-tools__post_to_user', {}, ctx)).toBeNull();
    expect(deriveActivity('mcp__comms-tools__post_to_channel', {}, ctx)).toBeNull();
    expect(deriveActivity('mcp__comms-tools__mute_channel', {}, ctx)).toBeNull();
    expect(deriveActivity('mcp__orchestration-tools__report_completion', {}, ctx)).toBeNull();
    expect(deriveActivity('mcp__scheduling-tools__parse_datetime', {}, ctx)).toBeNull();
    expect(deriveActivity('TodoWrite', {}, ctx)).toBeNull();
  });
});

describe('deriveActivityFromEvent', () => {
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
    expect(deriveActivityFromEvent(event, {})).toBe('opening a pull request');
  });

  it('returns null for non-assistant events and plain-string content', () => {
    expect(deriveActivityFromEvent({ type: 'result' }, {})).toBeNull();
    expect(deriveActivityFromEvent({ type: 'assistant', message: { content: 'hi' } }, {})).toBeNull();
    expect(deriveActivityFromEvent(null, {})).toBeNull();
  });
});
