/**
 * Memory Lifecycle Integration Test
 *
 * End-to-end test for the full extraction pipeline with a mocked extraction API.
 * Verifies that handleTaskCompleted() correctly writes all memory artifacts
 * to the new memory-dir paths and does NOT post to Slack (post was removed).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ============================================================================
// Temp directory state (set before mocks resolve)
// ============================================================================

let tempDir: string;
let memoryDir: string;
let usersDir: string;
let activityPath: string;
let summariesDir: string;
let sessionsDir: string;

// ============================================================================
// Mock paths.js — all path functions point into the temp directory
// ============================================================================

vi.mock('../paths.js', () => ({
  isMemoryEnabled: () => true,
  isHousekeepingEnabled: () => true,
  getMemoryDir: () => memoryDir,
  getUsersDir: () => usersDir,
  getUserPath: (id: string) => {
    const safe = id.includes(':') ? id.replace(':', '__') : id;
    return join(usersDir, `${safe}.md`);
  },
  getRecentActivityPath: () => activityPath,
  getSummaryPath: (taskId: string) => {
    if (!/^[A-Za-z0-9._\-]+$/.test(taskId) || /^\.+$/.test(taskId)) {
      throw new Error(`getTaskDir: invalid taskId ${JSON.stringify(taskId)}`);
    }
    return join(memoryDir, 'tasks', taskId, 'summary.md');
  },
  getPendingPath: () => join(memoryDir, 'pending-extractions.md'),
  getTaskTelemetryPath: (taskId: string) => join(memoryDir, 'tasks', taskId, 'telemetry.jsonl'),
  isAllowedUserId: (id: string) =>
    /^(U|W|B|T)[A-Z0-9]{6,}$/.test(id) || /^(cli|local):[A-Za-z0-9_\-]+$/.test(id),
  isSlackUserId: (id: string) => /^(U|W|B|T)[A-Z0-9]{6,}$/.test(id),
  isFallbackUserId: (id: string) => /^(cli|local):[A-Za-z0-9_\-]+$/.test(id),
  isAllowedTaskId: (id: string) => /^[A-Za-z0-9._\-]+$/.test(id),
  getUserCap: () => 100,
  getSectionCap: () => 30,
  getStalenessDays: () => 180,
  getEntitiesDir: () => join(memoryDir, 'entities'),
  getEntityIndexPath: () => join(memoryDir, 'entities', 'index.md'),
  getEntityPath: (slug: string) => join(memoryDir, 'entities', `${slug}.md`),
  getEntityCap: () => 300,
  getEntityInjectMax: () => 8,
  getOrgInjectMax: () => 8,
  getEntityObsCap: () => 30,
  isValidEntitySlug: (s: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(s) && s !== 'index',
}));

// ============================================================================
// Mock tasks/persistence.js — load files from temp dir
// ============================================================================

vi.mock('../../tasks/persistence.js', () => ({
  loadMetadata: async (taskId: string) => {
    const metaPath = join(sessionsDir, taskId, 'shared', 'metadata.json');
    if (!existsSync(metaPath)) return null;
    const content = await readFile(metaPath, 'utf-8');
    return JSON.parse(content);
  },
  readKnowledgeLog: async (taskId: string) => {
    const logPath = join(sessionsDir, taskId, 'shared', 'knowledge.log');
    if (!existsSync(logPath)) return '';
    return readFile(logPath, 'utf-8');
  },
}));

// ============================================================================
// Mock slack/client.js — must remain a stub even though no test asserts on it,
// because lifecycle.ts no longer imports it (test only verifies non-call).
// ============================================================================

vi.mock('../../connectors/slack/client.js', () => ({
  postSlackMessage: vi.fn().mockResolvedValue(undefined),
}));

// ============================================================================
// Mock logger.js — silent stub
// ============================================================================

vi.mock('../../system/logger.js', () => ({
  logger: {
    system: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    slack: vi.fn(),
    agent: vi.fn(),
    debug: vi.fn(),
  },
}));

// ============================================================================
// Mock extractor.js — keep real functions, stub runExtraction
// ============================================================================

vi.mock('../extractor.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../extractor.js')>();
  return {
    ...real,
    runExtraction: vi.fn(),
  };
});

// ============================================================================
// Import the module under test and mocked modules (after mocks are set up)
// ============================================================================

import { handleTaskCompleted, rescheduleTaskCompleted, extractUsernames, extractAuthorUsers, selectRelatedTasksByEntity, migrateLegacySummaries } from '../lifecycle.js';
import { enqueuePending, readPending } from '../pending-queue.js';
import { runExtraction } from '../extractor.js';
import { postSlackMessage } from '../../connectors/slack/client.js';

// ============================================================================
// Test data
// ============================================================================

const TASK_ID = 'task-20260410-1000-abc123';
const USER_DANA = 'U07DANA001';
const USER_ALICE = 'U07ALIC002';
const USER_BOB = 'U07BOB0003';

const METADATA = {
  task_id: TASK_ID,
  task_owner: 'backend-agent',
  participants: ['pm-agent', 'backend-agent'],
  channels: {
    'slack:C1:1234': {
      type: 'slack',
      thread_id: '1234',
      channel_id: 'C1',
      channel_name: 'general',
      last_processed_ts: '1234.5678',
      visibility: 'public',
    },
  },
  default_channel: 'slack:C1:1234',
  agent_sessions: {},
  repositories: {},
  status: 'completed',
  created_at: '2026-04-10T10:00:00Z',
  updated_at: '2026-04-10T10:30:00Z',
};

const KNOWLEDGE_LOG = [
  `[2026-04-10T10:00:00Z] [@<${USER_DANA}:Dana Lee> in slack:#<C1:general>:1234 | msg:1234.001] Fix the login bug`,
  '[2026-04-10T10:01:00Z] [pm-agent] [decision] Assigned backend-agent',
  '[2026-04-10T10:05:00Z] [backend-agent] [discovery] Missing validation in auth handler',
].join('\n');

/** Clone METADATA with different channels (deep enough for the tests). */
function metadataWithChannels(channels: Record<string, unknown>) {
  return { ...METADATA, channels };
}

