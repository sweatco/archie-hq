// SPDX-License-Identifier: AGPL-3.0-or-later
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { InitiativeStore } from '../store.js';
import { AdmissionDeferred, ModelGateway } from '../model.js';
import { InitiativeService } from '../service.js';
import type { ObservationSlack } from '../slack.js';

const NOW = Date.parse('2026-10-20T10:00:00Z');
const schema = z.object({ answer: z.string().max(10) });
const request = { model: 'claude-haiku-5-5', system: 'Test', input: 'Evidence', schema };
const result = () => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: '{"answer":"ok"}' }],
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
});
let store: InitiativeStore;
let gateway: ModelGateway;
let create: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  store = new InitiativeStore(':memory:', 'T1', NOW);
  create = vi.fn(async () => result());
  gateway = new ModelGateway(store, { messages: { create } } as unknown as Anthropic);
});
afterEach(() => {
  store.close();
  vi.useRealTimers();
});

describe('paid model admission and accounting', () => {
  it.each(['max_tokens', 'citations'])(
    'bounds repeated %s extraction failures across restarts and retries new evidence',
    async (failure) => {
      const thread = (NOW / 1000 + 1).toFixed(6);
      const message = {
        channel: 'C1',
        thread,
        ts: thread,
        version: thread,
        author: 'U1',
        text: 'Please review the brief.',
      };
      store.channel('C1', true, false);
      store.record(message, NOW);
      const slack: ObservationSlack = {
        inspect: async () => ({ shared: false, recipientCanRead: true }),
        channels: async () => [],
        page: async () => ({ messages: [] }),
        dm: async () => {
          throw new Error('Unexpected DM');
        },
        recipient: async () => null,
        verifyDm: async () => false,
        send: async () => {
          throw new Error('Unexpected send');
        },
        find: async () => undefined,
        active: () => false,
        link: () => '',
      };
      const config = {
        mode: 'shadow' as const,
        extractionModel: request.model,
        investigationModel: 'claude-sonnet-5-5',
      };
      let service = new InitiativeService(store, slack, gateway, config);
      create.mockResolvedValue({
        ...result(),
        stop_reason: failure === 'max_tokens' ? 'max_tokens' : 'end_turn',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              threads: [
                {
                  channel: 'C1',
                  thread,
                  observations: [
                    { key: 'review', text: 'Review', kind: 'question', evidence: [999] },
                  ],
                  matters: [],
                },
              ],
            }),
          },
        ],
        usage: { ...result().usage, output_tokens: 4000 },
      });
      try {
        for (const minute of [0, 5, 10]) {
          vi.setSystemTime(NOW + minute * 60_000);
          store.schedule('extract', 'global', Date.now());
          await service.tick();
        }
        service.stop();
        service.release();
        service = new InitiativeService(store, slack, gateway, config);
        for (const minute of [15, 75]) {
          vi.setSystemTime(NOW + minute * 60_000);
          store.schedule('extract', 'global', Date.now());
          await service.tick();
        }
        expect(create).toHaveBeenCalledTimes(3);
        expect(store.dirty()).toHaveLength(1);
        expect(store['row']('SELECT count(*) n FROM charges WHERE settled IS NULL')?.n).toBe(0);

        vi.setSystemTime(NOW + 76 * 60_000);
        store.record(
          {
            ...message,
            version: (Date.now() / 1000).toFixed(6),
            text: 'The brief has been reviewed.',
          },
          Date.now(),
        );
        create.mockResolvedValue({
          ...result(),
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                threads: [{ channel: 'C1', thread, observations: [], matters: [] }],
              }),
            },
          ],
        });
        store.schedule('extract', 'global', Date.now());
        await service.tick();
        expect(create).toHaveBeenCalledTimes(4);
        expect(store.dirty()).toEqual([]);
      } finally {
        service.stop();
        service.release();
      }
    },
  );

  it('uses the provider schema adapter, validates locally, and settles complete usage', async () => {
    expect(await gateway.complete(request, new AbortController().signal)).toEqual({ answer: 'ok' });
    const params = create.mock.calls[0][0] as {
      output_config: { format: { schema: { properties: { answer: { maxLength?: number } } } } };
    };
    expect(params.output_config.format.schema.properties.answer.maxLength).toBeUndefined();
    expect(store['row']('SELECT actual,settled FROM charges')).toMatchObject({
      actual: 18,
      settled: NOW,
    });
  });

  it('rechecks access before retries and never dispatches after revocation', async () => {
    create.mockRejectedValueOnce(
      new Anthropic.InternalServerError(500, undefined, 'server error', new Headers()),
    );
    const authorize = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    await expect(
      gateway.complete({ ...request, authorize }, new AbortController().signal),
    ).rejects.toThrow('Source access changed');
    expect(create).toHaveBeenCalledTimes(1);
    expect(store['row']('SELECT count(*) AS n FROM charges')?.n).toBe(1);
    expect(store['row']('SELECT settled FROM charges')?.settled).toBeNull();
  });

  it('checks shutdown during authorization before reserving money', async () => {
    const controller = new AbortController();
    await expect(
      gateway.complete(
        {
          ...request,
          authorize: async () => {
            controller.abort();
            return true;
          },
        },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(store.budget(NOW)).toBe(0);
  });

  it('caps concurrent direct calls at four', async () => {
    let resolve!: (value: ReturnType<typeof result>) => void;
    const pending = new Promise<ReturnType<typeof result>>((done) => {
      resolve = done;
    });
    create.mockReturnValue(pending);
    const calls = Array.from({ length: 4 }, () =>
      gateway.complete(request, new AbortController().signal),
    );
    await expect(gateway.complete(request, new AbortController().signal)).rejects.toBeInstanceOf(
      AdmissionDeferred,
    );
    resolve(result());
    await Promise.all(calls);
    expect(create).toHaveBeenCalledTimes(4);
  });

  it('bounds context and refuses unpriced models before dispatch', async () => {
    await expect(
      gateway.complete({ ...request, input: 'x'.repeat(40_000) }, new AbortController().signal),
    ).rejects.toThrow('split it');
    await expect(
      gateway.complete({ ...request, model: 'unpriced' }, new AbortController().signal),
    ).rejects.toThrow('Unpriced');
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps liability when usage is incomplete and still records the response', async () => {
    create.mockResolvedValue({ ...result(), usage: { input_tokens: 10, output_tokens: 5 } });
    await gateway.complete(request, new AbortController().signal);
    expect(store['row']('SELECT settled FROM charges')?.settled).toBeNull();
    expect(store['row']('SELECT state FROM requests')?.state).toBe('complete');
  });
});
