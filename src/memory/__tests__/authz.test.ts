import { describe, it, expect } from 'vitest';
import {
  parseSummaryAccess,
  authorizeEpisodicRead,
  classifyTaskChannels,
  type MemoryToolsCtx,
} from '../authz.js';

// Mirrors the exact frontmatter shape buildSummaryMarkdown emits (see
// lifecycle.test.ts, which asserts the writer side of this contract).
const ORG_SUMMARY = `---
task_id: task-org
status: completed
created_at: 2026-07-01T00:00:00.000Z
updated_at: 2026-07-02T00:00:00.000Z
domain: engineering
extraction_at: 2026-07-02T01:00:00.000Z
access: org
links:
  slack:
    - channel_id: C0PUBLIC
      thread_id: "1751.001"
      visibility: public
  github:
  cli:
users:
  - id: U07AAA111
    display_name: "Igor"
---

# Summary

Did the thing.
`;

// First-iteration artifact: access: dm summaries exist in dev stores only.
// The revised policy denies them exactly like legacy unstamped summaries.
const V1_DM_SUMMARY = `---
task_id: task-dm
status: completed
created_at: 2026-07-01T00:00:00.000Z
updated_at: 2026-07-02T00:00:00.000Z
domain: engineering
extraction_at: 2026-07-02T01:00:00.000Z
access: dm
links:
  slack:
    - channel_id: D0BOBDM
      thread_id: "1751.002"
      visibility: dm
  github:
  cli:
    - session_id: task-dm
users:
  - id: U07BOB222
    display_name: "Bob"
---

# Summary

Private DM work.
`;

const LEGACY_SUMMARY = `---
task_id: task-legacy
status: completed
created_at: 2026-06-01T00:00:00.000Z
updated_at: 2026-06-02T00:00:00.000Z
domain: engineering
extraction_at: 2026-06-02T01:00:00.000Z
links:
  slack:
    - channel_id: C0OLD
      thread_id: "1750.001"
  github:
  cli:
users:
  - id: U07OLD333
    display_name: "Old"
---

# Summary

Pre-policy summary without an access stamp.
`;

describe('parseSummaryAccess', () => {
  it('parses the org stamp from summary frontmatter', () => {
    expect(parseSummaryAccess(ORG_SUMMARY)).toEqual({ access: 'org' });
  });

  it('a v1 access: dm stamp parses to null (denied like legacy)', () => {
    expect(parseSummaryAccess(V1_DM_SUMMARY)).toEqual({ access: null });
  });

  it('legacy summaries without an access stamp parse as access null', () => {
    expect(parseSummaryAccess(LEGACY_SUMMARY)).toEqual({ access: null });
  });

  it('never throws on garbage or missing frontmatter', () => {
    expect(parseSummaryAccess('')).toEqual({ access: null });
    expect(parseSummaryAccess('# Just markdown')).toEqual({ access: null });
    expect(parseSummaryAccess('---\naccess: org')).toEqual({ access: null }); // unterminated
    // access mentioned only in the body is not a stamp
    expect(parseSummaryAccess('---\ntask_id: x\n---\naccess: org').access).toBeNull();
    // unknown values are not a grant
    expect(parseSummaryAccess('---\naccess: everyone\n---\n').access).toBeNull();
  });
});

