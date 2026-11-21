// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface SignatureHeaders {
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
}

const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;
const SECRET_PREFIX = 'whsec_';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function bearerTokenMatches(
  authorization: string | undefined,
  secrets: readonly string[],
): boolean {
  const token = /^Bearer +(\S+)$/i.exec(authorization ?? '')?.[1];
  if (!token) return false;
  // Digests have equal length, so the comparison takes the same time for any token.
  const presented = sha256(token);
  let matched = false;
  for (const secret of secrets) {
    if (timingSafeEqual(presented, sha256(secret))) matched = true;
  }
  return matched;
}

/** Standard Webhooks `v1`: HMAC-SHA256 over `<id>.<timestamp>.<body>`, keyed with the base64 part of the secret. */
export function signatureMatches(
  body: Uint8Array,
  headers: SignatureHeaders,
  secrets: readonly string[],
): boolean {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  if (id === '' || !/^\d{1,15}$/.test(timestamp)) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > TIMESTAMP_TOLERANCE_SECONDS) return false;

  // A sender rotating its key sends several space-separated signatures.
  const presented = headers['webhook-signature']
    .split(' ')
    .filter((versioned) => versioned.startsWith('v1,'))
    .map((versioned) => Buffer.from(versioned.slice('v1,'.length)));

  let matched = false;
  for (const secret of secrets) {
    const mac = createHmac('sha256', signingKey(secret)).update(`${id}.${timestamp}.`).update(body);
    const expected = Buffer.from(mac.digest('base64'));
    for (const candidate of presented) {
      // timingSafeEqual throws on a length mismatch.
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected))
        matched = true;
    }
  }
  return matched;
}

function signingKey(secret: string): Buffer {
  const encoded = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  const key = Buffer.from(encoded, 'base64');
  // HMAC accepts an empty key, so an unreadable secret is rejected here.
  if (key.length === 0) throw new Error('Input signing secret holds no key material');
  return key;
}
