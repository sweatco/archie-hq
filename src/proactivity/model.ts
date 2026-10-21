// SPDX-License-Identifier: AGPL-3.0-or-later
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Message, MessageCreateParamsNonStreaming, Usage } from '@anthropic-ai/sdk/resources/messages';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ObservationStore } from '../memory/observation-store.js';

const PRICES: Record<string, { input: number; output: number }> = {
  // Microdollars/token. Haiku uses its higher long-context tier conservatively.
  // Source: platform.claude.com/docs/en/about-claude/pricing, checked 2026-10-20.
  'claude-haiku-5-5': { input: 0.5, output: 2.5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
};

export class AdmissionDeferred extends Error {}

export interface ModelRequest {
  model: string;
  system: string;
  input: unknown;
  schema: z.ZodType;
  priority?: boolean;
  scope?: string;
  authorize?: () => Promise<boolean>;
}

export interface BackgroundModel {
  complete<T>(request: ModelRequest & { schema: z.ZodType<T> }, signal: AbortSignal): Promise<T>;
  fits?(request: ModelRequest): boolean;
}

export class ModelGateway implements BackgroundModel {
  private client?: Anthropic;
  private active = 0;

  constructor(private readonly store: ObservationStore, client?: Anthropic) {
    this.client = client;
    store.run(`CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, remote TEXT, charge TEXT NOT NULL, request TEXT NOT NULL, context TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created INTEGER NOT NULL)`);
    store.run('CREATE TABLE IF NOT EXISTS requests (charge TEXT PRIMARY KEY, model TEXT NOT NULL, fingerprint TEXT NOT NULL, remote TEXT, usage TEXT, state TEXT NOT NULL)');
  }

  private get provider(): Anthropic { return this.client ??= new Anthropic({ maxRetries: 0, timeout: 90_000 }); }

  async verify(models: string[]): Promise<void> {
    for (const model of new Set(models)) {
      if (!PRICES[model]) throw new Error(`No verified background pricing for ${model}`);
      await this.provider.models.retrieve(model);
    }
  }

  private prepare(request: ModelRequest): { params: MessageCreateParamsNonStreaming; maximum: number } {
    const prices = PRICES[request.model];
    if (!prices) throw new Error('Unpriced background model');
    const params: MessageCreateParamsNonStreaming = {
      model: request.model, system: request.system, max_tokens: 4000,
      messages: [{ role: 'user', content: JSON.stringify(request.input) }],
      output_config: { format: zodOutputFormat(request.schema) },
      service_tier: 'standard_only',
    };
    // UTF-8 bytes conservatively bound text tokens; headroom covers protocol/schema overhead.
    const inputBound = Buffer.byteLength(JSON.stringify(params)) + 8192;
    if (inputBound > 32_000) throw new Error('Background context exceeds the extraction limit; split it first');
    return { params, maximum: Math.ceil(inputBound * prices.input * 2 + params.max_tokens * prices.output) };
  }

  fits(request: ModelRequest): boolean {
    try { this.prepare(request); return true; }
    catch (error) {
      if (error instanceof Error && error.message.includes('context exceeds')) return false;
      throw error;
    }
  }

  batchCapacity(): number {
    return Math.max(0, 3 - this.active - Number(this.store.row("SELECT count(*) AS n FROM batches WHERE state IN ('submitting','pending','uncertain')")!.n));
  }

  private settle(id: string, usage: Usage, model: string): void {
    const counts = [usage.input_tokens, usage.output_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens];
    if (counts.some((n) => typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)) return;
    const prices = PRICES[model];
    const amount = Math.ceil((usage.input_tokens + usage.cache_creation_input_tokens! * 2 + usage.cache_read_input_tokens!) * prices.input + usage.output_tokens * prices.output);
    this.store.settle(id, amount, Date.now());
  }

  private parse<T>(message: Message, schema: z.ZodType<T>): T {
    if (message.stop_reason !== 'end_turn') throw new Error(`Incomplete background output: ${message.stop_reason}`);
    const text = message.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
    return schema.parse(JSON.parse(text));
  }

  async complete<T>(request: ModelRequest & { schema: z.ZodType<T> }, signal: AbortSignal): Promise<T> {
    const { params, maximum } = this.prepare(request);
    const batches = Number(this.store.row("SELECT count(*) AS n FROM batches WHERE state IN ('submitting','pending','uncertain')")!.n);
    if (this.active + batches >= 4) throw new AdmissionDeferred('Background request concurrency reached');
    this.active++;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted();
        if (this.store.setting('stop') === 'true' || this.store.setting('pause') === 'true') throw new AdmissionDeferred('Background analysis was stopped or paused');
        if (request.authorize && !await request.authorize()) throw new AdmissionDeferred('Source access changed before dispatch');
        signal.throwIfAborted();
        if (this.store.setting('stop') === 'true' || this.store.setting('pause') === 'true') throw new AdmissionDeferred('Background analysis was stopped or paused');
        const charge = this.store.reserve(maximum, request.priority === true, Date.now(), request.scope);
        if (!charge) throw new AdmissionDeferred('Background daily allowance unavailable');
        this.store.run("INSERT INTO requests VALUES (?,?,?,NULL,NULL,'dispatching')", charge, request.model, createHash('sha256').update(JSON.stringify(params)).digest('hex'));
        try {
          const result = await this.provider.messages.create(params, { signal, maxRetries: 0 });
          this.settle(charge, result.usage, request.model);
          this.store.run("UPDATE requests SET state='complete',remote=?,usage=? WHERE charge=?", (result as Message & { _request_id?: string })._request_id ?? null, JSON.stringify(result.usage), charge);
          return this.parse(result, request.schema);
        } catch (error) {
          this.store.run("UPDATE requests SET state=CASE WHEN usage IS NULL THEN 'uncertain' ELSE 'invalid' END,remote=COALESCE(remote,?) WHERE charge=?", error instanceof Anthropic.APIError ? error.requestID ?? null : null, charge);
          // An interrupted call may have executed. Its reservation remains until usage is known.
          if (signal.aborted || !(error instanceof Anthropic.APIError) || !error.status || error.status < 500 || attempt === 2) throw error;
        }
      }
      throw new Error('Unreachable model retry state');
    } finally { this.active--; }
  }

  async submit(request: ModelRequest, context: unknown, signal: AbortSignal): Promise<string> {
    return (await this.submitMany([{ request, context }], signal))[0];
  }

  async submitMany(items: Array<{ request: ModelRequest; context: unknown }>, signal: AbortSignal): Promise<string[]> {
    if (!items.length || items.length > 100) throw new Error('Batch requires 1–100 items');
    signal.throwIfAborted();
    for (const authorize of new Set(items.map((i) => i.request.authorize).filter(Boolean))) {
      if (!await authorize!()) throw new AdmissionDeferred('Source access changed before batch dispatch');
    }
    signal.throwIfAborted();
    if (this.store.setting('stop') === 'true' || this.store.setting('pause') === 'true') throw new AdmissionDeferred('Background analysis was stopped or paused');
    if (items.length > this.batchCapacity()) throw new AdmissionDeferred('Batch concurrency reached; keep one slot for direct checks');
    const requests = items.map((item) => ({ ...this.prepare(item.request), id: randomUUID(), item, charge: '' }));
    try {
      for (const r of requests) {
        const charge = this.store.reserve(r.maximum, false, Date.now(), r.item.request.scope);
        if (!charge) throw new AdmissionDeferred('Batch allowance unavailable');
        r.charge = charge;
        this.store.run('INSERT INTO batches VALUES (?,NULL,?,?,?,?,NULL,?)', r.id, charge, JSON.stringify(r.params), JSON.stringify(r.item.context), 'submitting', Date.now());
      }
    } catch (error) {
      // These requests have not been dispatched, so their execution cost is provably zero.
      for (const r of requests.filter((r) => r.charge)) {
        this.store.settle(r.charge, 0, Date.now());
        this.store.run("UPDATE batches SET state='not dispatched' WHERE id=?", r.id);
      }
      throw error;
    }
    try {
      const batch = await this.provider.messages.batches.create({ requests: requests.map((r) => ({ custom_id: r.id, params: r.params })) }, { signal, maxRetries: 0 });
      this.store.transaction(() => {
        for (const r of requests) this.store.run("UPDATE batches SET remote=?,state='pending' WHERE id=?", batch.id, r.id);
      });
    } catch (error) {
      for (const r of requests) this.store.run("UPDATE batches SET state='uncertain' WHERE id=?", r.id);
      throw error;
    }
    return requests.map((r) => r.id);
  }

  async poll(signal: AbortSignal): Promise<void> {
    for (const remote of this.store.rows("SELECT DISTINCT remote FROM batches WHERE state='pending' AND remote IS NOT NULL LIMIT 10")) {
      const batch = await this.provider.messages.batches.retrieve(String(remote.remote), { signal, maxRetries: 0 });
      if (batch.processing_status !== 'ended') continue;
      for await (const item of await this.provider.messages.batches.results(batch.id, { signal, maxRetries: 0 })) {
        const row = this.store.row("SELECT * FROM batches WHERE id=? AND remote=? AND state='pending'", item.custom_id, remote.remote);
        if (!row) continue;
        if (item.result.type === 'succeeded') {
          const params = JSON.parse(String(row.request)) as MessageCreateParamsNonStreaming;
          // Ordinary prices overstate batch usage, providing a conservative debit.
          this.settle(String(row.charge), item.result.message.usage, params.model);
          const discard = JSON.parse(String(row.context)).discard === true;
          this.store.run('UPDATE batches SET result=?,state=? WHERE id=?', JSON.stringify(discard ? { usage: item.result.message.usage } : item.result.message), discard ? 'applied' : 'complete', row.id);
        } else {
          // Non-success results without authoritative usage keep their liability.
          this.store.run("UPDATE batches SET result=?,state='failed' WHERE id=?", JSON.stringify(item.result), row.id);
        }
      }
    }
  }

  completed<T>(id: string, schema: z.ZodType<T>): T | null {
    const row = this.store.row("SELECT result FROM batches WHERE id=? AND state='complete'", id);
    if (!row) return null;
    try { return this.parse(JSON.parse(String(row.result)) as Message, schema); }
    catch { this.store.run("UPDATE batches SET state='invalid' WHERE id=?", id); return null; }
  }

  async cancel(signal: AbortSignal): Promise<void> {
    for (const row of this.store.rows("SELECT DISTINCT remote FROM batches WHERE state='pending' AND remote IS NOT NULL")) {
      await this.provider.messages.batches.cancel(String(row.remote), { signal, maxRetries: 0 });
    }
  }

  expire(now: number): void {
    this.store.run(`UPDATE batches SET request=json_object('model',json_extract(request,'$.model')),context='{"discard":true}',result=NULL,
      state=CASE WHEN state IN ('submitting','pending','uncertain') THEN state ELSE 'expired' END WHERE EXISTS
      (SELECT 1 FROM json_each(batches.context,'$.evidence') j LEFT JOIN revisions r ON r.id=j.value LEFT JOIN messages m ON m.channel=r.channel AND m.ts=r.ts
      LEFT JOIN revisions latest ON latest.id=m.revision WHERE r.id IS NULL OR r.excerpt='' OR r.captured<? OR latest.deleted=1)`, now - 90 * 86_400_000);
    this.store.run(`UPDATE batches SET request=json_object('model',json_extract(request,'$.model')),context=json_object('discard',json('true'),'evidence',json_extract(context,'$.evidence')) WHERE created<? OR EXISTS
      (SELECT 1 FROM json_each(batches.context,'$.evidence') j JOIN revisions r ON r.id=j.value WHERE r.captured<?)`, now - 30 * 86_400_000, now - 30 * 86_400_000);
    this.store.run("UPDATE batches SET result=NULL,state=CASE WHEN state IN ('complete','applied','invalid','failed') THEN 'expired' ELSE state END WHERE created<?", now - 90 * 86_400_000);
  }
}
