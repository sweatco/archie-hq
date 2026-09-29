import { describe, expect, it } from 'vitest';
import { retentionPrecondition } from './retention.js';

describe('retention scoring precondition', () => {
  const early = { retention: { targetObserved: true, observationCount: 1, canonicalPresent: true } };
  it('requires observed eviction and canonical recovery evidence', () => {
    expect(retentionPrecondition([early, { retention: { targetObserved: false, observationCount: 30, canonicalPresent: true } }]).met).toBe(true);
  });
  it('marks a never-stored or still-present target inapplicable', () => {
    expect(retentionPrecondition([{ retention: { targetObserved: false, observationCount: 30, canonicalPresent: true } }]).met).toBe(false);
    expect(retentionPrecondition([early, { retention: { targetObserved: true, observationCount: 30, canonicalPresent: true } }]).met).toBe(false);
  });
  it('requires the original canonical fact after eviction', () => {
    expect(retentionPrecondition([early, { retention: { targetObserved: false, observationCount: 30, canonicalPresent: false } }]).met).toBe(false);
  });
});
