// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Trigger, TriggerCondition } from '../../types/trigger.js';
import {
  approvalReference,
  bindNewInputs,
  buildRoutineReviewBlocks,
  isEventRoutine,
  parseApprovalReference,
  routineDigest,
  type RoutineReview,
} from '../routine-review.js';

const ENDED = { pointer: '/type', op: 'equals', value: 'meeting.ended' } as const;
const NEW_INPUT: TriggerCondition = {
  type: 'new_input_event',
  purpose: 'Meeting recordings',
  auth: 'standard_webhooks',
  filter: [ENDED],
};

function proposal(over: Partial<Trigger> = {}): Trigger {
  return {
    id: 'trg-20261124-0900-notes1',
    status: 'pending',
    created_by: 'unknown',
    created_at: '2026-11-24T09:00:00.000Z',
    binding: { type: 'channel', channel_id: 'C0NOTES', channel_name: 'notes' },
    conditions: [NEW_INPUT],
    action: { prompt: 'Summarize the meeting.' },
    summary: 'Meeting notes',
    ...over,
  };
}

const REVIEW: RoutineReview = {
  source: {
    label: 'New input “Meeting recordings”',
    scheme: 'standard_webhooks',
    owner: { kind: 'approver' },
    inputFilter: [],
    routineFilter: [ENDED],
  },
  audience: '#notes, a private channel',
};

const text = (blocks: unknown[]) => JSON.stringify(blocks);

describe('routineDigest', () => {
  it.each<[string, Partial<Trigger>]>([
    ['the instructions', { action: { prompt: 'Summarize the meeting. Then page the CEO.' } }],
    ['the summary', { summary: 'Something else' }],
    ['the destination', { binding: { type: 'channel', channel_id: 'C0ALL', channel_name: 'all' } }],
    ['the filter', { conditions: [{ ...NEW_INPUT, filter: [] }] }],
    ['the purpose', { conditions: [{ ...NEW_INPUT, purpose: 'Deploys' }] }],
    ['the scheme', { conditions: [{ ...NEW_INPUT, auth: 'bearer' }] }],
    [
      'the input',
      { conditions: [{ type: 'incoming_event', input_id: 'inp-AAAAAAAAAAAAAAAAAAAAAA' }] },
    ],
  ])('changes with %s', (_what, change) => {
    expect(routineDigest(proposal(change))).not.toBe(routineDigest(proposal()));
  });
});

describe('an approval reference', () => {
  it('carries the trigger and the digest, and reads back', () => {
    const trigger = proposal();

    expect(parseApprovalReference(approvalReference(trigger))).toEqual({
      triggerId: trigger.id,
      shown: routineDigest(trigger),
    });
  });

  it('has no digest when it is a bare trigger id', () => {
    expect(parseApprovalReference('trg-20261124-0900-notes1')).toEqual({
      triggerId: 'trg-20261124-0900-notes1',
    });
  });
});

describe('bindNewInputs', () => {
  it('turns a new-input condition into a condition on the input created for it', () => {
    const trigger = proposal();

    expect(bindNewInputs(trigger, ['inp-AAAAAAAAAAAAAAAAAAAAAA'])).toBe(true);
    expect(trigger.conditions).toEqual([
      { type: 'incoming_event', input_id: 'inp-AAAAAAAAAAAAAAAAAAAAAA', filter: [ENDED] },
    ]);
  });

  it('changes nothing when no input was created', () => {
    const trigger = proposal();

    expect(bindNewInputs(trigger, [])).toBe(false);
    expect(trigger.conditions).toEqual([NEW_INPUT]);
  });
});

describe('the review card', () => {
  it('shows the source, the owner, the filter, the audience and the instructions', () => {
    const shown = text(buildRoutineReviewBlocks(proposal(), REVIEW));

    expect(shown).toContain('New input “Meeting recordings”, a signed webhook');
    expect(shown).toContain('whoever approves this');
    expect(shown).toContain('`/type` is \\"meeting.ended\\"');
    expect(shown).toContain('#notes, a private channel');
    expect(shown).toContain('Summarize the meeting.');
  });

  it('shows long instructions in full, over several sections', () => {
    const prompt = `${'a'.repeat(2900)}${'b'.repeat(2900)}END`;

    const blocks = buildRoutineReviewBlocks(proposal({ action: { prompt } }), REVIEW);

    const sections = blocks
      .map((block) => block as { text?: { type: string; text: string } })
      .filter((block) => block.text?.type === 'plain_text');
    expect(sections.map((section) => section.text?.text).join('')).toBe(prompt);
    expect(sections.every((section) => (section.text?.text.length ?? 0) <= 3000)).toBe(true);
  });

  it('says so when the instructions are longer than a card can show', () => {
    const shown = text(
      buildRoutineReviewBlocks(proposal({ action: { prompt: 'x'.repeat(29_500) } }), REVIEW),
    );

    expect(shown).toContain('500 more characters than a card can show');
  });

  it('keeps text a model wrote from mentioning anyone', () => {
    const shown = text(
      buildRoutineReviewBlocks(proposal({ summary: 'Notes <!channel> & more' }), REVIEW),
    );

    expect(shown).toContain('Notes &lt;!channel&gt; &amp; more');
  });

  it('puts the digest on Approve and the bare id on Deny', () => {
    const trigger = proposal();

    const blocks = buildRoutineReviewBlocks(trigger, REVIEW);

    const actions = blocks.at(-1) as { elements: Array<{ action_id: string; value: string }> };
    expect(actions.elements.map((button) => [button.action_id, button.value])).toEqual([
      ['approve_trigger', `${trigger.id}|${routineDigest(trigger)}`],
      ['deny_trigger', trigger.id],
    ]);
  });
});

it('tells an event routine from other triggers', () => {
  expect(isEventRoutine(proposal())).toBe(true);
  expect(
    isEventRoutine(
      proposal({
        conditions: [{ type: 'schedule', tz: 'UTC', next_run_at: '2099-01-01T09:00:00.000Z' }],
      }),
    ),
  ).toBe(false);
});
