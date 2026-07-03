import { describe, it, expect } from 'vitest';
import {
  registerMcpAuthRequest,
  completeMcpAuth,
  pruneExpiredMcpAuthRequests,
  MCP_AUTH_REQUEST_TTL_SECONDS,
} from '../mcp-auth.js';
import type { TaskMetadata } from '../../types/task.js';

function makeMetadata(taskId: string): TaskMetadata {
  return {
    task_id: taskId,
    task_owner: null,
    participants: [],
    channels: {},
    default_channel: null,
    agent_sessions: {},
    repositories: {},
    status: 'in_progress',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

const NOW = 1_800_000_000;

describe('per-user MCP OAuth metadata transitions', () => {
  it('completes an outstanding request: binds the user and consumes the request', () => {
    const metadata = makeMetadata('task-a');
    registerMcpAuthRequest(metadata, 'req-1', {
      server: 'notion', agent_id: 'backend-agent', created_at: NOW, channel_id: 'C1', message_ts: '111.222',
    });

    const result = completeMcpAuth(metadata, 'req-1', 'notion', 'U1');

    expect(result.consumed).toBe(true);
    expect(result.request?.message_ts).toBe('111.222');
    expect(metadata.mcp_auth_bindings).toEqual({ notion: 'U1' });
    expect(metadata.mcp_auth_requests).toEqual({});
  });

  it('is idempotent: a replayed completion neither rebinds nor reports consumed', () => {
    const metadata = makeMetadata('task-a');
    registerMcpAuthRequest(metadata, 'req-1', { server: 'notion', agent_id: 'a', created_at: NOW });

    expect(completeMcpAuth(metadata, 'req-1', 'notion', 'U1').consumed).toBe(true);
    // Duplicate callback (provider retry / tab reload) — possibly a different user.
    const replay = completeMcpAuth(metadata, 'req-1', 'notion', 'U2');

    expect(replay.consumed).toBe(false);
    expect(metadata.mcp_auth_bindings).toEqual({ notion: 'U1' });
  });

  it('rejects completion for an unknown request id or mismatched server', () => {
    const metadata = makeMetadata('task-a');
    registerMcpAuthRequest(metadata, 'req-1', { server: 'notion', agent_id: 'a', created_at: NOW });

    expect(completeMcpAuth(metadata, 'req-other', 'notion', 'U1').consumed).toBe(false);
    expect(completeMcpAuth(metadata, 'req-1', 'linear', 'U1').consumed).toBe(false);
    expect(metadata.mcp_auth_bindings).toBeUndefined();
    expect(metadata.mcp_auth_requests?.['req-1']).toBeDefined();
  });

  it('keeps concurrent tasks independent for the same user and server', () => {
    // Two tasks each have an outstanding wall request for the same user+server;
    // completing one must not touch the other (correlation is per request id,
    // never slack_user_id alone).
    const taskA = makeMetadata('task-a');
    const taskB = makeMetadata('task-b');
    registerMcpAuthRequest(taskA, 'req-a', { server: 'notion', agent_id: 'x', created_at: NOW });
    registerMcpAuthRequest(taskB, 'req-b', { server: 'notion', agent_id: 'y', created_at: NOW });

    expect(completeMcpAuth(taskA, 'req-a', 'notion', 'U1').consumed).toBe(true);

    expect(taskA.mcp_auth_bindings).toEqual({ notion: 'U1' });
    expect(taskB.mcp_auth_bindings).toBeUndefined();
    expect(taskB.mcp_auth_requests?.['req-b']).toBeDefined();
    // The other task's request completes on its own, with its own user.
    expect(completeMcpAuth(taskB, 'req-b', 'notion', 'U2').consumed).toBe(true);
    expect(taskB.mcp_auth_bindings).toEqual({ notion: 'U2' });
  });

  it('prunes only expired requests', () => {
    const metadata = makeMetadata('task-a');
    registerMcpAuthRequest(metadata, 'req-old', {
      server: 'notion', agent_id: 'a', created_at: NOW - MCP_AUTH_REQUEST_TTL_SECONDS - 1,
    });
    registerMcpAuthRequest(metadata, 'req-live', { server: 'linear', agent_id: 'a', created_at: NOW });

    const removed = pruneExpiredMcpAuthRequests(metadata, NOW);

    expect(removed).toEqual(['req-old']);
    expect(metadata.mcp_auth_requests).toEqual({
      'req-live': { server: 'linear', agent_id: 'a', created_at: NOW },
    });
    // An expired request can no longer complete.
    expect(completeMcpAuth(metadata, 'req-old', 'notion', 'U1').consumed).toBe(false);
  });

  it('a later completion for a different server does not disturb existing bindings', () => {
    const metadata = makeMetadata('task-a');
    registerMcpAuthRequest(metadata, 'req-1', { server: 'notion', agent_id: 'a', created_at: NOW });
    registerMcpAuthRequest(metadata, 'req-2', { server: 'linear', agent_id: 'a', created_at: NOW });

    completeMcpAuth(metadata, 'req-1', 'notion', 'U1');
    completeMcpAuth(metadata, 'req-2', 'linear', 'U2');

    expect(metadata.mcp_auth_bindings).toEqual({ notion: 'U1', linear: 'U2' });
  });
});
