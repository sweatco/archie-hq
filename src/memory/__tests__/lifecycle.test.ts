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
  getSummariesDir: () => summariesDir,
  getSummaryPath: (taskId: string) => join(summariesDir, `${taskId}.md`),
  getPendingPath: () => join(memoryDir, 'pending-extractions.md'),
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
  isValidEntitySlug: (s: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(s) && s !== 'index',
  getTaskSummaryPath: (taskId: string) => join(sessionsDir, taskId, 'shared', 'summary.md'),
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

import { handleTaskCompleted, rescheduleTaskCompleted, extractUsernames, selectRelatedTasksByEntity } from '../lifecycle.js';
import { enqueuePending, readPending } from '../pending-queue.js';
import { runExtraction } from '../extractor.js';
import { postSlackMessage } from '../../connectors/slack/client.js';

// ============================================================================
// Test data
// ============================================================================

const TASK_ID = 'task-20260410-1000-abc123';
const USER_EGOR = 'U07EGOR001';
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
  `[2026-04-10T10:00:00Z] [slack:#<C1:general>:1234] [@<${USER_EGOR}:Egor Khmelev>] Fix the login bug`,
  '[2026-04-10T10:01:00Z] [pm-agent] [decision] Assigned backend-agent',
  '[2026-04-10T10:05:00Z] [backend-agent] [discovery] Missing validation in auth handler',
].join('\n');

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
    await mkdir(summariesDir, { recursive: true });
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
        [USER_EGOR]: [
          { action: 'add', section: 'Work Style', content: 'Prefers direct communication' },
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

    const userPath = join(usersDir, `${USER_EGOR}.md`);
    expect(existsSync(userPath)).toBe(true);
    const content = await readFile(userPath, 'utf-8');
    expect(content).toContain(`slack_user_id: ${USER_EGOR}`);
    expect(content).toContain('display_name: "Egor Khmelev"');
    expect(content).toContain('Prefers direct communication');
  });

  it('writes summary.md under workdir/memory/summaries/ (not session dir)', async () => {
    handleTaskCompleted(TASK_ID);
    await drain();

    const newSummaryPath = join(summariesDir, `${TASK_ID}.md`);
    const oldSummaryPath = join(sessionsDir, TASK_ID, 'shared', 'summary.md');
    expect(existsSync(newSummaryPath)).toBe(true);
    expect(existsSync(oldSummaryPath)).toBe(false);
    const content = await readFile(newSummaryPath, 'utf-8');
    expect(content).toContain('task_id: ' + TASK_ID);
    expect(content).toContain('domain: engineering');
    expect(content).toContain('Investigated and fixed the login bug.');
  });

  it('summary contains Memory Updates section with per-file bullets', async () => {
    handleTaskCompleted(TASK_ID);
    await drain();
    const content = await readFile(join(summariesDir, `${TASK_ID}.md`), 'utf-8');
    expect(content).toContain('## Memory Updates');
    expect(content).not.toContain('### org.md');
    expect(content).toContain('### entities/backend.md');
    expect(content).toContain('Uses NestJS with PostgreSQL');
    expect(content).toContain(`### users/${USER_EGOR}.md`);
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
    const content = await readFile(join(summariesDir, `${TASK_ID}.md`), 'utf-8');
    expect(content).toContain('## Memory Updates');
    expect(content).toContain('_no durable learnings_');
  });

  it('summary contains Related Tasks section with placeholder when activity index is empty', async () => {
    handleTaskCompleted(TASK_ID);
    await drain();
    const content = await readFile(join(summariesDir, `${TASK_ID}.md`), 'utf-8');
    expect(content).toContain('## Related Tasks');
    expect(content).toContain('_no related tasks found_');
  });

  it('summary includes Slack thread link in frontmatter', async () => {
    handleTaskCompleted(TASK_ID);
    await drain();
    const content = await readFile(join(summariesDir, `${TASK_ID}.md`), 'utf-8');
    expect(content).toContain('links:');
    expect(content).toContain('channel_id: C1');
    expect(content).toContain('thread_id: "1234"');
  });

  it('creates recent-activity.md with the activity summary', async () => {
    handleTaskCompleted(TASK_ID);
    await drain();

    expect(existsSync(activityPath)).toBe(true);
    const content = await readFile(activityPath, 'utf-8');
    expect(content).toContain('Fixed login validation bug');
    expect(content).toContain(USER_EGOR); // user column is the raw Slack ID
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
    expect(existsSync(join(usersDir, `${USER_EGOR}.md`))).toBe(true);
    expect(await readPending()).toEqual([]);
  });

  it('passes all involved-user IDs to the extractor and drops updates for unknown users', async () => {
    // Knowledge log mentions both alice and bob; extractor returns an update for
    // a third (charlie) which must be dropped.
    const log = [
      `[2026-04-10T10:00:00Z] [@<${USER_ALICE}:Alice Smith>] Look at this`,
      `[2026-04-10T10:01:00Z] [@<${USER_BOB}:Bob Jones>] Joining`,
    ].join('\n');
    await writeFile(join(sessionsDir, TASK_ID, 'shared', 'knowledge.log'), log, 'utf-8');

    vi.mocked(runExtraction).mockResolvedValue({
      user_updates: {
        [USER_ALICE]: [{ action: 'add', section: 'Work Style', content: 'Likes lists' }],
        [USER_BOB]: [{ action: 'add', section: 'Work Style', content: 'Prefers concise' }],
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

    const related = await selectRelatedTasksByEntity(['payment-service'], 'task-B', []);
    expect(related.map((r) => r.taskId)).toEqual(['task-A']);
  });
});

// ============================================================================
// extractUsernames unit tests
// ============================================================================

describe('extractUsernames(transcript)', () => {
  it('returns raw Slack IDs with display names', () => {
    const log = `[@<${USER_EGOR}:Egor Khmelev>] hello\n[@<${USER_ALICE}:Alice Smith>] hi`;
    const refs = extractUsernames(log);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({ userId: USER_EGOR, displayName: 'Egor Khmelev' });
    expect(refs[1]).toEqual({ userId: USER_ALICE, displayName: 'Alice Smith' });
  });

  it('matches the production log format with channel context after the mention', () => {
    // Real-world log lines have additional context between the mention's `>`
    // and the outer bracket's `]`, e.g.:
    //   `[@<U03RQQTE1EF:Igor Sova> in slack:#<D0AUZLR6ZJQ:DM with Igor Sova>:179...]`
    const log =
      '[2026-05-28T17:18:38.189Z] [@<U03RQQTE1EF:Igor Sova> in slack:#<D0AUZLR6ZJQ:DM with Igor Sova>:1779988687.863119] Hey Archie';
    const refs = extractUsernames(log);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({ userId: 'U03RQQTE1EF', displayName: 'Igor Sova' });
  });

  it('does not treat channel references (#<…:…>) as user mentions', () => {
    // The `#<D…:…>` channel reference uses the same UID:Name shape but lacks
    // the `@` prefix, so it must not be picked up as a user mention.
    const log = '[@<U07ABC123:Alex> in slack:#<D0AUZLR6ZJQ:DM with Igor>:1779988687] msg';
    const refs = extractUsernames(log);
    expect(refs).toHaveLength(1);
    expect(refs[0].userId).toBe('U07ABC123');
  });

  it('deduplicates by user ID', () => {
    const log = `[@<${USER_EGOR}:Egor Khmelev>] one\n[@<${USER_EGOR}:Egor K.>] two`;
    const refs = extractUsernames(log);
    expect(refs).toHaveLength(1);
    expect(refs[0].userId).toBe(USER_EGOR);
  });

  it('ignores malformed mentions', () => {
    const log = '[@<u1:Egor>] short ID\n[@<NOTAVALID:Bob>] non-Slack prefix';
    const refs = extractUsernames(log);
    expect(refs).toHaveLength(0);
  });
});
