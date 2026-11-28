// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync } from 'node:sqlite';

export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    // SQLite rolls back by itself on errors such as a full disk; ROLLBACK is for a transaction still open.
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
