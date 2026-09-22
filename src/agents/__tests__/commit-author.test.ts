import { describe, it, expect } from 'vitest';
import { buildCommitAuthorEnv } from '../commit-author.js';
import type { AgentDef } from '../../types/agent.js';
import type { TaskMetadata } from '../../types/task.js';

// The def is no longer inspected — the approval is the whole gate — so a bare
// cast is enough.
const pmDef = { id: 'pm-agent', isPm: true } as unknown as AgentDef;

const meta = (edit_approved_by?: TaskMetadata['edit_approved_by']) =>
  ({ edit_approved_by }) as Pick<TaskMetadata, 'edit_approved_by'>;

describe('buildCommitAuthorEnv', () => {
  it('authors as the approver with their email when present', () => {
    expect(
      buildCommitAuthorEnv(pmDef, meta({ id: 'U1', name: 'Egor Tolstoy', email: 'egor@sweatco.in' })),
    ).toEqual({ GIT_AUTHOR_NAME: 'Egor Tolstoy', GIT_AUTHOR_EMAIL: 'egor@sweatco.in' });
  });

  it('falls back to a noreply email keyed by Slack id when email is absent', () => {
    expect(buildCommitAuthorEnv(pmDef, meta({ id: 'U1', name: 'Egor' }))).toEqual({
      GIT_AUTHOR_NAME: 'Egor',
      GIT_AUTHOR_EMAIL: 'U1@users.noreply.archie.invalid',
    });
  });

  it('uses the noreply fallback for a whitespace-only email', () => {
    expect(
      buildCommitAuthorEnv(pmDef, meta({ id: 'U1', name: 'Egor', email: '   ' })),
    ).toEqual({ GIT_AUTHOR_NAME: 'Egor', GIT_AUTHOR_EMAIL: 'U1@users.noreply.archie.invalid' });
  });

  it('trims surrounding whitespace from the name', () => {
    expect(buildCommitAuthorEnv(pmDef, meta({ id: 'U1', name: '  Egor  ' }))).toMatchObject({
      GIT_AUTHOR_NAME: 'Egor',
    });
  });

  it('injects nothing when the name is blank (an empty author would fatal git commit)', () => {
    expect(buildCommitAuthorEnv(pmDef, meta({ id: 'U1', name: '   ' }))).toEqual({});
  });

  it('injects nothing when no approver was recorded', () => {
    expect(buildCommitAuthorEnv(pmDef, meta(undefined))).toEqual({});
  });

  // The regression this guards: the gate used to be `isRepoAgent(def)`, and the
  // flattening left the PM — which carries no `repo` — as the only agent there
  // is, so the predicate went permanently false and every commit after an
  // approval was authored by the bot instead of the approver.
  it('authors as the approver for the PM, the only agent that commits now', () => {
    expect(
      buildCommitAuthorEnv(pmDef, meta({ id: 'U1', name: 'Egor', email: 'egor@sweatco.in' })),
    ).toEqual({ GIT_AUTHOR_NAME: 'Egor', GIT_AUTHOR_EMAIL: 'egor@sweatco.in' });
  });
});
