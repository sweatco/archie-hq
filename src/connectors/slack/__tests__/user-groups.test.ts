// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { SlackGroupAccess, GROUP_CACHE_TTL_MS } from '../user-groups.js';

function setup() {
  const user = vi.fn().mockResolvedValue({ ok: true, user: { team_id: 'T1', deleted: false, is_bot: false } });
  const list = vi.fn().mockResolvedValue({ ok: true, usergroups: [{ id: 'S1', team_id: 'T1', date_delete: 0 }, { id: 'S2', team_id: 'T1', date_delete: 0 }] });
  const users = vi.fn().mockResolvedValue({ ok: true, users: ['U1'] });
  const client = { users: { info: user }, usergroups: { list, users: { list: users } } } as unknown as WebClient;
  const home = vi.fn().mockReturnValue('T1');
  return { checker: new SlackGroupAccess(() => client, home), user, list, users, home };
}
const principal = { teamId: 'T1', userId: 'U1' };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('Slack group authorization', () => {
  it('allows members, denies nonmembers, and coalesces/cache-bounds group lookups', async () => {
    const { checker, users } = setup();
    await Promise.all([checker.requireMembership(principal, ['S1']), checker.requireMembership(principal, ['S1'])]);
    expect(users).toHaveBeenCalledTimes(1);
    await expect(checker.requireMembership({ ...principal, userId: 'U2' }, ['S1'])).rejects.toThrow('Requires membership');
    expect(users).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(GROUP_CACHE_TTL_MS + 1);
    users.mockResolvedValue({ ok: true, users: [] });
    await expect(checker.requireMembership(principal, ['S1'])).rejects.toThrow('Requires membership');
    expect(users).toHaveBeenCalledTimes(2);
  });

  it('invalidates cached membership and rejects an in-flight result after a group event', async () => {
    const { checker, users } = setup();
    await checker.requireMembership(principal, ['S1']);
    checker.invalidate();
    let finish!: (value: unknown) => void;
    users.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const lookup = checker.requireMembership(principal, ['S1']);
    const rejected = expect(lookup).rejects.toThrow('Could not verify');
    await vi.advanceTimersByTimeAsync(1);
    checker.invalidate();
    finish({ ok: true, users: ['U1'] });
    await rejected;
    users.mockResolvedValue({ ok: true, users: [] });
    await expect(checker.requireMembership(principal, ['S1'])).rejects.toThrow('Requires membership');
  });

  it.each([
    { usergroups: [] },
    { usergroups: [{ id: 'S1', team_id: 'T1', date_delete: 123 }] },
    { usergroups: [{ id: 'S1', team_id: 'T2' }] },
    { usergroups: [{ id: 'S1', team_id: 'T1', is_external: true }] },
    { ok: false, usergroups: [{ id: 'S1', team_id: 'T1' }] },
  ])('fails closed for missing/disabled/foreign/unreadable groups: %j', async (metadata) => {
    const { checker, list } = setup();
    list.mockResolvedValue({ ok: true, ...metadata });
    await expect(checker.requireMembership(principal, ['S1'])).rejects.toThrow('Could not verify');
  });

  it.each([{ deleted: true }, { is_bot: true }, { is_app_user: true }, { is_restricted: true }, { is_ultra_restricted: true }, { team_id: 'T2' }])('rejects ineligible accounts: %j', async (flags) => {
    const { checker, user } = setup();
    user.mockResolvedValue({ ok: true, user: { team_id: 'T1', ...flags } });
    await expect(checker.requireMembership(principal, ['S1'])).rejects.toThrow('active internal');
  });

  it('rejects unknown identities/workspaces before making a Slack call', async () => {
    const { checker, user, home } = setup();
    await expect(checker.requireMembership(undefined, ['S1'])).rejects.toThrow('verified human');
    await expect(checker.requireMembership({ ...principal, teamId: 'T2' }, ['S1'])).rejects.toThrow('verified human');
    home.mockReturnValue(null);
    await expect(checker.requireMembership(principal, ['S1'])).rejects.toThrow('verified human');
    expect(user).not.toHaveBeenCalled();
  });

  it('accepts any configured group, and never relies on the truncated users snapshot', async () => {
    const { checker, users, list } = setup();
    list.mockResolvedValue({ ok: true, usergroups: [{ id: 'S1', team_id: 'T1', users: [] }, { id: 'S2', team_id: 'T1', users: [] }] });
    users.mockImplementation(async ({ usergroup }) => ({ ok: true, users: usergroup === 'S2' ? ['U1'] : [] }));
    await expect(checker.requireMembership(principal, ['S1', 'S2'])).resolves.toEqual(expect.any(Function));
  });

  it('invalidates a successful proof at cache expiry, a group event, or workspace change', async () => {
    const { checker, home } = setup();
    const check = await checker.requireMembership(principal, ['S1']);
    expect(check).not.toThrow();
    vi.advanceTimersByTime(GROUP_CACHE_TTL_MS);
    expect(check).toThrow('expired or changed');
    const refreshed = await checker.requireMembership(principal, ['S1']);
    checker.invalidate();
    expect(refreshed).toThrow('expired or changed');
    const current = await checker.requireMembership(principal, ['S1']);
    home.mockReturnValue('T2');
    expect(current).toThrow('expired or changed');
  });

  it('bounds Slack retries and fails closed instead of timing out the tool hook', async () => {
    const { checker, user } = setup();
    user.mockImplementation(() => new Promise(() => {}));
    const result = expect(checker.requireMembership(principal, ['S1'])).rejects.toThrow('Could not verify');
    await vi.advanceTimersByTimeAsync(5_001);
    await result;
  });
});
