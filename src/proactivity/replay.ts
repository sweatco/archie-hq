// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { ObservationStore } from '../memory/observation-store.js';
import type { Delivery, Matter, Observation, ThreadSnapshot } from '../memory/observation-types.js';
import { lisbonDay } from '../memory/observation-types.js';
import { InitiativeService, Assessment, type InitiativeConfig } from './service.js';
import { AdmissionDeferred, type BackgroundModel, type ModelRequest, ModelGateway } from './model.js';
import type { ObservationSlack } from './slack.js';

export const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Bind reviews to the actual decision implementation, including its storage and input bounds.
export const PIPELINE = fingerprint(['replay', 'cohort', 'learning', 'service', 'context', 'model', '../memory/observation-store'].map((name) =>
  readFileSync(new URL(`${name.startsWith('.') ? '' : './'}${name}${extname(import.meta.url)}`, import.meta.url), 'utf8')));

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
  observations: Observation[];
  deliveries: Delivery[];
  usedSlots: { digest: number; extra: number };
  controls: Record<string, string>;
  active: string[];
  ownerCanRead: boolean;
}
export interface DecisionResult { interventions: Array<Pick<Delivery, 'channel' | 'thread' | 'text' | 'evidence' | 'matters'>>; matters: Matter[] }

export async function captureDecision(store: ObservationStore, slack: ObservationSlack, config: InitiativeConfig, roots: ThreadSnapshot[], now: number): Promise<DecisionCase> {
  const channel = roots[0].channel;
  if (roots.some((s) => s.channel !== channel)) throw new Error('Decision cases must remain source-local');
  const observations = store.rows('SELECT o.* FROM observations o JOIN observation_search s ON s.id=o.id WHERE o.channel=? AND o.valid=1 ORDER BY s.rowid', channel).map((r) => ({ ...r, evidence: JSON.parse(String(r.evidence)) })) as unknown as Observation[];
  const sources = [...roots];
  for (const observation of observations) if (!sources.some((s) => s.thread === observation.thread)) {
    const snapshot = store.snapshot(channel, observation.thread);
    if (snapshot) sources.push(snapshot);
  }
  const matters = roots.flatMap((s) => store.threadMatters(channel, s.thread));
  const ids = new Set([...sources.flatMap((s) => s.evidence.map((e) => e.id)), ...matters.flatMap((m) => m.evidence)]);
  for (const source of sources) for (const row of store.rows('SELECT r.id FROM revisions r JOIN messages m ON m.revision=r.id WHERE r.channel=? AND r.thread=? AND r.deleted=1', channel, source.thread)) ids.add(Number(row.id));
  const controls = Object.fromEntries(store.rows("SELECT key,value FROM settings WHERE key IN ('stop','pause','mute','watermark') OR key LIKE 'unfollow:%'").map((r) => [String(r.key), String(r.value)]));
  const access = await slack.inspect(channel, true);
  return { pipeline: PIPELINE, now, config, roots: roots.map(({ channel, thread }) => ({ channel, thread })),
    sources: sources.map(({ evidence, ...s }) => ({ ...s, evidence: evidence.map((e) => e.id) })),
    refs: [...ids].sort((a, b) => a - b).map((id) => ({ id, hash: fingerprint(store.row('SELECT * FROM revisions WHERE id=?', id)) })),
    matters, observations, controls, ownerCanRead: !!access?.ownerCanRead,
    active: roots.filter((s) => slack.active(channel, s.thread)).map((s) => s.thread),
    deliveries: ['sent', 'sending', 'uncertain', 'pending'].flatMap((state) => store.deliveries(state as Delivery['state'], matters.map((m) => m.id))).map((d) => ({ ...d, text: '' })),
    usedSlots: { digest: Number(store.row("SELECT count(*) AS n FROM deliveries WHERE slot_day=? AND digest=1 AND state IN ('sent','sending','uncertain')", lisbonDay(now))!.n),
      extra: Number(store.row("SELECT count(*) AS n FROM deliveries WHERE slot_day=? AND digest=0 AND state IN ('sent','sending','uncertain')", lisbonDay(now))!.n) },
  };
}

export function validDecision(store: ObservationStore, input: DecisionCase): boolean {
  return input.pipeline === PIPELINE && input.refs.length > 0 && input.refs.every((ref) => {
    const row = store.row('SELECT * FROM revisions WHERE id=?', ref.id);
    const latest = row && store.row('SELECT r.deleted FROM revisions r JOIN messages m ON m.revision=r.id WHERE m.channel=? AND m.ts=?', row.channel, row.ts);
    return !!row && !!latest && (latest.deleted !== 1 || row.deleted === 1) && fingerprint(row) === ref.hash
      && store.row('SELECT allowed FROM channels WHERE id=?', row.channel)?.allowed === 1;
  });
}