// Helper: wait for the in-process sequential extraction queue to drain.
const drain = () => new Promise((resolve) => setTimeout(resolve, 200));

// ============================================================================
// Test suite
// ============================================================================

describe('handleTaskCompleted() — end-to-end integration', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'archie-lifecycle-test-'));
    memoryDir = join(tempDir, 'memory');
    usersDir = join(memoryDir, 'users');
    activityPath = join(memoryDir, 'recent-activity.md');
    summariesDir = join(memoryDir, 'summaries');
    sessionsDir = join(tempDir, 'sessions');

    await mkdir(join(sessionsDir, TASK_ID, 'shared'), { recursive: true });
    await mkdir(usersDir, { recursive: true });
    await mkdir(memoryDir, { recursive: true });

    await writeFile(
      join(sessionsDir, TASK_ID, 'shared', 'metadata.json'),
      JSON.stringify(METADATA, null, 2),
      'utf-8'
    );
    await writeFile(
      join(sessionsDir, TASK_ID, 'shared', 'knowledge.log'),
      KNOWLEDGE_LOG,
      'utf-8'
    );

    vi.mocked(postSlackMessage).mockClear();
    vi.mocked(runExtraction).mockClear();
    vi.mocked(runExtraction).mockResolvedValue({
      user_updates: {
        [USER_DANA]: [
          { action: 'add', section: 'Work Style', content: 'Prefers direct communication', evidence: ['msg:1234.001'] },
        ],
      },
      entity_updates: [
        {
          slug: 'backend',
          type: 'repo',
          scope: 'repo',
          repos: ['backend'],
          summary: 'Backend service',
          observations: [{ category: 'config', text: 'Uses NestJS with PostgreSQL' }],
        },
      ],
      task_summary: 'Investigated and fixed the login bug.',
      activity_summary: 'Fixed login validation bug',
      domain: 'engineering',
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('does not write org.md (org.md retired); org knowledge lands in an entity', async () => {
    handleTaskCompleted(TASK_ID);
    await drain();

    expect(existsSync(join(memoryDir, 'org.md'))).toBe(false);
    const entityPath = join(memoryDir, 'entities', 'backend.md');
    expect(existsSync(entityPath)).toBe(true);
    expect(await readFile(entityPath, 'utf-8')).toContain('Uses NestJS with PostgreSQL');
  });

  it('writes users/<U…>.md keyed by raw Slack ID with frontmatter', async () => {
    handleTaskCompleted(TASK_ID);
    await drain();

    const userPath = join(usersDir, `${USER_DANA}.md`);
    expect(existsSync(userPath)).toBe(true);
    const content = await readFile(userPath, 'utf-8');
    expect(content).toContain(`slack_user_id: ${USER_DANA}`);
    expect(content).toContain('display_name: "Dana Lee"');
    expect(content).toContain('Prefers direct communication');
  });

  it('writes summary.md under workdir/memory/tasks/<taskId>/ (not session dir)', async () => {
    handleTaskCompleted(TASK_ID);
    await drain();

    const newSummaryPath = join(memoryDir, 'tasks', TASK_ID, 'summary.md');
    const oldSummaryPath = join(sessionsDir, TASK_ID, 'shared', 'summary.md');
    expect(existsSync(newSummaryPath)).toBe(true);
    expect(existsSync(oldSummaryPath)).toBe(false);
    const content = await readFile(newSummaryPath, 'utf-8');
    expect(content).toContain('task_id: ' + TASK_ID);
    expect(content).toContain('domain: engineering');
    expect(content).toContain('Investigated and fixed the login bug.');
  });

  it('migrateLegacySummaries moves memory/summaries/*.md into memory/tasks/<id>/summary.md and removes the legacy dir', async () => {
    await mkdir(summariesDir, { recursive: true });
    await writeFile(join(summariesDir, 'task-20260101-0001-aaaaaa.md'), 'A', 'utf-8');
    await writeFile(join(summariesDir, 'task-20260101-0002-bbbbbb.md'), 'B', 'utf-8');

    await migrateLegacySummaries();

    expect(await readFile(join(memoryDir, 'tasks', 'task-20260101-0001-aaaaaa', 'summary.md'), 'utf-8')).toBe('A');
    expect(await readFile(join(memoryDir, 'tasks', 'task-20260101-0002-bbbbbb', 'summary.md'), 'utf-8')).toBe('B');
    expect(existsSync(summariesDir)).toBe(false);
  });

  it('migrateLegacySummaries no-ops without a legacy dir and leaves non-migratable files behind', async () => {
    await migrateLegacySummaries(); // absent legacy dir → no throw

    await mkdir(summariesDir, { recursive: true });
    await writeFile(join(summariesDir, 'not a task id.md'), 'X', 'utf-8');
    await migrateLegacySummaries();

    expect(existsSync(join(summariesDir, 'not a task id.md'))).toBe(true); // skipped, legacy dir kept
  });

  it('summary contains Memory Updates section with per-file bullets', async () => {
    handleTaskCompleted(TASK_ID);
    await drain();
    const content = await readFile(join(memoryDir, 'tasks', TASK_ID, 'summary.md'), 'utf-8');
    expect(content).toContain('## Memory Updates');
    expect(content).not.toContain('### org.md');
    expect(content).toContain('### entities/backend.md');
    expect(content).toContain('Uses NestJS with PostgreSQL');
    expect(content).toContain(`### users/${USER_DANA}.md`);
    expect(content).toContain('**added** `## Work Style` › Prefers direct communication');
  });

  it('summary marks empty extraction as _no durable learnings_', async () => {
    vi.mocked(runExtraction).mockResolvedValue({
      user_updates: {},
      entity_updates: [],
      task_summary: 'Nothing to learn.',
      activity_summary: 'Routine task',
      domain: 'engineering',
    });
    handleTaskCompleted(TASK_ID);
    await drain();
    const content = await readFile(join(memoryDir, 'tasks', TASK_ID, 'summary.md'), 'utf-8');
    expect(content).toContain('## Memory Updates');
    expect(content).toContain('_no durable learnings_');
  });

  it('summary contains Related Tasks section with placeholder when activity index is empty', async () => {
    handleTaskCompleted(TASK_ID);
    await drain();
    const content = await readFile(join(memoryDir, 'tasks', TASK_ID, 'summary.md'), 'utf-8');
    expect(content).toContain('## Related Tasks');
    expect(content).toContain('_no related tasks found_');
  });

  it('summary includes Slack thread link, per-link visibility, and the access stamp in frontmatter', async () => {
    handleTaskCompleted(TASK_ID);
    await drain();
    const content = await readFile(join(memoryDir, 'tasks', TASK_ID, 'summary.md'), 'utf-8');
    expect(content).toContain('links:');
    expect(content).toContain('channel_id: C1');
    expect(content).toContain('thread_id: "1234"');
    expect(content).toContain('visibility: public');
    expect(content).toMatch(/^access: org$/m);
  });

  it('creates recent-activity.md with the activity summary and access column', async () => {
    handleTaskCompleted(TASK_ID);
    await drain();

    expect(existsSync(activityPath)).toBe(true);
    const content = await readFile(activityPath, 'utf-8');
    expect(content).toContain('Fixed login validation bug');
    expect(content).toContain(USER_DANA); // user column is the raw Slack ID
    expect(content).toMatch(/\|\s*org\s*\|$/m); // access column stamped
  });

  it('does NOT post any "Learned from this task" Slack message (post was removed)', async () => {
    handleTaskCompleted(TASK_ID);
    await drain();

    expect(vi.mocked(postSlackMessage)).not.toHaveBeenCalled();
  });

  it('enqueues then dequeues the pending entry on a successful extraction', async () => {
    handleTaskCompleted(TASK_ID);
    await drain();
    // After a clean run the queue should be empty
    expect(await readPending()).toEqual([]);
  });

  it('replays a pending task left over from a previous run', async () => {
    // Simulate a crash: queue file has the task ID but extraction never ran.
    await enqueuePending(TASK_ID);
    expect(await readPending()).toEqual([TASK_ID]);

    rescheduleTaskCompleted(TASK_ID);
    await drain();

    // Reschedule should have completed extraction and removed the entry
    expect(existsSync(join(usersDir, `${USER_DANA}.md`))).toBe(true);
    expect(await readPending()).toEqual([]);
  });

  it('passes all author-user IDs to the extractor and drops updates for unknown users', async () => {
    // Knowledge log has messages authored by both alice and bob; extractor
    // returns an update for a third (charlie) which must be dropped.
    const log = [
      `[2026-04-10T10:00:00Z] [@<${USER_ALICE}:Alice Smith> in slack:#<C1:general>:1234 | msg:1234.010] Look at this`,
      `[2026-04-10T10:01:00Z] [@<${USER_BOB}:Bob Jones> in slack:#<C1:general>:1234 | msg:1234.011] Joining`,
    ].join('\n');
    await writeFile(join(sessionsDir, TASK_ID, 'shared', 'knowledge.log'), log, 'utf-8');

    vi.mocked(runExtraction).mockResolvedValue({
      user_updates: {
        [USER_ALICE]: [{ action: 'add', section: 'Work Style', content: 'Likes lists', evidence: ['msg:1234.010'] }],
        [USER_BOB]: [{ action: 'add', section: 'Work Style', content: 'Prefers concise', evidence: ['msg:1234.011'] }],
        // The extractor mock returns updates for the allowed set — the *parser*
        // (not mocked here) is what drops unknown users at runtime. This test
        // confirms the lifecycle passes the right allowedUserIds set.
      },
      entity_updates: [],
      task_summary: 'Talked to alice and bob.',
      activity_summary: 'Discussion with alice and bob',
      domain: 'engineering',
    });

    handleTaskCompleted(TASK_ID);
    await drain();

    expect(vi.mocked(runExtraction)).toHaveBeenCalledOnce();
    const allowedSet = vi.mocked(runExtraction).mock.calls[0][1];
    expect(allowedSet).toBeInstanceOf(Set);
    expect(Array.from(allowedSet as Set<string>).sort()).toEqual([USER_ALICE, USER_BOB].sort());

    expect(existsSync(join(usersDir, `${USER_ALICE}.md`))).toBe(true);
    expect(existsSync(join(usersDir, `${USER_BOB}.md`))).toBe(true);
  });

  // ---- Entity layer ----

  it('writes an entity page (with auto touched_by) and rebuilds the index from entity_updates', async () => {
    vi.mocked(runExtraction).mockResolvedValue({
      user_updates: {},
      entity_updates: [
        {
          slug: 'payment-service',
          type: 'service',
          scope: 'repo',
          repos: ['backend'],
          summary: 'NestJS payments API',
          observations: [{ category: 'decision', text: 'chose idempotency keys' }],
          relations: [{ type: 'depends_on', target: 'postgres-prod' }],
        },
      ],
      task_summary: 'Worked on the payment service.',
      activity_summary: 'Payments work',
      domain: 'engineering',
    });

    handleTaskCompleted(TASK_ID);
    await drain();

    const entityPath = join(memoryDir, 'entities', 'payment-service.md');
    expect(existsSync(entityPath)).toBe(true);
    const content = await readFile(entityPath, 'utf-8');
    expect(content).toContain('entity: payment-service');
    expect(content).toContain('- [decision] chose idempotency keys');
    expect(content).toContain('- depends_on [[postgres-prod]]');
    expect(content).toContain(`- touched_by [[${TASK_ID}]]`); // auto-added

    const indexPath = join(memoryDir, 'entities', 'index.md');
    expect(existsSync(indexPath)).toBe(true);
    expect(await readFile(indexPath, 'utf-8')).toContain('[[payment-service]]');
  });

  it('selectRelatedTasksByEntity links tasks that share an entity', async () => {
    const entitiesDir = join(memoryDir, 'entities');
    await mkdir(entitiesDir, { recursive: true });
    await writeFile(
      join(entitiesDir, 'payment-service.md'),
      [
        '---',
        'entity: payment-service',
        'type: service',
        'display_name: "Payment Service"',
        'aliases: []',
        'scope: org',
        'repos: []',
        'domain: engineering',
        'status: active',
        '---',
        '<!-- L0: payments -->',
        '',
        '## Facts',
        '- [fact] x  <!-- touched: 2026-05-01 -->',
        '',
        '## Relations',
        '- touched_by [[task-A]]',
        '- touched_by [[task-B]]',
        '',
      ].join('\n'),
      'utf-8'
    );

    const orgIndex = [
      { date: '2026-05-01', taskId: 'task-A', summary: 'Payments work', domain: 'engineering', user: 'U07DANA001', access: 'org' as const },
    ];
    const related = await selectRelatedTasksByEntity(['payment-service'], 'task-B', orgIndex);
    expect(related.map((r) => r.taskId)).toEqual(['task-A']);

    // A co-touching task NOT in the (authorized) index is dropped entirely —
    // no placeholder row may reference it in an org-readable summary.
    const none = await selectRelatedTasksByEntity(['payment-service'], 'task-B', []);
    expect(none).toEqual([]);
  });

  // ---- Confidentiality gate (extraction) ----

  const writeMetadata = async (channels: Record<string, unknown>) => {
    await writeFile(
      join(sessionsDir, TASK_ID, 'shared', 'metadata.json'),
      JSON.stringify(metadataWithChannels(channels), null, 2),
      'utf-8'
    );
  };

  const expectNoArtifacts = async () => {
    expect(vi.mocked(runExtraction)).not.toHaveBeenCalled();
    expect(existsSync(join(memoryDir, 'tasks', TASK_ID, 'summary.md'))).toBe(false);
    expect(existsSync(join(usersDir, `${USER_DANA}.md`))).toBe(false);
    expect(existsSync(activityPath)).toBe(false);
  };

  it('skips extraction entirely for private-channel tasks and records a skip', async () => {
    await writeMetadata({
      'slack:G9:1': { type: 'slack', thread_id: '1', channel_id: 'G9', channel_name: 'secret', last_processed_ts: '1', visibility: 'private' },
    });

    handleTaskCompleted(TASK_ID);
    await drain();

    await expectNoArtifacts();
    const telemetry = await readFile(join(memoryDir, 'tasks', TASK_ID, 'telemetry.jsonl'), 'utf-8');
    const record = JSON.parse(telemetry.trim());
    expect(record.kind).toBe('extraction-skip');
    expect(record.reason).toBe('private');
    // Pending-queue entry is still drained — the skip is terminal, not a retry.
    expect(await readPending()).toEqual([]);
  });

  it('unstamped slack channels gate as private (fail-closed)', async () => {
    await writeMetadata({
      'slack:C1:1234': { type: 'slack', thread_id: '1234', channel_id: 'C1', channel_name: 'general', last_processed_ts: '1' },
    });

    handleTaskCompleted(TASK_ID);
    await drain();

    await expectNoArtifacts();
    const telemetry = await readFile(join(memoryDir, 'tasks', TASK_ID, 'telemetry.jsonl'), 'utf-8');
    expect(JSON.parse(telemetry.trim()).reason).toBe('private');
  });

  it('skips extraction for ext-shared tasks with its own reason', async () => {
    await writeMetadata({
      'slack:C1:1234': { type: 'slack', thread_id: '1234', channel_id: 'C1', channel_name: 'general', last_processed_ts: '1', visibility: 'public' },
      'slack:C2:9': { type: 'slack', thread_id: '9', channel_id: 'C2', channel_name: 'partner', last_processed_ts: '9', visibility: 'ext-shared' },
    });

    handleTaskCompleted(TASK_ID);
    await drain();

    await expectNoArtifacts();
    const telemetry = await readFile(join(memoryDir, 'tasks', TASK_ID, 'telemetry.jsonl'), 'utf-8');
    expect(JSON.parse(telemetry.trim()).reason).toBe('ext-shared');
  });

  it('DM tasks (mixed public+dm included) run prefs-only: user memory only, no episodic artifacts', async () => {
    await writeMetadata({
      'slack:C1:1234': { type: 'slack', thread_id: '1234', channel_id: 'C1', channel_name: 'general', last_processed_ts: '1', visibility: 'public' },
      'slack:D7:2': { type: 'slack', thread_id: '2', channel_id: 'D7', channel_name: 'DM with Dana', last_processed_ts: '2', visibility: 'dm' },
    });

    handleTaskCompleted(TASK_ID);
    await drain();

    // User preference updates ARE applied (DMs are the richest prefs source)…
    expect(existsSync(join(usersDir, `${USER_DANA}.md`))).toBe(true);
    // …but nothing episodic exists: no summary, no activity row, no entities.
    expect(existsSync(join(memoryDir, 'tasks', TASK_ID, 'summary.md'))).toBe(false);
    expect(existsSync(activityPath)).toBe(false);
    expect(existsSync(join(memoryDir, 'entities', 'backend.md'))).toBe(false);
    const telemetry = await readFile(join(memoryDir, 'tasks', TASK_ID, 'telemetry.jsonl'), 'utf-8');
    expect(JSON.parse(telemetry.trim()).kind).toBe('extraction-prefs-only');
  });

  it('a downgraded re-completion retracts the stale org summary and activity row', async () => {
    // First completion: all-public → full extraction with access: org.
    handleTaskCompleted(TASK_ID);
    await drain();
    expect(existsSync(join(memoryDir, 'tasks', TASK_ID, 'summary.md'))).toBe(true);
    expect(await readFile(activityPath, 'utf-8')).toContain(TASK_ID);

    // Task reopens, a DM attaches, task completes again → prefs-only + retraction.
    await writeMetadata({
      'slack:C1:1234': { type: 'slack', thread_id: '1234', channel_id: 'C1', channel_name: 'general', last_processed_ts: '1', visibility: 'public' },
      'slack:D7:2': { type: 'slack', thread_id: '2', channel_id: 'D7', channel_name: 'DM with Dana', last_processed_ts: '2', visibility: 'dm' },
    });
    handleTaskCompleted(TASK_ID);
    await drain();

    expect(existsSync(join(memoryDir, 'tasks', TASK_ID, 'summary.md'))).toBe(false);
    expect(await readFile(activityPath, 'utf-8')).not.toContain(TASK_ID);
    const records = (await readFile(join(memoryDir, 'tasks', TASK_ID, 'telemetry.jsonl'), 'utf-8'))
      .trim().split('\n').map((l) => JSON.parse(l));
    const prefsOnly = records.filter((r) => r.kind === 'extraction-prefs-only');
    expect(prefsOnly).toHaveLength(1);
    expect(prefsOnly[0].retracted).toBe(true);
  });

  it('a downgraded re-completion retracts even when the extractor fails', async () => {
    // First completion: all-public → full extraction with access: org.
    handleTaskCompleted(TASK_ID);
    await drain();
    expect(existsSync(join(memoryDir, 'tasks', TASK_ID, 'summary.md'))).toBe(true);

    // Task reopens with a DM attached; this time extraction returns null
    // (routine LLM failure). Retraction must not depend on extraction success
    // — the stale org grant would otherwise survive permanently (no retry).
    await writeMetadata({
      'slack:C1:1234': { type: 'slack', thread_id: '1234', channel_id: 'C1', channel_name: 'general', last_processed_ts: '1', visibility: 'public' },
      'slack:D7:2': { type: 'slack', thread_id: '2', channel_id: 'D7', channel_name: 'DM with Dana', last_processed_ts: '2', visibility: 'dm' },
    });
    vi.mocked(runExtraction).mockResolvedValueOnce(null);
    handleTaskCompleted(TASK_ID);
    await drain();

    expect(existsSync(join(memoryDir, 'tasks', TASK_ID, 'summary.md'))).toBe(false);
    expect(await readFile(activityPath, 'utf-8')).not.toContain(TASK_ID);
    const records = (await readFile(join(memoryDir, 'tasks', TASK_ID, 'telemetry.jsonl'), 'utf-8'))
      .trim().split('\n').map((l) => JSON.parse(l));
    const prefsOnly = records.filter((r) => r.kind === 'extraction-prefs-only');
    expect(prefsOnly).toHaveLength(1);
    expect(prefsOnly[0].retracted).toBe(true);
  });

  it('unknown-stamped channels skip extraction with reason unknown', async () => {
    await writeMetadata({
      'slack:C1:1234': { type: 'slack', thread_id: '1234', channel_id: 'C1', channel_name: 'general', last_processed_ts: '1', visibility: 'unknown' },
    });

    handleTaskCompleted(TASK_ID);
    await drain();

    await expectNoArtifacts();
    const telemetry = await readFile(join(memoryDir, 'tasks', TASK_ID, 'telemetry.jsonl'), 'utf-8');
    expect(JSON.parse(telemetry.trim()).reason).toBe('unknown');
  });

  it('drops a user update whose evidence cites another author (second-hand claim) with telemetry', async () => {
    const log = [
      `[2026-04-10T10:00:00Z] [@<${USER_ALICE}:Alice Smith> in slack:#<C1:general>:1234 | msg:1234.020] Bob loves spreadsheets`,
      `[2026-04-10T10:01:00Z] [@<${USER_BOB}:Bob Jones> in slack:#<C1:general>:1234 | msg:1234.021] hi`,
    ].join('\n');
    await writeFile(join(sessionsDir, TASK_ID, 'shared', 'knowledge.log'), log, 'utf-8');

    vi.mocked(runExtraction).mockResolvedValue({
      user_updates: {
        // Bob is in the author set, but the claim derives from ALICE's line.
        [USER_BOB]: [{ action: 'add', section: 'Work Style', content: 'Loves spreadsheets', evidence: ['msg:1234.020'] }],
        // And an update with no citations at all is equally invalid.
        [USER_ALICE]: [{ action: 'add', section: 'Work Style', content: 'Uncited claim' }],
      },
      entity_updates: [],
      task_summary: 'Chat.',
      activity_summary: 'Chat',
      domain: 'engineering',
    });

    handleTaskCompleted(TASK_ID);
    await drain();

    expect(existsSync(join(usersDir, `${USER_BOB}.md`))).toBe(false);
    expect(existsSync(join(usersDir, `${USER_ALICE}.md`))).toBe(false);
    const records = (await readFile(join(memoryDir, 'tasks', TASK_ID, 'telemetry.jsonl'), 'utf-8'))
      .trim().split('\n').map((l) => JSON.parse(l));
    const drops = records.filter((r) => r.kind === 'user-update-dropped');
    expect(drops).toHaveLength(2);
    expect(drops.map((d) => d.targetUser).sort()).toEqual([USER_ALICE, USER_BOB].sort());
  });

  it('mention-only users are NOT writable — allowedUserIds covers authors only', async () => {
    // Alice authors; Bob is only mentioned in the body of her message.
    const log = [
      `[2026-04-10T10:00:00Z] [@<${USER_ALICE}:Alice Smith> in slack:#<C1:general>:1234 | msg:1.1] Ask @<${USER_BOB}:Bob Jones> about the deploy`,
    ].join('\n');
    await writeFile(join(sessionsDir, TASK_ID, 'shared', 'knowledge.log'), log, 'utf-8');

    vi.mocked(runExtraction).mockResolvedValue({
      user_updates: {
        [USER_ALICE]: [{ action: 'add', section: 'Work Style', content: 'Likes lists', evidence: ['msg:1.1'] }],
      },
      entity_updates: [],
      task_summary: 'Deploy discussion.',
      activity_summary: 'Deploy discussion',
      domain: 'engineering',
    });

    handleTaskCompleted(TASK_ID);
    await drain();

    const allowedSet = vi.mocked(runExtraction).mock.calls[0][1] as Set<string>;
    expect(Array.from(allowedSet)).toEqual([USER_ALICE]);
    expect(existsSync(join(usersDir, `${USER_BOB}.md`))).toBe(false);
  });
});

