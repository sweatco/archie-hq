import { describe, it, expect } from 'vitest';
import { renderChannel } from '../channel-render.js';
import { registerChannelDeliverer } from '../../tasks/channel-delivery.js';
import type { Channel, ChannelType } from '../../types/task.js';

describe('renderChannel', () => {
  it('renders a Slack channel with a # prefix', () => {
    const ch: Channel = {
      type: 'slack', thread_id: '1', channel_id: 'C1', channel_name: 'engineering', last_processed_ts: '0',
    };
    expect(renderChannel('slack:C1:1', ch)).toBe('#engineering');
  });

  it('renders a Slack DM without a # prefix', () => {
    const ch: Channel = {
      type: 'slack', thread_id: '1', channel_id: 'D1', channel_name: 'DM with Jane', last_processed_ts: '0',
    };
    expect(renderChannel('slack:D1:1', ch)).toBe('DM with Jane');
  });

  it('falls back to the channel id when a Slack channel has no name', () => {
    const ch: Channel = {
      type: 'slack', thread_id: '1', channel_id: 'C1', channel_name: '', last_processed_ts: '0',
    };
    expect(renderChannel('slack:C1:1', ch)).toBe('#C1');
  });

  it('renders a CLI channel', () => {
    const ch: Channel = { type: 'cli', id: 'cli:local' };
    expect(renderChannel('cli:local', ch)).toBe('CLI session');
  });

  it('renders a registered kind through the registry, without this module knowing what the kind is', () => {
    const REGISTERED = 'made-up-registered-kind' as ChannelType;
    registerChannelDeliverer(REGISTERED, async () => undefined, (ch) => `custom render of ${ch.type}`);
    const ch = { type: REGISTERED } as unknown as Channel;

    expect(renderChannel('made-up:1', ch)).toBe('custom render of made-up-registered-kind');
  });

  it('falls back to the channel id when nothing is registered for the kind at all', () => {
    const UNREGISTERED = 'nobody-registered-anything-for-this-kind' as ChannelType;
    const ch = { type: UNREGISTERED } as unknown as Channel;

    expect(renderChannel('unregistered:xyz', ch)).toBe('unregistered:xyz');
  });

  // Registry is a process-wide Map, not reset between test files in a worker — a "recall unregistered"
  // case here would be order-dependent. Pinned in src/voice/__tests__ instead.
});
