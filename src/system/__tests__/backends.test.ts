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
afterEach(() => {
  process.env = { ...ORIG };
  vi.restoreAllMocks();
});

describe('backends config resolver', () => {
  it('defaults repo host to github when REPO_HOST is unset', () => {
    delete process.env.REPO_HOST;
    expect(resolveRepoHostKind()).toBe('github');
  });

  it('honors REPO_HOST=github explicitly', () => {
    process.env.REPO_HOST = 'github';
    expect(resolveRepoHostKind()).toBe('github');
  });

  it('rejects an unknown REPO_HOST value', () => {
    process.env.REPO_HOST = 'bitbucket';
    expect(() => assertBackendConfig()).toThrow(/REPO_HOST/);
  });

  it('rejects REPO_HOST=gitlab when GITLAB_* is unconfigured', () => {
    process.env.REPO_HOST = 'gitlab';
    delete process.env.GITLAB_BASE_URL;
    delete process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_WEBHOOK_SECRET;
    expect(() => assertBackendConfig()).toThrow(/GITLAB_BASE_URL/i);
  });

  it('accepts REPO_HOST=gitlab when GITLAB_* is configured', () => {
    process.env.REPO_HOST = 'gitlab';
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    process.env.GITLAB_WEBHOOK_SECRET = 's';
    expect(() => assertBackendConfig()).not.toThrow();
    expect(resolveRepoHostKind()).toBe('gitlab');
  });

  it('backend matrix reports repoHost and no runtime field', () => {
    delete process.env.REPO_HOST;
    expect(getBackendMatrix()).toEqual({ repoHost: expect.any(String) });
  });
});
