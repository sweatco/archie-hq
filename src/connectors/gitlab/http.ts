/**
 * The single seam through which every GitLab REST v4 call flows, so the vendor
 * surface stays confined to src/connectors/gitlab/. Auth is a group/project
 * access token sent as PRIVATE-TOKEN (spec D1). Base URL comes from GITLAB_BASE_URL.
 */

import { logger } from '../../system/logger.js';

export interface GlRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path under /api/v4, e.g. `/projects/${encodeURIComponent(repo)}/merge_requests/${iid}`. */
  path: string;
  /** Query params; undefined values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body for POST/PUT. */
  body?: unknown;
  /** When true, return the raw text body (used for job trace). Default: parse JSON. */
  raw?: boolean;
}

function baseUrl(): string {
  const url = process.env.GITLAB_BASE_URL;
  if (!url) throw new Error('GITLAB_BASE_URL is not set');
  return url.replace(/\/+$/, '');
}

function token(): string {
  const t = process.env.GITLAB_TOKEN;
  if (!t) throw new Error('GITLAB_TOKEN is not set');
  return t;
}

/** Perform a GitLab REST call. Throws on non-2xx with a compact message. */
export async function glRequest<T = unknown>(opts: GlRequestOptions): Promise<T> {
  const url = new URL(`${baseUrl()}/api/v4${opts.path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = { 'PRIVATE-TOKEN': token() };
  let bodyInit: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyInit = JSON.stringify(opts.body);
  }

  const res = await fetch(url, { method: opts.method ?? 'GET', headers, body: bodyInit });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.warn('gitlab', `${opts.method ?? 'GET'} ${opts.path} → ${res.status}`);
    throw new Error(`GitLab ${opts.method ?? 'GET'} ${opts.path} failed: ${res.status} ${text.slice(0, 300)}`);
  }

  if (opts.raw) return (await res.text()) as unknown as T;
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

/** Read a paginated GitLab collection, following `x-next-page` up to `maxPages`. */
export async function glRequestAll<T = unknown>(opts: GlRequestOptions, maxPages = 5): Promise<T[]> {
  const out: T[] = [];
  let page = 1;
  for (; page <= maxPages; page++) {
    const url = new URL(`${baseUrl()}/api/v4${opts.path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    const res = await fetch(url, { headers: { 'PRIVATE-TOKEN': token() } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitLab GET ${opts.path} failed: ${res.status} ${text.slice(0, 300)}`);
    }
    out.push(...((await res.json()) as T[]));
    const next = res.headers.get('x-next-page');
    if (!next) break;
  }
  return out;
}
