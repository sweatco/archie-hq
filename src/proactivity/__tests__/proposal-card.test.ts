// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Delivery } from '../types.js';

const f = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('@slack/web-api', () => ({ WebClient: vi.fn(function () { return { chat: { update: f.update } }; }) }));
vi.mock('../../connectors/slack/client.js', async original => ({
  ...await original<typeof import('../../connectors/slack/client.js')>(),
  getSlackClient: () => ({ token: 'test-token' }), isSlackDryRun: () => false,
}));
import { PublicSlack } from '../slack.js';

const delivery: Delivery = { id: 'card', channel: 'D_OWNER', thread: null, ts: '10.000001', text: 'Proposal; repository owner/repo; https://slack.test/source; normal task budget outside $200/day.',
  matters: [], evidence: [1], policy: 'base', digest: false, state: 'sent', created: 0, proposal: { id: 'release', version: 'v1' } };
beforeEach(() => { f.update.mockReset(); f.update.mockResolvedValue({ ok: true }); });
describe('proposal card replacement', () => {
  it('replaces all old actions while retaining proposal, sources and budget, then supplies an Open task link', async () => {
    const slack = new PublicSlack('U_OWNER');
    await slack.updateProposal(delivery, 'Starting… Approval saved.');
    await slack.updateProposal(delivery, 'Task started; outcome unverified.', 'https://slack.test/owner/task');
    const calls = f.update.mock.calls.map(call => call[0]);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toMatchObject({ channel: 'D_OWNER', ts: delivery.ts, text: expect.stringContaining(delivery.text) });
      expect(call.blocks).toEqual([{ type: 'markdown', text: call.text }]);
      expect(JSON.stringify(call.blocks)).not.toContain('initiative_start_task');
      expect(call.blocks.some((block: { type: string }) => block.type === 'actions')).toBe(false);
    }
    expect(calls[1].text).toContain('[Open task](https://slack.test/owner/task)');
    expect(calls[0].text).not.toContain('Task started');
  });
});
