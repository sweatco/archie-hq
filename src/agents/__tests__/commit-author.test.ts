import { describe, it, expect } from 'vitest';
import { buildCommitAuthorEnv } from '../commit-author.js';
import type { AgentDef } from '../../types/agent.js';
import type { TaskMetadata } from '../../types/task.js';

// isRepoAgent only inspects `def.repo`, so minimal casts are enough here.
const repoDef = {
  repo: { repos: [{ github: 'o/r', baseBranch: 'main' }], primary: 'o/r' },
} as unknown as AgentDef;
const genericDef = {} as unknown as AgentDef;

const meta = (edit_approved_by?: TaskMetadata['edit_approved_by']) =>
  ({ edit_approved_by }) as Pick<TaskMetadata, 'edit_approved_by'>;

describe('buildCommitAuthorEnv', () => {
  it('authors as the approver with their email when present', () => {
    expect(
      buildCommitAuthorEnv(repoDef, meta({ id: 'U1', name: 'Egor Tolstoy', email: 'egor@sweatco.in' })),
    ).toEqual({ GIT_AUTHOR_NAME: 'Egor Tolstoy', GIT_AUTHOR_EMAIL: 'egor@sweatco.in' });
  });

  it('falls back to a noreply email keyed by Slack id when email is absent', () => {
    expect(buildCommitAuthorEnv(repoDef, meta({ id: 'U1', name: 'Egor' }))).toEqual({
      GIT_AUTHOR_NAME: 'Egor',
      GIT_AUTHOR_EMAIL: 'U1@users.noreply.archie.invalid',
    });
  });

  it('uses the noreply fallback for a whitespace-only email', () => {
    expect(
      buildCommitAuthorEnv(repoDef, meta({ id: 'U1', name: 'Egor', email: '   ' })),
    ).toEqual({ GIT_AUTHOR_NAME: 'Egor', GIT_AUTHOR_EMAIL: 'U1@users.noreply.archie.invalid' });
  });

  it('trims surrounding whitespace from the name', () => {
    expect(buildCommitAuthorEnv(repoDef, meta({ id: 'U1', name: '  Egor  ' }))).toMatchObject({
      GIT_AUTHOR_NAME: 'Egor',
    });
  });

  it('injects nothing when the name is blank (an empty author would fatal git commit)', () => {
    expect(buildCommitAuthorEnv(repoDef, meta({ id: 'U1', name: '   ' }))).toEqual({});
  });

  it('injects nothing when no approver was recorded', () => {
    expect(buildCommitAuthorEnv(repoDef, meta(undefined))).toEqual({});
  });

  it('injects nothing for a non-repo agent even if an approver is recorded', () => {
    expect(
      buildCommitAuthorEnv(genericDef, meta({ id: 'U1', name: 'Egor', email: 'egor@sweatco.in' })),
    ).toEqual({});
  });
});
