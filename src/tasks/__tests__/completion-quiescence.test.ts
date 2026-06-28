/**
 * Unit tests for the completion-as-quiescence model (see
 * docs/plans/20260627-completion-quiescence.md).
 *
 * Covers the two load-bearing pure decisions:
 *  - `idleDecision` — at quiescence, park (completion intent) vs recover (dropped
 *    ball) vs wait (not active / forced-stop pending / still working).
 *  - `shouldClearCompletionIntent` — the edge-exact PM intent-clear that must NOT
 *    mis-fire on the SDK `init` re-fire of an already-active turn.
 *
 * The wired behaviours (report_completion sets intent, enqueue marks the target
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
  agents?: Agent[];
}): Pick<Task, 'isActive' | 'completionIntent' | 'agentProcesses'> {
  const agentProcesses = new Map<string, Agent>();
  (opts.agents ?? []).forEach((a, i) => agentProcesses.set(`agent-${i}`, a));
  return {
    isActive: opts.isActive ?? true,
    completionIntent: opts.completionIntent ?? false,
    agentProcesses,
  } as unknown as Pick<Task, 'isActive' | 'completionIntent' | 'agentProcesses'>;
}

describe('idleDecision', () => {
  it('waits when the task is not active', () => {
    expect(idleDecision(fakeTask({ isActive: false, agents: [fakeAgent()] }))).toBe('wait');
  });

  it('waits when any agent has a pending (forced-stop) teardown', () => {
    expect(
      idleDecision(fakeTask({ agents: [fakeAgent(), fakeAgent({ pendingTeardown: true })] })),
    ).toBe('wait');
  });

  it('waits when no agents are spawned (not quiescent)', () => {
    expect(idleDecision(fakeTask({ agents: [] }))).toBe('wait');
  });

  it('waits when any agent is still active (work in flight)', () => {
    expect(
      idleDecision(fakeTask({ completionIntent: true, agents: [fakeAgent({ active: true }), fakeAgent()] })),
    ).toBe('wait');
  });

  it('waits when an agent has an in-flight background task (busy, not stalled)', () => {
    // Turn ended (session inactive) but a backgrounded wait is pending — must not
    // park or recover under it, even with completion intent set.
    expect(
      idleDecision(fakeTask({ completionIntent: true, agents: [fakeAgent({ bgTasks: ['t1'] })] })),
    ).toBe('wait');
  });

  it('completes when quiescent and PM signalled completion intent', () => {
    expect(
      idleDecision(fakeTask({ completionIntent: true, agents: [fakeAgent(), fakeAgent()] })),
    ).toBe('complete');
  });

  it('recovers when quiescent but nobody parked (dropped ball)', () => {
    expect(
      idleDecision(fakeTask({ completionIntent: false, agents: [fakeAgent()] })),
    ).toBe('recover');
  });

  it('prioritises the forced-stop teardown guard over completion intent', () => {
    expect(
      idleDecision(
        fakeTask({ completionIntent: true, agents: [fakeAgent({ pendingTeardown: true })] }),
      ),
    ).toBe('wait');
  });
});

describe('shouldClearCompletionIntent', () => {
  it('clears on a genuine PM inactive→active edge (re-engagement)', () => {
    expect(shouldClearCompletionIntent('pm-agent', true, false)).toBe(true);
  });

  it('does NOT clear on the init re-fire of an already-active PM turn', () => {
    // The SDK `init` re-fire arrives with the agent already active (the synchronous
    // enqueue mark set it first), so wasActive=true — must not re-clear intent.
    expect(shouldClearCompletionIntent('pm-agent', true, true)).toBe(false);
  });

  it('does NOT clear when a specialist re-engages', () => {
    expect(shouldClearCompletionIntent('mobile-agent', true, false)).toBe(false);
  });

  it('does NOT clear on PM going inactive', () => {
    expect(shouldClearCompletionIntent('pm-agent', false, true)).toBe(false);
  });
});
