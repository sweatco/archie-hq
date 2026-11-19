// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface SignatureHeaders {
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
}

/** Standard Webhooks: how far a delivery's timestamp may be from this host's clock. */
const TOLERANCE_SECONDS = 5 * 60;
const SECRET_PREFIX = 'whsec_';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** True when the `Authorization: Bearer` token equals one of the input's active secrets. */
export function bearerTokenMatches(
  authorization: string | undefined,
  secrets: readonly string[],
): boolean {
  const token = /^Bearer +(\S+)$/i.exec(authorization ?? '')?.[1];
  if (!token) return false;
  // Comparing digests keeps the comparison constant-time without revealing the secret's length.
  const presented = sha256(token);
  let matched = false;
  for (const secret of secrets) {
    if (timingSafeEqual(presented, sha256(secret))) matched = true;
  }
  return matched;
}

/**
 * True when a Standard Webhooks `v1` signature over the received bytes verifies with one of the
 * input's active secrets and the timestamp is within tolerance.
 *
 * The signed content is `<id>.<timestamp>.<body>`, keyed with the base64 part of the secret:
 * https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
 */
export function signatureMatches(
  body: Uint8Array,
  headers: SignatureHeaders,
  secrets: readonly string[],
): boolean {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  if (id === '' || !/^\d{1,15}$/.test(timestamp)) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) return false;

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
  // An empty key would still produce a signature, so a damaged secret must not verify anything.
  if (key.length === 0) throw new Error('Input signing secret holds no key material');
  return key;
}
