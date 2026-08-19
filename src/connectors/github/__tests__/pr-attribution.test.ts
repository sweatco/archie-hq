/**
 * Unit tests for the PR attribution line.
 *
 * The line exists because GitHub sets a PR's author from the credential that opens
 * it, so a PR Archie opens for someone can only name them in the body. These cover
 * the two ways that went wrong before: the human being absent (left to the model,
 * which named the Slack requester in prose or not at all), and Claude Code's
 * harness footer crediting the coding tool.
 */

import { describe, it, expect } from 'vitest';
import { buildAttributedBody, stripAttribution, ATTRIBUTION_MARKER } from '../pr-attribution.js';

const MENTION = '@archie-hq';

describe('buildAttributedBody', () => {
  it('names Archie and the human in an alert above the description', () => {
    const out = buildAttributedBody('## The report\n\nSomething broke.', 'Bandita Parida', MENTION);

    expect(out).toBe(
      `${ATTRIBUTION_MARKER}\n> [!NOTE]\n> Opened by @archie-hq on behalf of **Bandita Parida**.\n\n## The report\n\nSomething broke.`,
    );
  });

  it('invents no human when no approver was recorded', () => {
    // CLI approvals and pre-feature tasks have no edit_approved_by.
    const out = buildAttributedBody('Body.', null, MENTION);

    expect(out).toBe(`${ATTRIBUTION_MARKER}\n> [!NOTE]\n> Opened by @archie-hq.\n\nBody.`);
  });

  it('leaves the body alone when no identity is configured', () => {
    expect(buildAttributedBody('Body.', 'Bandita Parida', null)).toBe('Body.');
  });

  it('replaces rather than stacks when re-applied to its own output', () => {
    // update_pr re-stamps every body rewrite, and the agent may pass back a body
    // it read off the PR — so the operation has to be idempotent.
    const once = buildAttributedBody('Body.', 'Bandita Parida', MENTION);
    const twice = buildAttributedBody(once, 'Bandita Parida', MENTION);

    expect(twice).toBe(once);
    expect(twice.match(/Opened by/g)).toHaveLength(1);
  });

  it('re-attributes to a different human without leaving the old name behind', () => {
    const first = buildAttributedBody('Body.', 'Bandita Parida', MENTION);
    const second = buildAttributedBody(first, 'Egor Khmelev', MENTION);

    expect(second).toContain('on behalf of **Egor Khmelev**.');
    expect(second).not.toContain('Bandita');
  });

  it('keeps the Slack thread link the agent writes into the body', () => {
    // The prompt still has the agent append the originating thread; attribution
    // must not eat it.
    const out = buildAttributedBody('Body.\n\nSlack thread in #liveops: https://slack.example/p1', 'Bandita Parida', MENTION);

    expect(out).toContain('Slack thread in #liveops: https://slack.example/p1');
  });

  it('leaves no blank description behind when the agent wrote none', () => {
    expect(buildAttributedBody('', 'Bandita Parida', MENTION)).toBe(
      `${ATTRIBUTION_MARKER}\n> [!NOTE]\n> Opened by @archie-hq on behalf of **Bandita Parida**.`,
    );
  });
});

describe('stripAttribution', () => {
  it('leaves an unstamped body untouched apart from trimming', () => {
    expect(stripAttribution('## Report\n\nDetail.')).toBe('## Report\n\nDetail.');
  });

  it('does not eat a blockquote the author wrote themselves', () => {
    // Only the quote directly under the marker belongs to us — an unmarked alert
    // or quote of the author's own must survive.
    const body = '> [!WARNING]\n> Do not merge before Friday.\n\nProse.';

    expect(stripAttribution(body)).toBe(body);
  });
});
