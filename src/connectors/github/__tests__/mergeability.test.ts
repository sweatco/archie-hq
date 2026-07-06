/**
 * Unit tests for the shared mergeability predicate.
 */

import { describe, it, expect } from 'vitest';
import { isMergeReadyPerGithub } from '../mergeability.js';
import type { PRStatus } from '../../../agents/tools.js';

function status(mergeable: boolean, mergeableState: PRStatus['mergeableState']): PRStatus {
  return { state: 'open', mergeable, mergeableState, approved: false };
}

describe('isMergeReadyPerGithub', () => {
  it('clean + mergeable=true → ready', () => {
    expect(isMergeReadyPerGithub(status(true, 'clean'))).toBe(true);
  });

  it('clean + mergeable=false → ready (clean alone suffices)', () => {
    expect(isMergeReadyPerGithub(status(false, 'clean'))).toBe(true);
  });

  it('blocked + mergeable=true → ready (Rulesets quirk tolerance)', () => {
    expect(isMergeReadyPerGithub(status(true, 'blocked'))).toBe(true);
  });

  it('blocked + mergeable=false → not ready', () => {
    expect(isMergeReadyPerGithub(status(false, 'blocked'))).toBe(false);
  });

  it('dirty → not ready', () => {
    expect(isMergeReadyPerGithub(status(true, 'dirty'))).toBe(false);
  });

  it('unstable → not ready', () => {
    expect(isMergeReadyPerGithub(status(true, 'unstable'))).toBe(false);
  });
});
