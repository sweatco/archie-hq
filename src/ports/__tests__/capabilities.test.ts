import { describe, it, expect } from 'vitest';
import { GITHUB_CAPABILITIES, GITLAB_CAPABILITIES_DEFAULT } from '../capabilities.js';

describe('capability descriptors', () => {
  it('github advertises reviews, security alerts, re-review; no native auto-merge', () => {
    expect(GITHUB_CAPABILITIES.reviewStates).toBe(true);
    expect(GITHUB_CAPABILITIES.securityAlerts).toBe(true);
    expect(GITHUB_CAPABILITIES.reReviewRequest).toBe(true);
    expect(GITHUB_CAPABILITIES.nativeAutoMerge).toBe(false);
  });

  it('gitlab advertises review states (synthesized) + native auto-merge; no security alerts / re-review', () => {
    expect(GITLAB_CAPABILITIES_DEFAULT.reviewStates).toBe(true);
    expect(GITLAB_CAPABILITIES_DEFAULT.securityAlerts).toBe(false);
    expect(GITLAB_CAPABILITIES_DEFAULT.reReviewRequest).toBe(false);
    expect(GITLAB_CAPABILITIES_DEFAULT.nativeAutoMerge).toBe(true);
  });
});
