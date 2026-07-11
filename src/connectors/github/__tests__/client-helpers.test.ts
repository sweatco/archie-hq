/**
 * Unit tests for the GitHubClient permission and reaction helpers.
 *
 * Stubs the installation octokit's `request` (patched onto the client so
 * getOctokit never mints a token) and asserts endpoint paths, params, and the
 * legacy permission passthrough.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../system/logger.js', () => ({
  logger: {
    system: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn(),
  },
}));

import { GitHubClient } from '../client.js';

const request = vi.fn();

function makeClient(): GitHubClient {
  const client = new GitHubClient({ appId: '1', privateKey: 'test-key', installationId: 1 });
  (client as unknown as { octokit: { request: typeof request } }).octokit = { request };
  return client;
}

beforeEach(() => {
  request.mockReset();
});

describe('getCollaboratorPermission', () => {
  it('calls the collaborator-permission endpoint and passes the legacy value through', async () => {
    request.mockResolvedValue({ data: { permission: 'write' } });

    const permission = await makeClient().getCollaboratorPermission('acme/backend', 'dana');

    expect(request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/collaborators/{username}/permission',
      { owner: 'acme', repo: 'backend', username: 'dana' },
    );
    expect(permission).toBe('write');
  });

  it.each(['admin', 'read', 'none'] as const)('passes %s through unchanged', async (value) => {
    request.mockResolvedValue({ data: { permission: value } });
    await expect(makeClient().getCollaboratorPermission('acme/backend', 'dana')).resolves.toBe(value);
  });

  it('propagates API errors to the caller (fail-closed handled upstream)', async () => {
    request.mockRejectedValue(new Error('404'));
    await expect(makeClient().getCollaboratorPermission('acme/backend', 'ghost')).rejects.toThrow('404');
  });
});

describe('addCommentReaction', () => {
  it('posts an eyes reaction to the comment reactions endpoint by default', async () => {
    request.mockResolvedValue({ data: {} });

    await makeClient().addCommentReaction('acme/backend', 12345);

    expect(request).toHaveBeenCalledWith(
      'POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions',
      { owner: 'acme', repo: 'backend', comment_id: 12345, content: 'eyes' },
    );
  });

  it('accepts an explicit content value', async () => {
    request.mockResolvedValue({ data: {} });

    await makeClient().addCommentReaction('acme/backend', 12345, 'rocket');

    expect(request).toHaveBeenCalledWith(
      'POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions',
      expect.objectContaining({ content: 'rocket' }),
    );
  });
});

describe('addIssueReaction', () => {
  it('posts an eyes reaction to the issue reactions endpoint by default', async () => {
    request.mockResolvedValue({ data: {} });

    await makeClient().addIssueReaction('acme/backend', 42);

    expect(request).toHaveBeenCalledWith(
      'POST /repos/{owner}/{repo}/issues/{issue_number}/reactions',
      { owner: 'acme', repo: 'backend', issue_number: 42, content: 'eyes' },
    );
  });
});
