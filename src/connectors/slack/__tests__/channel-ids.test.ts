import { describe, it, expect } from 'vitest';
import type { TaskMetadata } from '../../../types/task.js';
import { isDmOrUserId, formatConversationLabel, taskSlackChannelLabels } from '../channel-ids.js';

describe('isDmOrUserId', () => {
  it('flags 1:1 DM channel ids', () => {
    expect(isDmOrUserId('D0123ABCD')).toBe(true);
  });

  it('flags user ids that Slack would coerce into a DM', () => {
    expect(isDmOrUserId('U0123ABCD')).toBe(true);
    expect(isDmOrUserId('W0123ABCD')).toBe(true); // enterprise-grid user id
  });

  it('allows public/private channel ids (those are gated at the API layer)', () => {
    expect(isDmOrUserId('C0123ABCD')).toBe(false); // public/private channel — or an mpim
    expect(isDmOrUserId('G0123ABCD')).toBe(false); // legacy private channel / mpim
  });
});

describe('formatConversationLabel', () => {
  it('prefixes a channel name with #', () => {
    expect(formatConversationLabel('general')).toBe('#general');
  });

  it('leaves a DM label alone — it is already human-readable', () => {
    expect(formatConversationLabel('DM with Dana')).toBe('DM with Dana');
  });

  it('does not mistake a channel whose name merely starts with "DM with" for a DM', () => {
    expect(formatConversationLabel('DM within')).toBe('#DM within');
  });
});

describe('taskSlackChannelLabels', () => {
  it('renders a DM home channel without a # prefix', () => {
    const labels = taskSlackChannelLabels({
      channels: {},
      home_channel: { channel_id: 'D_DANA', channel_name: 'DM with Dana' },
    } as unknown as TaskMetadata);

    expect([...labels]).toEqual([['D_DANA', 'DM with Dana']]);
  });

  it('still prefixes a channel home channel', () => {
    const labels = taskSlackChannelLabels({
      channels: {},
      home_channel: { channel_id: 'C_OPS', channel_name: 'ops-daily' },
    } as unknown as TaskMetadata);

    expect([...labels]).toEqual([['C_OPS', '#ops-daily']]);
  });
});
