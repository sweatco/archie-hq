// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { extname } from 'node:path';
import { InitiativeStore } from './store.js';
import type { Delivery, Matter, Observation, ThreadSnapshot } from './types.js';
import { lisbonDay } from './types.js';
import { InitiativeService, Assessment, LearningDeferred, type InitiativeConfig } from './service.js';
import { AdmissionDeferred, type BackgroundModel, type ModelRequest, ModelGateway } from './model.js';
import type { RecordedCheck } from './persistence/replay.js';
import type { ObservationSlack } from './slack.js';

export const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Bind reviews to the actual decision implementation, including its storage and input bounds.
const implementationFiles = readdirSync(new URL('.', import.meta.url), { recursive: true })
  .map(String).filter(name => name.endsWith(extname(import.meta.url)) && !name.includes('__tests__')).sort();
const taskBoundaryFiles = ['../tasks/task', '../tasks/persistence', '../tasks/recovery', '../tasks/destination', '../agents/spawn'].map(name => name + extname(import.meta.url));
export const PIPELINE = fingerprint([...implementationFiles, ...taskBoundaryFiles].map(name => [name, readFileSync(new URL(name, import.meta.url), 'utf8')]));

type Ref = { id: number; hash: string };
type Source = Omit<ThreadSnapshot, 'evidence'> & { evidence: number[] };
export interface DecisionCase {
  pipeline: string;
  now: number;
  config: InitiativeConfig;
  roots: Array<{ channel: string; thread: string }>;
  sources: Source[];
  refs: Ref[];
  matters: Matter[];
  checks: RecordedCheck[];
  observations: Observation[];
  deliveries: Delivery[];
  usedSlots: { digest: number; extra: number };
  controls: Record<string, string>;
  active: string[];
  ownerCanRead: boolean;
}
export interface DecisionResult { interventions: Array<Pick<Delivery, 'channel' | 'thread' | 'text' | 'evidence' | 'matters'>>; matters: Matter[] }

export async function captureDecision(store: InitiativeStore, slack: ObservationSlack, config: InitiativeConfig, roots: ThreadSnapshot[], now: number): Promise<DecisionCase> {
  const channel = roots[0].channel;
  if (roots.some((s) => s.channel !== channel)) throw new Error('Decision cases must remain source-local');
  const observations = store.replay.observations(channel);
  const sources = [...roots];
  for (const observation of observations) if (!sources.some((s) => s.thread === observation.thread)) {
    const snapshot = store.snapshot(channel, observation.thread);
    if (snapshot) sources.push(snapshot);
  }
  const matters = roots.flatMap((s) => store.threadMatters(channel, s.thread));
  const ids = new Set([...sources.flatMap((s) => s.evidence.map((e) => e.id)), ...matters.flatMap((m) => m.evidence)]);
  for (const source of sources) for (const row of store.replay.tombstones(channel, source.thread)) ids.add(Number(row.id));
  const controls = Object.fromEntries(store.replay.controls().map((r) => [String(r.key), String(r.value)]));
  const access = await slack.inspect(channel, true).catch(cause => {
    throw new LearningDeferred('Learning snapshot access lookup unavailable', { cause });
  });
  return { pipeline: PIPELINE, now, config, roots: roots.map(({ channel, thread }) => ({ channel, thread })),
    sources: sources.map(({ evidence, ...s }) => ({ ...s, evidence: evidence.map((e) => e.id) })),
    refs: [...ids].sort((a, b) => a - b).map((id) => ({ id, hash: fingerprint(store.attention.revision(id)) })),
    matters, checks: store.replay.checks(matters.map(matter => matter.id)), observations, controls, ownerCanRead: !!access?.ownerCanRead,
    active: roots.filter((s) => slack.active(channel, s.thread)).map((s) => s.thread),
    deliveries: ['sent', 'sending', 'uncertain', 'pending'].flatMap((state) => store.deliveries(state as Delivery['state'], matters.map((m) => m.id))).map((d) => ({ ...d, text: '' })),
    usedSlots: { digest: Number(store.replay.digestSlots(lisbonDay(now))!.n),
      extra: Number(store.replay.extraSlots(lisbonDay(now))!.n) },
  };
}

export function validDecision(store: InitiativeStore, input: DecisionCase): boolean {
  return input.pipeline === PIPELINE && input.refs.length > 0 && input.refs.every((ref) => {
    const row = store.attention.revision(ref.id);
    const latest = row && store.attention.currentMessage(row.channel, row.ts);
    return !!row && !!latest && (latest.deleted !== 1 || row.deleted === 1) && fingerprint(row) === ref.hash
      && store.attention.channelProgress(row.channel)?.allowed === 1;
  });
}

