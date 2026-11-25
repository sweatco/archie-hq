// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { logger } from '../system/logger.js';
import { initializeSchema } from './schema.js';
import { inTransaction } from './sqlite.js';
import {
  inputFilterSchema,
  type ConsumerMatch,
  type Handoff,
  type HandoffState,
  type IgnoredReason,
  type InboxEndReason,
  type Input,
  type InputState,
  type Receipt,
} from './types.js';

/** How many bytes of bodies may wait for handoff. */
export interface InboxLimits {
  inputCapacityBytes: number;
  workspaceCapacityBytes: number;
}

export const DEFAULT_INBOX_LIMITS: InboxLimits = {
  inputCapacityBytes: 100 * 1024 * 1024,
  workspaceCapacityBytes: 1024 * 1024 * 1024,
};

export interface Delivery {
  inputId: string;
  binding: string;
  /** Null for a delivery without a key, which is always treated as new. */
  eventKey: string | null;
  digest: string;
  body: Uint8Array;
  receivedAt: number;
}

export interface MatchedConsumer extends ConsumerMatch {
  kind: string;
}

export type ReceiveResult =
  | { status: 'accepted'; receiptId: string }
  | { status: 'duplicate'; receiptId: string }
  | { status: 'ignored'; receiptId: string; reason: IgnoredReason }
  | { status: 'conflict'; receiptId: string }
  | { status: 'full' }
  | { status: 'unavailable'; reason: 'unknown' | 'deleted' };

export interface InputSummary {
  input: Input;
  createdAt: number;
  receipts: number;
  ignored: number;
  pendingHandoffs: number;
}

/** One ended or waiting handoff, for the operator. */
export interface HandoffRecord {
  id: string;
  receiptId: string;
  inputId: string;
  receivedAt: number;
  consumerKind: string;
  consumerId: string;
  state: HandoffState;
  /** Set when the handoff ended any way other than `accepted`. */
  reason: string | null;
  attempts: number;
  reservation: string | null;
}

/** One delivery an input authenticated, with what became of it at each consumer. An ignored one has no handoffs. */
export interface DeliveryRecord {
  receiptId: string;
  receivedAt: number;
  outcome: Receipt['outcome'];
  ignoredReason: IgnoredReason | null;
  handoffs: Array<
    Pick<HandoffRecord, 'consumerKind' | 'consumerId' | 'state' | 'reason' | 'reservation'>
  >;
}

export interface ClaimedHandoff {
  handoff: Handoff;
  /** Proves the lease on every later write for this attempt. */
  token: string;
  body: Uint8Array;
}

const inputRowSchema = z.object({
  id: z.string(),
  state: z.enum(['enabled', 'paused', 'deleted']),
  auth: z.enum(['standard_webhooks', 'bearer']),
  secret_refs: z.string(),
  filter: z.string(),
  routines: z.string(),
  revision: z.number(),
  owner: z.string().nullable(),
  purpose: z.string(),
});

const receiptRowSchema = z.object({
  id: z.string(),
  input_id: z.string(),
  input_revision: z.number(),
  binding: z.string(),
  event_key: z.string().nullable(),
  digest: z.string(),
  outcome: z.enum(['open', 'closed', 'ignored']),
  ignored_reason: z.enum(['paused', 'filtered']).nullable(),
  conflicts: z.number(),
  received_at: z.number(),
});

const dueHandoffSchema = z.object({
  id: z.string(),
  receipt_id: z.string(),
  consumer_kind: z.string(),
  consumer_id: z.string(),
  snapshot: z.string(),
  attempts: z.number(),
  reservation: z.string().nullable(),
  input_state: z.enum(['enabled', 'paused', 'deleted']),
  body: z.instanceof(Uint8Array),
});

const handoffStateSchema = z.enum(['pending', 'accepted', 'skipped', 'cancelled', 'failed']);

const deliveryRowSchema = z.object({
  id: z.string(),
  received_at: z.number(),
  outcome: z.enum(['open', 'closed', 'ignored']),
  ignored_reason: z.enum(['paused', 'filtered']).nullable(),
});

