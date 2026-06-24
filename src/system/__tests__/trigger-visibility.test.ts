/**
 * Tests for trigger visibility scoping — public triggers are visible from every
 * tier, private-channel triggers only from that channel, DM triggers only from
 * that user's DM, and the operator (CLI) sees everything.
 */

import { describe, it, expect } from 'vitest';
import { triggerVisibleFrom, type TriggerOrigin } from '../trigger-visibility.js';
import type { Trigger } from '../../types/trigger.js';

function channelTrigger(channelId: string): Trigger {
  return {
    id: `trg-${channelId}`,
    status: 'enabled',
    created_by: 'U1',
    created_at: '2026-06-24T00:00:00Z',
    binding: { type: 'channel', channel_id: channelId, channel_name: channelId },
    conditions: [{ type: 'schedule', tz: 'UTC', cron: '0 9 * * *', next_run_at: '2026-06-25T09:00:00Z' }],
    action: { prompt: 'do the thing' },
  };
}

function dmTrigger(userId: string): Trigger {
  return {
    id: `trg-dm-${userId}`,
    status: 'enabled',
    created_by: userId,
    created_at: '2026-06-24T00:00:00Z',
    binding: { type: 'user', user_id: userId },
    conditions: [{ type: 'schedule', tz: 'UTC', cron: '0 9 * * *', next_run_at: '2026-06-25T09:00:00Z' }],
    action: { prompt: 'do the thing' },
  };
}

// Privacy resolver driven by an explicit private-set.
const privacyFn = (privateChannels: Set<string>) => async (channelId: string) => privateChannels.has(channelId);

describe('triggerVisibleFrom', () => {
  const publicResolver = privacyFn(new Set());

  it('public-channel trigger is visible from a public channel', async () => {
    const origin: TriggerOrigin = { kind: 'channel', channelId: 'C_OTHER' };
    expect(await triggerVisibleFrom(channelTrigger('C_PUB'), origin, publicResolver)).toBe(true);
  });

  it('public-channel trigger is visible from a DM', async () => {
    const origin: TriggerOrigin = { kind: 'dm', userId: 'U9' };
    expect(await triggerVisibleFrom(channelTrigger('C_PUB'), origin, publicResolver)).toBe(true);
  });

  it('private-channel trigger is hidden from a different public channel', async () => {
    const resolver = privacyFn(new Set(['C_PRIV']));
    const origin: TriggerOrigin = { kind: 'channel', channelId: 'C_PUB' };
    expect(await triggerVisibleFrom(channelTrigger('C_PRIV'), origin, resolver)).toBe(false);
  });

  it('private-channel trigger is visible from that same private channel', async () => {
    const resolver = privacyFn(new Set(['C_PRIV']));
    const origin: TriggerOrigin = { kind: 'channel', channelId: 'C_PRIV' };
    expect(await triggerVisibleFrom(channelTrigger('C_PRIV'), origin, resolver)).toBe(true);
  });

  it('private-channel trigger is hidden from a DM', async () => {
    const resolver = privacyFn(new Set(['C_PRIV']));
    const origin: TriggerOrigin = { kind: 'dm', userId: 'U9' };
    expect(await triggerVisibleFrom(channelTrigger('C_PRIV'), origin, resolver)).toBe(false);
  });

  it('a channel that became private drops out of public listings (live resolution)', async () => {
    // Same trigger; only the resolver's verdict changed (public → private).
    const t = channelTrigger('C_FLIP');
    const origin: TriggerOrigin = { kind: 'channel', channelId: 'C_PUB' };
    expect(await triggerVisibleFrom(t, origin, privacyFn(new Set()))).toBe(true);
    expect(await triggerVisibleFrom(t, origin, privacyFn(new Set(['C_FLIP'])))).toBe(false);
  });

  it('DM trigger is visible only from that user\'s DM', async () => {
    expect(await triggerVisibleFrom(dmTrigger('U1'), { kind: 'dm', userId: 'U1' }, publicResolver)).toBe(true);
    expect(await triggerVisibleFrom(dmTrigger('U1'), { kind: 'dm', userId: 'U2' }, publicResolver)).toBe(false);
    expect(await triggerVisibleFrom(dmTrigger('U1'), { kind: 'channel', channelId: 'C_PUB' }, publicResolver)).toBe(false);
  });

  it('operator (CLI) sees everything', async () => {
    const resolver = privacyFn(new Set(['C_PRIV']));
    expect(await triggerVisibleFrom(channelTrigger('C_PRIV'), { kind: 'operator' }, resolver)).toBe(true);
    expect(await triggerVisibleFrom(dmTrigger('U1'), { kind: 'operator' }, resolver)).toBe(true);
  });
});
