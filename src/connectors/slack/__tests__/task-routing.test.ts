import { describe, it, expect } from 'vitest';
import { shouldCreateNewTask, isAckableEvent, shouldForwardMessageEvent } from '../task-routing.js';

describe('shouldCreateNewTask', () => {
  it('creates a task on @mention (anywhere)', () => {
    expect(shouldCreateNewTask('app_mention', 'C123', false)).toBe(true);
  });

  it('creates a task for a DM message', () => {
    expect(shouldCreateNewTask('message', 'D123', false)).toBe(true);
  });

  it('creates a task when a human replies to a thread the bot started', () => {
    expect(shouldCreateNewTask('message', 'C123', true)).toBe(true);
  });

  it('does NOT create a task for a plain reply in a human-started channel thread', () => {
    expect(shouldCreateNewTask('message', 'C123', false)).toBe(false);
  });

  it('@mention still wins even if the root is not the bot', () => {
    expect(shouldCreateNewTask('app_mention', 'C123', false)).toBe(true);
  });
});

describe('group-DM (G…) routing parity', () => {
  // A group DM has a `G…` channel id. It is handled channel-like everywhere:
  // ackable/task-creating only via the app_mention arm, forwardable only via the
  // thread-reply or watched-trigger arms — never via the `D`-prefix DM arm.

  it('AC1: an @mention in a group DM creates a task and is ackable', () => {
    expect(shouldCreateNewTask('app_mention', 'G0ABC', false)).toBe(true);
    expect(isAckableEvent('app_mention', 'G0ABC')).toBe(true);
  });

  it('AC2: a thread reply in a group DM is forwarded', () => {
    expect(
      shouldForwardMessageEvent(
        { type: 'message', channel: 'G0ABC', ts: '2', thread_ts: '1' },
        () => false,
      ),
    ).toBe(true);
  });

  it('AC3: an ambient top-level group-DM message with no trigger is not forwarded, nor ackable', () => {
    expect(
      shouldForwardMessageEvent({ type: 'message', channel: 'G0ABC', ts: '1' }, () => false),
    ).toBe(false);
    expect(isAckableEvent('message', 'G0ABC')).toBe(false);
  });

  it('regression: an ambient top-level channel message still forwards when a trigger is watching', () => {
    expect(
      shouldForwardMessageEvent({ type: 'message', channel: 'C0XYZ', ts: '1' }, () => true),
    ).toBe(true);
  });
});
