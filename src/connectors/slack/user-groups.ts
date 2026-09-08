// SPDX-License-Identifier: AGPL-3.0-or-later

import type { WebClient } from '@slack/web-api';
import { getHomeTeamId, getSlackClient } from './client.js';
import { ToolAccessDenied, type SlackPrincipal } from '../../agents/tool-access.js';

export const GROUP_CACHE_TTL_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 5_000;
type GroupMembers = { expires: number; users: Set<string> };

/** Each cache entry includes group state AND members, never an event snapshot. */
export class SlackGroupAccess {
  private generation = 0;
  private cache = new Map<string, GroupMembers>();
  private pending = new Map<string, Promise<GroupMembers>>();

  constructor(
    private client: () => WebClient,
    private homeTeam: () => string | null,
  ) {}

  invalidate(): void {
    this.generation++;
    this.cache.clear();
    this.pending.clear();
  }

  get version(): number { return this.generation; }

  /** Returns a synchronous freshness check for callers that must persist before executing. */
  async requireMembership(principal: SlackPrincipal | undefined, groups: string[]): Promise<() => void> {
    const teamId = this.homeTeam();
    if (!principal || !teamId || principal.teamId !== teamId || !/^[UW][A-Z0-9]+$/.test(principal.userId)) {
      throw new ToolAccessDenied('A verified human from the configured Slack workspace is required.');
    }
    const generation = this.generation;
    const started = Date.now();
    try {
      // Group checks also revalidate the account; deactivated/bot/guest users
      // must not remain eligible because a cached group still names them.
      const userResult = await this.bounded(this.client().users.info({ user: principal.userId }));
      const user = userResult.user;
      if (!userResult.ok || !user || user.team_id !== teamId || user.deleted || user.is_bot || user.is_app_user ||
          user.is_restricted || user.is_ultra_restricted) {
        throw new ToolAccessDenied('An active internal Slack member is required.');
      }
      const members = await Promise.all(groups.map((group) => this.members(teamId, group)));
      if (!members.some(({ users }) => users.has(principal.userId))) {
        throw new ToolAccessDenied(`Requires membership in Slack user group ${groups.join(' or ')}.`);
      }
      const expires = Math.min(started + GROUP_CACHE_TTL_MS, ...members.map((entry) => entry.expires));
      const recheck = () => {
        if (generation !== this.generation || this.homeTeam() !== teamId || Date.now() >= expires) {
          throw new ToolAccessDenied('Slack membership verification expired or changed; retry.');
        }
      };
      recheck();
      return recheck;
    } catch (error) {
      if (error instanceof ToolAccessDenied) throw error;
      throw new ToolAccessDenied(`Could not verify Slack user groups ${groups.join(', ')}. Retry when Slack is available.`);
    }
  }

  private members(teamId: string, groupId: string): Promise<GroupMembers> {
    const key = `${teamId}:${groupId}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const generation = this.generation;
    const lookup = (async () => {
      const started = Date.now();
      const client = this.client();
      const [metadata, result] = await Promise.all([
        this.bounded(client.usergroups.list({ include_disabled: true, include_users: false, team_id: teamId })),
        this.bounded(client.usergroups.users.list({ usergroup: groupId, team_id: teamId })),
      ]);
      const group = metadata.usergroups?.find((entry) => entry.id === groupId);
      if (!metadata.ok || !result.ok || !group || group.team_id !== teamId || group.is_external ||
          group.date_delete || !Array.isArray(result.users)) {
        throw new Error('Missing, disabled, external, or unreadable Slack user group.');
      }
      if (generation !== this.generation || this.homeTeam() !== teamId) {
        throw new Error('Slack group cache was invalidated during lookup.');
      }
      const entry = { users: new Set(result.users), expires: started + GROUP_CACHE_TTL_MS };
      this.cache.set(key, entry);
      return entry;
    })();
    this.pending.set(key, lookup);
    void lookup.finally(() => {
      if (this.pending.get(key) === lookup) this.pending.delete(key);
    }).catch(() => {});
    return lookup;
  }

  private async bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Slack authorization lookup timed out.')), LOOKUP_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export const slackGroupAccess = new SlackGroupAccess(() => getSlackClient(), () => getHomeTeamId());
