/**
 * Handler-level tests for handleGitHubMentionDirect (AC2-AC5, AC9) and the
 * GitHub-born follow-up path (AC7, AC11 companion pins).
 *
 * Real payload fixtures drive the real router to produce mentions; the GitHub
 * client and registry are mocked; SESSIONS_DIR points at a temp dir so
 * Task.create and knowledge-log writes are real files. Task.prototype.sendMessage
 * is stubbed so no agent ever spawns.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { readFile, rm } from 'fs/promises';
import { join } from 'node:path';

const WORKDIR_ROOT = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'archie-mention-handler-test-'));
  process.env.ARCHIE_WORKDIR = dir;
  return dir;
});

vi.mock('../client.js', () => ({
  getGitHubClient: vi.fn(),
}));

vi.mock('../merge.js', () => ({
  checkAndMergeLinkedPRs: vi.fn(),
}));

vi.mock('../../../system/plugin-sync.js', () => ({
  syncPlugins: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../agents/registry.js', () => ({
  scanAgentDefs: vi.fn().mockReturnValue([]),
  getAgentDef: vi.fn().mockReturnValue(undefined),
  getVisiblePeerIdsForSender: vi.fn().mockReturnValue([]),
  synthesizeDynamicAgentDef: vi.fn(),
  findAgentDefsContainingRepo: vi.fn(),
}));

vi.mock('../../../system/event-bus.js', () => ({
  emitEvent: vi.fn(),
  onEvent: vi.fn(),
}));

vi.mock('../../../system/logger.js', () => ({
  logger: {
    system: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn(),
    plain: vi.fn(), slack: vi.fn(), agentAction: vi.fn(), agentFinding: vi.fn(),
    agentToSlack: vi.fn(), agentMessage: vi.fn(),
  },
}));

import { handleGitHubMentionDirect, handleExistingTaskDirect } from '../events.js';
import { routeGitHubEvent, formatGitHubContext, type GitHubMentionEvent } from '../webhooks.js';
import { Task } from '../../../tasks/task.js';
import { loadMetadata, getKnowledgeLogPath } from '../../../tasks/persistence.js';
import { AGENT_PROMPTS } from '../../../agents/prompts.js';
import { getGitHubClient } from '../client.js';
import { findAgentDefsContainingRepo } from '../../../agents/registry.js';
import { emitEvent } from '../../../system/event-bus.js';
import { logger } from '../../../system/logger.js';

const SLUG = 'archie-test';

const mockClient = {
  getCollaboratorPermission: vi.fn(),
  addPRComment: vi.fn(),
  addCommentReaction: vi.fn(),
  addIssueReaction: vi.fn(),
};

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf-8'));
}

/** Run the real router on a fixture payload and unwrap the new_task mention. */
async function mentionFromPayload(eventType: string, payload: Record<string, unknown>): Promise<GitHubMentionEvent> {
  const route = await routeGitHubEvent(eventType, payload);
  if (route.action !== 'direct' || route.handler !== 'new_task') {
    throw new Error(`Fixture did not route to new_task: ${JSON.stringify(route)}`);
  }
  return route.mention;
}

function commentMentionPayload(body = `@${SLUG} please investigate`): Record<string, unknown> {
  const p = loadFixture('issue-comment-created');
  (p.comment as Record<string, unknown>).body = body;
  return p;
}

function issueMentionPayload(): Record<string, unknown> {
  const p = loadFixture('issues-opened');
  (p.issue as Record<string, unknown>).body = `@${SLUG} the app crashes on startup, please investigate`;
  return p;
}

/** Task ID captured from the task:created event emitted by Task.create. */
function createdTaskId(): string {
  const call = vi.mocked(emitEvent).mock.calls.find((c) => c[0] === 'task:created');
  if (!call) throw new Error('No task:created event captured');
  return call[1] as string;
}

