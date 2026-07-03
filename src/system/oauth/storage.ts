/**
 * On-disk storage for OAuth records and in-flight pending attempts.
 *
 * Legacy shared vault records: `${OAUTH_DIR}/<server-name>.json`
 *   { plaintext meta..., envelope: { ciphertext, iv, tag } }
 *
 * Per-user token records: `${OAUTH_USERS_DIR}/<slackUserId>/<server-name>.json`
 *
 * Shared DCR client registrations: `${OAUTH_CLIENTS_DIR}/<server-name>.json`
 *
 * Pending attempts: `${OAUTH_PENDING_DIR}/<state>.json`
 *   { plaintext meta..., envelope: { ... } }
 */

import { join } from 'path';
import { readdir } from 'fs/promises';
import { OAUTH_DIR, OAUTH_PENDING_DIR, OAUTH_CLIENTS_DIR, OAUTH_USERS_DIR } from '../workdir.js';
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
  OAuthClientMeta,
  OAuthClientRecord,
  OAuthClientSealed,
  OAuthUserRecord,
  OAuthUserRecordMeta,
  OAuthUserSealed,
  OAuthPendingMeta,
  OAuthPendingRecord,
  OAuthPendingSealed,
} from './types.js';

const SERVER_NAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;

// Slack ids are short alphanumerics (U…/W…); the guard just has to keep the
// value a single safe path segment.
const SLACK_USER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function assertSafeServerName(name: string): void {
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid MCP server name "${name}" — must match ${SERVER_NAME_PATTERN}`);
  }
}

function assertSafeUserId(slackUserId: string): void {
  if (!SLACK_USER_ID_PATTERN.test(slackUserId)) {
    throw new Error(`Invalid Slack user id "${slackUserId}" — must match ${SLACK_USER_ID_PATTERN}`);
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

export function clientPathFor(serverName: string): string {
  assertSafeServerName(serverName);
  return join(OAUTH_CLIENTS_DIR, `${serverName}.json`);
}

export function userVaultPathFor(slackUserId: string, serverName: string): string {
  assertSafeUserId(slackUserId);
  assertSafeServerName(serverName);
  return join(OAUTH_USERS_DIR, slackUserId, `${serverName}.json`);
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

// ---- Shared DCR client registrations ---------------------------------------

export async function writeOAuthClientRecord(
  meta: OAuthClientMeta,
  sealed: OAuthClientSealed,
): Promise<void> {
  const record: OAuthClientRecord = { ...meta, envelope: encryptJson(sealed) };
  await writeJsonAtomic(clientPathFor(meta.server_name), record, 0o600);
}

export async function readOAuthClientRecord(serverName: string): Promise<OAuthClientRecord | null> {
  return readJson<OAuthClientRecord>(clientPathFor(serverName));
}

export async function readOAuthClientSealed(record: OAuthClientRecord): Promise<OAuthClientSealed> {
  return decryptJson<OAuthClientSealed>(record.envelope);
}

export async function hasOAuthClientRecord(serverName: string): Promise<boolean> {
  return fileExists(clientPathFor(serverName));
}

// ---- Per-user token records -------------------------------------------------

export async function writeUserOAuthRecord(
  meta: OAuthUserRecordMeta,
  sealed: OAuthUserSealed,
): Promise<void> {
  const record: OAuthUserRecord = { ...meta, envelope: encryptJson(sealed) };
  await writeJsonAtomic(userVaultPathFor(meta.slack_user_id, meta.server_name), record, 0o600);
}

export async function readUserOAuthRecord(
  slackUserId: string,
  serverName: string,
): Promise<OAuthUserRecord | null> {
  return readJson<OAuthUserRecord>(userVaultPathFor(slackUserId, serverName));
}

export async function readUserOAuthSealed(record: OAuthUserRecord): Promise<OAuthUserSealed> {
  return decryptJson<OAuthUserSealed>(record.envelope);
}

export async function deleteUserOAuthRecord(
  slackUserId: string,
  serverName: string,
): Promise<boolean> {
  return deleteFileIfExists(userVaultPathFor(slackUserId, serverName));
}

export async function hasUserOAuthRecord(
  slackUserId: string,
  serverName: string,
): Promise<boolean> {
  return fileExists(userVaultPathFor(slackUserId, serverName));
}

/** Server names one user holds token records for. */
export async function listUserServers(slackUserId: string): Promise<string[]> {
  assertSafeUserId(slackUserId);
  let entries: string[];
  try {
    entries = await readdir(join(OAUTH_USERS_DIR, slackUserId));
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

/** Slack user ids that hold any per-user token record. */
export async function listOAuthUserIds(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(OAUTH_USERS_DIR);
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries.filter((name) => SLACK_USER_ID_PATTERN.test(name)).sort();
}

/** Slack user ids that hold a token record for one server. */
export async function listServerUsers(serverName: string): Promise<string[]> {
  assertSafeServerName(serverName);
  const users: string[] = [];
  for (const uid of await listOAuthUserIds()) {
    if (await hasUserOAuthRecord(uid, serverName)) users.push(uid);
  }
  return users;
}

/**
 * Whether any vault record exists — legacy shared, per-user, or shared client.
 * Drives the fail-fast master-key check at startup: a deployment with records
 * but a missing/garbled `ARCHIE_SECRETS_KEY` should die at boot, not at spawn.
 */
export async function anyOAuthRecordExists(): Promise<boolean> {
  if ((await listOAuthServers()).length > 0) return true;
  try {
    if ((await readdir(OAUTH_CLIENTS_DIR)).some((n) => n.endsWith('.json'))) return true;
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const uid of await listOAuthUserIds()) {
    if ((await listUserServers(uid)).length > 0) return true;
  }
  return false;
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
