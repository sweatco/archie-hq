// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The signature check is Archie's own, so the Standard Webhooks specification's published test
 * vector is what proves it interoperates with real senders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bearerTokenMatches, signatureMatches } from '../authenticate.js';

describe('signatureMatches', () => {
  const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const body = Buffer.from('{"test": 2432232314}');
  const signature = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=';
  const signedAt = 1614265330_000;
  const headers = {
    'webhook-id': 'msg_p5jXN8AQM9LWM0D4loKWxJek',
    'webhook-timestamp': '1614265330',
    'webhook-signature': signature,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(signedAt);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts the published Standard Webhooks vector', () => {
    expect(signatureMatches(body, headers, [secret])).toBe(true);
  });

  it('rejects the vector when one character of the body differs', () => {
    expect(signatureMatches(Buffer.from('{"test": 2432232315}'), headers, [secret])).toBe(false);
  });

  it('rejects the vector under another message id', () => {
    expect(signatureMatches(body, { ...headers, 'webhook-id': 'msg_other' }, [secret])).toBe(false);
  });

  it.each([
    ['just inside', 5 * 60_000, true],
    ['outside', 5 * 60_000 + 1000, false],
  ])('judges a timestamp %s the five-minute tolerance', (_name, elapsedMs, accepted) => {
    vi.setSystemTime(signedAt + elapsedMs);
    expect(signatureMatches(body, headers, [secret])).toBe(accepted);
    vi.setSystemTime(signedAt - elapsedMs);
    expect(signatureMatches(body, headers, [secret])).toBe(accepted);
  });

  it('accepts when any signature in the header matches, as during sender-side rotation', () => {
    const rotated = { ...headers, 'webhook-signature': `v1,AAAA ${signature}` };
    expect(signatureMatches(body, rotated, [secret])).toBe(true);
  });

  it('ignores signature versions it does not know', () => {
    const unknown = { ...headers, 'webhook-signature': signature.replace('v1,', 'v2,') };
    expect(signatureMatches(body, unknown, [secret])).toBe(false);
  });

  it.each(['1614265330x', ' 1614265330', '-1614265330', '1.6e9', ''])(
    'rejects the malformed timestamp %j',
    (timestamp) => {
      const malformed = { ...headers, 'webhook-timestamp': timestamp };
      expect(signatureMatches(body, malformed, [secret])).toBe(false);
    },
  );

  it('rejects a signature that only starts with the right one', () => {
    const padded = { ...headers, 'webhook-signature': `${signature}AAAA` };
    expect(signatureMatches(body, padded, [secret])).toBe(false);
  });

  it('rejects missing headers', () => {
    expect(signatureMatches(body, { ...headers, 'webhook-signature': '' }, [secret])).toBe(false);
    expect(signatureMatches(body, { ...headers, 'webhook-id': '' }, [secret])).toBe(false);
  });

  it('accepts any of the active secrets', () => {
    const other = 'whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    expect(signatureMatches(body, headers, [other, secret])).toBe(true);
    expect(signatureMatches(body, headers, [other])).toBe(false);
  });

  it('fails loudly, rather than rejecting, when a stored secret is unusable', () => {
    expect(() => signatureMatches(body, headers, ['whsec_'])).toThrow();
  });
});

describe('bearerTokenMatches', () => {
  const secret = 'Zm9vYmFyLXRva2VuLXdpdGgtZW5vdWdoLWVudHJvcHk';

  it('accepts the exact token, with a case-insensitive scheme', () => {
    expect(bearerTokenMatches(`Bearer ${secret}`, [secret])).toBe(true);
    expect(bearerTokenMatches(`bearer ${secret}`, [secret])).toBe(true);
  });

  it('accepts any of the active secrets', () => {
    expect(bearerTokenMatches(`Bearer ${secret}`, ['another-secret', secret])).toBe(true);
  });

  it.each([
    ['a missing header', undefined],
    ['another scheme', `Basic ${secret}`],
    ['a prefix of the token', `Bearer ${secret.slice(0, -1)}`],
    ['the token with a suffix', `Bearer ${secret}x`],
    ['an empty token', 'Bearer '],
  ])('rejects %s', (_name, authorization) => {
    expect(bearerTokenMatches(authorization, [secret])).toBe(false);
  });
});
