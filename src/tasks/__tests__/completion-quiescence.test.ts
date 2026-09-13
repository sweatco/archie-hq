/**
 * Unit tests for the completion-as-quiescence model (see
 * docs/plans/20260627-completion-quiescence.md).
 *
 * Covers the two load-bearing pure decisions:
 *  - `idleDecision` — at quiescence, park (completion intent) vs recover (dropped
 *    ball) vs wait (not active / forced-stop pending / still working).
 *  - `shouldClearCompletionIntent` — the edge-exact intent-clear that must NOT
 *    mis-fire on the SDK `init` re-fire of an already-active turn.
 *
 * The wired behaviours (report_completion sets intent, enqueue marks the agent
 * active) are exercised by the pre-merge smoke tests, not here — they need a live
 * Task + SDK and aren't unit-isolable.
 */

import { describe, it, expect } from 'vitest';
import { idleDecision } from '../recovery.js';
import { shouldClearCompletionIntent } from '../task.js';
import type { Task } from '../task.js';
import type { Agent } from '../../agents/agent.js';

/** Minimal agent stand-in — idleDecision reads `pendingTeardown`, `session.active`, `backgroundTasks`. */
function fakeAgent(opts: { active?: boolean; pendingTeardown?: boolean; bgTasks?: string[] } = {}): Agent {
  return {
    pendingTeardown: opts.pendingTeardown ? () => Promise.resolve() : undefined,
    session: { active: opts.active ?? false },
    backgroundTasks: new Set<string>(opts.bgTasks ?? []),
  } as unknown as Agent;
}

function fakeTask(opts: {
  isActive?: boolean;
  completionIntent?: boolean;
  agent?: Agent;
}): Pick<Task, 'isActive' | 'completionIntent' | 'agent'> {
  return {
    isActive: opts.isActive ?? true,
    completionIntent: opts.completionIntent ?? false,
    agent: opts.agent,
  } as unknown as Pick<Task, 'isActive' | 'completionIntent' | 'agent'>;
}

describe('idleDecision', () => {
  it('waits when the task is not active', () => {
    expect(idleDecision(fakeTask({ isActive: false, agent: fakeAgent() }))).toBe('wait');
  });

  it('waits when the agent has a pending (forced-stop) teardown', () => {
    expect(idleDecision(fakeTask({ agent: fakeAgent({ pendingTeardown: true }) }))).toBe('wait');
  });

  it('waits when the agent has not spawned (not quiescent)', () => {
    expect(idleDecision(fakeTask({}))).toBe('wait');
  });

  it('waits when the agent is still active (work in flight)', () => {
    expect(
      idleDecision(fakeTask({ completionIntent: true, agent: fakeAgent({ active: true }) })),
    ).toBe('wait');
  });

  it('waits when the agent has an in-flight background task (busy, not stalled)', () => {
    // Turn ended (session inactive) but a backgrounded wait is pending — must not
    // park or recover under it, even with completion intent set.
    expect(
      idleDecision(fakeTask({ completionIntent: true, agent: fakeAgent({ bgTasks: ['t1'] }) })),
    ).toBe('wait');
  });

  it('completes when quiescent and PM signalled completion intent', () => {
    expect(idleDecision(fakeTask({ completionIntent: true, agent: fakeAgent() }))).toBe('complete');
  });

  it('recovers when quiescent but nobody parked (dropped ball)', () => {
    expect(idleDecision(fakeTask({ completionIntent: false, agent: fakeAgent() }))).toBe('recover');
  });

  it('prioritises the forced-stop teardown guard over completion intent', () => {
    expect(
      idleDecision(fakeTask({ completionIntent: true, agent: fakeAgent({ pendingTeardown: true }) })),
    ).toBe('wait');
  });
});

describe('shouldClearCompletionIntent', () => {
  it('clears on a genuine inactive→active edge (re-engagement)', () => {
    expect(shouldClearCompletionIntent(true, false)).toBe(true);
  });

  it('does NOT clear on the init re-fire of an already-active turn', () => {
    // The SDK `init` re-fire arrives with the agent already active (the synchronous
    // enqueue mark set it first), so wasActive=true — must not re-clear intent.
    expect(shouldClearCompletionIntent(true, true)).toBe(false);
  });

  it('does NOT clear on the agent going inactive', () => {
    expect(shouldClearCompletionIntent(false, true)).toBe(false);
  });
});
