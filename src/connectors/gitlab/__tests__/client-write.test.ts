import { describe, it, expect, vi, afterEach } from 'vitest';
import { GitLabHost } from '../client.js';

const ENV = { ...process.env };
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...ENV };
});

function setEnv() {
  process.env.GITLAB_BASE_URL = 'https://gl.example';
  process.env.GITLAB_TOKEN = 't';
}

describe('GitLabHost.createPullRequest', () => {
  it('POSTs an MR and returns iid + web_url', async () => {
    setEnv();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ iid: 12, web_url: 'https://gl.example/g/p/-/merge_requests/12' }), { status: 201 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const host = new GitLabHost();
    const res = await host.createPullRequest('g/p', 'feat/x', 'main', 'Title', 'Body');
    expect(res).toEqual({ pr_number: 12, pr_url: 'https://gl.example/g/p/-/merge_requests/12' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/projects/g%2Fp/merge_requests');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ source_branch: 'feat/x', target_branch: 'main', title: 'Title', description: 'Body' });
  });
});

describe('GitLabHost.mergePullRequest', () => {
  it('squashes by default and returns success', async () => {
    setEnv();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ state: 'merged' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const host = new GitLabHost();
    const res = await host.mergePullRequest('g/p', 12);
    expect(res.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/merge_requests/12/merge');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toMatchObject({ squash: true });
  });

  it('returns success:false with the error message on failure', async () => {
    setEnv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Method Not Allowed', { status: 405 })));
    const host = new GitLabHost();
    const res = await host.mergePullRequest('g/p', 12);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/405|Method Not Allowed/);
  });
});

describe('GitLabHost.closePullRequest / updatePR / addPRComment', () => {
  it('closePullRequest PUTs state_event=close', async () => {
    setEnv();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await new GitLabHost().closePullRequest('g/p', 12);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/merge_requests/12');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toMatchObject({ state_event: 'close' });
  });

  it('updatePR maps title/body/base to title/description/target_branch', async () => {
    setEnv();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await new GitLabHost().updatePR('g/p', 12, { title: 'T', body: 'B', base: 'develop' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ title: 'T', description: 'B', target_branch: 'develop' });
  });

  it('addPRComment POSTs a note', async () => {
    setEnv();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 1 }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    await new GitLabHost().addPRComment('g/p', 12, 'hello');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/merge_requests/12/notes');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ body: 'hello' });
  });
});

describe('GitLabHost.getPRReviews (review synthesis)', () => {
  it('maps approvals to approved and unresolved reviewer discussions to changes_requested', async () => {
    setEnv();
    const fetchMock = vi.fn()
      // MR (for author)
      .mockResolvedValueOnce(new Response(JSON.stringify({ author: { username: 'author1' } }), { status: 200 }))
      // approvals
      .mockResolvedValueOnce(new Response(JSON.stringify({ approved_by: [{ user: { username: 'rev1' } }] }), { status: 200 }))
      // discussions (paginated; one unresolved reviewer thread, one authored by the MR author, one resolved)
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: 'd1', individual_note: false, notes: [{ author: { username: 'rev2' }, body: 'please fix', resolvable: true, resolved: false, created_at: '2026-01-01T00:00:00Z' }] },
        { id: 'd2', individual_note: false, notes: [{ author: { username: 'author1' }, body: 'self note', resolvable: true, resolved: false, created_at: '2026-01-01T00:01:00Z' }] },
        { id: 'd3', individual_note: false, notes: [{ author: { username: 'rev2' }, body: 'ok now', resolvable: true, resolved: true, created_at: '2026-01-01T00:02:00Z' }] },
      ]), { status: 200, headers: {} }));
    vi.stubGlobal('fetch', fetchMock);

    const reviews = await new GitLabHost().getPRReviews('g/p', 12);
    const approved = reviews.filter((r) => r.state === 'approved');
    const changes = reviews.filter((r) => r.state === 'changes_requested');
    expect(approved.map((r) => r.user)).toEqual(['rev1']);
    // Only rev2's unresolved, non-author, resolvable discussion counts.
    expect(changes).toHaveLength(1);
    expect(changes[0].user).toBe('rev2');
  });
});

