// SPDX-License-Identifier: AGPL-3.0-or-later
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Message, MessageCreateParamsNonStreaming, Usage } from '@anthropic-ai/sdk/resources/messages';
import { createHash, scryptSync } from 'node:crypto';
import { z } from 'zod';
import type { InitiativeStore } from './store.js';

const PRICES: Record<string, { input: number; output: number }> = {
  // Microdollars/token. Haiku uses its higher long-context tier conservatively.
  // Source: platform.claude.com/docs/en/about-claude/pricing, checked 2026-10-20.
  'claude-haiku-5-5': { input: 0.5, output: 2.5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
};

export class AdmissionDeferred extends Error {}

interface DiscoveryProgress {
  version: 2;
  cursor?: string;
  page?: { pending: Array<{ id: string; created: number }>; nextCursor?: string; hasMore: boolean };
  active: boolean;
  pages: number;
  checked: number;
  startedAt: number;
  updatedAt: number;
  terminalScanAt?: number;
  unread: string[];
  unreadCount: number;
  lastRound?: { finishedAt: number; unreadCount: number; unreadSample: string[] };
}

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
  private readonly providerIdentity?: string;

  constructor(private readonly store: InitiativeStore, client?: Anthropic, providerIdentity?: string) {
    this.client = client;
    const credential = client?.apiKey ?? process.env.ANTHROPIC_API_KEY;
    const endpoint = client?.baseURL ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
    // Stable across restarts; endpoint-scoped derivation binds recovery without persisting the credential.
    this.providerIdentity = providerIdentity ?? (credential
      ? `scrypt-v1:${scryptSync(credential, `archie-initiative-provider:${endpoint}`, 32).toString('hex')}`
      : undefined);
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
    const batches = Number(this.store.requests.activeBatches()!.n);
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
        this.store.requests.dispatchDirect(charge, request.model, createHash('sha256').update(JSON.stringify(params)).digest('hex'));
        try {
          const result = await this.provider.messages.create(params, { signal, maxRetries: 0 });
          this.settle(charge, result.usage, request.model);
          this.store.requests.completeDirect((result as Message & { _request_id?: string })._request_id ?? null, JSON.stringify(result.usage), charge);
          return this.parse(result, request.schema);
        } catch (error) {
          this.store.requests.uncertainDirect(error instanceof Anthropic.APIError ? error.requestID ?? null : null, charge);
          // An interrupted call may have executed. Its reservation remains until usage is known.
          if (signal.aborted || !(error instanceof Anthropic.APIError) || !error.status || error.status < 500 || attempt === 2) throw error;
        }
      }
      throw new Error('Unreachable model retry state');
    } finally { this.active--; }
  }

  private async receive(remote: string, signal: AbortSignal): Promise<boolean> {
    let count = 0;
    for await (const item of await this.provider.messages.batches.results(remote, { signal, maxRetries: 0 })) {
      // Discovery may inspect an unrelated workspace batch. Keep scans bounded.
      signal.throwIfAborted();
      if (++count > 1000) return false;
      const row = this.store.requests.correlatedResult(item.custom_id, remote);
      if (!row) continue;
      if (item.result.type === 'succeeded') {
        const params = JSON.parse(String(row.request)) as MessageCreateParamsNonStreaming;
        this.settle(String(row.charge), item.result.message.usage, params.model);
        const discard = JSON.parse(String(row.context)).discard === true;
        this.store.requests.completeBatch(JSON.stringify(discard ? { usage: item.result.message.usage } : item.result.message), discard ? 'applied' : 'complete', row.id);
      } else {
        // The API explicitly guarantees errored/canceled/expired results are unbilled.
        this.store.settle(String(row.charge), 0, Date.now());
        this.store.requests.failedBatch(JSON.stringify(item.result), row.id);
      }
    }
    return true;
  }

  private async discoverPage(progress: DiscoveryProgress, signal: AbortSignal): Promise<void> {
    const page = await this.provider.messages.batches.list({ limit: 20, after_id: progress.cursor }, { signal, maxRetries: 0 });
    if (page.data.length > 20) throw new Error('Provider discovery metadata page exceeded its bound');
    if (page.has_more && !page.last_id) throw new Error('Provider discovery pagination is incomplete');
    const pending: Array<{ id: string; created: number }> = [];
    for (const batch of page.data) {
      const created = Date.parse(batch.created_at);
      if (!Number.isFinite(created)) throw new Error('Provider discovery returned invalid creation time');
      if (batch.processing_status !== 'ended') progress.active = true;
      else if (Date.now() - created < 29 * 86_400_000) pending.push({ id: batch.id, created });
    }
    progress.pages++;
    progress.checked += page.data.length;
    progress.page = { pending, nextCursor: page.last_id ?? undefined, hasMore: page.has_more };
  }

  private advanceDiscoveryPage(id: string, created: number, progress: DiscoveryProgress): void {
    const page = progress.page!;
    if (page.pending.length) return;
    if (page.hasMore) progress.cursor = page.nextCursor;
    else {
      if (!progress.active && Date.now() > created + 3_600_000 + 86_400_000) {
        this.store.requests.retireUnknown(id);
        progress.terminalScanAt = Date.now();
        this.store.set(`batch-recovery:${id}`, 'Complete provider scan found no running candidate. Result identity and usage remain unresolved; liability stays reserved.');
      }
      progress.lastRound = { finishedAt: Date.now(), unreadCount: progress.unreadCount, unreadSample: progress.unread };
      progress.cursor = undefined;
      progress.active = false;
      progress.unread = [];
      progress.unreadCount = 0;
    }
    progress.page = undefined;
  }

  private async discover(signal: AbortSignal): Promise<void> {
    let downloads = 0;
    const failures: unknown[] = [];
    for (const row of this.store.requests.unknownSubmissions()) {
      const id = String(row.id);
      const key = `batch-discovery:${id}`;
      const current = this.store.requests.localBatch(id);
      if (current?.remote || !['submitting', 'uncertain', 'retired'].includes(String(current?.state))) continue;
      if (!this.providerIdentity || this.store.setting(`batch-provider:${id}`) !== this.providerIdentity) {
        this.store.set(`batch-recovery:${id}`, 'Provider credentials changed or the legacy submission is unbound. Confirm the original provider workspace and use bind-provider before discovery. Liability and execution slots remain reserved.');
        const saved = JSON.parse(this.store.setting(key) ?? '{}');
        this.store.set(key, JSON.stringify({ ...saved, updatedAt: Date.now() }));
        continue;
      }
      const saved = JSON.parse(this.store.setting(key) ?? '{}') as Partial<DiscoveryProgress>;
      // Legacy cursors may already have skipped uninspected candidates; restart their scan once.
      const progress: DiscoveryProgress = saved.version === 2 ? saved as DiscoveryProgress
        : { version: 2, active: false, pages: 0, checked: 0, startedAt: Date.now(), updatedAt: 0, unread: [], unreadCount: 0 };
      progress.unread ??= [];
      progress.unreadCount ??= 0;
      try {
        if (!progress.page) await this.discoverPage(progress, signal);
        const pending = progress.page!.pending;
        const candidates = pending.length;
        for (let attempt = 0; attempt < candidates && downloads < 3; attempt++) {
          signal.throwIfAborted();
          const candidate = pending[0];
          if (Date.now() - candidate.created >= 29 * 86_400_000) { pending.shift(); continue; }
          downloads++;
          let inspected = false;
          try { inspected = await this.receive(candidate.id, signal); }
          catch (error) { failures.push(error); }
          pending.shift();
          if (!inspected) {
            // Finish this bounded scan before retrying unread streams in the next round.
            progress.unreadCount++;
            progress.unread = [...progress.unread, candidate.id].slice(-20);
          }
          progress.updatedAt = Date.now();
          this.store.set(key, JSON.stringify(progress));
          if (this.store.requests.localBatch(id)?.remote) break;
        }
        this.advanceDiscoveryPage(id, Number(row.created), progress);
      } catch (error) { failures.push(error); }
      finally {
        progress.updatedAt = Date.now();
        this.store.set(key, JSON.stringify(progress));
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Provider discovery incomplete; unread results retry on a later scan');
  }

  async poll(signal: AbortSignal): Promise<void> {
    const failures: unknown[] = [];
    for (const remote of this.store.requests.pendingRemotes()) {
      try {
        const batch = await this.provider.messages.batches.retrieve(String(remote.remote), { signal, maxRetries: 0 });
        if (batch.processing_status === 'ended') {
          this.store.requests.endedBatch(batch.id);
          const created = Date.parse(batch.created_at);
          if (Number.isFinite(created) && Date.now() - created >= 29 * 86_400_000) {
            this.store.requests.retireRemote(batch.id);
            this.store.set(`batch-recovery:${batch.id}`, 'Provider confirms processing ended, but results are beyond retention. Execution slots released; unresolved liability remains reserved.');
          } else await this.receive(batch.id, signal);
        }
      } catch (error) { failures.push(error); }
    }
    try { await this.discover(signal); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Provider reconciliation incomplete; outstanding liability retained');
  }

  bindProvider(id: string): void {
    if (!this.providerIdentity || !this.store.requests.localBatch(id)) throw new Error('Existing batch and configured provider credentials required');
    this.store.set(`batch-provider:${id}`, this.providerIdentity);
    this.store.set(`batch-binding-ack:${id}`, String(Date.now()));
  }

  async reconcileRemote(remote: string, signal: AbortSignal): Promise<void> {
    const batch = await this.provider.messages.batches.retrieve(remote, { signal, maxRetries: 0 });
    if (batch.processing_status !== 'ended') throw new Error('Remote batch is still running; keep its execution slots reserved');
    this.store.requests.endedBatch(batch.id);
    this.store.requests.retryResults(batch.id);
    await this.receive(batch.id, signal);
  }

  async cancel(signal: AbortSignal): Promise<void> {
    for (const row of this.store.requests.allPendingRemotes()) {
      await this.provider.messages.batches.cancel(String(row.remote), { signal, maxRetries: 0 });
    }
  }

  expire(now: number): void {
    this.store.requests.expire(now);
  }

}
