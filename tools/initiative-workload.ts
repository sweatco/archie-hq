// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { InitiativeStore } from '../src/proactivity/store.js';
import { InitiativeService } from '../src/proactivity/service.js';
import { ObservationRecall } from '../src/proactivity/recall.js';
import { AdmissionDeferred, ModelGateway } from '../src/proactivity/model.js';
import type { ObservationSlack } from '../src/proactivity/slack.js';
import type { SourceMessage } from '../src/proactivity/types.js';
import type { TaskMetadata } from '../src/types/task.js';
import { logger } from '../src/system/logger.js';

const START = Date.parse('2026-10-20T09:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function percentile(values: number[], quantile: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * quantile))] ?? 0;
}

export async function runInitiativeWorkload() {
  const root = mkdtempSync(join(tmpdir(), 'archie-initiative-workload-'));
  const originalNow = Date.now;
  let now = START;
  Date.now = () => now;
  const began = performance.now();
  const store = new InitiativeStore(join(root, 'state.sqlite'), 'T_WORKLOAD', START);
  const channels = Array.from({ length: 40 }, (_, i) => `C${i.toString().padStart(5, '0')}`);
  const events: Array<{ at: number; message: SourceMessage }> = [];
  const history: SourceMessage[] = [];
  for (let channel = 0; channel < channels.length; channel++) for (let thread = 0; thread < 6; thread++) {
    const rootAt = START + thread * 30_000 + channel + thread;
    const ts = (rootAt / 1000).toFixed(6);
    const count = thread === 0 && channel % 5 === 0 ? 226 : 6;
    for (let message = 0; message < count; message++) {
      const at = rootAt + message * (count > 6 ? 6000 : 3 * MINUTE);
      const messageTs = (at / 1000).toFixed(6);
      events.push({ at, message: { channel: channels[channel], thread: ts, ts: messageTs, version: messageTs, author: `U${message % 7}`,
        text: `${thread === 0 ? '[action] Release review' : 'Public discussion'} ${channel}/${thread}/${message}. ${'Context for the team. '.repeat(25)}` } });
    }
    if (thread === 1 && channel % 4 === 0) {
      const editAt = START + 75 * MINUTE + channel;
      events.push({ at: editAt, message: { channel: channels[channel], thread: ts, ts, version: (editAt / 1000).toFixed(6), author: 'U0', text: 'Decision changed after the first extraction.' } });
    }
  }
  events.sort((a, b) => a.at - b.at);
  const calls = { inspect: 0, channels: 0, page: 0, ownerDm: 0, verifyDm: 0, sends: 0, models: 0 };
  const contextBytes: number[] = [];
  const outputBytes: number[] = [];
  const dueLateness: number[] = [];
  const inputDelays: number[] = [];
  const waiting: Array<{ key: string; generation: number; at: number }> = [];
  const provider = {
    messages: { create: async (params: { messages: Array<{ content: string }> }) => {
      calls.models++;
      const bytes = Buffer.byteLength(JSON.stringify(params));
      contextBytes.push(bytes);
      const input = JSON.parse(params.messages[0].content);
      let answer: unknown;
      if (input.threads) {
        answer = { threads: input.threads.map((thread: { channel: string; thread: string; evidence: Array<{ id: number; text: string }> }) => {
          const evidence = thread.evidence.slice(-1).map(item => item.id);
          return { channel: thread.channel, thread: thread.thread,
            observations: [{ key: 'discussion', text: 'The public discussion has an evidenced update.', kind: 'change', evidence }],
            matters: thread.evidence.some(item => item.text.includes('[action]')) ? [{ key: 'review', title: 'Release review', detail: 'Review the release decision.', evidence,
              state: 'open', owner: 'U_OWNER', deadline: { date: new Date(START + 2 * HOUR).toISOString().slice(0, 10), time: new Date(START + 2 * HOUR).toISOString().slice(11, 16), timeZone: 'UTC' }, explicit: true, reopen: false }] : [] };
        }) };
      } else if (input.matter) {
        dueLateness.push(Math.max(0, now - input.matter.nextCheck));
        answer = { resolved: false, help: null, public: false, evidence: input.matter.evidence };
      } else answer = { answer: 'ok' };
      const text = JSON.stringify(answer);
      outputBytes.push(Buffer.byteLength(text));
      return { stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: {
        input_tokens: Math.ceil(bytes / 4), output_tokens: Math.ceil(Buffer.byteLength(text) / 4), cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      } };
    } },
  };
  const gateway = new ModelGateway(store, provider as unknown as Anthropic);
  const slack: ObservationSlack = {
    inspect: async channel => { calls.inspect++; return channels.includes(channel) ? { shared: false, ownerCanRead: true } : null; },
    channels: async () => { calls.channels++; return channels; },
    page: async (channel, oldest, latest, cursor, thread) => {
      calls.page++;
      const current = [...new Map(history.filter(message => message.channel === channel && (!thread || message.thread === thread)
        && Number(message.ts) >= Number(oldest) && Number(message.ts) <= Number(latest)).map(message => [message.ts, message])).values()]
        .sort((a, b) => Number(a.ts) - Number(b.ts));
      const start = Number(cursor ?? 0);
      const end = Math.min(current.length, start + 40);
      return { messages: current.slice(start, end), cursor: end < current.length ? String(end) : undefined };
    },
    ownerDm: async () => { calls.ownerDm++; return 'D_OWNER'; }, verifyDm: async channel => { calls.verifyDm++; return channel === 'D_OWNER'; },
    send: async () => { calls.sends++; return 'sent'; }, find: async () => undefined, active: () => false,
    link: (channel, thread) => `https://slack.test/${channel}/${thread}`,
  };
  const service = new InitiativeService(store, slack, gateway, { mode: 'shadow', owner: 'U_OWNER', extractionModel: 'claude-haiku-5-5', investigationModel: 'claude-sonnet-5-5' }, () => now);
  let peakQueue = 0;
  let peakDue = 0;
  let cursor = 0;
  let beforeIdleModels = 0;
  let idleEndModels = 0;
  let idleStart = 0;
  let idleEnd = 0;
  try {
    service.seed(now);
    for (let minute = 0; minute <= 8 * 60; minute++) {
      now = START + minute * MINUTE;
      while (cursor < events.length && events[cursor].at <= now) {
        const event = events[cursor++];
        history.push(event.message);
        await service.capture(event.message, event.at);
        const snapshot = store.snapshot(event.message.channel, event.message.thread);
        if (snapshot) waiting.push({ key: `${snapshot.channel}:${snapshot.thread}`, generation: snapshot.generation, at: event.at });
      }
      await service.tick(now, true);
      const state = store.workloadState(now);
      peakQueue = Math.max(peakQueue, state.queue); peakDue = Math.max(peakDue, state.due);
      const progress = new Map(state.threads.map(thread => [`${thread.channel}:${thread.thread}`, Number(thread.processed)]));
      for (let i = waiting.length - 1; i >= 0; i--) if ((progress.get(waiting[i].key) ?? 0) >= waiting[i].generation) {
        inputDelays.push(now - waiting[i].at); waiting.splice(i, 1);
      }
      if (minute === 6 * 60) { beforeIdleModels = calls.models; idleStart = store.workloadState(now).revisions; }
      if (minute === 8 * 60) { idleEndModels = calls.models; idleEnd = state.revisions; }
    }
    const beforeRecall = calls.inspect;
    const recall = new ObservationRecall(store, slack);
    const hits = await recall.search({ memory_destination: { channel_id: 'D_OWNER' } } as TaskMetadata, 'discussion', 10);
    const ownerRecallChecks = calls.inspect - beforeRecall;
    const state = store.workloadState(now);
    const metrics = {
      declaration: { synthetic: true, publicChannels: 40, threadsPerChannel: 6, longThreads: 8, longThreadMessages: 226,
        editedRoots: 10, sourcePageSize: 40, ticks: 481, hours: 8, mode: 'shadow', scope: 'Normalized service intake, collection, gateway admission, extraction and investigation; fake Slack and provider, zero network latency. Excludes Bolt transport queue and actual provider execution.' },
      events: { accepted: cursor, remainingToProcess: waiting.length, eventToThreadObservationMs: { median: percentile(inputDelays, .5), p95: percentile(inputDelays, .95), max: Math.max(0, ...inputDelays) },
        meaning: 'Arrival to a processed thread generation; long-thread omissions remain visible coverage gaps, not claims that every message was understood.' },
      dueCheckLatenessMs: { median: percentile(dueLateness, .5), p95: percentile(dueLateness, .95), max: Math.max(0, ...dueLateness) },
      calls: { ...calls }, ownerRecall: { hits: hits.length, metadataChecks: ownerRecallChecks },
      modelContexts: { admissions: calls.models, serializedRequestBytes: { total: contextBytes.reduce((a, b) => a + b, 0), max: Math.max(0, ...contextBytes), p95: percentile(contextBytes, .95) }, outputBytes: outputBytes.reduce((a, b) => a + b, 0) },
      idle: { hours: 2, sourceRevisionGrowth: idleEnd - idleStart, modelAdmissions: idleEndModels - beforeIdleModels,
        meaning: 'Unchanged unresolved matters still receive scheduled due checks; inactive resolved/non-actionable threads should not be re-extracted.' },
      queue: { peak: peakQueue, peakDue, final: state.queue, finalDue: state.due, deferred: state.deferred },
      storage: { revisions: state.revisions, validObservations: state.observations, rawUtf8Bytes: state.rawBytes,
        sqliteBytes: statSync(join(root, 'state.sqlite')).size, walBytes: statSync(join(root, 'state.sqlite-wal')).size },
      syntheticAccountingMicrodollars: { reserved: state.unsettled, settled: state.settled, chargedForDay: state.budget,
        note: 'Fake usage is derived from measured serialized bytes / 4, then priced by the real gateway. These ledger figures are an illustrative token estimate, not a paid invoice, live cost measurement or usefulness result.' },
      wallClockMs: Math.round(performance.now() - began),
    };
    const pressure = new InitiativeStore(':memory:', 'T_PRESSURE', now);
    try {
      const pressureGateway = new ModelGateway(pressure, provider as unknown as Anthropic);
      const probe = { model: 'claude-sonnet-5-5', system: 'Return the requested result.', input: {}, schema: z.object({ answer: z.string() }) };
      pressure.reserve(149_999_999, false, now);
      let routineDeferred = false;
      try { await pressureGateway.complete(probe, new AbortController().signal); } catch (error) { if (error instanceof AdmissionDeferred) routineDeferred = true; else throw error; }
      await pressureGateway.complete({ ...probe, priority: true }, new AbortController().signal);
      pressure.reserve(200_000_000 - pressure.budget(now), true, now);
      let priorityDeferred = false;
      try { await pressureGateway.complete({ ...probe, priority: true }, new AbortController().signal); } catch (error) { if (error instanceof AdmissionDeferred) priorityDeferred = true; else throw error; }
      return { ...metrics, pressure: { fixture: 'Separate real SQLite ledger seeded through reservation admission with synthetic prior liability; not generated workload spend.',
        routineDeferred, priorityDeferredAtHardCap: priorityDeferred, allowanceUsedMicrodollars: pressure.budget(now) } };
    } finally { pressure.close(); }
  } finally {
    Date.now = originalNow;
    service.stop(); service.release(); store.close(); rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runInitiativeWorkload().then(report => {
    const output = process.argv[2];
    if (output) writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
    logger.system(JSON.stringify(report, null, 2));
  }).catch(error => { logger.error('initiative-workload', 'Workload failed', error); process.exitCode = 1; });
}