describe('authorizeEpisodicRead', () => {
  const caller: MemoryToolsCtx = {
    taskId: 'task-caller',
    agent: 'pm-agent',
    authorUserIds: ['U07AAA111'],
  };

  it('always allows self, even with no summary on disk', () => {
    expect(authorizeEpisodicRead(caller, 'task-caller', null)).toEqual({ allowed: true });
  });

  it('denies EVERYTHING for locked callers — self included (lockdown precedes the self rule)', () => {
    const extCaller: MemoryToolsCtx = { ...caller, extShared: true };
    expect(authorizeEpisodicRead(extCaller, 'task-org', parseSummaryAccess(ORG_SUMMARY))).toEqual({
      allowed: false,
      reason: 'ext-shared',
    });
    expect(authorizeEpisodicRead(extCaller, 'task-caller', null)).toEqual({
      allowed: false,
      reason: 'ext-shared',
    });
  });

  it('denies targets with no summary or no access stamp (fail-closed)', () => {
    expect(authorizeEpisodicRead(caller, 'task-x', null)).toEqual({
      allowed: false,
      reason: 'no-access-stamp',
    });
    expect(authorizeEpisodicRead(caller, 'task-legacy', parseSummaryAccess(LEGACY_SUMMARY))).toEqual({
      allowed: false,
      reason: 'no-access-stamp',
    });
  });

  it('allows org-stamped targets for any caller', () => {
    const stranger: MemoryToolsCtx = { taskId: 'task-z', authorUserIds: [] };
    expect(authorizeEpisodicRead(stranger, 'task-org', parseSummaryAccess(ORG_SUMMARY))).toEqual({
      allowed: true,
    });
  });

  it('denies v1 dm-stamped targets even with full overlap (no dm class in the read rule)', () => {
    // The caller authors alongside Bob — the v1 rule would have granted this.
    const bobPresent: MemoryToolsCtx = {
      taskId: 'task-z',
      authorUserIds: ['U07BOB222'],
    };
    expect(authorizeEpisodicRead(bobPresent, 'task-dm', parseSummaryAccess(V1_DM_SUMMARY))).toEqual({
      allowed: false,
      reason: 'no-access-stamp',
    });
  });

  it('empty caller ctx gets self-only access; org stays org-readable', () => {
    const empty: MemoryToolsCtx = {};
    expect(authorizeEpisodicRead(empty, 'task-dm', parseSummaryAccess(V1_DM_SUMMARY))).toEqual({
      allowed: false,
      reason: 'no-access-stamp',
    });
    expect(authorizeEpisodicRead(empty, 'task-org', parseSummaryAccess(ORG_SUMMARY))).toEqual({
      allowed: true,
    });
  });
});

describe('classifyTaskChannels', () => {
  it('all-public slack + github + cli classify full/org', () => {
    expect(
      classifyTaskChannels({
        'slack:C1:1': { type: 'slack', visibility: 'public' },
        'github:r:1': { type: 'github' },
        'cli:local': { type: 'cli' },
      }),
    ).toEqual({ mode: 'full', access: 'org' });
  });

  it('any dm channel — mixed public+dm included — makes the task prefs-only', () => {
    expect(
      classifyTaskChannels({
        'slack:C1:1': { type: 'slack', visibility: 'public' },
        'slack:D1:2': { type: 'slack', visibility: 'dm' },
      }),
    ).toEqual({ mode: 'prefs-only' });
    expect(classifyTaskChannels({ 'slack:D1:1': { type: 'slack', visibility: 'dm' } })).toEqual({
      mode: 'prefs-only',
    });
  });

  it('any private channel skips the task', () => {
    expect(
      classifyTaskChannels({
        'slack:C1:1': { type: 'slack', visibility: 'public' },
        'slack:G1:2': { type: 'slack', visibility: 'private' },
      }),
    ).toEqual({ mode: 'skip', reason: 'private' });
  });

  it('ext-shared skips the task and beats every other class', () => {
    expect(
      classifyTaskChannels({ 'slack:C1:1': { type: 'slack', visibility: 'ext-shared' } }),
    ).toEqual({ mode: 'skip', reason: 'ext-shared' });
    expect(
      classifyTaskChannels({
        'slack:C1:1': { type: 'slack', visibility: 'unknown' },
        'slack:C2:2': { type: 'slack', visibility: 'ext-shared' },
        'slack:D1:3': { type: 'slack', visibility: 'dm' },
      }),
    ).toEqual({ mode: 'skip', reason: 'ext-shared' });
  });

  it('unknown (classification failure) skips with its own reason and beats private/dm', () => {
    expect(
      classifyTaskChannels({
        'slack:C1:1': { type: 'slack', visibility: 'unknown' },
        'slack:G1:2': { type: 'slack', visibility: 'private' },
        'slack:D1:3': { type: 'slack', visibility: 'dm' },
      }),
    ).toEqual({ mode: 'skip', reason: 'unknown' });
  });

  it('unstamped slack channels skip as private (fail-closed)', () => {
    expect(classifyTaskChannels({ 'slack:C1:1': { type: 'slack' } })).toEqual({
      mode: 'skip',
      reason: 'private',
    });
  });

  it('out-of-vocabulary visibility values skip as private (whitelist, never fail open)', () => {
    expect(
      classifyTaskChannels({
        'slack:C1:1': { type: 'slack', visibility: 'shared' as never },
      }),
    ).toEqual({ mode: 'skip', reason: 'private' });
  });

  it('zero channels classify full/org (no human conversation ingested)', () => {
    expect(classifyTaskChannels({})).toEqual({ mode: 'full', access: 'org' });
  });
});