let sendMessageSpy: ReturnType<typeof vi.spyOn>;
let createSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.clearAllMocks();
  await rm(join(WORKDIR_ROOT, 'sessions'), { recursive: true, force: true });
  vi.stubEnv('GITHUB_APP_SLUG', SLUG);
  mockClient.getCollaboratorPermission.mockResolvedValue('write');
  mockClient.addPRComment.mockResolvedValue(undefined);
  mockClient.addCommentReaction.mockResolvedValue(undefined);
  mockClient.addIssueReaction.mockResolvedValue(undefined);
  vi.mocked(getGitHubClient).mockReturnValue(mockClient as never);
  vi.mocked(findAgentDefsContainingRepo).mockReturnValue([{ id: 'backend-agent' }] as never);
  sendMessageSpy = vi.spyOn(Task.prototype, 'sendMessage').mockResolvedValue(undefined) as never;
  createSpy = vi.spyOn(Task, 'create') as never;
});

afterEach(() => {
  sendMessageSpy.mockRestore();
  createSpy.mockRestore();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

afterAll(async () => {
  await rm(WORKDIR_ROOT, { recursive: true, force: true });
});

describe('handleGitHubMentionDirect — creation path (AC2, AC4, AC5)', () => {
  // AC2's seed contract is split into per-claim cases below so each clause is
  // visible by name in a black-box audit; they share this end-to-end setup.
  async function runAuthorizedMention(): Promise<string> {
    const mention = await mentionFromPayload('issue_comment', commentMentionPayload());
    await handleGitHubMentionDirect(mention);
    return createdTaskId();
  }

  it('seeds knowledge.log with the repo and issue number via the destination prefix (AC2)', async () => {
    const taskId = await runAuthorizedMention();
    const log = await readFile(getKnowledgeLogPath(taskId), 'utf-8');
    expect(log).toContain('github:acme/backend/issue #55');
  });

  it('seeds knowledge.log with the issue title, body, and thread link (AC2)', async () => {
    const taskId = await runAuthorizedMention();
    const log = await readFile(getKnowledgeLogPath(taskId), 'utf-8');
    expect(log).toContain('opened "Login button broken"');
    expect(log).toContain('The login button 500s on tap.');
    // Newline-terminated: the bare thread link, not a substring of the
    // comment permalink (…/issues/55#issuecomment-9001).
    expect(log).toContain('https://github.com/acme/backend/issues/55\n');
  });

  it('seeds the verbatim mentioning comment with its [comment_id] tag, author, and link back (AC2)', async () => {
    const taskId = await runAuthorizedMention();
    const log = await readFile(getKnowledgeLogPath(taskId), 'utf-8');
    expect(log).toContain(`@${SLUG} please investigate [comment_id=9001]`);
    expect(log).toContain('@<dana>');
    expect(log).toContain('https://github.com/acme/backend/issues/55#issuecomment-9001');
  });

  it('records the GitHub origin as a github channel entry with repo + issue number, on disk immediately (sync-save, AC2)', async () => {
    const taskId = await runAuthorizedMention();

    // Read straight from disk: the channel entry (readonly marker) must be
    // durable the moment the handler returns — no debounce window.
    const onDisk = await loadMetadata(taskId);
    expect(onDisk?.channels['github:acme/backend#55']).toMatchObject({
      type: 'github',
      repo: 'acme/backend',
      issue_number: 55,
      is_pr: false,
      last_processed_comment_id: 9001,
    });
    expect(onDisk?.default_channel).toBe('github:acme/backend#55');
    expect(onDisk?.title).toBe('Login button broken');
  });

  it('pings the PM with the newTask prompt after seeding (AC2)', async () => {
    let logAtPing = '';
    sendMessageSpy.mockImplementation(async function (this: Task) {
      logAtPing = await readFile(getKnowledgeLogPath(this.taskId), 'utf-8');
    } as never);

    await runAuthorizedMention();

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy).toHaveBeenCalledWith(AGENT_PROMPTS.newTask, 'pm-agent');
    expect(logAtPing).toContain('[comment_id=9001]'); // seed already on disk at ping time
  });

  it('acknowledges a comment mention with a comment reaction plus a task-naming comment (AC5)', async () => {
    const mention = await mentionFromPayload('issue_comment', commentMentionPayload());
    await handleGitHubMentionDirect(mention);

    const taskId = createdTaskId();
    expect(mockClient.addCommentReaction).toHaveBeenCalledWith('acme/backend', 9001);
    expect(mockClient.addIssueReaction).not.toHaveBeenCalled();
    expect(mockClient.addPRComment).toHaveBeenCalledTimes(1);
    const [, , ackBody] = mockClient.addPRComment.mock.calls[0]!;
    expect(ackBody).toContain(taskId);
    expect(ackBody).not.toContain(`@${SLUG}`);
  });

  it('creates and acks from an issues.opened mention, with the reaction on the issue (AC4)', async () => {
    const mention = await mentionFromPayload('issues', issueMentionPayload());
    await handleGitHubMentionDirect(mention);

    const taskId = createdTaskId();
    const onDisk = await loadMetadata(taskId);
    expect(onDisk?.channels['github:acme/backend#70']).toMatchObject({
      type: 'github',
      repo: 'acme/backend',
      issue_number: 70,
      is_pr: false,
    });
    expect(onDisk?.title).toBe('Crash on startup');

    const log = await readFile(getKnowledgeLogPath(taskId), 'utf-8');
    expect(log).toContain('github:acme/backend/issue #70');
    expect(log).toContain('opened "Crash on startup"');
    expect(log).toContain(`@${SLUG} the app crashes on startup, please investigate`);
    expect(log).toContain('https://github.com/acme/backend/issues/70');

    expect(mockClient.addIssueReaction).toHaveBeenCalledWith('acme/backend', 70);
    expect(mockClient.addCommentReaction).not.toHaveBeenCalled();
    expect(mockClient.addPRComment).toHaveBeenCalledWith('acme/backend', 70, expect.stringContaining(taskId));
    expect(sendMessageSpy).toHaveBeenCalledWith(AGENT_PROMPTS.newTask, 'pm-agent');
  });

  it('does not abort creation when the ack calls throw — task, seed, and PM ping still land (AC5)', async () => {
    const mention = await mentionFromPayload('issue_comment', commentMentionPayload());
    mockClient.addCommentReaction.mockRejectedValue(new Error('403 reactions disabled'));
    mockClient.addPRComment.mockRejectedValue(new Error('issue locked'));

    await handleGitHubMentionDirect(mention);

    const taskId = createdTaskId();
    const onDisk = await loadMetadata(taskId);
    expect(onDisk?.channels['github:acme/backend#55']).toMatchObject({ type: 'github', issue_number: 55 });
    const log = await readFile(getKnowledgeLogPath(taskId), 'utf-8');
    expect(log).toContain(`@${SLUG} please investigate [comment_id=9001]`);
    expect(sendMessageSpy).toHaveBeenCalledWith(AGENT_PROMPTS.newTask, 'pm-agent');
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'Server', expect.stringContaining('Failed to add ack reaction'), expect.any(Error),
    );
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'Server', expect.stringContaining('Failed to post ack comment'), expect.any(Error),
    );
    expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
  });

  it('delivers to the existing task instead of duplicating when the thread mapped mid-flight', async () => {
    // Route the mention while no task exists (both webhooks race past the
    // mapping), then map the thread before the handler runs — the D6 re-check
    // must fall through to existing-task delivery.
    const mention = await mentionFromPayload('issue_comment', commentMentionPayload('follow-up mention @' + SLUG));

    const existing = await Task.create();
    existing.linkGitHubChannel('acme/backend', 55, false);
    await existing.save(true);
    createSpy.mockClear();

    await handleGitHubMentionDirect(mention);

    expect(createSpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledWith(AGENT_PROMPTS.existingTask, 'pm-agent');
    const log = await readFile(getKnowledgeLogPath(existing.taskId), 'utf-8');
    expect(log).toContain('follow-up mention @' + SLUG);
  });
});

