// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync } from 'node:sqlite';

/** Runs `fn` in one write transaction and returns its result. */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    // SQLite has already rolled back after errors such as a full disk; a second ROLLBACK
    // would throw and hide the original error.
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
