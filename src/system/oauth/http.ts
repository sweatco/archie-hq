import { lookup as dnsLookup } from 'node:dns';
import type { LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent } from 'undici';

const OAUTH_HTTP_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const MAX_RESPONSE_SIZE = 1024 * 1024;

function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}

const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, '');
      return;
    }
    if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
      callback(new Error(`OAuth endpoint ${hostname} resolves to a non-public address`), '');
      return;
    }
    if (options.all) {
      callback(null, addresses);
      return;
    }
    const selected = options.family
      ? addresses.find(({ family }) => family === options.family)
      : addresses[0];
    if (!selected) {
      callback(new Error(`OAuth endpoint ${hostname} has no address for family ${options.family}`), '');
      return;
    }
    callback(null, selected.address, selected.family);
  });
};

const oauthDispatcher = new Agent({
  connect: { lookup: safeLookup, timeout: OAUTH_HTTP_TIMEOUT_MS },
  headersTimeout: OAUTH_HTTP_TIMEOUT_MS,
  bodyTimeout: OAUTH_HTTP_TIMEOUT_MS,
  maxResponseSize: MAX_RESPONSE_SIZE,
  maxRedirections: 0,
});

function isExplicitlyAllowedLoopback(url: URL): boolean {
  if (process.env.ARCHIE_OAUTH_ALLOW_INSECURE_LOOPBACK !== '1') return false;
  if (url.hostname === 'localhost') return true;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  try {
    return ipaddr.process(hostname).range() === 'loopback';
  } catch {
    return false;
  }
}

export function assertSafeOAuthUrl(value: string | URL): URL {
  const url = value instanceof URL ? new URL(value) : new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (url.username || url.password) {
    throw new Error(`OAuth endpoint must not contain credentials: ${url.origin}`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isExplicitlyAllowedLoopback(url))) {
    throw new Error(`OAuth endpoint must use HTTPS: ${url.toString()}`);
  }
  if (ipaddr.isValid(hostname) && !isPublicAddress(hostname) && !isExplicitlyAllowedLoopback(url)) {
    throw new Error(`OAuth endpoint must use a public address: ${url.hostname}`);
  }
  return url;
}

function composeSignal(signal: AbortSignal | null | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export async function oauthFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let current = assertSafeOAuthUrl(url);
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  const signal = composeSignal(init.signal);

  for (let redirects = 0; ; redirects++) {
    const allowLoopback = isExplicitlyAllowedLoopback(current);
    const response = await globalThis.fetch(current, {
      ...init,
      headers,
      redirect: 'manual',
      signal,
      ...(allowLoopback ? {} : { dispatcher: oauthDispatcher }),
    } as RequestInit);

    if (!isRedirect(response.status)) return response;
    if (method !== 'GET' && method !== 'HEAD') {
      await response.body?.cancel().catch(() => {});
      throw new Error(`OAuth ${method} endpoint redirected; refusing to forward request credentials`);
    }
    if (redirects >= MAX_REDIRECTS) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`OAuth endpoint exceeded ${MAX_REDIRECTS} redirects`);
    }
    const location = response.headers.get('location');
    if (!location) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`OAuth endpoint returned HTTP ${response.status} without Location`);
    }
    const next = assertSafeOAuthUrl(new URL(location, current));
    if (next.origin !== current.origin) {
      headers.delete('authorization');
      headers.delete('cookie');
    }
    await response.body?.cancel().catch(() => {});
    current = next;
  }
}