// ============================================================================
// extractUsernames unit tests
// ============================================================================

describe('extractUsernames(transcript)', () => {
  it('returns raw Slack IDs with display names', () => {
    const log = `[@<${USER_DANA}:Dana Lee>] hello\n[@<${USER_ALICE}:Alice Smith>] hi`;
    const refs = extractUsernames(log);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({ userId: USER_DANA, displayName: 'Dana Lee' });
    expect(refs[1]).toEqual({ userId: USER_ALICE, displayName: 'Alice Smith' });
  });

  it('matches the production log format with channel context after the mention', () => {
    // Real-world log lines have additional context between the mention's `>`
    // and the outer bracket's `]`, e.g.:
    //   `[@<U03RQQTE1EF:Riley Quinn> in slack:#<D0AUZLR6ZJQ:DM with Riley Quinn>:179...]`
    const log =
      '[2026-05-28T17:18:38.189Z] [@<U03RQQTE1EF:Riley Quinn> in slack:#<D0AUZLR6ZJQ:DM with Riley Quinn>:1779988687.863119] Hey Archie';
    const refs = extractUsernames(log);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({ userId: 'U03RQQTE1EF', displayName: 'Riley Quinn' });
  });

  it('does not treat channel references (#<…:…>) as user mentions', () => {
    // The `#<D…:…>` channel reference uses the same UID:Name shape but lacks
    // the `@` prefix, so it must not be picked up as a user mention.
    const log = '[@<U07ABC123:Alex> in slack:#<D0AUZLR6ZJQ:DM with Riley>:1779988687] msg';
    const refs = extractUsernames(log);
    expect(refs).toHaveLength(1);
    expect(refs[0].userId).toBe('U07ABC123');
  });

  it('deduplicates by user ID', () => {
    const log = `[@<${USER_DANA}:Dana Lee>] one\n[@<${USER_DANA}:Dana L.>] two`;
    const refs = extractUsernames(log);
    expect(refs).toHaveLength(1);
    expect(refs[0].userId).toBe(USER_DANA);
  });

  it('matches the Slack-native <@UID:Name> bracket order (new producer format)', () => {
    const log = `[<@${USER_DANA}:Dana Lee>] hello\n[<@${USER_ALICE}:Alice Smith> in slack:#<D0X:DM>:1] hi`;
    const refs = extractUsernames(log);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({ userId: USER_DANA, displayName: 'Dana Lee' });
    expect(refs[1]).toEqual({ userId: USER_ALICE, displayName: 'Alice Smith' });
  });

  it('dedupes across both bracket orders (old @< logs + new <@ logs)', () => {
    const log = `[@<${USER_DANA}:Dana Lee>] old-format\n[<@${USER_DANA}:Dana Lee>] new-format`;
    const refs = extractUsernames(log);
    expect(refs).toHaveLength(1);
    expect(refs[0].userId).toBe(USER_DANA);
  });

  it('ignores malformed mentions', () => {
    const log = '[@<u1:Dana>] short ID\n[@<NOTAVALID:Bob>] non-Slack prefix';
    const refs = extractUsernames(log);
    expect(refs).toHaveLength(0);
  });
});