const deliveryHandoffSchema = z.object({
  receipt_id: z.string(),
  consumer_kind: z.string(),
  consumer_id: z.string(),
  state: handoffStateSchema,
  reason: z.string().nullable(),
  reservation: z.string().nullable(),
});

const handoffRecordSchema = z.object({
  id: z.string(),
  receipt_id: z.string(),
  input_id: z.string(),
  received_at: z.number(),
  consumer_kind: z.string(),
  consumer_id: z.string(),
  state: handoffStateSchema,
  reason: z.string().nullable(),
  attempts: z.number(),
  reservation: z.string().nullable(),
});

function stoppedInput(state: 'paused' | 'deleted'): InboxEndReason {
  return state === 'paused' ? 'input_paused' : 'input_deleted';
}

function toInput(row: Record<string, unknown>): Input {
  const stored = inputRowSchema.parse(row);
  return {
    id: stored.id,
    state: stored.state,
    auth: stored.auth,
    secretRefs: z.array(z.string()).parse(JSON.parse(stored.secret_refs)),
    filter: inputFilterSchema.parse(JSON.parse(stored.filter)),
    routines: z.array(z.string()).parse(JSON.parse(stored.routines)),
    revision: stored.revision,
    owner: stored.owner,
    purpose: stored.purpose,
  };
}

