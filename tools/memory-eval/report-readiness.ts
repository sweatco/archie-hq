import type { CalibrationReadiness } from './calibration.js';
import { digest, type Case, type History } from './schema.js';

type Completion = 'complete' | 'incomplete';

export function reviewInvariantHash(cases: Case[], histories: Map<string, History>): string {
  return digest(JSON.stringify(cases.map(({ review: _review, reason: _reason, ...c }) => {
    const history = histories.get(c.historyId);
    if (!history) throw new Error(`missing history for review hash: ${c.id}`);
    return { case: c, history };
  })));
}

export function reportReadiness(executionStatus: Completion, gradingStatus: Completion,
  cases: Case[], calibration: CalibrationReadiness) {
  const complete = executionStatus === 'complete' && gradingStatus === 'complete';
  const sourceLabelStatus = cases.length > 0 && cases.every((c) => c.review === 'approved') ? 'approved' : 'pending';
  const humanCalibrationStatus = !complete ? 'blocked_by_incomplete_run' : calibration.reviewReady ? 'ready' : 'pending';
  const reviewStatus = !complete ? 'incomplete_run' : sourceLabelStatus === 'approved'
    ? calibration.reviewReady ? 'ready' : 'calibration_pending'
    : calibration.reviewReady ? 'source_labels_pending' : 'source_labels_and_calibration_pending';
  return { sourceLabelStatus, humanCalibrationStatus, reviewStatus,
    status: !complete ? 'incomplete' : reviewStatus === 'ready' ? 'review_ready' : 'provisional',
    qualityOutcome: 'not_gated' as const };
}
