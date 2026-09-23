import { randomUUID } from 'crypto';
import type { Task } from '../tasks/task.js';
import type { TaskMemoryScope } from '../types/task.js';
import { classifySlackMemoryScope, getUserInfo, isInternalMemoryUser } from '../connectors/slack/client.js';
import { isAuthorizedMemoryScope, scopeForSlackChannel } from '../tasks/memory-scope.js';
import { createKeyedLock } from '../system/keyed-lock.js';
import { logger } from '../system/logger.js';
import { stripLastTouched } from './annotations.js';
import { applyEntityUpdate, listEntities, resolveEntity } from './entities.js';
import { rebuildIndex } from './entity-index.js';
import { enqueueMemoryWrite } from './lifecycle.js';
import { isAllowedEntityType, sanitizeEntityObservation, sanitizeEntitySlug, sanitizeEntitySummary, sanitizeUpdate } from './sanitize.js';
import { isMemoryHumanUserId, isMemoryReady, isMemoryToolsEnabled } from './paths.js';
import { applyUserUpdatesWithIdentity, readUser } from './store.js';
import type { EntityType } from './types.js';

type Result = { status: 'saved' | 'unchanged' | 'pending' | 'rejected' | 'cancelled' | 'expired'; text?: string; entity?: string; message?: string };
type Preference = { content: string; source_message_ts: string };
type Fact = { entity: string; content: string; source_message_ts: string; create?: { type: EntityType; summary: string } };

const approvalLock = createKeyedLock();
const APPROVAL_TTL_MS = 60 * 60 * 1000;

function normalized(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

async function source(task: Task, messageTs: string): Promise<{ authorId: string; displayName: string; scope: TaskMemoryScope } | null> {
  if (!isMemoryReady() || !isMemoryToolsEnabled()) return null;
  const destination = task.metadata.memory_destination;
  const authorId = task.metadata.memory_message_authors?.[messageTs];
  if (!destination || !authorId || !isMemoryHumanUserId(authorId)) return null;
  const displayName = task.metadata.memory_authors?.[authorId];
  if (!displayName) return null;
  const scope = scopeForSlackChannel(await classifySlackMemoryScope(destination.channel_id), destination.channel_id);
  if (!isAuthorizedMemoryScope(destination, scope)) return null;
  if (scope.kind === 'user' && scope.user_id !== authorId) return null;
  if (!isInternalMemoryUser(await getUserInfo(authorId))) return null;
  return { authorId, displayName, scope };
}

async function savePreference(task: Task, preference: Preference, expectedScope: 'public' | 'private', expectedAuthor: string): Promise<Result> {
  return enqueueMemoryWrite(async () => {
    const current = await source(task, preference.source_message_ts);
    if (!current || current.authorId !== expectedAuthor) return { status: 'rejected', message: 'Memory authorization changed.' };
    if (expectedScope === 'public' && current.scope.kind !== 'public') return { status: 'rejected', message: 'This preference now needs private approval.' };
    if (expectedScope === 'private' && current.scope.kind !== 'user' && current.scope.kind !== 'private_channel') return { status: 'rejected', message: 'The private conversation is no longer authorized.' };

    const old = await readUser(current.authorId);
    const alreadyStored = old.split('\n').some((line) =>
      line.startsWith('- ') && normalized(stripLastTouched(line).slice(2)) === normalized(preference.content)
    );
    if (alreadyStored) return { status: 'unchanged', text: preference.content };
    const applied = await applyUserUpdatesWithIdentity(current.authorId, current.displayName, [
      { action: 'add', section: 'Preferences', content: preference.content },
    ]);
    if (applied.appliedUpdates.length === 0) return { status: 'rejected', message: 'The preference was rejected by memory validation.' };
    return { status: 'saved', text: preference.content };
  });
}

export async function rememberPreference(task: Task, input: Preference): Promise<Result> {
  const clean = sanitizeUpdate({ action: 'add', section: 'Preferences', content: input.content });
  if (!clean) return { status: 'rejected', message: 'Use a short, descriptive preference without instructions or secrets.' };
  const preference = { content: clean.content, source_message_ts: input.source_message_ts };
  const origin = await source(task, preference.source_message_ts);
  if (!origin) return { status: 'rejected', message: 'The source author or conversation is not authorized.' };
  if (origin.scope.kind === 'public') return savePreference(task, preference, 'public', origin.authorId);

  return approvalLock(task.taskId, async () => {
    const current = await source(task, preference.source_message_ts);
    if (!current || current.authorId !== origin.authorId || (current.scope.kind !== 'user' && current.scope.kind !== 'private_channel')) {
      return { status: 'rejected', message: 'The private conversation is no longer authorized.' };
    }
    const pending = task.metadata.pending_memory_preference;
    if (pending && Date.parse(pending.requested_at) > Date.now() - APPROVAL_TTL_MS) {
      return { status: 'pending', text: pending.content, message: 'A preference approval is already pending in this task.' };
    }
    const channelId = task.metadata.memory_destination?.channel_id;
    const channelKey = Object.keys(task.metadata.channels).find((key) => {
      const channel = task.metadata.channels[key];
      return channel.type === 'slack' && channel.channel_id === channelId;
    });
    if (!channelId || !channelKey) return { status: 'rejected', message: 'No Slack thread is available for approval.' };

    const id = randomUUID();
    task.metadata.pending_memory_preference = {
      id, author_id: origin.authorId, channel_id: channelId,
      source_message_ts: preference.source_message_ts, content: preference.content,
      requested_at: new Date().toISOString(),
    };
    const blocks = [
      { type: 'section', text: { type: 'plain_text', text: `Save across conversations: ${preference.content}` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'This will become part of your shared workspace profile.' }] },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Save across conversations' }, action_id: 'approve_memory_preference', value: `${task.taskId}|${id}`, style: 'primary' },
        { type: 'button', text: { type: 'plain_text', text: 'Cancel' }, action_id: 'deny_memory_preference', value: `${task.taskId}|${id}` },
      ] },
    ];
    try {
      await task.save(true);
      await task.postInteractiveToUser('Approve sharing this preference across conversations?', blocks, 'memory_preference', channelKey, undefined, id);
    } catch (error) {
      task.metadata.pending_memory_preference = undefined;
      await task.save(true).catch((saveError) => logger.warn('memory', 'Could not clear failed preference approval', saveError));
      throw error;
    }
    return { status: 'pending', text: preference.content, message: 'Waiting for the author to approve the exact preference.' };
  });
}