describe('handleGitHubMentionDirect — gates (AC3, AC9)', () => {
  it.each(['read', 'none'] as const)('discards a %s-permission author: no task, no reply, no reaction, reason logged (AC3)', async (perm) => {
    const mention = await mentionFromPayload('issue_comment', commentMentionPayload());
    mockClient.getCollaboratorPermission.mockResolvedValue(perm);

    await handleGitHubMentionDirect(mention);

    expect(createSpy).not.toHaveBeenCalled();
    expect(mockClient.addPRComment).not.toHaveBeenCalled();
    expect(mockClient.addCommentReaction).not.toHaveBeenCalled();
    expect(mockClient.addIssueReaction).not.toHaveBeenCalled();
    expect(vi.mocked(logger.system)).toHaveBeenCalledWith(expect.stringContaining(`permission '${perm}'`));
  });

  it('fails closed when the permission lookup throws', async () => {
    const mention = await mentionFromPayload('issue_comment', commentMentionPayload());
    mockClient.getCollaboratorPermission.mockRejectedValue(new Error('boom'));

    await handleGitHubMentionDirect(mention);

    expect(createSpy).not.toHaveBeenCalled();
    expect(mockClient.addPRComment).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'Server', expect.stringContaining('fail closed'), expect.any(Error),
    );
  });

  it('fails closed when the GitHub client is unconfigured', async () => {
    const mention = await mentionFromPayload('issue_comment', commentMentionPayload());
    vi.mocked(getGitHubClient).mockReturnValue(null as never);

    await handleGitHubMentionDirect(mention);

    expect(createSpy).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'Server', expect.stringContaining('GitHub client not configured'),
    );
  });

  it('declines once for two authorized mentions on an uncovered repo within the window (AC9)', async () => {
    vi.mocked(findAgentDefsContainingRepo).mockReturnValue([] as never);
    const payload = commentMentionPayload();
    (payload.repository as Record<string, unknown>).full_name = 'uncovered/repo';
    const mention = await mentionFromPayload('issue_comment', payload);

    await handleGitHubMentionDirect(mention);
    await handleGitHubMentionDirect(mention);

    expect(createSpy).not.toHaveBeenCalled();
    expect(mockClient.addPRComment).toHaveBeenCalledTimes(1);
    const [repo, num, decline] = mockClient.addPRComment.mock.calls[0]!;
    expect(repo).toBe('uncovered/repo');
    expect(num).toBe(55);
    expect(decline).not.toContain(`@${SLUG}`);
  });

  it('posts a fresh decline after the dedup window elapses (expiry + lazy eviction)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    vi.mocked(findAgentDefsContainingRepo).mockReturnValue([] as never);
    const payload = commentMentionPayload();
    (payload.repository as Record<string, unknown>).full_name = 'uncovered/repo';
    ((payload.issue as Record<string, unknown>)).number = 91;
    const mention = await mentionFromPayload('issue_comment', payload);

    await handleGitHubMentionDirect(mention);
    expect(mockClient.addPRComment).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 10 * 60_000 + 1_000);
    await handleGitHubMentionDirect(mention);
    expect(mockClient.addPRComment).toHaveBeenCalledTimes(2);
  });

  it('stays silent for an unauthorized mention in an uncovered repo (authorization first)', async () => {
    vi.mocked(findAgentDefsContainingRepo).mockReturnValue([] as never);
    mockClient.getCollaboratorPermission.mockResolvedValue('read');
    const payload = commentMentionPayload();
    (payload.repository as Record<string, unknown>).full_name = 'uncovered/repo';
    ((payload.issue as Record<string, unknown>)).number = 92;
    const mention = await mentionFromPayload('issue_comment', payload);

    await handleGitHubMentionDirect(mention);

    expect(mockClient.addPRComment).not.toHaveBeenCalled();
  });

  it('logs and posts no ack when creation throws after the permission gate', async () => {
    const mention = await mentionFromPayload('issue_comment', commentMentionPayload());
    createSpy.mockRejectedValue(new Error('disk full') as never);

    await expect(handleGitHubMentionDirect(mention)).resolves.toBeUndefined();

    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'Server', expect.stringContaining('Failed to create task from GitHub mention'), expect.any(Error),
    );
    expect(mockClient.addPRComment).not.toHaveBeenCalled();
    expect(mockClient.addCommentReaction).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });
});

