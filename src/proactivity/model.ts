// SPDX-License-Identifier: AGPL-3.0-or-later
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Message, MessageCreateParamsNonStreaming, Usage } from '@anthropic-ai/sdk/resources/messages';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { InitiativeStore } from './store.js';

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
  private active = 0;
  constructor(private readonly store: InitiativeStore, private client?: Anthropic) {}

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
    if (this.active >= 4) throw new AdmissionDeferred('Background request concurrency reached');
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
        this.store.dispatchRequest(charge, request.model, createHash('sha256').update(JSON.stringify(params)).digest('hex'));
        try {
          const result = await this.provider.messages.create(params, { signal, maxRetries: 0 });
          this.settle(charge, result.usage, request.model);
          this.store.completeRequest((result as Message & { _request_id?: string })._request_id ?? null, JSON.stringify(result.usage), charge);
          return this.parse(result, request.schema);
        } catch (error) {
          this.store.uncertainRequest(error instanceof Anthropic.APIError ? error.requestID ?? null : null, charge);
          // An interrupted call may have executed. Its reservation remains until usage is known.
          if (signal.aborted || !(error instanceof Anthropic.APIError) || !error.status || error.status < 500 || attempt === 2) throw error;
        }
      }
      throw new Error('Unreachable model retry state');
    } finally { this.active--; }
  }
}
