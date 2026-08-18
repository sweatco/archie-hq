import { describe, it, expect, vi, afterEach } from 'vitest';
import { GitLabHost } from '../client.js';

const ENV_SNAPSHOT = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...ENV_SNAPSHOT };
});

describe('GitLabHost skeleton', () => {
  it('reports kind gitlab and least-capable defaults', () => {
    const host = new GitLabHost();
    expect(host.kind).toBe('gitlab');
    expect(host.capabilities().securityAlerts).toBe(false);
  });

  it('builds a clone URL from GITLAB_BASE_URL', () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    const host = new GitLabHost();
    expect(host.cloneUrl('group/proj')).toBe('https://gl.example/group/proj.git');
  });
});

function mockFetchOnce(json: unknown, status = 200, headers: Record<string, string> = {}) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(json), { status, headers }));
}

describe('GitLabHost.getPRStatus', () => {
  it('maps MR + approvals into canonical PRStatus', async () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    const fetchMock = vi.fn()
      // MR
      .mockResolvedValueOnce(new Response(JSON.stringify({
        iid: 7, state: 'opened', merged: false, detailed_merge_status: 'mergeable',
      }), { status: 200 }))
      // approvals
      .mockResolvedValueOnce(new Response(JSON.stringify({ approved: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const host = new GitLabHost();
    const status = await host.getPRStatus('group/proj', 7);
    expect(status).toEqual({ state: 'open', mergeable: true, mergeableState: 'clean', approved: true });
  });

  it('marks non-clean detailed_merge_status as not mergeable', async () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        iid: 7, state: 'opened', merged: false, detailed_merge_status: 'conflict',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ approved: false }), { status: 200 })));
    const host = new GitLabHost();
    const status = await host.getPRStatus('group/proj', 7);
    expect(status.mergeableState).toBe('dirty');
    expect(status.mergeable).toBe(false);
  });
});

describe('GitLabHost.getPRComments', () => {
  it('maps MR notes into canonical PRComment[]', async () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    vi.stubGlobal('fetch', mockFetchOnce([
      { id: 1, author: { username: 'alice' }, body: 'hi', created_at: '2026-01-01T00:00:00Z', system: false },
      { id: 2, author: { username: 'bot' }, body: 'x', created_at: '2026-01-01T00:01:00Z', system: true },
    ]));
    const host = new GitLabHost();
    const comments = await host.getPRComments('group/proj', 7);
    expect(comments).toHaveLength(1); // system note filtered out
    expect(comments[0]).toMatchObject({ id: 1, author: 'alice', body: 'hi' });
  });
});

describe('GitLabHost.listPRChecks', () => {
  it('maps the latest pipeline jobs into a PRChecksReport', async () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    vi.stubGlobal('fetch', vi.fn()
      // MR (for head sha + pipeline)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sha: 'abc123', head_pipeline: { id: 55 },
      }), { status: 200 }))
      // pipeline jobs
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: 1, name: 'build', status: 'success', stage: 'build', web_url: 'u1', started_at: null, finished_at: null },
        { id: 2, name: 'test', status: 'failed', stage: 'test', web_url: 'u2', started_at: null, finished_at: null },
      ]), { status: 200 })));

    const host = new GitLabHost();
    const report = await host.listPRChecks('group/proj', 7);
    expect(report.headSha).toBe('abc123');
    expect(report.entries).toHaveLength(2);
    expect(report.entries[1]).toMatchObject({ name: 'test', conclusion: 'failure', source: 'check_run' });
  });
});

describe('GitLabHost.getCheckRunById', () => {
  it('fetches a log tail when the job failed', async () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    const fetchMock = vi.fn()
      // job
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 42, name: 'test', stage: 'test', status: 'failed', web_url: 'http://x/-/jobs/42',
        commit: { id: 'sha1' }, started_at: 't1', finished_at: 't2',
      }), { status: 200 }))
      // trace
      .mockResolvedValueOnce(new Response('some log output\nFailures:\n  boom', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const host = new GitLabHost();
    const report = await host.getCheckRunById('group/proj', 42);
    expect(report.conclusion).toBe('failure');
    expect(report.logTail).toContain('Failures:');
    expect(report.logTail).toContain('boom');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not fetch a trace when the job succeeded', async () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      id: 42, name: 'test', stage: 'test', status: 'success', web_url: 'http://x/-/jobs/42',
      commit: { id: 'sha1' }, started_at: 't1', finished_at: 't2',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const host = new GitLabHost();
    const report = await host.getCheckRunById('group/proj', 42);
    expect(report.conclusion).toBe('success');
    expect(report.logTail).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caps a long log tail to the last 3000 chars', async () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    const trace = 'Failures:\n' + 'x'.repeat(4000);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 42, name: 'test', stage: 'test', status: 'failed', web_url: 'http://x/-/jobs/42',
        commit: { id: 'sha1' }, started_at: 't1', finished_at: 't2',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(trace, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const host = new GitLabHost();
    const report = await host.getCheckRunById('group/proj', 42);
    expect(report.logTail).toBeDefined();
    expect(report.logTail!.length).toBe(3000);
    expect(report.logTail).toBe(trace.slice(-3000));
  });
});

describe('GitLabHost.getWorkflowRunById', () => {
  it('maps the pipeline + jobs into a WorkflowRunReport, fetching log tails only for failed jobs', async () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    const fetchMock = vi.fn()
      // pipeline
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 99, status: 'failed', sha: 'shaX', ref: 'main', web_url: 'http://p/-/pipelines/99',
      }), { status: 200 }))
      // pipeline jobs
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: 1, name: 'build', status: 'success', web_url: 'u1' },
        { id: 2, name: 'test', status: 'failed', web_url: 'u2' },
      ]), { status: 200 }))
      // trace for the failed job only
      .mockResolvedValueOnce(new Response('log\nFailures:\n  oops', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const host = new GitLabHost();
    const report = await host.getWorkflowRunById('group/proj', 99);
    expect(report.id).toBe(99);
    expect(report.conclusion).toBe('failure');
    expect(report.jobs).toHaveLength(2);
    expect(report.jobs[0]).toMatchObject({ id: 1, name: 'build', conclusion: 'success', logTail: undefined });
    expect(report.jobs[1]).toMatchObject({ id: 2, name: 'test', conclusion: 'failure' });
    expect(report.jobs[1].logTail).toContain('Failures:');
    expect(report.jobs[1].logTail).toContain('oops');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('GitLabHost.listAccessibleRepos', () => {
  it('maps projects to the canonical repo shape (github = group/project)', async () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    vi.stubGlobal('fetch', mockFetchOnce([
      { path_with_namespace: 'group/backend', default_branch: 'main', description: 'svc' },
      { path_with_namespace: 'group/mobile', default_branch: 'develop', description: null },
    ]));
    const host = new GitLabHost();
    const repos = await host.listAccessibleRepos();
    expect(repos[0]).toEqual({ github: 'group/backend', default_branch: 'main', description: 'svc' });
    expect(repos[1].github).toBe('group/mobile');
  });
});

describe('GitLabHost.resolveRepo', () => {
  it('returns default_branch for a project', async () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    vi.stubGlobal('fetch', mockFetchOnce({ default_branch: 'main' }));
    const host = new GitLabHost();
    expect(await host.resolveRepo('group/backend')).toEqual({ default_branch: 'main' });
  });

  it('returns null when the project 404s', async () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    const host = new GitLabHost();
    expect(await host.resolveRepo('group/missing')).toBeNull();
  });
});
