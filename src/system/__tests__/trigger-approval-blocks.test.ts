/**
 * The Approve/Deny card's Block Kit, against the REAL builder.
 *
 * It lives here rather than beside the Slack handler tests because those suites
 * replace `trigger-scheduler` with a hand-written mock factory — asserting block
 * shape there would assert against the stub. So the split is deliberate: shape
 * is pinned once here, and the handler tests check only which branch passes
 * blocks through and which clears them.
 *
 * The `notice` form carries the load-bearing case. An approval refused because a
 * trigger cap was reached leaves the proposal pending on purpose, so the user can
 * free a slot and approve that same proposal — which only works if the re-rendered
 * card still has its buttons.
 */

import { describe, it, expect } from 'vitest';
import { buildTriggerApprovalBlocks } from '../trigger-scheduler.js';
import type { Trigger } from '../../types/trigger.js';

const TRIGGER_ID = 'trg-20260824-0900-blocks';

function trigger(over: Partial<Trigger> = {}): Trigger {
  return {
    id: TRIGGER_ID,
    status: 'pending',
    summary: 'the standup digest',
    created_by: 'U_REQ',
    created_at: '2026-08-24T09:00:00.000Z',
    binding: { type: 'channel', channel_id: 'C_STANDUP', channel_name: 'standup' },
    conditions: [{ type: 'schedule', cron: '0 9 * * 1-5', tz: 'Europe/London', next_run_at: '2026-08-25T08:00:00.000Z' }],
    action: { prompt: 'post the digest' },
    ...over,
  } as Trigger;
}

type Block = { type: string; text?: { text: string }; fields?: Array<{ text: string }>; elements?: Array<{ action_id: string; value: string }> };

const actionsOf = (blocks: unknown[]) => (blocks as Block[]).find((b) => b.type === 'actions');

describe('buildTriggerApprovalBlocks', () => {
  it('describes what, when and where as separate fields rather than raw cron', () => {
    const fields = (buildTriggerApprovalBlocks(trigger()) as Block[]).find((b) => b.fields)!.fields!;
    const text = fields.map((f) => f.text).join('\n');

    expect(text).toContain('*What*\nthe standup digest');
    expect(text).toContain('*Where*\n#standup');
    // The cadence is rendered for a human; the cron expression must not leak.
    expect(text).toMatch(/\*When\*\n.+/);
    expect(text).not.toContain('0 9 * * 1-5');
    // Nor may the internal action prompt appear on a user-facing card.
    expect(text).not.toContain('post the digest');
  });

  it('carries both buttons, each addressed to this trigger', () => {
    const actions = actionsOf(buildTriggerApprovalBlocks(trigger()))!;
    expect(actions.elements!.map((e) => e.action_id)).toEqual(['approve_trigger', 'deny_trigger']);
    // The id on the button is what makes a card for one trigger unable to resolve
    // another — several cards for one trigger are normal, cards are never retracted.
    expect(actions.elements!.every((e) => e.value === TRIGGER_ID)).toBe(true);
  });

  it('leads with the setup question when no notice is given', () => {
    const first = (buildTriggerApprovalBlocks(trigger()) as Block[])[0]!;
    expect(first.text!.text).toBe('*Set up this automation?*');
  });

  it('replaces the heading with a notice but KEEPS the buttons — the cap-refusal case', () => {
    const notice = '⚠️ the active-trigger limit was reached';
    const blocks = buildTriggerApprovalBlocks(trigger(), notice);

    expect((blocks as Block[])[0]!.text!.text).toBe(notice);
    const actions = actionsOf(blocks);
    expect(actions, 'a refused approval must leave the card clickable').toBeDefined();
    expect(actions!.elements!.map((e) => e.action_id)).toEqual(['approve_trigger', 'deny_trigger']);
  });

  it('falls back to a clipped action prompt when the PM wrote no summary', () => {
    const fields = (buildTriggerApprovalBlocks(trigger({ summary: undefined })) as Block[]).find((b) => b.fields)!.fields!;
    expect(fields[0]!.text).toContain('post the digest');
  });
});
