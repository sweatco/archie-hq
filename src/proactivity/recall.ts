// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TaskMetadata } from '../types/task.js';
import { deriveTaskDestination } from '../tasks/destination.js';
import type { ObservationAPI } from './api.js';
import { SourceAccess } from './access.js';
import type { InitiativeStore } from './store.js';
import type { ObservationSlack } from './slack.js';

export class ObservationRecall implements ObservationAPI {
  private readonly access: SourceAccess;

  constructor(private readonly store: InitiativeStore, private readonly slack: ObservationSlack) {
    this.access = new SourceAccess(store, slack);
  }

  private async scope(metadata: TaskMetadata): Promise<{ channels: string[]; owner: boolean }> {
    const destination = metadata.memory_destination?.channel_id
      ?? deriveTaskDestination(metadata.channels ?? {}, metadata.default_channel, metadata.home_channel?.channel_id)?.channel_id;
    if (!destination) return { channels: [], owner: false };
    if (await this.slack.verifyDm(destination)) return { channels: [], owner: true };
    return { channels: await this.access.check(destination) ? [destination] : [], owner: false };
  }

  async search(metadata: TaskMetadata, query: string, limit: number) {
    const scope = await this.scope(metadata);
    const hits = this.store.search(query, scope.owner ? null : scope.channels, limit);
    const allowed = new Map<string, boolean>();
    const results = [];
    for (const observation of hits) {
      if (!allowed.has(observation.channel)) allowed.set(observation.channel, await this.access.check(observation.channel, scope.owner));
      const current = this.store.attention.observation(observation.id);
      if (allowed.get(observation.channel) && current) results.push({ id: observation.id, text: `${current.text}\n${this.slack.link(observation.channel, observation.thread)}`, recency: '' });
    }
    return results;
  }

  async read(metadata: TaskMetadata, kind: 'observation' | 'matter' | 'matters', id?: string): Promise<unknown> {
    const scope = await this.scope(metadata);
    if (kind === 'matters') {
      if (!scope.owner) return 'Owner DM required.';
      const matters = [];
      const allowed = new Map<string, boolean>();
      for (const matter of this.store.matters()) {
        if (!allowed.has(matter.channel)) allowed.set(matter.channel, await this.access.check(matter.channel, true));
        const current = this.store.matter(matter.id);
        if (allowed.get(matter.channel) && current?.valid && ['open', 'snoozed'].includes(current.state)) matters.push(current);
      }
      return matters;
    }
    if (kind === 'matter') {
      const matter = this.store.matter(id ?? '');
      if (!scope.owner || !matter?.valid || !await this.access.check(matter.channel, true)) return 'Matter unavailable.';
      const current = this.store.matter(matter.id);
      return current?.valid ? { matter: current, source: this.store.snapshot(matter.channel, matter.thread), explanation: this.store.explain(matter.id) } : 'Matter unavailable.';
    }
    const observation = this.store.attention.observation(id ?? '');
    if (!observation || (!scope.owner && !scope.channels.includes(String(observation.channel))) || !await this.access.check(String(observation.channel), scope.owner)) return 'Observation unavailable.';
    const current = this.store.attention.observation(id ?? '');
    return current ? { observation: current, source: this.store.snapshot(String(current.channel), String(current.thread)) } : 'Observation unavailable.';
  }
}