describe('handleExistingTaskDirect — GitHub-born follow-ups (AC7) and AC11 pins', () => {
  async function makeGitHubBornTask(issueNumber: number, watermark?: number): Promise<Task> {
    const task = await Task.create();
    const key = task.linkGitHubChannel('acme/backend', issueNumber, false);
    if (watermark !== undefined) {
      (task.metadata.channels[key] as { last_processed_comment_id?: number }).last_processed_comment_id = watermark;
    }
    await task.save(true);
    return task;
  }

  function followUpContext(
    issueNumber: number,
    commentId: number,
    user: string,
    body = 'a plain follow-up',
  ): ReturnType<typeof formatGitHubContext> {
    const p = loadFixture('issue-comment-created');
    (p.issue as Record<string, unknown>).number = issueNumber;
    (p.comment as Record<string, unknown>).id = commentId;
    (p.comment as Record<string, unknown>).body = body;
    ((p.comment as Record<string, unknown>).user as Record<string, unknown>).login = user;
    (p.sender as Record<string, unknown>).login = user;
    return formatGitHubContext('issue_comment', p);
  }

  /** The Task instance the handler loaded (fresh from disk each call). */
  async function loadedInstance(getSpy: ReturnType<typeof vi.spyOn>, call = 0): Promise<Task> {
    return (await getSpy.mock.results[call]!.value) as Task;
  }

  it('routes an authorized mention-free follow-up: appends, advances the watermark, pings the PM (AC7)', async () => {
    const task = await makeGitHubBornTask(155);
    const getSpy = vi.spyOn(Task, 'get');

    await handleExistingTaskDirect(task.taskId, followUpContext(155, 9500, 'writer1'));

    expect(mockClient.getCollaboratorPermission).toHaveBeenCalledWith('acme/backend', 'writer1');
    const log = await readFile(getKnowledgeLogPath(task.taskId), 'utf-8');
    expect(log).toContain('a plain follow-up [comment_id=9500]');
    expect(log).toContain('github:acme/backend/issue #155');
    expect(sendMessageSpy).toHaveBeenCalledWith(AGENT_PROMPTS.existingTask, 'pm-agent');

    const inst = await loadedInstance(getSpy);
    expect((inst.metadata.channels['github:acme/backend#155'] as { last_processed_comment_id?: number }).last_processed_comment_id).toBe(9500);
  });

  it('silently drops a read/none follow-up author: no append, no PM wake, watermark unchanged (AC7 gate)', async () => {
    const task = await makeGitHubBornTask(156, 111);
    mockClient.getCollaboratorPermission.mockResolvedValue('read');
    const getSpy = vi.spyOn(Task, 'get');

    await handleExistingTaskDirect(task.taskId, followUpContext(156, 9600, 'reader1'));

    const log = await readFile(getKnowledgeLogPath(task.taskId), 'utf-8');
    expect(log).not.toContain('a plain follow-up');
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(vi.mocked(logger.system)).toHaveBeenCalledWith(expect.stringContaining("permission 'read'"));

    const inst = await loadedInstance(getSpy);
    expect((inst.metadata.channels['github:acme/backend#156'] as { last_processed_comment_id?: number }).last_processed_comment_id).toBe(111);
  });

  it('fails closed on a thrown lookup and does not cache the failure — a retry re-queries', async () => {
    const task = await makeGitHubBornTask(157);
    mockClient.getCollaboratorPermission.mockRejectedValue(new Error('502'));

    await handleExistingTaskDirect(task.taskId, followUpContext(157, 9601, 'flaky1'));
    await handleExistingTaskDirect(task.taskId, followUpContext(157, 9602, 'flaky1'));

    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(mockClient.getCollaboratorPermission).toHaveBeenCalledTimes(2);
    const log = await readFile(getKnowledgeLogPath(task.taskId), 'utf-8');
    expect(log).not.toContain('a plain follow-up');
  });

  it('drops [bot] follow-up authors before any permission lookup', async () => {
    const task = await makeGitHubBornTask(158);

    await handleExistingTaskDirect(task.taskId, followUpContext(158, 9603, 'otherbot[bot]'));

    expect(mockClient.getCollaboratorPermission).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
    const log = await readFile(getKnowledgeLogPath(task.taskId), 'utf-8');
    expect(log).not.toContain('a plain follow-up');
  });

  it('performs exactly one permission lookup for two follow-ups by the same author within the TTL', async () => {
    const task = await makeGitHubBornTask(159);

    await handleExistingTaskDirect(task.taskId, followUpContext(159, 9701, 'cacher1'));
    await handleExistingTaskDirect(task.taskId, followUpContext(159, 9702, 'cacher1'));

    expect(mockClient.getCollaboratorPermission).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy).toHaveBeenCalledTimes(2);
  });

  it('skips a redelivered follow-up comment id via the channel watermark (AC7 dedup)', async () => {
    const task = await makeGitHubBornTask(160, 9800);

    await handleExistingTaskDirect(task.taskId, followUpContext(160, 9800, 'writer2'));

    expect(sendMessageSpy).not.toHaveBeenCalled();
    const log = await readFile(getKnowledgeLogPath(task.taskId), 'utf-8');
    expect(log).not.toContain('a plain follow-up');
    expect(vi.mocked(logger.system)).toHaveBeenCalledWith(
      expect.stringContaining('Skipping already-processed comment 9800'),
    );
  });

  it('dedups a redelivered triggering comment via the creation-time watermark (AC7)', async () => {
    // Full mention path first: creation seeds the comment AND sets the channel
    // watermark to the triggering comment id (9001).
    const mention = await mentionFromPayload('issue_comment', commentMentionPayload());
    await handleGitHubMentionDirect(mention);
    const taskId = createdTaskId();
    sendMessageSpy.mockClear();

    // Webhook redelivery of that same comment now resolves via the mapping and
    // arrives as existing-task delivery — the seed consumed it, so it must skip.
    await handleExistingTaskDirect(taskId, followUpContext(55, 9001, 'dana', `@${SLUG} please investigate`));

    expect(sendMessageSpy).not.toHaveBeenCalled();
    const log = await readFile(getKnowledgeLogPath(taskId), 'utf-8');
    expect(log.split('[comment_id=9001]').length - 1).toBe(1); // the seed entry only — no duplicate append
    expect(vi.mocked(logger.system)).toHaveBeenCalledWith(
      expect.stringContaining('Skipping already-processed comment 9001'),
    );
  });

  it('keeps the Archie-managed PR path ungated with byte-identical advance dedup (AC11)', async () => {
    const task = await Task.create();
    task.metadata.repositories['backend-agent'] = [{
      github: 'acme/backend',
      branch_states: { 'archie/task-x': { pr_number: 88, last_processed_comment_id: 9000 } },
    }];
    await task.save(true);
    const getSpy = vi.spyOn(Task, 'get');

    const p = loadFixture('issue-comment-created-pr');
    (p.sender as Record<string, unknown>).login = 'prcommenter';
    ((p.comment as Record<string, unknown>).user as Record<string, unknown>).login = 'prcommenter';
    await handleExistingTaskDirect(task.taskId, formatGitHubContext('issue_comment', p));

    expect(mockClient.getCollaboratorPermission).not.toHaveBeenCalled();
    const log = await readFile(getKnowledgeLogPath(task.taskId), 'utf-8');
    expect(log).toContain('Ship it once CI is green. [comment_id=9100]');
    expect(sendMessageSpy).toHaveBeenCalledWith(AGENT_PROMPTS.existingTask, 'pm-agent');

    const inst = await loadedInstance(getSpy);
    expect(inst.metadata.repositories['backend-agent']![0]!.branch_states!['archie/task-x']!.last_processed_comment_id).toBe(9100);
  });

  it('keeps the Archie-managed PR skip path byte-identical, still with no permission lookup (AC11)', async () => {
    const task = await Task.create();
    task.metadata.repositories['backend-agent'] = [{
      github: 'acme/backend',
      branch_states: { 'archie/task-x': { pr_number: 88, last_processed_comment_id: 9100 } },
    }];
    await task.save(true);

    const p = loadFixture('issue-comment-created-pr');
    (p.sender as Record<string, unknown>).login = 'prcommenter';
    ((p.comment as Record<string, unknown>).user as Record<string, unknown>).login = 'prcommenter';
    await handleExistingTaskDirect(task.taskId, formatGitHubContext('issue_comment', p));

    expect(mockClient.getCollaboratorPermission).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(vi.mocked(logger.system)).toHaveBeenCalledWith(
      expect.stringContaining('Skipping already-processed comment 9100 on PR #88'),
    );
  });
});
