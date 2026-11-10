// SPDX-License-Identifier: AGPL-3.0-or-later
import type { InitiativeStore } from './store.js';
import type { ObservationSlack } from './slack.js';
import { logger } from '../system/logger.js';

export class SourceAccess {
  constructor(
    private readonly store: InitiativeStore,
    private readonly slack: ObservationSlack,
  ) {}

  async evaluate(
    channel: string,
    recipient?: string,
  ): Promise<'allowed' | 'denied' | 'unavailable'> {
    try {
      const access = await this.slack.inspect(channel, recipient);
      if (!recipient) this.store.channel(channel, !!access, access?.shared ?? false);
      return access && (!recipient || access.recipientCanRead) ? 'allowed' : 'denied';
    } catch (error) {
      if (!recipient)
        this.store.channel(channel, false, false, 'Access lookup failed; coverage unknown');
      logger.warn('initiative', `Access unavailable for ${channel}`, error);
      return 'unavailable';
    }
  }

  async check(channel: string, recipient?: string): Promise<boolean> {
    return (await this.evaluate(channel, recipient)) === 'allowed';
  }
}
