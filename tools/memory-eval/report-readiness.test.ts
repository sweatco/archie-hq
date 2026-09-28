import { describe, expect, it } from 'vitest';
import { syntheticCorpus } from './corpus.js';
import { reportReadiness, reviewInvariantHash } from './report-readiness.js';
import type { CalibrationReadiness } from './calibration.js';

const corpus = syntheticCorpus();
const approved = { ...corpus.cases.find((c) => c.id === 'synthetic-decision-correction-1-future')!, review: 'approved' as const };
const packet = (reviewReady: boolean): CalibrationReadiness => ({ packetHash: 'test', reviewReady,
  reviewed: reviewReady ? 2 : 1, total: 2,
  pending: reviewReady ? [] : [{ sampleId: 'sample-test', reason: 'missing or stale human review' }] });

describe('report readiness', () => {
  it('advances reviewed approved cases without asserting a quality pass', () => {
    expect(reportReadiness('complete', 'complete', [approved], packet(true))).toMatchObject({
      sourceLabelStatus: 'approved', humanCalibrationStatus: 'ready', reviewStatus: 'ready',
      status: 'review_ready', qualityOutcome: 'not_gated',
    });
  });

  it('keeps source labels and answer calibration independent', () => {
    expect(reportReadiness('complete', 'complete', [{ ...approved, review: 'draft' }], packet(true))).toMatchObject({
      sourceLabelStatus: 'pending', humanCalibrationStatus: 'ready', reviewStatus: 'source_labels_pending', status: 'provisional',
    });
    expect(reportReadiness('complete', 'complete', [approved], packet(false))).toMatchObject({
      sourceLabelStatus: 'approved', humanCalibrationStatus: 'pending', reviewStatus: 'calibration_pending', status: 'provisional',
    });
  });

  it('never promotes an incomplete execution or grade from a reviewed answer subset', () => {
    for (const [execution, grading] of [['incomplete', 'complete'], ['complete', 'incomplete']] as const) {
      expect(reportReadiness(execution, grading, [approved], packet(true))).toMatchObject({
        humanCalibrationStatus: 'blocked_by_incomplete_run', reviewStatus: 'incomplete_run', status: 'incomplete',
        qualityOutcome: 'not_gated',
      });
    }
  });

  it('allows review-only edits while rejecting changed case content and source history', () => {
    const history = corpus.histories.find((h) => h.id === approved.historyId)!;
    const histories = new Map([[history.id, history]]);
    const base = reviewInvariantHash([approved], histories);
    expect(reviewInvariantHash([{ ...approved, review: 'draft', reason: 'review pending' }], histories)).toBe(base);
    expect(reviewInvariantHash([{ ...approved, required: ['different'] }], histories)).not.toBe(base);
    expect(reviewInvariantHash([approved], new Map([[history.id, { ...history, events: [] }]]))).not.toBe(base);
  });
});