export class IncomingStore {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly limits: InboxLimits = DEFAULT_INBOX_LIMITS,
  ) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=5000');
      initializeSchema(this.db);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  insertInput(input: Input, createdAt: number): void {
    this.run(
      'INSERT INTO inputs(id,state,auth,secret_refs,filter,routines,revision,owner,purpose,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      input.id,
      input.state,
      input.auth,
      JSON.stringify(input.secretRefs),
      JSON.stringify(input.filter),
      JSON.stringify(input.routines),
      input.revision,
      input.owner,
      input.purpose,
      createdAt,
    );
  }

  input(id: string): Input | null {
    const row = this.row('SELECT * FROM inputs WHERE id=?', id);
    return row ? toInput(row) : null;
  }

  inputSummaries(): InputSummary[] {
    return this.db
      .prepare(
        `SELECT i.*,
                (SELECT COUNT(*) FROM receipts r WHERE r.input_id=i.id) AS receipts,
                (SELECT COUNT(*) FROM receipts r WHERE r.input_id=i.id AND r.outcome='ignored') AS ignored,
                (SELECT COUNT(*) FROM handoffs h WHERE h.state='pending'
                    AND (SELECT input_id FROM receipts WHERE id=h.receipt_id)=i.id) AS pending
           FROM inputs i ORDER BY i.created_at, i.rowid`,
      )
      .all()
      .map((row) => ({
        input: toInput(row),
        createdAt: Number(row.created_at),
        receipts: Number(row.receipts),
        ignored: Number(row.ignored),
        pendingHandoffs: Number(row.pending),
      }));
  }

  /** Later deliveries are recorded as ignored; waiting handoffs are cancelled and a leased one may finish. */
  pauseInput(id: string, now = Date.now()): Input | null {
    return this.moveInput(id, 'paused', now);
  }

  resumeInput(id: string, now = Date.now()): Input | null {
    return this.moveInput(id, 'enabled', now);
  }

  /** Final. Cancels handoffs as pausing does. */
  markInputDeleted(id: string, now = Date.now()): Input | null {
    return this.moveInput(id, 'deleted', now);
  }

  /** Lets a trigger receive this input's events. A deleted input is returned unchanged. */
  linkRoutine(id: string, triggerId: string): Input | null {
    return this.changeRoutines(id, (linked) =>
      linked.includes(triggerId) ? linked : [...linked, triggerId],
    );
  }

  /** Applies from the next delivery. */
  unlinkRoutine(id: string, triggerId: string): Input | null {
    return this.changeRoutines(id, (linked) => linked.filter((routine) => routine !== triggerId));
  }

  receipt(id: string): Receipt | null {
    const row = this.row('SELECT * FROM receipts WHERE id=?', id);
    if (!row) return null;
    const stored = receiptRowSchema.parse(row);
    return {
      id: stored.id,
      inputId: stored.input_id,
      inputRevision: stored.input_revision,
      binding: stored.binding,
      eventKey: stored.event_key,
      digest: stored.digest,
      outcome: stored.outcome,
      ignoredReason: stored.ignored_reason,
      conflicts: stored.conflicts,
      receivedAt: stored.received_at,
    };
  }

  /** The newest receipt of an input, whatever became of it. */
  latestReceipt(inputId: string): Receipt | null {
    const row = this.row(
      'SELECT id FROM receipts WHERE input_id=? ORDER BY received_at DESC, rowid DESC LIMIT 1',
      inputId,
    );
    return row ? this.receipt(String(row.id)) : null;
  }

  /**
   * A known key is answered first, so a retry gets its receipt even when the inbox is full.
   * A retry of an ignored event is accepted under the same receipt once the input takes it.
   */
  receive(delivery: Delivery, consumers: readonly MatchedConsumer[]): ReceiveResult {
    return inTransaction(this.db, () => {
      const input = this.input(delivery.inputId);
      if (!input) return { status: 'unavailable', reason: 'unknown' };
      if (input.state === 'deleted') return { status: 'unavailable', reason: 'deleted' };

      const wanted = input.state === 'enabled' && consumers.length > 0;
      const known =
        delivery.eventKey === null
          ? undefined
          : this.row(
              'SELECT id,digest,outcome FROM receipts WHERE input_id=? AND binding=? AND event_key=?',
              input.id,
              delivery.binding,
              delivery.eventKey,
            );
      if (known) {
        const receiptId = String(known.id);
        if (known.digest !== delivery.digest) {
          this.run(
            'UPDATE receipts SET conflicts=conflicts+1,last_conflict_at=? WHERE id=?',
            delivery.receivedAt,
            receiptId,
          );
          return { status: 'conflict', receiptId };
        }
        if (known.outcome !== 'ignored' || !wanted) return { status: 'duplicate', receiptId };
        if (this.wouldExceedCapacity(input.id, delivery.body.byteLength)) return { status: 'full' };
        // The receipt's age restarts, so the sweep measures the handoff from this delivery.
        this.run(
          "UPDATE receipts SET outcome='open',ignored_reason=NULL,input_revision=?,received_at=? WHERE id=?",
          input.revision,
          delivery.receivedAt,
          receiptId,
        );
        this.insertHandoffs(receiptId, delivery, consumers);
        return { status: 'accepted', receiptId };
      }

      const receiptId = `rcp-${randomUUID()}`;
      if (!wanted) {
        const reason = input.state === 'paused' ? 'paused' : 'filtered';
        this.insertReceipt(receiptId, input, delivery, reason);
        return { status: 'ignored', receiptId, reason };
      }
      if (this.wouldExceedCapacity(input.id, delivery.body.byteLength)) return { status: 'full' };

      this.insertReceipt(receiptId, input, delivery, null);
      this.insertHandoffs(receiptId, delivery, consumers);
      return { status: 'accepted', receiptId };
    });
  }

  private insertHandoffs(
    receiptId: string,
    delivery: Delivery,
    consumers: readonly MatchedConsumer[],
  ): void {
    this.run('INSERT INTO payloads(receipt_id,body) VALUES (?,?)', receiptId, delivery.body);
    for (const consumer of consumers)
      this.run(
        "INSERT INTO handoffs(id,receipt_id,consumer_kind,consumer_id,snapshot,state,due_at) VALUES (?,?,?,?,?,'pending',?)",
        `hnd-${randomUUID()}`,
        receiptId,
        consumer.kind,
        consumer.consumerId,
        consumer.snapshot,
        delivery.receivedAt,
      );
  }

  /** An ignored receipt keeps only the key and digest, for retries and history. */
  private insertReceipt(
    receiptId: string,
    input: Input,
    delivery: Delivery,
    ignoredReason: IgnoredReason | null,
  ): void {
    this.run(
      'INSERT INTO receipts(id,input_id,input_revision,binding,event_key,digest,outcome,ignored_reason,received_at) VALUES (?,?,?,?,?,?,?,?,?)',
      receiptId,
      input.id,
      input.revision,
      delivery.binding,
      // SQLite treats NULL keys as distinct, so each unkeyed delivery gets its own receipt.
      delivery.eventKey,
      delivery.digest,
      ignoredReason === null ? 'open' : 'ignored',
      ignoredReason,
      delivery.receivedAt,
    );
  }

  private wouldExceedCapacity(inputId: string, incomingBytes: number): boolean {
    const stored = this.requiredRow(
      `SELECT COALESCE(SUM(length(p.body)),0) AS workspace,
              COALESCE(SUM(CASE WHEN r.input_id=? THEN length(p.body) END),0) AS input
         FROM payloads p JOIN receipts r ON r.id=p.receipt_id`,
      inputId,
    );
    return (
      Number(stored.input) + incomingBytes > this.limits.inputCapacityBytes ||
      Number(stored.workspace) + incomingBytes > this.limits.workspaceCapacityBytes
    );
  }

  /** Leases the oldest due handoff and counts the attempt; one whose input was stopped is cancelled instead. */
  claimHandoff(now: number, leaseMs: number): ClaimedHandoff | null {
    return inTransaction(this.db, () => {
      for (let id = this.dueHandoffId(now); id !== null; id = this.dueHandoffId(now)) {
        const due = this.storedHandoff(id);
        if (!due) {
          this.failUnreadableHandoff(id);
          continue;
        }
        if (due.input_state !== 'enabled') {
          this.cancelHandoff(due.id, due.receipt_id, stoppedInput(due.input_state));
          continue;
        }

        const token = randomUUID();
        this.run(
          'UPDATE handoffs SET token=?,lease_until=?,attempts=attempts+1 WHERE id=?',
          token,
          now + leaseMs,
          due.id,
        );
        return {
          token,
          body: due.body,
          handoff: {
            id: due.id,
            receiptId: due.receipt_id,
            consumerKind: due.consumer_kind,
            consumerId: due.consumer_id,
            snapshot: due.snapshot,
            state: 'pending',
            attempts: due.attempts + 1,
            reservation: due.reservation,
          },
        };
      }
      return null;
    });
  }

  /** Returns whether the caller still held the lease. */
  saveReservation(id: string, token: string, reservation: string): boolean {
    return (
      this.run('UPDATE handoffs SET reservation=? WHERE id=? AND token=?', reservation, id, token) >
      0
    );
  }

  /** Schedules another attempt at `dueAt`, or cancels the handoff when its input was stopped meanwhile. */
  releaseHandoff(id: string, token: string, dueAt: number): 'retry' | 'cancelled' | 'lost' {
    return inTransaction(this.db, () => {
      const held = this.row(
        `SELECT h.receipt_id, i.state AS input_state
           FROM handoffs h
           JOIN receipts r ON r.id=h.receipt_id
           JOIN inputs i ON i.id=r.input_id
          WHERE h.id=? AND h.token=?`,
        id,
        token,
      );
      if (!held) return 'lost';
      const inputState = inputRowSchema.shape.state.parse(held.input_state);
      if (inputState !== 'enabled') {
        this.cancelHandoff(id, String(held.receipt_id), stoppedInput(inputState));
        return 'cancelled';
      }
      this.run('UPDATE handoffs SET token=NULL,lease_until=0,due_at=? WHERE id=?', dueAt, id);
      return 'retry';
    });
  }

  /** Returns whether the lease was held. A receipt's last finish also deletes its body, atomically. */
  finishHandoff(
    id: string,
    token: string,
    state: 'accepted' | 'skipped' | 'failed',
    reason: string | null = null,
  ): boolean {
    return inTransaction(this.db, () => {
      const finished = this.row(
        'UPDATE handoffs SET state=?,reason=?,token=NULL,lease_until=0 WHERE id=? AND token=? RETURNING receipt_id',
        state,
        reason,
        id,
        token,
      );
      if (!finished) return false;
      this.settleReceipt(String(finished.receipt_id));
      return true;
    });
  }

  abandonedReservations(consumerKind: string): Array<{ handoffId: string; reservation: string }> {
    return this.db
      .prepare(
        `SELECT id, reservation FROM handoffs
          WHERE consumer_kind=? AND reservation IS NOT NULL
            AND state IN ('skipped','cancelled','failed')`,
      )
      .all(consumerKind)
      .map((row) => ({ handoffId: String(row.id), reservation: String(row.reservation) }));
  }

  /** The newest handoffs first, for one input or for all. */
  handoffHistory(limit: number, inputId?: string): HandoffRecord[] {
    return this.db
      .prepare(
        `SELECT h.id, h.receipt_id, r.input_id, r.received_at, h.consumer_kind, h.consumer_id,
                h.state, h.reason, h.attempts, h.reservation
           FROM handoffs h JOIN receipts r ON r.id=h.receipt_id
          WHERE ?1 IS NULL OR r.input_id=?1
          ORDER BY r.received_at DESC, h.rowid DESC LIMIT ?2`,
      )
      .all(inputId ?? null, limit)
      .map((row) => {
        const stored = handoffRecordSchema.parse(row);
        return {
          id: stored.id,
          receiptId: stored.receipt_id,
          inputId: stored.input_id,
          receivedAt: stored.received_at,
          consumerKind: stored.consumer_kind,
          consumerId: stored.consumer_id,
          state: stored.state,
          reason: stored.reason,
          attempts: stored.attempts,
          reservation: stored.reservation,
        };
      });
  }

  /** The newest deliveries of one input first, ignored ones included. */
  deliveryHistory(inputId: string, limit: number): DeliveryRecord[] {
    const newest =
      'SELECT id FROM receipts WHERE input_id=?1 ORDER BY received_at DESC, rowid DESC LIMIT ?2';
    const handoffs = new Map<string, DeliveryRecord['handoffs']>();
    for (const row of this.db
      .prepare(
        `SELECT receipt_id, consumer_kind, consumer_id, state, reason, reservation
           FROM handoffs WHERE receipt_id IN (${newest}) ORDER BY rowid`,
      )
      .all(inputId, limit)) {
      const stored = deliveryHandoffSchema.parse(row);
      const ofReceipt = handoffs.get(stored.receipt_id) ?? [];
      ofReceipt.push({
        consumerKind: stored.consumer_kind,
        consumerId: stored.consumer_id,
        state: stored.state,
        reason: stored.reason,
        reservation: stored.reservation,
      });
      handoffs.set(stored.receipt_id, ofReceipt);
    }
    return this.db
      .prepare(
        `SELECT id, received_at, outcome, ignored_reason FROM receipts
          WHERE input_id=?1 ORDER BY received_at DESC, rowid DESC LIMIT ?2`,
      )
      .all(inputId, limit)
      .map((row) => {
        const stored = deliveryRowSchema.parse(row);
        return {
          receiptId: stored.id,
          receivedAt: stored.received_at,
          outcome: stored.outcome,
          ignoredReason: stored.ignored_reason,
          handoffs: handoffs.get(stored.id) ?? [],
        };
      });
  }

  /** Fails unleased handoffs of older deliveries and removes settled receipts, freeing their event keys. */
  sweep(
    now: number,
    handoffsBefore: number,
    receiptsBefore: number,
  ): { failed: number; purged: number } {
    return inTransaction(this.db, () => {
      const failed = this.endHandoffs(
        `UPDATE handoffs SET state='failed',reason='expired',token=NULL,lease_until=0
          WHERE state='pending' AND lease_until<=?
            AND (SELECT received_at FROM receipts WHERE id=handoffs.receipt_id)<=?
          RETURNING receipt_id`,
        now,
        handoffsBefore,
      );
      this.run(
        "DELETE FROM handoffs WHERE receipt_id IN (SELECT id FROM receipts WHERE received_at<=? AND outcome!='open')",
        receiptsBefore,
      );
      const purged = this.run(
        "DELETE FROM receipts WHERE received_at<=? AND outcome!='open'",
        receiptsBefore,
      );
      return { failed, purged };
    });
  }

  private moveInput(id: string, next: InputState, now: number): Input | null {
    return inTransaction(this.db, () => {
      const input = this.input(id);
      if (!input || input.state === next || input.state === 'deleted') return input;
      this.run('UPDATE inputs SET state=? WHERE id=?', next, id);
      if (next !== 'enabled')
        this.endHandoffs(
          `UPDATE handoffs SET state='cancelled',reason=?,token=NULL,lease_until=0
            WHERE state='pending' AND lease_until<=?
              AND (SELECT input_id FROM receipts WHERE id=handoffs.receipt_id)=?
            RETURNING receipt_id`,
          stoppedInput(next),
          now,
          id,
        );
      return { ...input, state: next };
    });
  }

  private changeRoutines(id: string, change: (linked: string[]) => string[]): Input | null {
    return inTransaction(this.db, () => {
      const input = this.input(id);
      if (!input || input.state === 'deleted') return input;
      const routines = change(input.routines);
      if (routines.length === input.routines.length) return input;
      const revision = input.revision + 1;
      this.run(
        'UPDATE inputs SET routines=?,revision=? WHERE id=?',
        JSON.stringify(routines),
        revision,
        id,
      );
      return { ...input, routines, revision };
    });
  }

  /** Chosen from the due index in its own order; the body is read only for the chosen handoff. */
  private dueHandoffId(now: number): string | null {
    const next = this.row(
      `SELECT id FROM handoffs
        WHERE state='pending' AND due_at<=? AND lease_until<=?
        ORDER BY due_at, lease_until, rowid LIMIT 1`,
      now,
      now,
    );
    return next ? String(next.id) : null;
  }

  /** Null when the handoff's body or one of its rows is missing or malformed. */
  private storedHandoff(id: string) {
    const stored = dueHandoffSchema.safeParse(
      this.row(
        `SELECT h.id, h.receipt_id, h.consumer_kind, h.consumer_id, h.snapshot, h.attempts,
                h.reservation, i.state AS input_state, p.body
           FROM handoffs h
           JOIN receipts r ON r.id=h.receipt_id
           JOIN inputs i ON i.id=r.input_id
           JOIN payloads p ON p.receipt_id=h.receipt_id
          WHERE h.id=?`,
        id,
      ),
    );
    return stored.success ? stored.data : null;
  }

  /** Left pending, it would stay first in line and hold back every later handoff. */
  private failUnreadableHandoff(id: string): void {
    this.endHandoffs(
      "UPDATE handoffs SET state='failed',reason=?,token=NULL,lease_until=0 WHERE id=? RETURNING receipt_id",
      'unreadable' satisfies InboxEndReason,
      id,
    );
    logger.error(
      'incoming',
      `Incoming handoff failed: its stored delivery is unreadable handoff=${id}`,
    );
  }

  private cancelHandoff(id: string, receiptId: string, reason: InboxEndReason): void {
    this.run(
      "UPDATE handoffs SET state='cancelled',reason=?,token=NULL,lease_until=0 WHERE id=?",
      reason,
      id,
    );
    this.settleReceipt(receiptId);
  }

  /** Runs an UPDATE that ends handoffs and returns their receipts, then settles each receipt. */
  private endHandoffs(sql: string, ...args: SQLInputValue[]): number {
    const ended = this.db.prepare(sql).all(...args);
    for (const receiptId of new Set(ended.map((row) => String(row.receipt_id))))
      this.settleReceipt(receiptId);
    return ended.length;
  }

  /** Deletes the body and closes the receipt when all its handoffs have ended. */
  private settleReceipt(receiptId: string): void {
    // The unary plus steers SQLite to the receipt index.
    if (
      this.row("SELECT 1 FROM handoffs WHERE receipt_id=? AND +state='pending' LIMIT 1", receiptId)
    )
      return;
    this.run('DELETE FROM payloads WHERE receipt_id=?', receiptId);
    this.run("UPDATE receipts SET outcome='closed' WHERE id=?", receiptId);
  }

  private row(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).get(...args);
  }

  private requiredRow(sql: string, ...args: SQLInputValue[]) {
    const row = this.row(sql, ...args);
    if (!row) throw new Error('SQLite returned no row where one must exist');
    return row;
  }

  /** Returns the number of rows changed. */
  private run(sql: string, ...args: SQLInputValue[]): number {
    return Number(this.db.prepare(sql).run(...args).changes);
  }
}
