import { describe, it, expect, afterEach, vi } from 'vitest';

// The GitLab connector client lands in a later task and doesn't exist on disk
// yet, so isolate backends.ts's import of it here. NOTE: this specifier must
// stay textually identical to the import in backends.ts (not re-derived from
// this file's own relative path) — since the target module doesn't resolve to
// a real file, Vitest's mock matching falls back to raw specifier text rather
// than a canonicalized path.
vi.mock('../connectors/gitlab/client.js', () => ({
  GitLabHost: class {},
}));

import { resolveRepoHostKind, assertBackendConfig, getBackendMatrix } from '../backends.js';

const ORIG = { ...process.env };
afterEach(() => { process.env = { ...ORIG }; vi.restoreAllMocks(); });

describe('backends resolver — gitlab', () => {
  it('resolves REPO_HOST=gitlab', () => {
    process.env.REPO_HOST = 'gitlab';
    expect(resolveRepoHostKind()).toBe('gitlab');
  });

  it('accepts gitlab when all env is present', () => {
    process.env.REPO_HOST = 'gitlab';
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    process.env.GITLAB_WEBHOOK_SECRET = 's';
    expect(() => assertBackendConfig()).not.toThrow();
  });

  it('rejects gitlab with a missing env var, naming it', () => {
    process.env.REPO_HOST = 'gitlab';
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    delete process.env.GITLAB_TOKEN;
    process.env.GITLAB_WEBHOOK_SECRET = 's';
    expect(() => assertBackendConfig()).toThrow(/GITLAB_TOKEN/);
  });

  it('reports the resolved matrix for gitlab', () => {
    process.env.REPO_HOST = 'gitlab';
    expect(getBackendMatrix()).toEqual({ repoHost: 'gitlab' });
  });
});
