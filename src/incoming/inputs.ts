// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { lastRefusedDelivery } from './refusals.js';
import type { InputSecrets } from './secrets.js';
import type { IncomingStore } from './store.js';
import {
  inputFilterSchema,
  type Input,
  type InputActor,
  type InputAuth,
  type PointerCheck,
  type Receipt,
} from './types.js';

export interface InputServices {
  store: IncomingStore;
  secrets: InputSecrets;
}

export interface NewInput {
  auth: InputAuth;
  filter?: PointerCheck[];
  /** Reserved beforehand by a caller that must find the same input again after an interruption. */
  id?: string;
  owner?: string | null;
  purpose?: string;
}

export function newInputId(): string {
  return `inp-${randomBytes(16).toString('base64url')}`;
}

/** Seals the secret before the input row exists, so every reachable input has a readable secret. */
export async function createInput(
  services: InputServices,
  spec: NewInput,
): Promise<{ input: Input; secret: string }> {
  const filter = inputFilterSchema.parse(spec.filter ?? []);
  const { ref, secret } = await services.secrets.create(spec.auth);
  const input: Input = {
    id: spec.id ?? newInputId(),
    state: 'enabled',
    auth: spec.auth,
    secretRefs: [ref],
    filter,
    routines: [],
    revision: 1,
    owner: spec.owner ?? null,
    purpose: spec.purpose ?? '',
  };
  try {
    services.store.insertInput(input, Date.now());
  } catch (error) {
    await services.secrets.remove(ref);
    throw error;
  }
  return { input, secret };
}

/** Marks the input deleted before removing its secrets; a repeated call finishes an interrupted cleanup. */
export async function deleteInput(services: InputServices, id: string): Promise<Input | null> {
  const input = services.store.markInputDeleted(id);
  if (!input) return null;
  for (const ref of input.secretRefs) await services.secrets.remove(ref);
  return input;
}

/** The operator manages every input. A Slack user manages the inputs they own; an input without an owner is the operator's alone. */
export function mayManageInput(input: Input, actor: InputActor): boolean {
  return actor.kind === 'operator' || (input.owner !== null && input.owner === actor.userId);
}

export type LinkChange =
  | { status: 'changed' | 'unchanged'; input: Input }
  | { status: 'refused'; reason: 'unknown_input' | 'input_deleted' | 'not_owner' };

/** Lets a trigger receive the input's events, when the actor manages the input. `unchanged` means it was linked already. */
export function linkRoutine(
  store: IncomingStore,
  actor: InputActor,
  inputId: string,
  triggerId: string,
): LinkChange {
  return changeLink(store, actor, inputId, triggerId, true);
}

/** Stops the trigger receiving the input's events. `unchanged` means it was not linked. */
export function unlinkRoutine(
  store: IncomingStore,
  actor: InputActor,
  inputId: string,
  triggerId: string,
): LinkChange {
  return changeLink(store, actor, inputId, triggerId, false);
}

function changeLink(
  store: IncomingStore,
  actor: InputActor,
  inputId: string,
  triggerId: string,
  linked: boolean,
): LinkChange {
  const input = store.input(inputId);
  if (!input) return { status: 'refused', reason: 'unknown_input' };
  if (input.state === 'deleted') return { status: 'refused', reason: 'input_deleted' };
  if (!mayManageInput(input, actor)) return { status: 'refused', reason: 'not_owner' };
  if (input.routines.includes(triggerId) === linked) return { status: 'unchanged', input };

  const changed = linked
    ? store.linkRoutine(inputId, triggerId)
    : store.unlinkRoutine(inputId, triggerId);
  // The input was read a moment ago in the same tick, so only a deletion by another process can land in between.
  if (!changed || changed.state === 'deleted')
    return { status: 'refused', reason: 'input_deleted' };
  return { status: 'changed', input: changed };
}

export type KeyReveal =
  | { status: 'revealed'; secret: string }
  | { status: 'refused'; reason: 'unknown_input' | 'input_deleted' | 'not_owner' | 'unreadable' };

/** Only the owner reads a key. The operator replaces one instead of reading it. */
export async function revealKey(
  services: InputServices,
  actor: InputActor,
  inputId: string,
): Promise<KeyReveal> {
  const input = services.store.input(inputId);
  if (!input) return { status: 'refused', reason: 'unknown_input' };
  if (input.state === 'deleted') return { status: 'refused', reason: 'input_deleted' };
  if (actor.kind !== 'slack_user' || input.owner !== actor.userId)
    return { status: 'refused', reason: 'not_owner' };
  const secret = await readKey(services, input);
  return secret ? { status: 'revealed', secret } : { status: 'refused', reason: 'unreadable' };
}

/** What Archie holds about an input's sender. Reading it starts nothing and writes nothing. */
export interface ConnectionStatus {
  keyReadable: boolean;
  /** The newest delivery that authenticated, recorded or not acted on. */
  lastReceipt: Pick<Receipt, 'receivedAt' | 'outcome' | 'ignoredReason'> | null;
  /** The newest delivery whose signature or token did not verify, since the daemon started. */
  lastRefusedAt: number | null;
}

export async function connectionStatus(
  services: InputServices,
  input: Input,
): Promise<ConnectionStatus> {
  const receipt = services.store.latestReceipt(input.id);
  return {
    keyReadable: (await readKey(services, input)) !== null,
    lastReceipt: receipt && {
      receivedAt: receipt.receivedAt,
      outcome: receipt.outcome,
      ignoredReason: receipt.ignoredReason,
    },
    lastRefusedAt: lastRefusedDelivery(input.id),
  };
}

/** Null when the key's file is missing or cannot be decrypted. */
async function readKey(services: InputServices, input: Input): Promise<string | null> {
  const [ref] = input.secretRefs;
  if (!ref) return null;
  try {
    return await services.secrets.read(ref);
  } catch {
    return null;
  }
}
