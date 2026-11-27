// SPDX-License-Identifier: AGPL-3.0-or-later
/** The review of an event routine: what its approval card shows, and the digest that ties a click to that card. */
import { createHash } from 'node:crypto';
import { describeCheck } from '../incoming/filter.js';
import type { InputAuth, PointerCheck } from '../incoming/types.js';
import type { Trigger, TriggerCondition } from '../types/trigger.js';

type EventCondition = Extract<TriggerCondition, { type: 'incoming_event' | 'new_input_event' }>;

export function isEventCondition(condition: TriggerCondition): condition is EventCondition {
  return condition.type === 'incoming_event' || condition.type === 'new_input_event';
}

export function isEventRoutine(trigger: Pick<Trigger, 'conditions'>): boolean {
  return trigger.conditions.some(isEventCondition);
}

/**
 * Identifies what a review card shows: instructions, summary, destination and conditions.
 * The id reserved for a new input is left out, so a repeated click on the same card still matches.
 */
export function routineDigest(trigger: Trigger): string {
  const { binding } = trigger;
  const shown = {
    prompt: trigger.action.prompt,
    summary: trigger.summary ?? '',
    binding: [binding.type, binding.channel_id, binding.type === 'user' ? binding.user_id : ''],
    conditions: trigger.conditions.map((condition) => {
      if (condition.type === 'new_input_event')
        return [condition.type, condition.purpose, condition.auth, condition.filter ?? []];
      if (condition.type === 'incoming_event')
        return [condition.type, condition.input_id, condition.filter ?? []];
      return condition;
    }),
  };
  return createHash('sha256').update(JSON.stringify(shown)).digest('hex').slice(0, 32);
}

/** What the Approve button and the approval event carry for an event routine. */
export function approvalReference(trigger: Trigger): string {
  return `${trigger.id}|${routineDigest(trigger)}`;
}

/** A reference without a digest comes from a card of another kind of trigger. */
export function parseApprovalReference(reference: string): { triggerId: string; shown?: string } {
  const [triggerId = '', shown] = reference.split('|');
  return shown ? { triggerId, shown } : { triggerId };
}

/** Turns each new-input condition into a condition on the input reserved for it. False, changing nothing, when one has no reserved input. */
export function bindNewInputs(trigger: Trigger): boolean {
  const bound: TriggerCondition[] = [];
  for (const condition of trigger.conditions) {
    if (condition.type !== 'new_input_event') {
      bound.push(condition);
      continue;
    }
    if (!condition.input_id) return false;
    bound.push({
      type: 'incoming_event',
      input_id: condition.input_id,
      ...(condition.filter?.length ? { filter: condition.filter } : {}),
    });
  }
  trigger.conditions = bound;
  return true;
}

export type SourceOwner =
  | { kind: 'user'; userId: string }
  /** A new input: whoever approves the proposal. */
  | { kind: 'approver' }
  | { kind: 'operator' }
  | { kind: 'unknown' };

/** The input a routine listens to, as its review names it. */
export interface RoutineSource {
  label: string;
  /** Null when the input could not be read. */
  scheme: InputAuth | null;
  owner: SourceOwner;
  inputFilter: readonly PointerCheck[];
  routineFilter: readonly PointerCheck[];
}

export interface RoutineReview {
  source: RoutineSource;
  /** The conversation the results go to and who can read it, e.g. "#notes, a private channel". */
  audience: string;
}

// Slack limits a section's text to 3,000 characters and a field's to 2,000.
const SECTION_TEXT_MAX = 2900;
const FIELD_TEXT_MAX = 1900;
const INSTRUCTION_SECTIONS_MAX = 10;

/** Slack reads `<…>` as a mention or a link and `&` as an entity; escaped, model-written text stays text. */
function plain(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function clipped(text: string): string {
  return text.length > FIELD_TEXT_MAX ? `${text.slice(0, FIELD_TEXT_MAX - 1)}…` : text;
}

function field(title: string, value: string): { type: 'mrkdwn'; text: string } {
  return { type: 'mrkdwn', text: `*${title}*\n${clipped(value)}` };
}

const SCHEME_LABEL: Record<InputAuth, string> = {
  standard_webhooks: 'signed webhook',
  bearer: 'webhook with a bearer token',
};

function describeSource(source: RoutineSource): string {
  const label = plain(source.label);
  return source.scheme ? `${label}, a ${SCHEME_LABEL[source.scheme]}` : label;
}

function describeOwner(owner: SourceOwner): string {
  if (owner.kind === 'user') return `<@${owner.userId}>`;
  if (owner.kind === 'approver') return 'whoever approves this';
  if (owner.kind === 'operator') return 'the operator';
  return 'unknown';
}

function describeFilter(source: RoutineSource): string {
  const checks = [...source.inputFilter, ...source.routineFilter];
  if (checks.length === 0) return 'every event the input receives';
  return plain(checks.map(describeCheck).join(' and '));
}

function instructionSections(prompt: string): unknown[] {
  const sections: unknown[] = [];
  for (
    let start = 0;
    start < prompt.length && sections.length < INSTRUCTION_SECTIONS_MAX;
    start += SECTION_TEXT_MAX
  ) {
    const text = prompt.slice(start, start + SECTION_TEXT_MAX);
    sections.push({ type: 'section', text: { type: 'plain_text', text, emoji: false } });
  }
  const hidden = prompt.length - sections.length * SECTION_TEXT_MAX;
  if (hidden > 0)
    sections.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `The instructions go on for ${hidden} more characters than a card can show. Ask for the full text before approving.`,
        },
      ],
    });
  return sections;
}

/** The approval card of an event routine: source, owner, filter, audience and the instructions in full. */
export function buildRoutineReviewBlocks(trigger: Trigger, review: RoutineReview): unknown[] {
  const { source } = review;
  return [
    { type: 'section', text: { type: 'mrkdwn', text: '*Set up this automation?*' } },
    {
      type: 'section',
      fields: [
        field('What', plain(trigger.summary?.trim() || '(no summary)')),
        field('Audience', plain(review.audience)),
        field('Source', describeSource(source)),
        field('Owner', describeOwner(source.owner)),
        field('Filter', describeFilter(source)),
      ],
    },
    { type: 'section', text: { type: 'mrkdwn', text: '*Instructions*' } },
    ...instructionSections(trigger.action.prompt),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve' },
          action_id: 'approve_trigger',
          value: approvalReference(trigger),
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Deny' },
          action_id: 'deny_trigger',
          value: trigger.id,
          style: 'danger',
        },
      ],
    },
  ];
}
