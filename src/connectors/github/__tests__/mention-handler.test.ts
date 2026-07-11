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

import { handleGitHubMentionDirect } from '../events.js';
import { routeGitHubEvent, type GitHubMentionEvent } from '../webhooks.js';
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
  it('creates a seeded task from an authorized comment mention', async () => {
    const mention = await mentionFromPayload('issue_comment', commentMentionPayload());
    await handleGitHubMentionDirect(mention);

    const taskId = createdTaskId();

    // Sync-save assertion: the channel entry (readonly marker) is on disk
    // immediately after the handler returns — no debounce window.
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

    const log = await readFile(getKnowledgeLogPath(taskId), 'utf-8');
    expect(log).toContain('github:acme/backend/issue #55');           // repo + number
    expect(log).toContain('opened "Login button broken"');            // title
    expect(log).toContain('The login button 500s on tap.');           // issue body
    expect(log).toContain(`@${SLUG} please investigate [comment_id=9001]`); // mentioning comment
    expect(log).toContain('@<dana>');                                  // author
    expect(log).toContain('https://github.com/acme/backend/issues/55#issuecomment-9001'); // link back

    expect(sendMessageSpy).toHaveBeenCalledWith(AGENT_PROMPTS.newTask, 'pm-agent');
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