describe('GitLabHost.getReviewThreads', () => {
  it('maps resolvable discussions to ReviewThread with comments', async () => {
    setEnv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([
      {
        id: 'disc1', individual_note: false,
        notes: [{
          id: 101, author: { username: 'rev2' }, body: 'line comment', resolvable: true, resolved: false,
          created_at: '2026-01-01T00:00:00Z',
          position: { new_path: 'src/a.ts', new_line: 42 },
        }],
      },
      { id: 'plain', individual_note: true, notes: [{ id: 200, author: { username: 'x' }, body: 'not a thread', resolvable: false, resolved: false, created_at: '2026-01-01T00:00:00Z' }] },
    ]), { status: 200 })));

    const threads = await new GitLabHost().getReviewThreads('g/p', 12);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ threadId: 'disc1', isResolved: false, path: 'src/a.ts', line: 42 });
    expect(threads[0].comments[0]).toMatchObject({ commentId: 101, author: 'rev2', body: 'line comment' });
  });
});

describe('GitLabHost.resolveReviewThread', () => {
  it('PUTs resolved=true on the discussion', async () => {
    setEnv();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await new GitLabHost().resolveReviewThread('g/p', 12, 'disc1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/merge_requests/12/discussions/disc1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ resolved: true });
  });
});

describe('GitLabHost.replyToReviewComment', () => {
  it('finds the discussion holding the note id and POSTs a reply note', async () => {
    setEnv();
    const fetchMock = vi.fn()
      // discussions lookup
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: 'discA', notes: [{ id: 500 }, { id: 501 }] },
        { id: 'discB', notes: [{ id: 999 }] },
      ]), { status: 200 }))
      // reply POST
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 502 }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await new GitLabHost().replyToReviewComment('g/p', 12, 501, 'thanks');
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toContain('/merge_requests/12/discussions/discA/notes');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ body: 'thanks' });
  });

  it('throws a clear error when no discussion holds the note id', async () => {
    setEnv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([{ id: 'discB', notes: [{ id: 999 }] }]), { status: 200 })));
    await expect(new GitLabHost().replyToReviewComment('g/p', 12, 501, 'x')).rejects.toThrow(/discussion/i);
  });
});

describe('GitLabHost.requestReReview', () => {
  it('is a logged no-op (reReviewRequest capability is false)', async () => {
    setEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await new GitLabHost().requestReReview('g/p', 12);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GitLabHost.addReviewComment', () => {
  it('POSTs a positioned discussion using the MR diff_refs', async () => {
    setEnv();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ diff_refs: { base_sha: 'b', head_sha: 'h', start_sha: 's' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1 }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await new GitLabHost().addReviewComment('g/p', 12, 'src/a.ts', 42, 'nit');
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.position).toMatchObject({ position_type: 'text', new_path: 'src/a.ts', new_line: 42, base_sha: 'b', head_sha: 'h', start_sha: 's' });
  });
});

describe('GitLabHost.listCodeScanningAlerts / getCodeScanningAlert (capability-gated stubs)', () => {
  // GitLab's Ultimate-only vulnerability API is not mapped (out of scope for this
  // adapter); securityAlerts stays false in GITLAB_CAPABILITIES_DEFAULT, so these
  // methods must degrade without making any network call.
  it('listCodeScanningAlerts returns [] without calling the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const alerts = await new GitLabHost().listCodeScanningAlerts('g/p', {});
    expect(alerts).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getCodeScanningAlert throws "not supported" without calling the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new GitLabHost().getCodeScanningAlert('g/p', 7)).rejects.toThrow(/not supported/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
