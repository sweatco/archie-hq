// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Evidence } from '../types.js';

export type Row = Record<string, string | number | null>;
export type RevisionRecord = Omit<Evidence, 'own' | 'bot' | 'deleted' | 'context' | 'eventId'> & { own: number; bot: number; deleted: number; excerpt: string; hash: string };
export type ChannelRecord = { id: string; allowed: number; shared: number; checkpoint: string; cursor: string | null; gap: string | null };
export type BatchRecord = { id: string; remote: string | null; charge: string; request: string; context: string; state: string; result: string | null; created: number };
export type PolicyRecord = { id: string; body: string; base: string; evidence: string; evaluation: string | null; state: string };
export type EpisodeRecord = { id: string; channel: string; thread: string; topic: string; observed: number; payload: string; baseline: string };
export type CohortRecord = { id: string; policy: string; manifest: string; state: string };
export type PredictionRecord = { cohort: string; episode: string; candidate: string | null; baseline: string | null; error: string | null };
export type EvaluationRecord = { id: string; policy: string; rubric: string; episodes: string; result: string; passed: number; created: number };

export class SqlOperations {
  constructor(private readonly database: DatabaseSync) {}

  protected row<T = Row>(sql: string, ...args: SQLInputValue[]): T | undefined {
    return this.database.prepare(sql).get(...args) as T | undefined;
  }

  protected rows<T = Row>(sql: string, ...args: SQLInputValue[]): T[] {
    return this.database.prepare(sql).all(...args) as T[];
  }

  protected run(sql: string, ...args: SQLInputValue[]) {
    return this.database.prepare(sql).run(...args);
  }

  protected atomic<T>(work: () => T): T {
    if (this.database.isTransaction) return work();
    this.database.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.database.exec('COMMIT'); return result; }
    catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
}