// ============================================================================
// extractAuthorUsers unit tests
// ============================================================================

describe('extractAuthorUsers(transcript)', () => {
  it('returns authors from production-format source lines', () => {
    const log = [
      `[2026-05-28T17:18:38.189Z] [@<${USER_DANA}:Dana Lee> in slack:#<C1:general>:1779988687.863119 | msg:1779988688.000100] Hey Archie`,
      `[2026-05-28T17:19:00.000Z] [@<${USER_ALICE}:Alice Smith> in slack:#<C1:general>:1779988687.863119] Following up`,
    ].join('\n');
    expect(extractAuthorUsers(log)).toEqual([
      { userId: USER_DANA, displayName: 'Dana Lee' },
      { userId: USER_ALICE, displayName: 'Alice Smith' },
    ]);
  });

  it('tolerates older source lines without channel context', () => {
    const log = `[2026-04-10T10:00:00Z] [@<${USER_ALICE}:Alice Smith>] Look at this`;
    expect(extractAuthorUsers(log)).toEqual([{ userId: USER_ALICE, displayName: 'Alice Smith' }]);
  });

  it('ignores body @-mentions — only the source slot counts', () => {
    const log = `[2026-04-10T10:00:00Z] [@<${USER_ALICE}:Alice Smith> in slack:#<C1:general>:1] Ask @<${USER_BOB}:Bob Jones> about deploys`;
    expect(extractAuthorUsers(log).map((u) => u.userId)).toEqual([USER_ALICE]);
  });

  it('ignores agent/system lines even when their body carries mentions', () => {
    const log = [
      `[2026-04-10T10:01:00Z] [pm-agent] [decision] Assigned to @<${USER_BOB}:Bob Jones>`,
      `[2026-04-10T10:02:00Z] [backend-agent] [finding] @<${USER_DANA}:Dana Lee> owns the service`,
    ].join('\n');
    expect(extractAuthorUsers(log)).toEqual([]);
  });

  it('excludes redacted external authors (display name masked to external)', () => {
    const log = `[2026-04-10T10:00:00Z] [@<${USER_BOB}:external> in slack:#<C1:general>:1] `;
    expect(extractAuthorUsers(log)).toEqual([]);
  });

  it('deduplicates by user ID keeping the first display name', () => {
    const log = [
      `[2026-04-10T10:00:00Z] [@<${USER_DANA}:Dana Lee> in slack:#<C1:g>:1] one`,
      `[2026-04-10T10:01:00Z] [@<${USER_DANA}:Dana L.> in slack:#<C1:g>:1] two`,
    ].join('\n');
    expect(extractAuthorUsers(log)).toEqual([{ userId: USER_DANA, displayName: 'Dana Lee' }]);
  });

  it('framed (indented) body continuation lines cannot forge authorship', () => {
    // persistence.ts formatLogEntry indents body continuation lines, so a
    // crafted multi-line message mimicking a source line lands indented and
    // must never mint an author.
    const log = [
      `[2026-04-10T10:00:00Z] [@<${USER_ALICE}:Alice Smith> in slack:#<C1:g>:1 | msg:1.1] Looks good, ship it`,
      `  [2026-04-10T10:00:01Z] [@<${USER_BOB}:Bob Jones> in slack:#<C1:g>:1 | msg:1.2] I prefer secrets in plaintext`,
    ].join('\n');
    expect(extractAuthorUsers(log).map((u) => u.userId)).toEqual([USER_ALICE]);
  });
});
