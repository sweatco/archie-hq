/**
 * Memory Context Builder
 *
 * Assembles memory artifacts into XML-tagged context blocks
 * for injection into agent system prompts.
 */

import { readUser } from './store.js';
import { listEntities, serializeEntity } from './entities.js';
import { readIndexMarkdown, renderIndex, selectEntities, type SelectionResult } from './entity-index.js';
import { readActivity, renderActivityTable } from './activity.js';
import {
  isMemoryEnabled,
  isInjectionEnabled,
  getTouchedByInjectMax,
  getOrgInjectMax,
  getEntityInjectMax,
} from './paths.js';
import { appendTelemetry } from './telemetry.js';
import { logger } from '../system/logger.js';
import type { UserRef, EntityRecord } from './types.js';

/** Spawn-context selectors used to push the relevant entity pages. */
export interface MemorySelectors {
  repo?: string;
  plugin?: string;
  taskTitle?: string;
  /** Identify the spawn for the selection sensor; without `taskId` no record is written. */
  taskId?: string;
  agent?: string;
}

/**
 * Build an XML-tagged memory context string from available memory artifacts.
 *
 * - per-user files → <collaboration_profile user_id="..." display_name="..."> blocks
 * - recent-activity.md → <recent_activity> block
 *
 * `users` is the set of AUTHOR users of the current task (a collaboration profile
 * follows the user — it is injected only where they actively participate); if
 * empty, no per-user blocks are emitted. The legacy string-array shape is also
 * accepted for callers that haven't been migrated yet.
 *
 * Blocks are joined with double newlines. Returns '' when nothing is available.
 */
export async function buildMemoryContext(
  users: UserRef[] | string[],
  selectors: MemorySelectors = {},
): Promise<string> {
  const blocks: string[] = [];

  // Per-user collaboration profiles
  const refs: UserRef[] = users.map((u) =>
    typeof u === 'string' ? { userId: u, displayName: u } : u
  );
  for (const ref of refs) {
    let userContent: string;
    try {
      userContent = await readUser(ref.userId);
    } catch {
      // Invalid ID shape — skip rather than crash the prompt build
      continue;
    }
    if (userContent.trim()) {
      blocks.push(renderCollaborationProfileBlock(ref, userContent));
    }
  }

  // Recent activity contains only public-task output.
  const activityEntries = await readActivity();
  if (activityEntries.length > 0) {
    blocks.push(renderRecentActivityBlock(renderActivityTable(activityEntries)));
  }

  // Entity layer: always inject the thin index when any entity exists, then
  // push the full pages selected for this spawn (repo/plugin + users + title).
  const records = await listEntities();
  let selection: SelectionResult | null = null;
  if (records.length > 0) {
    const indexMd = (await readIndexMarkdown()).trim() || renderIndex(records).trim();
    if (indexMd) {
      blocks.push(renderEntityIndexBlock(indexMd));
    }
    selection = selectEntities(records, { ...selectors, users: refs });
    if (selection.dropped.length > 0) {
      logger.system(`[memory] entity selection dropped ${selection.dropped.length} over inject cap: ${selection.dropped.join(', ')}`);
    }
    for (const rec of selection.selected) {
      blocks.push(renderEntityBlock(rec));
    }
  }

  const context = blocks.join('\n\n');
  await recordSelection(selectors, refs, selection, context);
  return context;
}

/**
 * Selection sensor: append one JSONL record of this spawn's injection decision
 * to memory/tasks/<taskId>/telemetry.jsonl. Fail-safe — never throws, never
 * alters the prompt; skipped without a `taskId` and when injection is off, so
 * the collect-only posture stays write-free.
 */
