// SPDX-License-Identifier: AGPL-3.0-or-later
import type { InitiativeStore } from './store.js';
import type { ObservationSlack } from './slack.js';
import { SourceAccess } from './access.js';
import type { SourceMessage, Matter, ThreadSnapshot } from './types.js';

const HOUR = 3_600_000;

export class SourceCollector {
  private readonly access: SourceAccess;
  constructor(private readonly store: InitiativeStore, private readonly slack: ObservationSlack, private readonly isStopped: () => boolean = () => false) {
    this.access = new SourceAccess(store, slack);
  }

  private accessible(channel: string, owner = false): Promise<boolean> { return this.access.check(channel, owner); }

  async capture(message: SourceMessage, now = Date.now()): Promise<void> {
    const access = await this.slack.inspect(message.channel);
    this.store.channel(message.channel, !!access, access?.shared ?? false);
    if (access && this.store.record(message, now) !== null && !message.own) this.store.schedule('thread', `${message.channel}:${message.thread}`, now, JSON.stringify({ channel: message.channel, thread: message.thread }));
  }

  async reconcile(now: number, signal: AbortSignal): Promise<void> {
    const channels = await this.slack.channels();
    const known = this.store.attention.allowedChannels();
    for (const row of known) if (!channels.includes(String(row.id))) this.store.channel(String(row.id), false, false, 'Bot membership removed');
    for (const channel of channels) {
      signal.throwIfAborted();
      if (!this.store.attention.scheduledJob('collect', channel)) this.store.schedule('collect', channel, now);
    }
  }

  async collect(channel: string, now: number, signal: AbortSignal): Promise<number> {
    if (!await this.accessible(channel)) return now + HOUR;
    const progress = this.store.attention.channelProgress(channel)!;
    const latest = this.store.setting(`scan:${channel}`) ?? String(now / 1000);
    this.store.set(`scan:${channel}`, latest);
    const page = await this.slack.page(channel, String(progress.checkpoint), latest, progress.cursor as string | undefined);
    signal.throwIfAborted();
    if (!await this.accessible(channel)) return now + HOUR;
    for (const message of page.messages) {
      if (this.store.record(message, now) !== null && !message.own) this.store.schedule('thread', `${channel}:${message.thread}`, now, JSON.stringify({ channel, thread: message.thread }));
    }
    this.store.advanceCollection(channel, page.cursor ? progress.checkpoint : latest, page.cursor);
    return now + (page.cursor ? 60_000 : HOUR);
  }

  async refresh(matter: Pick<Matter, 'channel' | 'thread'>, now: number, signal?: AbortSignal, maxReads = 10): Promise<ThreadSnapshot | null> {
    if (!await this.accessible(matter.channel)) return null;
    const oldest = this.store.setting('watermark')!;
    const key = `thread-scan:${matter.channel}:${matter.thread}`;
    const scan = JSON.parse(this.store.setting(key) ?? JSON.stringify({ latest: String(now / 1000), cursor: undefined, seen: [] })) as { latest: string; cursor?: string; seen?: string[] };
    scan.seen ??= [];
    const olderParent = Number(matter.thread) < Number(oldest);
    let parentUnavailable = false;
    if (olderParent) {
      signal?.throwIfAborted();
      const parent = await this.slack.page(matter.channel, matter.thread, matter.thread);
      signal?.throwIfAborted();
      if (!await this.accessible(matter.channel)) return null;
      const original = parent.messages.find((m) => m.ts === matter.thread);
      if (original) this.store.record({ ...original, context: true }, now);
      else {
        const previous = this.store.attention.currentMessage(matter.channel, matter.thread);
        if (previous) this.store.record({ channel: matter.channel, thread: matter.thread, ts: matter.thread, version: Number(scan.latest).toFixed(6), author: String(previous.author), text: '', deleted: true, own: previous.own === 1, bot: previous.bot === 1 }, now);
        else parentUnavailable = true;
      }
    }
    for (let reads = Number(olderParent); reads < maxReads; reads++) {
      if (this.isStopped()) return null;
      signal?.throwIfAborted();
      const page = await this.slack.page(matter.channel, oldest, scan.latest, scan.cursor, matter.thread);
      signal?.throwIfAborted();
      if (!await this.accessible(matter.channel)) return null;
      for (const message of page.messages) this.store.record(message, now);
      scan.seen.push(...page.messages.map((m) => m.ts));
      if (!page.cursor) {
        for (const missing of this.store.attention.coveredMessages(matter.channel, matter.thread, Number(oldest), Number(scan.latest), Number(scan.latest))) {
          if (!scan.seen.includes(String(missing.ts))) this.store.record({ channel: matter.channel, thread: matter.thread, ts: String(missing.ts),
            version: Number(scan.latest).toFixed(6), author: String(missing.author), text: '', deleted: true, own: missing.own === 1, bot: missing.bot === 1 }, now);
        }
        this.store.completeThreadRefresh(matter.channel, matter.thread, parentUnavailable ? 'Older thread parent unavailable; context incomplete' : null);
        return this.store.snapshot(matter.channel, matter.thread);
      }
      scan.cursor = page.cursor;
      this.store.set(key, JSON.stringify(scan));
      this.store.attention.setThreadGap('Thread pagination incomplete', matter.channel, matter.thread);
    }
    this.store.schedule('thread', `${matter.channel}:${matter.thread}`, now + 60_000, JSON.stringify(matter));
    return null;
  }

}
