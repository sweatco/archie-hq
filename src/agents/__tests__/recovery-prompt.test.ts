/**
 * The startup-recovery wake (`AGENT_PROMPTS.recovery`, sent by `recoverActiveTasks`
 * in `src/tasks/recovery.ts` to an in_progress task after a restart).
 *
 * A task can be recovered after a pending user message was consumed by a process
 * that died before answering it — the message never lands in the transcript the
 * PM reviews, only in `shared/knowledge.log`. The prompt has to point there (or at
 * the Slack thread) so the PM checks before silently calling report_completion.
 */
import { describe, it, expect } from 'vitest';

import { AGENT_PROMPTS } from '../prompts.js';

describe('AGENT_PROMPTS.recovery', () => {
  it('keeps the original interrupted/continue instruction', () => {
    expect(AGENT_PROMPTS.recovery).toContain(
      'Task was interrupted. Review the conversation for current state and continue where you left off.',
    );
  });

  it('points the PM at knowledge.log or the Slack thread for messages missing from its transcript', () => {
    expect(AGENT_PROMPTS.recovery).toContain('shared/knowledge.log');
    expect(AGENT_PROMPTS.recovery).toContain('Slack thread');
    expect(AGENT_PROMPTS.recovery).toMatch(/answer anything there/);
  });
});
