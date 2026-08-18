import { describe, it, expect } from 'vitest';
import {
  mapDetailedMergeStatus,
  mapPipelineStatusToConclusion,
  mapMrState,
  parseGitLabCheckRef,
} from '../status-map.js';

describe('mapDetailedMergeStatus', () => {
  it('mergeable → clean', () => {
    expect(mapDetailedMergeStatus('mergeable')).toBe('clean');
  });
  it('conflict/broken_status → dirty', () => {
    expect(mapDetailedMergeStatus('conflict')).toBe('dirty');
    expect(mapDetailedMergeStatus('broken_status')).toBe('dirty');
  });
  it('ci_still_running/preparing/checking/unchecked → unstable', () => {
    for (const s of ['ci_still_running', 'preparing', 'checking', 'unchecked']) {
      expect(mapDetailedMergeStatus(s)).toBe('unstable');
    }
  });
  it('approval/discussion/draft/blocked/rebase gates → blocked', () => {
    for (const s of ['not_approved', 'discussions_not_resolved', 'draft_status', 'blocked_status', 'not_open', 'need_rebase']) {
      expect(mapDetailedMergeStatus(s)).toBe('blocked');
    }
  });
  it('unknown value → unknown', () => {
    expect(mapDetailedMergeStatus('something_new')).toBe('unknown');
    expect(mapDetailedMergeStatus('')).toBe('unknown');
  });
});

describe('mapPipelineStatusToConclusion', () => {
  it('maps terminal statuses', () => {
    expect(mapPipelineStatusToConclusion('success')).toBe('success');
    expect(mapPipelineStatusToConclusion('failed')).toBe('failure');
    expect(mapPipelineStatusToConclusion('canceled')).toBe('cancelled');
    expect(mapPipelineStatusToConclusion('skipped')).toBe('skipped');
  });
  it('maps in-progress/created to null (no conclusion yet)', () => {
    for (const s of ['running', 'pending', 'created', 'manual', 'scheduled', 'waiting_for_resource', 'preparing']) {
      expect(mapPipelineStatusToConclusion(s)).toBeNull();
    }
  });
});

describe('mapMrState', () => {
  it('opened → open, merged → merged, closed/locked → closed', () => {
    expect(mapMrState('opened')).toBe('open');
    expect(mapMrState('merged')).toBe('merged');
    expect(mapMrState('closed')).toBe('closed');
    expect(mapMrState('locked')).toBe('closed');
  });
  it('merged flag overrides state', () => {
    expect(mapMrState('opened', true)).toBe('merged');
  });
});

describe('parseGitLabCheckRef', () => {
  it('parses a job URL', () => {
    expect(parseGitLabCheckRef('https://gl.example/group/proj/-/jobs/12345')).toEqual({ kind: 'job', id: 12345 });
  });
  it('parses a pipeline URL', () => {
    expect(parseGitLabCheckRef('https://gl.example/group/proj/-/pipelines/999')).toEqual({ kind: 'pipeline', id: 999 });
  });
  it('parses a bare numeric id as a job', () => {
    expect(parseGitLabCheckRef('4242')).toEqual({ kind: 'job', id: 4242 });
  });
  it('returns null for an unparseable ref', () => {
    expect(parseGitLabCheckRef('not-a-ref')).toBeNull();
  });
});
