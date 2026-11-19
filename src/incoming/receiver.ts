// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Incoming events receiver — `POST /webhooks/incoming/:inputId`.
 *
 * Authenticates a generic JSON webhook and commits its receipt before replying. No Task,
 * trigger or model code runs here; matching consumers are handed off from the inbox later.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Application, Request, Response } from 'express';

import { logger } from '../system/logger.js';
import { getIsShuttingDown } from '../system/shutdown.js';
import { bearerTokenMatches, signatureMatches } from './authenticate.js';
import { passesFilter } from './filter.js';
import type { InputSecrets } from './secrets.js';
import type { IncomingStore, MatchedConsumer, ReceiveResult } from './store.js';
import type { IncomingConsumer, Input } from './types.js';

const require = createRequire(import.meta.url);
const express = require('express') as typeof import('express');

export const INCOMING_ROUTE = '/webhooks/incoming/:inputId';
/** Starting default; see the incoming events plan. */
export const MAX_BODY_BYTES = 1024 * 1024;
const GENERIC_BINDING = 'generic';

export interface ReceiverServices {
  store: IncomingStore;
  secrets: InputSecrets;
  consumers: readonly IncomingConsumer[];
  maxBodyBytes?: number;
}

interface Reply {
  status: number;
  body: Record<string, string>;
}
type RawBodyParser = ReturnType<typeof express.raw>;
type BodyRead = { ok: true; body: Buffer } | { ok: false; reply: Reply };

const rejected = (status: number, error: string): Reply => ({ status, body: { error } });

export function mountIncomingReceiver(app: Application, services: ReceiverServices): void {
  logger.plain(`Incoming events: POST ${INCOMING_ROUTE}`);
  const parseRawJson = express.raw({
    type: 'application/json',
    // A compressed body would be signed in its compressed form and could expand past the limit.
    inflate: false,
    limit: services.maxBodyBytes ?? MAX_BODY_BYTES,
  });

  app.post(INCOMING_ROUTE, async (req: Request, res: Response) => {
    let reply: Reply;
    try {
      reply = await receiveDelivery(req, res, services, parseRawJson);
    } catch (error) {
      // Reached only by storage, vault and consumer failures, whose messages do not quote the body.
      logger.error('incoming', 'Delivery could not be recorded', error);
      reply = rejected(503, 'unavailable');
    }
    res.status(reply.status).json(reply.body);
  });
}

async function receiveDelivery(
  req: Request,
  res: Response,
  services: ReceiverServices,
  parseRawJson: RawBodyParser,
): Promise<Reply> {
  if (getIsShuttingDown()) return rejected(503, 'shutting_down');

  const input = services.store.input(String(req.params.inputId));
  if (!input) return rejected(404, 'unknown_input');
  if (input.state === 'deleted') return rejected(410, 'input_deleted');
  const secrets = await readSecrets(services.secrets, input);

  // A bearer token is checked before the body is read; a signature needs the body first.
  if (input.auth === 'bearer' && !bearerTokenMatches(req.get('authorization'), secrets))
    return unauthorized(input);

  const read = await readBody(parseRawJson, req, res);
  if (!read.ok) return read.reply;

  if (input.auth === 'standard_webhooks') {
    const headers = {
      'webhook-id': req.get('webhook-id') ?? '',
      'webhook-timestamp': req.get('webhook-timestamp') ?? '',
      'webhook-signature': req.get('webhook-signature') ?? '',
    };
    if (!signatureMatches(read.body, headers, secrets)) return unauthorized(input);
  }

  const text = decodeUtf8(read.body);
  if (text === null) return rejected(400, 'invalid_encoding');
  const event = parseJsonObject(text);
  if (!event) return rejected(400, 'invalid_json');
  const eventKey = req.get(input.auth === 'standard_webhooks' ? 'webhook-id' : 'idempotency-key');
  if (eventKey !== undefined && !/^[\x20-\x7e]{1,255}$/.test(eventKey))
    return rejected(400, 'invalid_event_key');

  // Shutdown may have begun while the body was still arriving.
  if (getIsShuttingDown()) return rejected(503, 'shutting_down');

  // Nothing is awaited from here to the commit, so the matches cannot go stale in between.
  const result = services.store.receive(
    {
      inputId: input.id,
      binding: GENERIC_BINDING,
      eventKey: eventKey ?? null,
      digest: createHash('sha256').update(read.body).digest('hex'),
      body: read.body,
      receivedAt: Date.now(),
    },
    matchConsumers(services.consumers, input, event),
  );
  return replyTo(input, result);
}