// Run the production extraction, reconciliation, investigation and delivery checks with
// a fixed source/clock surface. No production state or external communication is writable.
export async function replayDecision(source: InitiativeStore, input: DecisionCase, policy: string, body: string, model: BackgroundModel, baseline: boolean, signal: AbortSignal): Promise<DecisionResult> {
  if (!validDecision(source, input)) throw new Error('Decision source or pipeline changed');
  if (input.sources.some((s) => s.gap)) throw new Error('Recorded source coverage is incomplete');
  const store = new InitiativeStore(':memory:', source.setting('team')!, input.now);
  try {
    store.restoreReplay(input, input.refs.map(ref => source.attention.revision(ref.id)!), policy, body);
    const channel = input.roots[0].channel;
    const interventions: DecisionResult['interventions'] = [];
    const slack: ObservationSlack = {
      inspect: async (id) => id === channel ? { shared: false, ownerCanRead: input.ownerCanRead } : null,
      channels: async () => [channel],
      page: async (_id, oldest, latest, _cursor, thread) => {
        const supplied = input.sources.filter((s) => !thread || s.thread === thread);
        if (!supplied.length || supplied.some((s) => s.gap)) throw new Error('Recorded source read is incomplete');
        return { messages: supplied.flatMap((s) => s.evidence.map((id) => {
        const row = store.attention.revision(id)!;
        return { id, channel, thread: s.thread, ts: String(row.ts), version: String(row.version), author: String(row.author), text: String(row.text || row.excerpt), own: row.own === 1, bot: row.bot === 1, captured: Number(row.captured) };
      })).filter((e) => Number(e.ts) >= Number(oldest) && Number(e.ts) <= Number(latest)) }; },
      ownerDm: async () => 'D_REPLAY', verifyDm: async (id) => id === 'D_REPLAY', active: (_id, thread) => input.active.includes(thread),
      link: (id, thread) => `slack://${id}/${thread}`, find: async () => undefined,
      send: async (delivery) => { if (!input.deliveries.some((d) => d.id === delivery.id)) {
        const { channel, thread, text, evidence, matters } = delivery;
        interventions.push({ channel, thread, text, evidence, matters });
      } return 'replayed'; },
    };
    const wrapped: BackgroundModel = { fits: model.fits?.bind(model), complete: async (request, abort) => {
      if (baseline && (request.schema as unknown) === Assessment) {
        const matter = (request.input as { matter: Matter }).matter;
        return { resolved: matter.state === 'resolved', help: `${matter.title}: ${matter.detail}`, public: false, evidence: matter.evidence } as never;
      }
      return await model.complete(request, AbortSignal.any([abort, signal]));
    } };
    const service = new InitiativeService(store, slack, wrapped, { ...input.config, mode: 'live' }, () => input.now);
    const stop = () => service.stop();
    signal.addEventListener('abort', stop, { once: true });
    try {
      store.schedule('extract', 'global', input.now);
      for (let i = 0; i < 12; i++) {
        signal.throwIfAborted();
        await service.tick(input.now, true);
        if (!store.replay.dueJob(input.now)) break;
      }
      if (store.replay.dueJob(input.now)) throw new AdmissionDeferred('Replay awaits bounded model work');
      return { interventions, matters: store.replay.matterIds().map((r) => store.matter(String(r.id))!) };
    } finally { signal.removeEventListener('abort', stop); service.stop(); }
  } finally { store.close(); }
}

export function replayModel(store: InitiativeStore, gateway: ModelGateway, cohort: string, episode: string, evidence: number[], authorize: () => Promise<boolean>): BackgroundModel {
  return { fits: gateway.fits.bind(gateway), complete: async <T>(request: ModelRequest & { schema: import('zod').z.ZodType<T> }, signal: AbortSignal): Promise<T> => {
    const key = fingerprint([PIPELINE, request.model, request.system, request.input, request.schema.toJSONSchema()]);
    const row = store.replay.semanticStep(cohort, key);
    if (row) {
      const result = gateway.completed(String(row.id), request.schema);
      if (result !== null) return result;
      if (['failed', 'invalid', 'expired', 'applied', 'retired'].includes(String(store.requests.localBatch(row.id)?.state))) throw new Error('Replay request failed; the cohort remains incomplete');
    } else if (gateway.batchCapacity()) await gateway.submit({ ...request, authorize, scope: undefined }, { kind: 'pipeline', cohort, episode, step: key, evidence }, signal);
    throw new AdmissionDeferred('Replay model step pending');
  } };
}
