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

/** The shape `createInput` mints. */
export const INPUT_ID_PATTERN = /^inp-[A-Za-z0-9_-]{22}$/;

export interface Input {
  /** Random and unguessable; public enough to appear in the callback URL and in logs. */
  id: string;
  state: InputState;
  auth: InputAuth;
  secretRefs: string[];
  /** Every check must pass before any consumer is asked to match. */
  filter: PointerCheck[];
  /** Ids of the triggers the operator linked: the only routines that receive this input's events. */
  routines: string[];
  /** Counts changes to the links; a receipt records the one it was matched under. */
  revision: number;
  /** Slack user who manages the input in Slack. Null for an input the operator made, which is managed from the CLI only. */
  owner: string | null;
  /** Short label for cards and listings. Empty for an input made without one. */
  purpose: string;
}

/** A purpose is shown inside Slack messages, so it holds none of Slack's control characters. */
export const inputPurposeSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^<>&`\p{Cc}]+$/u, 'Expected plain text without <, >, & or backticks');

/** Who asks for a change to an input. The operator acts from the host; a Slack user is checked against the owner. */
export type InputActor = { kind: 'operator' } | { kind: 'slack_user'; userId: string };

export type IgnoredReason = 'paused' | 'filtered';

export interface Receipt {
  id: string;
  inputId: string;
  inputRevision: number;
  /** Scopes the event key together with the input. Generic webhooks use `generic`. */
  binding: string;
  /** Null for a delivery without a key, which is always new. */
  eventKey: string | null;
  /** SHA-256 of the raw body, hex. */
  digest: string;
  /** `open` while a handoff is pending. */
  outcome: 'open' | 'closed' | 'ignored';
  ignoredReason: IgnoredReason | null;
  /** Deliveries that reused this key with different content. */
  conflicts: number;
  receivedAt: number;
}

export type HandoffState = 'pending' | 'accepted' | 'skipped' | 'cancelled' | 'failed';

/** Why the inbox itself ended a handoff. A skip carries its consumer's own reason. */
export type InboxEndReason =
  | 'input_paused'
  | 'input_deleted'
  | 'attempts_exhausted'
  | 'interrupted'
  | 'expired'
  | 'unreadable';

export interface Handoff {
  id: string;
  receiptId: string;
  consumerKind: string;
  consumerId: string;
  /** The consumer's own JSON, fixed when the receipt commits and opaque to the inbox. */
  snapshot: string;
  state: HandoffState;
  attempts: number;
  /** The consumer's durable progress marker, written only while it holds the lease. */
  reservation: string | null;
}

export interface ConsumerMatch {
  consumerId: string;
  /** Outlives the payload, so keep the event body out of it. */
  snapshot: string;
}

/** What a consumer may read from the inbox, as it is at the moment of the call. */
export interface InboxView {
  input(id: string): Input | null;
  /** Reservations of a consumer's handoffs that ended any way other than `accepted`. */
  abandonedReservations(consumerKind: string): Array<{ handoffId: string; reservation: string }>;
}

export interface ConsumerUse {
  consumerId: string;
  label: string;
}

export type HandleResult = { state: 'accepted' } | { state: 'skipped'; reason: string };

export interface HandoffWork {
  handoff: Handoff;
  body: Uint8Array;
  inbox: InboxView;
  /** Throws when the lease was lost, which tells the consumer to stop. */
  saveReservation(reservation: string): void;
}

/** The seam between the inbox and whatever acts on an event. Errors thrown here are logged, so keep event data out of them. */
export interface IncomingConsumer {
  kind: string;
  /** Runs on the request path just before the receipt commits: synchronous and free of effects. */
  match(input: Input, event: Record<string, unknown>): ConsumerMatch[];
  /** May run more than once for a handoff, even concurrently: key the work by the handoff id. Throwing asks for a retry. */
  handle(work: HandoffWork): Promise<HandleResult>;
  /** Runs with each sweep, the first at start: drops work whose handoff ended without `handle` seeing it. */
  reconcile?(inbox: InboxView): Promise<void>;
  /** For listings. Synchronous and free of effects, like `match`. */
  uses?(input: Input): ConsumerUse[];
}
