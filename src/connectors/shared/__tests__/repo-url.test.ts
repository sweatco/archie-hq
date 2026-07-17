import { describe, it, expect, afterEach } from 'vitest';
import { repoEventPrefix, repoCloneUrl, repoBotIdentity } from '../repo-url.js';

const ENV = { ...process.env };
afterEach(() => { process.env = { ...ENV }; });

describe('repoEventPrefix', () => {
  it('defaults to github when REPO_HOST is unset', () => {
    delete process.env.REPO_HOST;
    expect(repoEventPrefix()).toBe('github');
  });
  it('returns github for REPO_HOST=github', () => {
    process.env.REPO_HOST = 'github';
    expect(repoEventPrefix()).toBe('github');
  });
  it('returns gitlab for REPO_HOST=gitlab', () => {
    process.env.REPO_HOST = 'gitlab';
    expect(repoEventPrefix()).toBe('gitlab');
  });
  it('normalizes case/whitespace', () => {
    process.env.REPO_HOST = '  GitLab ';
    expect(repoEventPrefix()).toBe('gitlab');
  });
});

describe('repoCloneUrl', () => {
  it('builds a github.com URL by default', () => {
    delete process.env.REPO_HOST;
    expect(repoCloneUrl('org/backend')).toBe('https://github.com/org/backend.git');
  });
  it('builds a GitLab URL from GITLAB_BASE_URL', () => {
    process.env.REPO_HOST = 'gitlab';
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    expect(repoCloneUrl('grp/proj')).toBe('https://gl.example/grp/proj.git');
  });
  it('strips a trailing slash from GITLAB_BASE_URL', () => {
    process.env.REPO_HOST = 'gitlab';
    process.env.GITLAB_BASE_URL = 'https://gl.example/';
    expect(repoCloneUrl('grp/proj')).toBe('https://gl.example/grp/proj.git');
  });
});

describe('repoBotIdentity', () => {
  it('derives the GitHub App identity by default', () => {
    delete process.env.REPO_HOST;
    process.env.GITHUB_APP_ID = '123';
    process.env.GITHUB_APP_SLUG = 'archie-hq';
    expect(repoBotIdentity()).toEqual({ name: 'archie-hq[bot]', email: '123+archie-hq[bot]@users.noreply.github.com' });
  });
  it('returns null for github when the App env is absent', () => {
    delete process.env.REPO_HOST;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_SLUG;
    expect(repoBotIdentity()).toBeNull();
  });
  it('returns the GitLab bot identity from GITLAB_BOT_NAME/EMAIL', () => {
    process.env.REPO_HOST = 'gitlab';
    process.env.GITLAB_BOT_NAME = 'archie-bot';
    process.env.GITLAB_BOT_EMAIL = 'project_1_bot@noreply.gl.example';
    expect(repoBotIdentity()).toEqual({ name: 'archie-bot', email: 'project_1_bot@noreply.gl.example' });
  });
  it('returns null for gitlab when bot name/email are absent', () => {
    process.env.REPO_HOST = 'gitlab';
    delete process.env.GITLAB_BOT_NAME;
    delete process.env.GITLAB_BOT_EMAIL;
    expect(repoBotIdentity()).toBeNull();
  });
});
