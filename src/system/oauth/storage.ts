/**
 * On-disk storage for OAuth records and in-flight pending attempts.
 *
 * Vault records: `${OAUTH_DIR}/<server-name>.json`
 *   { plaintext meta..., envelope: { ciphertext, iv, tag } }
 *
 * Pending attempts: `${OAUTH_PENDING_DIR}/<state>.json`
 *   { plaintext meta..., envelope: { ... } }
 */

import { join } from 'path';
import { readdir } from 'fs/promises';
import { OAUTH_DIR, OAUTH_PENDING_DIR } from '../workdir.js';
import {
  encryptJson,
  decryptJson,
  writeJsonAtomic,
  readJson,
  deleteFileIfExists,
  fileExists,
} from '../secrets-vault.js';
import type {
  OAuthRecord,
  OAuthRecordMeta,
  OAuthSealed,
  OAuthPendingMeta,
  OAuthPendingRecord,
  OAuthPendingSealed,
} from './types.js';

const SERVER_NAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;

function assertSafeServerName(name: string): void {
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid MCP server name "${name}" — must match ${SERVER_NAME_PATTERN}`);
  }
}

function assertSafeState(state: string): void {
  // Match what generateState() produces (base64url) to keep paths safe.
  if (!/^[A-Za-z0-9_-]+$/.test(state)) {
    throw new Error(`Invalid OAuth state token "${state}"`);
  }
}

export function vaultPathFor(serverName: string): string {
  assertSafeServerName(serverName);
  return join(OAUTH_DIR, `${serverName}.json`);
}

export function pendingPathFor(state: string): string {
  assertSafeState(state);
  return join(OAUTH_PENDING_DIR, `${state}.json`);
}

export async function writeOAuthRecord(
  meta: OAuthRecordMeta,
  sealed: OAuthSealed,
): Promise<void> {
  const record: OAuthRecord = { ...meta, envelope: encryptJson(sealed) };
  await writeJsonAtomic(vaultPathFor(meta.server_name), record, 0o600);
}

export async function readOAuthRecord(serverName: string): Promise<OAuthRecord | null> {
  return readJson<OAuthRecord>(vaultPathFor(serverName));
}

export async function readOAuthSealed(record: OAuthRecord): Promise<OAuthSealed> {
  return decryptJson<OAuthSealed>(record.envelope);
}

export async function deleteOAuthRecord(serverName: string): Promise<boolean> {
  return deleteFileIfExists(vaultPathFor(serverName));
}

export async function listOAuthServers(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(OAUTH_DIR);
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((name) => SERVER_NAME_PATTERN.test(name))
    .sort();
}

export async function hasOAuthRecord(serverName: string): Promise<boolean> {
  return fileExists(vaultPathFor(serverName));
}

// ---- Pending attempts -------------------------------------------------------

export async function writePendingRecord(
  meta: OAuthPendingMeta,
  sealed: OAuthPendingSealed,
): Promise<void> {
  const record: OAuthPendingRecord = { ...meta, envelope: encryptJson(sealed) };
  await writeJsonAtomic(pendingPathFor(meta.state), record, 0o600);
}

export async function readPendingRecord(state: string): Promise<OAuthPendingRecord | null> {
  return readJson<OAuthPendingRecord>(pendingPathFor(state));
}

export async function readPendingSealed(record: OAuthPendingRecord): Promise<OAuthPendingSealed> {
  return decryptJson<OAuthPendingSealed>(record.envelope);
}

export async function markPendingError(state: string, message: string): Promise<void> {
  const existing = await readPendingRecord(state);
  if (!existing) return;
  existing.error = message;
  existing.completed_at = Math.floor(Date.now() / 1000);
  await writeJsonAtomic(pendingPathFor(state), existing, 0o600);
}

export async function deletePendingRecord(state: string): Promise<boolean> {
  return deleteFileIfExists(pendingPathFor(state));
}

/**
 * Delete pending attempts older than `maxAgeMs`. Returns the number of
 * files removed.
 */
export async function reapStalePending(maxAgeMs: number): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(OAUTH_PENDING_DIR);
  } catch (err: any) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  const cutoffSec = Math.floor((Date.now() - maxAgeMs) / 1000);
  let removed = 0;
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const path = join(OAUTH_PENDING_DIR, name);
    const record = await readJson<OAuthPendingRecord>(path);
    if (!record) continue;
    if (record.created_at <= cutoffSec) {
      await deleteFileIfExists(path);
      removed++;
    }
  }
  return removed;
}