export async function rememberFact(task: Task, input: Fact): Promise<Result> {
  const clean = sanitizeEntityObservation({ category: 'fact', text: input.content });
  const slug = sanitizeEntitySlug(input.entity);
  if (!clean || !slug) return { status: 'rejected', message: 'Invalid fact or entity.' };
  return enqueueMemoryWrite(async () => {
    const current = await source(task, input.source_message_ts);
    if (!current || current.scope.kind !== 'public') return { status: 'rejected', message: 'Facts can only be saved from authorized public conversations.' };
    const existing = resolveEntity(input.entity, await listEntities());
    if (!existing && (!input.create || !isAllowedEntityType(input.create.type) || !sanitizeEntitySummary(input.create.summary))) {
      return { status: 'rejected', message: 'A new entity requires a valid type and short summary.' };
    }
    if (existing?.observations.some((o) => o.category === 'fact' && normalized(o.text) === normalized(clean.text))) {
      return { status: 'unchanged', entity: existing.entity, text: clean.text };
    }
    const applied = await applyEntityUpdate({
      slug: input.entity,
      ...(!existing && { type: input.create!.type, summary: input.create!.summary }),
      observations: [{ category: 'fact', text: clean.text }],
    }, task.taskId);
    if (!applied) return { status: 'rejected', message: 'The entity update was rejected.' };
    try {
      await rebuildIndex();
    } catch (error) {
      logger.warn('memory', `Fact saved on ${applied.slug}, but its index was not rebuilt`, error);
      return { status: 'saved', entity: applied.slug, text: clean.text, message: 'Fact saved; entity index update failed.' };
    }
    return { status: 'saved', entity: applied.slug, text: clean.text };
  });
}

export async function resolvePreferenceApproval(task: Task, id: string, userId: string, channelId: string, approve: boolean): Promise<Result> {
  return approvalLock(task.taskId, async () => {
    const pending = task.metadata.pending_memory_preference;
    if (!pending || pending.id !== id || pending.channel_id !== channelId) return { status: 'rejected', message: 'This approval is stale.' };
    if (pending.author_id !== userId || !isInternalMemoryUser(await getUserInfo(userId))) {
      return { status: 'rejected', message: 'Only the preference author can approve or cancel it.' };
    }
    const clear = async () => {
      task.metadata.pending_memory_preference = undefined;
      try { await task.save(true); }
      catch (error) {
        task.metadata.pending_memory_preference = pending;
        throw error;
      }
    };
    if (Date.parse(pending.requested_at) <= Date.now() - APPROVAL_TTL_MS) {
      await clear();
      return { status: 'expired', message: 'This approval expired.' };
    }
    if (!approve) {
      await clear();
      return { status: 'cancelled', message: 'Preference cancelled.' };
    }
    const saved = await savePreference(task, { content: pending.content, source_message_ts: pending.source_message_ts }, 'private', pending.author_id);
    if (saved.status === 'saved' || saved.status === 'unchanged') {
      await clear().catch((error) => logger.warn('memory', 'Preference saved but approval state was not persisted', error));
    }
    return saved;
  });
}