async function readSecrets(vault: InputSecrets, input: Input): Promise<string[]> {
  const stored = await Promise.all(input.secretRefs.map((ref) => vault.read(ref)));
  const secrets = stored.filter((secret) => secret !== null);
  if (secrets.length === 0) throw new Error(`Input ${input.id} has no readable secret`);
  return secrets;
}

function unauthorized(input: Input): Reply {
  logger.warn('incoming', `Rejected an unauthenticated delivery for input ${input.id}`);
  return rejected(401, 'unauthorized');
}

function readBody(parseRawJson: RawBodyParser, req: Request, res: Response): Promise<BodyRead> {
  return new Promise((resolve) => {
    parseRawJson(req, res, (error?: unknown) => {
      if (error !== undefined) return resolve({ ok: false, reply: bodyRejection(error) });
      const body: unknown = req.body;
      if (Buffer.isBuffer(body)) return resolve({ ok: true, body });
      // The parser skips, without an error, a request with no body or another media type.
      const reply =
        req.is('application/json') === null
          ? rejected(400, 'empty_body')
          : rejected(415, 'unsupported_media_type');
      resolve({ ok: false, reply });
    });
  });
}

function bodyRejection(error: unknown): Reply {
  const type = typeof error === 'object' && error !== null && 'type' in error ? error.type : null;
  if (type === 'entity.too.large') return rejected(413, 'body_too_large');
  if (type === 'encoding.unsupported') return rejected(415, 'unsupported_encoding');
  return rejected(400, 'unreadable_body');
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodeUtf8(body: Buffer): string | null {
  try {
    return utf8.decode(body);
  } catch {
    return null;
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // The parser's message can quote the body, so it is dropped rather than logged or returned.
    return null;
  }
  return isJsonObject(value) ? value : null;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchConsumers(
  consumers: readonly IncomingConsumer[],
  input: Input,
  event: Record<string, unknown>,
): MatchedConsumer[] {
  if (!passesFilter(input.filter, event)) return [];
  return consumers.flatMap((consumer) =>
    consumer.match(input, event).map((match) => ({ kind: consumer.kind, ...match })),
  );
}

function replyTo(input: Input, result: ReceiveResult): Reply {
  switch (result.status) {
    case 'accepted':
      logger.system(`Incoming event accepted: input=${input.id} receipt=${result.receiptId}`);
      return { status: 202, body: { receipt_id: result.receiptId, status: 'accepted' } };
    case 'duplicate':
      return { status: 200, body: { receipt_id: result.receiptId, status: 'duplicate' } };
    case 'ignored':
      return {
        status: 200,
        body: { receipt_id: result.receiptId, status: 'ignored', reason: result.reason },
      };
    case 'conflict':
      logger.warn(
        'incoming',
        `Event key reused with different content: input=${input.id} receipt=${result.receiptId}`,
      );
      return { status: 409, body: { error: 'event_key_conflict', receipt_id: result.receiptId } };
    case 'full':
      logger.warn('incoming', `Inbox is full; refused a delivery for input ${input.id}`);
      return rejected(429, 'inbox_full');
    case 'unavailable':
      return result.reason === 'deleted'
        ? rejected(410, 'input_deleted')
        : rejected(404, 'unknown_input');
  }
}
