import crypto from 'crypto';
import { join } from 'path';
import { SECRETS_DIR } from '../../system/workdir.js';
import { readJson, writeJsonAtomic, withKeyMutex } from '../../system/secrets-vault.js';

export interface ClaudeConnection {
  user_id: string;
  channel_id: string;
  channel_name: string;
  created_at: string;
}

// Only sha256 hashes of codes and credentials are kept, so nothing here needs the vault's encryption.
interface ConnectionStore {
  codes: Record<string, ClaudeConnection & { expires_at: string }>;
  credentials: Record<string, ClaudeConnection>;
}

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function storePath(): string {
  return join(SECRETS_DIR, 'claude-connections.json');
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function readStore(path: string): Promise<ConnectionStore> {
  return (await readJson<ConnectionStore>(path)) ?? { codes: {}, credentials: {} };
}

export async function issueCode(c: { user_id: string; channel_id: string; channel_name: string }): Promise<string> {
  let raw = '';
  for (let i = 0; i < 8; i++) {
    raw += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  const path = storePath();
  await withKeyMutex(path, async () => {
    const store = await readStore(path);
    const now = new Date();
    for (const [key, entry] of Object.entries(store.codes)) {
      if (new Date(entry.expires_at) <= now) {
        delete store.codes[key];
      }
    }
    store.codes[sha256(normalizeCode(code))] = {
      user_id: c.user_id,
      channel_id: c.channel_id,
      channel_name: c.channel_name,
      created_at: now.toISOString(),
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
    await writeJsonAtomic(path, store);
  });
  return code;
}

export async function redeemCode(code: string): Promise<{ credential: string; connection: ClaudeConnection } | null> {
  const hash = sha256(normalizeCode(code));
  const path = storePath();
  return withKeyMutex(path, async () => {
    const store = await readStore(path);
    const entry = store.codes[hash];
    if (!entry) {
      return null;
    }
    delete store.codes[hash];
    const now = new Date();
    if (new Date(entry.expires_at) <= now) {
      await writeJsonAtomic(path, store);
      return null;
    }
    const credential = crypto.randomBytes(32).toString('base64url');
    const connection: ClaudeConnection = {
      user_id: entry.user_id,
      channel_id: entry.channel_id,
      channel_name: entry.channel_name,
      created_at: now.toISOString(),
    };
    store.credentials[sha256(credential)] = connection;
    await writeJsonAtomic(path, store);
    return { credential, connection };
  });
}

export async function findConnection(credential: string): Promise<ClaudeConnection | null> {
  const store = await readStore(storePath());
  return store.credentials[sha256(credential)] ?? null;
}

export async function revokeUser(userId: string): Promise<number> {
  const path = storePath();
  return withKeyMutex(path, async () => {
    const store = await readStore(path);
    let removed = 0;
    for (const [key, entry] of Object.entries(store.credentials)) {
      if (entry.user_id === userId) {
        delete store.credentials[key];
        removed++;
      }
    }
    for (const [key, entry] of Object.entries(store.codes)) {
      if (entry.user_id === userId) {
        delete store.codes[key];
      }
    }
    await writeJsonAtomic(path, store);
    return removed;
  });
}
