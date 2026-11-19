// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

// JSON.parse rounds larger integers, so an equality check on one would also match its neighbours.
const exactNumber = z
  .number()
  .refine(
    (value) => !Number.isInteger(value) || Number.isSafeInteger(value),
    'Expected a number JSON can hold exactly',
  );
const jsonPrimitive = z.union([z.string(), exactNumber, z.boolean(), z.null()]);
const jsonPointer = z
  .string()
  .max(256)
  .refine((pointer) => pointer === '' || pointer.startsWith('/'), 'Expected an RFC 6901 pointer');

export const pointerCheckSchema = z.discriminatedUnion('op', [
  z.object({ pointer: jsonPointer, op: z.literal('present') }),
  z.object({ pointer: jsonPointer, op: z.literal('equals'), value: jsonPrimitive }),
  z.object({
    pointer: jsonPointer,
    op: z.literal('in'),
    values: z.array(jsonPrimitive).min(1).max(64),
  }),
]);
export const inputFilterSchema = z.array(pointerCheckSchema).max(16);

/** One bounded test of an event. An event kind is a check on `/type`. */
export type PointerCheck = z.infer<typeof pointerCheckSchema>;

export type InputAuth = 'standard_webhooks' | 'bearer';
export type InputState = 'enabled' | 'paused' | 'deleted';

export interface Input {
  /** Random and unguessable, but not a secret: it appears in the callback URL and in logs. */
  id: string;
  state: InputState;
  auth: InputAuth;
  /** Vault references of the secrets a delivery may authenticate with. */
  secretRefs: string[];
  /** Every check must pass before any consumer is asked to match. */
  filter: PointerCheck[];
  revision: number;
}

export type IgnoredReason = 'paused' | 'filtered';

export interface Receipt {
  id: string;
  inputId: string;
  inputRevision: number;
  /** Scopes the event key together with the input. Generic webhooks use `generic`. */
  binding: string;
  /** Null when the sender supplied no key: the delivery can never be a retry or a conflict. */
  eventKey: string | null;
  /** SHA-256 of the raw body, hex. */
  digest: string;
  /** `open` while a handoff is pending; an ignored receipt never had a body stored. */
  outcome: 'open' | 'closed' | 'ignored';
  ignoredReason: IgnoredReason | null;
  /** Deliveries that reused this key with different content. */
  conflicts: number;
  receivedAt: number;
}

export type HandoffState = 'pending' | 'accepted' | 'skipped' | 'cancelled' | 'failed';

export interface Handoff {
  id: string;
  receiptId: string;
  consumerKind: string;
  consumerId: string;
  /** The consumer's own JSON, fixed when the receipt commits. The inbox never reads it. */
  snapshot: string;
  state: HandoffState;
  attempts: number;
  /** The consumer's durable progress marker, written only while it holds the lease. */
  reservation: string | null;
}

export interface ConsumerMatch {
  consumerId: string;
  /** Must not contain the event body: it outlives the payload. */
  snapshot: string;
}

export interface HandoffWork {
  handoff: Handoff;
  body: Uint8Array;
  /** Throws when the lease was lost; the consumer must then stop and record nothing more. */
  saveReservation(reservation: string): void;
}

/** The seam between the inbox and whatever acts on an event: routines, proactivity. */
export interface IncomingConsumer {
  kind: string;
  /**
   * Runs on the request path just before the receipt commits, so it must be synchronous and
   * free of effects. Errors it throws are logged; they must not quote the event.
   */
  match(input: Input, event: Record<string, unknown>): ConsumerMatch[];
  /**
   * May run more than once for one handoff, even at the same time: after a crash that follows
   * the consumer's own commit, or when an attempt outlives its lease. The handoff id is the
   * idempotency key. Throwing means "retry later"; the error is logged and must not quote the body.
   */
  handle(work: HandoffWork): Promise<'accepted' | 'skipped'>;
}
