// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { AGENT_PROMPTS } from '../prompts.js';
import { triggeredBriefCopy } from '../spawn.js';

it('keeps the event file and the delivery line of a brief with a long prompt', () => {
  const eventFile = AGENT_PROMPTS.incomingEvent('/sessions/task-1/shared/incoming-event.json');
  const delivery = "Your first post_to_user opens this task's own thread in #notes.";
  const brief = AGENT_PROMPTS.triggered(
    `${'Summarise the meeting. '.repeat(600)}\n\n${eventFile}\n\n${delivery}`,
    'an incoming event',
  );

  const copy = triggeredBriefCopy(brief);

  expect(copy.length).toBeLessThan(8100);
  expect(copy).toContain(eventFile);
  expect(copy).toContain(delivery);
  expect(copy.startsWith(brief.slice(0, 200))).toBe(true);
  expect(triggeredBriefCopy('short')).toBe('short');
});
