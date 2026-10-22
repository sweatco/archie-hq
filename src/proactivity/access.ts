// SPDX-License-Identifier: AGPL-3.0-or-later
import type { InitiativeStore } from './store.js';
import type { ObservationSlack } from './slack.js';
import { logger } from '../system/logger.js';

export class SourceAccess {
  constructor(private readonly store: InitiativeStore, private readonly slack: ObservationSlack) {}

  async evaluate(channel: string, owner = false): Promise<'allowed' | 'denied' | 'unavailable'> {
    try {
      const access = await this.slack.inspect(channel, owner);
      this.store.channel(channel, !!access, access?.shared ?? false);
      return access && (!owner || access.ownerCanRead) ? 'allowed' : 'denied';
    } catch (error) {
      this.store.channel(channel, false, false, 'Access lookup failed; coverage unknown');
      logger.warn('initiative', `Access unavailable for ${channel}`, error);
      return 'unavailable';
    }
  }

  async check(channel: string, owner = false): Promise<boolean> { return await this.evaluate(channel, owner) === 'allowed'; }

  async all(channels: string[], owner = true): Promise<boolean> {
    if (!channels.length) return false;
    for (const channel of new Set(channels)) if (!await this.check(channel, owner)) return false;
    return true;
  }
}
