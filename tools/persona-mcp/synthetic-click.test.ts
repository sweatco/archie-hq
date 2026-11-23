import { describe, it, expect } from 'vitest';
import { sendSyntheticClick } from './synthetic-click.js';

const click = {
  teamId: 'T0TEST00001',
  userId: 'U0BOB000001',
  channelId: 'D0ALICE0001',
  messageTs: '1800000000.000100',
  actionId: 'approve_memory_preference',
};
const target = { webhookUrl: 'http://localhost:3000/webhooks/slack', signingSecret: 'secret' };

const answering = (status: number): typeof fetch =>
  (() => Promise.resolve(new Response('', { status }))) as typeof fetch;

describe('sendSyntheticClick', () => {
  it.each([
    [200, 'acknowledged'],
    [404, 'no_listener'],
    [401, 'rejected'],
    [500, 'failed'],
  ] as const)(
    'reads HTTP %i as %s and always marks the result synthetic',
    async (status, outcome) => {
      const result = await sendSyntheticClick(target, click, 1_800_000_000, answering(status));
      expect(result).toMatchObject({ synthetic: true, httpStatus: status, outcome });
      expect(result.note).not.toBe('');
    },
  );

  it('explains that a 404 can mean no HTTP receiver at all', async () => {
    const result = await sendSyntheticClick(target, click, 1_800_000_000, answering(404));
    expect(result.note).toMatch(/no HTTP receiver/);
  });
});
