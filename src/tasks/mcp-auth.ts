/**
 * Pure state transitions for per-user MCP OAuth on task metadata.
 *
 * Free of I/O so the ordering rules — idempotent completion, correlation by
 * auth_request_id (never slack_user_id alone), expiry pruning — are directly
 * unit-testable. Task methods wrap these with persistence, Slack side-effects,
 * and the wake.
 */

import type { McpAuthRequest, TaskMetadata } from '../types/task.js';

/** Outstanding wall requests expire on the same TTL as pending OAuth attempts. */
export const MCP_AUTH_REQUEST_TTL_SECONDS = 60 * 60;

/** Record a new outstanding wall request. */
export function registerMcpAuthRequest(
  metadata: TaskMetadata,
  authRequestId: string,
  request: McpAuthRequest,
): void {
  metadata.mcp_auth_requests = { ...(metadata.mcp_auth_requests ?? {}), [authRequestId]: request };
}

export interface McpAuthCompletion {
  consumed: boolean;
  /** The consumed request (wall message ref etc.) when consumed=true. */
  request?: McpAuthRequest;
}

/**
 * Consume an outstanding request and record the acting-user binding.
 * Idempotent: a request that is missing (already consumed, expired, or never
 * existed) or that names a different server leaves metadata untouched and
 * reports consumed=false — a replayed callback must not rebind or rewake.
 */
export function completeMcpAuth(
  metadata: TaskMetadata,
  authRequestId: string,
  serverName: string,
  slackUserId: string,
): McpAuthCompletion {
  const request = metadata.mcp_auth_requests?.[authRequestId];
  if (!request || request.server !== serverName) return { consumed: false };

  const requests = { ...metadata.mcp_auth_requests };
  delete requests[authRequestId];
  metadata.mcp_auth_requests = requests;
  metadata.mcp_auth_bindings = { ...(metadata.mcp_auth_bindings ?? {}), [serverName]: slackUserId };
  return { consumed: true, request };
}

/** Drop outstanding requests older than the TTL. Returns the removed ids. */
export function pruneExpiredMcpAuthRequests(
  metadata: TaskMetadata,
  nowSec: number,
  ttlSeconds: number = MCP_AUTH_REQUEST_TTL_SECONDS,
): string[] {
  const requests = metadata.mcp_auth_requests;
  if (!requests) return [];
  const removed = Object.entries(requests)
    .filter(([, req]) => nowSec - req.created_at > ttlSeconds)
    .map(([id]) => id);
  if (removed.length > 0) {
    const next = { ...requests };
    for (const id of removed) delete next[id];
    metadata.mcp_auth_requests = next;
  }
  return removed;
}