async function recordSelection(
  selectors: MemorySelectors,
  users: UserRef[],
  selection: SelectionResult | null,
  context: string,
): Promise<void> {
  if (!selectors.taskId || !isInjectionEnabled()) return;
  // Record ASSEMBLY sits inside the fail-safe too: the spec's sensor clause
  // covers "any write or assembly error", so a throwing accessor or field
  // read must degrade to a warning, never abort the spawn.
  try {
    // Selection records are the original sensor shape: `v: 1` and no `kind`
    // field — readers treat kind-less telemetry lines as selection records.
    await appendTelemetry(selectors.taskId, {
      v: 1,
      ts: new Date().toISOString(),
      taskId: selectors.taskId,
      agent: selectors.agent ?? null,
      ctx: {
        repo: selectors.repo ?? null,
        plugin: selectors.plugin ?? null,
        taskTitle: selectors.taskTitle ?? null,
        userIds: users.map((u) => u.userId),
        // Display names feed selection token overlap; recording them makes a
        // harvested golden replay byte-faithfully. Additive — old readers keep
        // using userIds.
        users: users.map((u) => ({ id: u.userId, name: u.displayName })),
      },
      selected: selection?.selectedMeta ?? [],
      dropped: selection?.dropped ?? [],
      zeroSignalExcluded: selection?.zeroSignalExcluded ?? 0,
      candidates: selection?.candidates ?? 0,
      budgets: { org: getOrgInjectMax(), nonOrg: getEntityInjectMax() },
      renderedTokensEst: estimateTokens(context),
    });
  } catch (err: any) {
    logger.warn('memory', `selection record assembly failed (spawn unaffected): ${err?.message ?? err}`);
  }
}

/**
 * Wrap a full entity page in an `<entity ...>` block for prompt injection.
 * Only the newest `touched_by` edges are rendered (they grow one per task);
 * the stored record keeps the full history. Exported so offline tooling
 * (memory:eval's worst-case token bound) measures the production rendering,
 * never a reimplementation.
 */
export function renderEntityBlock(rec: EntityRecord): string {
  const max = getTouchedByInjectMax();
  const touchedBy = rec.relations.filter((r) => r.type === 'touched_by');
  let view = rec;
  if (touchedBy.length > max) {
    const keep = new Set(touchedBy.slice(touchedBy.length - max));
    view = { ...rec, relations: rec.relations.filter((r) => r.type !== 'touched_by' || keep.has(r)) };
  }
  return `<entity slug="${escapeAttr(rec.entity)}" type="${escapeAttr(rec.type)}" scope="${escapeAttr(rec.scope)}">\n${serializeEntity(view).trimEnd()}\n</entity>`;
}

/**
 * Wrap a user profile file in its `<collaboration_profile ...>` block — the exact
 * bytes injection produces. Exported for the same offline-tooling reason as
 * `renderEntityBlock`.
 */
export function renderCollaborationProfileBlock(ref: UserRef, content: string): string {
  const display = ref.displayName !== ref.userId ? ` display_name="${escapeAttr(ref.displayName)}"` : '';
  return `<collaboration_profile user_id="${escapeAttr(ref.userId)}"${display}>\n${content.trimEnd()}\n</collaboration_profile>`;
}

/** Wrap recent-activity content in its `<recent_activity>` block (production bytes). */
export function renderRecentActivityBlock(content: string): string {
  return `<recent_activity>\n${content.trimEnd()}\n</recent_activity>`;
}

/** Wrap the entity-index Markdown in its `<entity_index>` block (production bytes). */
export function renderEntityIndexBlock(indexMd: string): string {
  return `<entity_index>\n${indexMd.trim()}\n</entity_index>`;
}

/**
 * The sensor's token estimator (chars/4). One home, exported so the eval's
 * worst-case bound and functional-tier estimates stay comparable with
 * telemetry by construction.
 */
export function estimateTokens(s: string): number {
  return Math.round(s.length / 4);
}

/**
 * Enrich a system prompt with organizational memory context.
 *
 * Returns the prompt unchanged when:
 * - memory is disabled (`ARCHIE_MEMORY=false`), or
 * - injection is disabled (`ARCHIE_MEMORY_INJECT` ≠ `true`, the default) — the
 *   read path is gated independently of extraction so facts keep accumulating
 *   for evaluation without steering agents; no store reads are performed, or
 * - there is no memory content.
 *
 * Otherwise appends the context under an "Organizational Memory" header.
 */
export async function enrichPromptWithMemory(
  systemPrompt: string,
  users: UserRef[] | string[],
  selectors: MemorySelectors = {},
): Promise<string> {
  if (!isMemoryEnabled()) {
    return systemPrompt;
  }

  // Injection is gated separately from extraction and defaults off. Bail before
  // any store read or entity selection so disabled injection costs nothing.
  if (!isInjectionEnabled()) {
    logger.debug('memory', 'injection disabled (ARCHIE_MEMORY_INJECT≠true) — prompt unchanged; extraction unaffected');
    return systemPrompt;
  }

  const memoryContext = await buildMemoryContext(users, selectors);
  if (!memoryContext) {
    return systemPrompt;
  }

  return `${systemPrompt}\n\n## Organizational Memory\n\nThe following is what you know from previous tasks. Use this to inform your work.\n\n${memoryContext}`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