// Run the production extraction, reconciliation, investigation and delivery checks with
// a fixed source/clock surface. No production state or external communication is writable.
export async function replayDecision(source: ObservationStore, input: DecisionCase, policy: string, body: string, model: BackgroundModel, baseline: boolean, signal: AbortSignal): Promise<DecisionResult> {
  if (!validDecision(source, input)) throw new Error('Decision source or pipeline changed');
  if (input.sources.some((s) => s.gap)) throw new Error('Recorded source coverage is incomplete');
  const store = new ObservationStore(':memory:', source.setting('team')!, input.now);
  try {
    for (const [key, value] of Object.entries(input.controls)) store.set(key, value);
    store.set('policy', policy); store.set('rollout_approved', policy);
    if (policy !== 'base') store.run("INSERT INTO policies(id,body,base,evidence,state) VALUES (?,?, 'base','[]','active')", policy, body);
    const channel = input.roots[0].channel;
    store.channel(channel, true, false);
    for (const ref of input.refs) {
      const row = source.row('SELECT * FROM revisions WHERE id=?', ref.id)!;
      const columns = Object.keys(row);
      store.run(`INSERT INTO revisions(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, ...Object.values(row));
    }
    for (const s of input.sources) {
      const root = input.roots.some((r) => r.thread === s.thread);
      store.run('INSERT INTO threads(channel,thread,generation,processed,changed,gap) VALUES (?,?,?,?,?,?)', channel, s.thread, s.generation, root ? 0 : s.generation, input.now, s.gap);
      for (const id of s.evidence) {
        const row = store.row('SELECT ts FROM revisions WHERE id=?', id)!;
        store.run('INSERT OR REPLACE INTO messages VALUES (?,?,?)', channel, row.ts, id);
      }
      for (const removed of s.removed ?? []) {
        const row = store.row('SELECT id FROM revisions WHERE channel=? AND ts=? AND version=? AND deleted=1 ORDER BY id DESC LIMIT 1', channel, removed.ts, removed.version);
        if (row) store.run('INSERT OR REPLACE INTO messages VALUES (?,?,?)', channel, removed.ts, row.id);
      }
    }
    for (const m of input.matters) store.run('INSERT INTO matters VALUES (?,?,?,?,?,?)', m.id, m.channel, m.thread, JSON.stringify({ ...m, policy }), Number(m.valid), m.nextCheck);
    for (const o of input.observations) {
      store.run('INSERT INTO observations VALUES (?,?,?,?,?,?,1)', o.id, o.channel, o.thread, o.text, JSON.stringify(o.evidence), o.kind);
      store.run('INSERT INTO observation_search VALUES (?,?)', o.id, o.text);
    }
    for (const d of input.deliveries) {
      store.run('INSERT INTO deliveries(id,channel,thread,text,matters,evidence,policy,digest,state,ts,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        d.id, d.channel, d.thread, '', JSON.stringify(d.matters), JSON.stringify(d.evidence), policy, Number(d.digest), d.state === 'pending' ? 'cancelled' : d.state, d.ts, d.created);
    }
    for (const [kind, count] of Object.entries(input.usedSlots)) for (let i = 0; i < count; i++) store.run("INSERT INTO deliveries VALUES (?,?,NULL,'','[]','[]',?,?,'sent',NULL,?,?)",
      `prior-slot:${kind}:${i}`, 'D_REPLAY', policy, Number(kind === 'digest'), input.now, lisbonDay(input.now));
    const interventions: DecisionResult['interventions'] = [];
    const slack: ObservationSlack = {
      inspect: async (id) => id === channel ? { shared: false, ownerCanRead: input.ownerCanRead } : null,
      channels: async () => [channel],
      page: async (_id, oldest, latest, _cursor, thread) => {
        const supplied = input.sources.filter((s) => !thread || s.thread === thread);
        if (!supplied.length || supplied.some((s) => s.gap)) throw new Error('Recorded source read is incomplete');
        return { messages: supplied.flatMap((s) => s.evidence.map((id) => {
        const row = store.row('SELECT * FROM revisions WHERE id=?', id)!;
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
        if (!store.row('SELECT kind FROM jobs WHERE due<=?', input.now)) break;
      }
      if (store.row('SELECT kind FROM jobs WHERE due<=?', input.now)) throw new AdmissionDeferred('Replay awaits bounded model work');
      return { interventions, matters: store.rows('SELECT id FROM matters').map((r) => store.matter(String(r.id))!) };
    } finally { signal.removeEventListener('abort', stop); service.stop(); }
  } finally { store.close(); }
}

export function replayModel(store: ObservationStore, gateway: ModelGateway, cohort: string, episode: string, evidence: number[], authorize: () => Promise<boolean>): BackgroundModel {
  return { fits: gateway.fits.bind(gateway), complete: async <T>(request: ModelRequest & { schema: import('zod').z.ZodType<T> }, signal: AbortSignal): Promise<T> => {
    const key = fingerprint([PIPELINE, request.model, request.system, request.input, request.schema.toJSONSchema()]);
    const row = store.row("SELECT id,state FROM batches WHERE json_extract(context,'$.cohort')=? AND json_extract(context,'$.step')=? AND state!='not dispatched' ORDER BY created LIMIT 1", cohort, key);
    if (row) {
      const result = gateway.completed(String(row.id), request.schema);
      if (result !== null) return result;
      if (['failed', 'invalid', 'expired', 'applied'].includes(String(store.row('SELECT state FROM batches WHERE id=?', row.id)?.state))) throw new Error('Replay request failed; the cohort remains incomplete');
    } else if (gateway.batchCapacity()) await gateway.submit({ ...request, authorize, scope: undefined }, { kind: 'pipeline', cohort, episode, step: key, evidence }, signal);
    throw new AdmissionDeferred('Replay model step pending');
  } };
}
