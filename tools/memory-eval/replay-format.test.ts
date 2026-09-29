import { describe, expect, it } from 'vitest';
import { replayLogEntry } from './replay-format.js';
import type { Event, History } from './schema.js';

const at = '2026-01-01T00:00:00.000Z';
const history: History = { id: 'sample', family: 'sample', source: 'synthetic', workload: 'synthetic',
  scope: { kind: 'public', channelId: 'CTESTCHAN01', authorIds: ['UTESTUSER01'] }, events: [], completions: [] };
const source = { ref: 'sample', start: 0, end: 1, quote: 'I prefer weekly reports.' };

describe('replay source headers', () => {
  it('preserves a verified own-message ID and timestamp', () => {
    const event: Event = { at, role: 'user', text: source.quote, source, taskId: 'task-1',
      authorId: 'UTESTUSER01', authorName: 'Test User', messageTs: '1767225600.123456' };
    const rendered = replayLogEntry(event, history);
    expect(rendered).toContain('<@UTESTUSER01:Test User>');
    expect(rendered).toContain('msg:1767225600.123456');
    expect(rendered).toContain('I prefer weekly reports.');
  });

  it('does not invent profile provenance for quotes or unverified messages', () => {
    const reported: Event = { at, role: 'user', text: 'Mira said she prefers weekly reports.', source };
    const assistant: Event = { at, role: 'assistant', text: 'Mira prefers weekly reports.', source };
    expect(replayLogEntry(reported, history)).not.toContain('msg:');
    expect(replayLogEntry(reported, history)).toContain('[unverified-user]');
    expect(replayLogEntry(assistant, history)).toContain('[pm-agent]');
    expect(replayLogEntry(assistant, history)).not.toContain('msg:');
  });
});
