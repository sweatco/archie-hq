import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import { readFileSync, statSync, rmSync } from 'fs';
import { join } from 'path';

const SECRETS_ROOT = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  return mkdtempSync(join(tmpdir(), 'archie-claude-connections-test-'));
});

vi.mock('../../../system/workdir.js', () => ({
  SECRETS_DIR: SECRETS_ROOT,
}));

import { issueCode, redeemCode, findConnection, revokeUser } from '../connections.js';

const FILE = join(SECRETS_ROOT, 'claude-connections.json');

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  rmSync(SECRETS_ROOT, { recursive: true, force: true });
});

describe('claude connections', () => {
  it('issues a code that redeems once for a credential that finds the connection', async () => {
    const code = await issueCode({ user_id: 'U1', channel_id: 'C1', channel_name: 'general' });
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const redeemed = await redeemCode(code);
    expect(redeemed).not.toBeNull();
    expect(redeemed!.credential).toEqual(expect.any(String));
    expect(redeemed!.connection).toMatchObject({ user_id: 'U1', channel_id: 'C1', channel_name: 'general' });

    expect(await findConnection(redeemed!.credential)).toEqual(redeemed!.connection);
    expect(await redeemCode(code)).toBeNull();
  });

  it('redeems a lowercase code with spaces', async () => {
    const code = await issueCode({ user_id: 'U2', channel_id: 'C2', channel_name: 'dev' });
    const loose = `${code.slice(0, 4)} ${code.slice(5)}`.toLowerCase();

    const redeemed = await redeemCode(loose);
    expect(redeemed).not.toBeNull();
    expect(redeemed!.connection.user_id).toBe('U2');
  });

  it('refuses a code after ten minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    vi.setSystemTime(now);
    const code = await issueCode({ user_id: 'U3', channel_id: 'C3', channel_name: 'ops' });

    vi.setSystemTime(now + 10 * 60_000 + 1000);
    expect(await redeemCode(code)).toBeNull();
  });

  it('revokes every credential and code of a user', async () => {
    const first = await issueCode({ user_id: 'U4', channel_id: 'C4', channel_name: 'eng' });
    const redeemed = await redeemCode(first);
    const pending = await issueCode({ user_id: 'U4', channel_id: 'C4', channel_name: 'eng' });

    expect(await revokeUser('U4')).toBe(1);
    expect(await findConnection(redeemed!.credential)).toBeNull();
    expect(await redeemCode(pending)).toBeNull();
  });

  it('keeps neither the code nor the credential on disk, in a 0600 file', async () => {
    const code = await issueCode({ user_id: 'U5', channel_id: 'C5', channel_name: 'qa' });
    const unredeemed = await issueCode({ user_id: 'U5', channel_id: 'C5', channel_name: 'qa' });
    const redeemed = await redeemCode(code);

    const text = readFileSync(FILE, 'utf-8');
    expect(text).not.toContain(code);
    expect(text).not.toContain(code.replace('-', ''));
    expect(text).not.toContain(unredeemed);
    expect(text).not.toContain(unredeemed.replace('-', ''));
    expect(text).not.toContain(redeemed!.credential);
    expect(statSync(FILE).mode & 0o777).toBe(0o600);
  });

  it('finds no connection for an unknown credential', async () => {
    expect(await findConnection('nope')).toBeNull();
  });
});
