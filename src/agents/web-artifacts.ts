/**
 * Web Artifacts — the pointer layer
 *
 * Layers a stable, unguessable web-artifact identity (`externalId`) over the
 * existing immutable snapshot substrate (`copyArtifactToShared`). A pointer is
 * a small JSON record — resolvable from the `externalId` alone, since the viewer
 * has no taskId — stored file-per-id under `WEB_ARTIFACTS_DIR/<externalId>.json`.
 *
 * This module is pure over already-validated absolute paths: path resolution,
 * sandbox checks, and format-gating happen in the tool layer that calls in. It
 * only mints ids, snapshots content, reads/writes pointer files, and renders
 * sanitized Markdown.
 *
 * This iteration renders only our own sanitized Markdown; `.html` is explicitly
 * rejected and deferred to PR #224.
 */

import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { resolve, sep } from 'path';
import MarkdownIt from 'markdown-it';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import type { WebArtifactFormat } from '../types/task.js';
import { WEB_ARTIFACTS_DIR } from '../system/workdir.js';
import { copyArtifactToShared } from './artifacts.js';
import { logger } from '../system/logger.js';

/**
 * The durable pointer record. Carries the stable `externalId` used in the
 * `/a/<externalId>` viewer URL plus the absolute path to the current immutable
 * snapshot and display/provenance metadata. Crucially, the URL and this record
 * never expose the producing `taskId` — it is stored only to gate updates to the
 * originating task.
 */
export interface WebArtifactPointer {
  externalId: string;
  taskId: string;
  snapshotPath: string;
  sourceFilename: string;
  format: WebArtifactFormat;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Format gating
// =============================================================================

/** Rejection message for `.html`/`.htm` — HTML rendering is deferred to PR #224. */
export const WEB_ARTIFACT_HTML_DEFERRAL_MESSAGE =
  'HTML web artifacts are not supported yet — HTML rendering is deferred to a follow-up (#224). ' +
  'Only Markdown (.md/.markdown) can be published as a web artifact this iteration.';

/** Rejection message for any other non-Markdown extension. */
export const WEB_ARTIFACT_GENERIC_FORMAT_MESSAGE =
  'Only Markdown (.md/.markdown) web artifacts are supported this iteration.';

/**
 * Format-gate a source filename. Returns `null` when the file is a supported
 * Markdown artifact, otherwise the user-facing rejection message to surface
 * (the `.html`/`.htm` deferral message, or the generic one). Case-insensitive
 * on the extension.
 */
export function webArtifactFormatError(sourceFilename: string): string | null {
  const lower = (sourceFilename || '').toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return null;
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    return WEB_ARTIFACT_HTML_DEFERRAL_MESSAGE;
  }
  return WEB_ARTIFACT_GENERIC_FORMAT_MESSAGE;
}

// =============================================================================
// External id parsing / validation
// =============================================================================

/** Standard UUID (as minted by `crypto.randomUUID`). */
const EXTERNAL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extract an `externalId` from either a raw id or a viewer URL/path. Accepts:
 *   - a bare id (`3f2…`)
 *   - a path form (`/a/3f2…`, `/a/3f2…/source`)
 *   - a full URL (`https://host/a/3f2…`)
 * Returns the id only when it matches the UUID shape, otherwise `null`. Building
 * store paths from the validated (regex-shaped) id — never the raw input — is
 * what breaks any path-traversal taint flow, mirroring the trigger-store guard.
 */
export function parseExternalId(idOrUrl: string): string | null {
  if (typeof idOrUrl !== 'string') return null;
  const trimmed = idOrUrl.trim();
  if (!trimmed) return null;
  // Prefer an `/a/<id>` segment anywhere in the string (path or full URL);
  // fall back to treating the whole string as a raw id.
  const m = trimmed.match(/\/a\/([^/?#]+)/);
  const candidate = m ? m[1] : trimmed;
  return EXTERNAL_ID_RE.test(candidate) ? candidate : null;
}

// =============================================================================
// Pointer store (file-per-id, global)
// =============================================================================

/**
 * Absolute path to a pointer file. Throws on any id that would escape
 * `WEB_ARTIFACTS_DIR`. Two guards, matching the trigger-store pattern: the
 * UUID-shape check, and requiring the resolved path to sit directly inside the
 * base directory.
 */
function getPointerPath(externalId: string): string {
  if (!EXTERNAL_ID_RE.test(externalId)) {
    throw new Error(`Invalid web-artifact external id: ${JSON.stringify(externalId)}`);
  }
  const base = resolve(WEB_ARTIFACTS_DIR);
  const full = resolve(base, `${externalId}.json`);
  if (!full.startsWith(base + sep)) {
    throw new Error(`Invalid web-artifact external id: ${JSON.stringify(externalId)}`);
  }
  return full;
}

/** Lazily ensure the pointer store directory exists. */
async function ensureStoreDir(): Promise<void> {
  if (!existsSync(WEB_ARTIFACTS_DIR)) {
    await mkdir(WEB_ARTIFACTS_DIR, { recursive: true });
  }
}

/** Persist a pointer (create or overwrite). */
async function savePointer(pointer: WebArtifactPointer): Promise<void> {
  await ensureStoreDir();
  await writeFile(getPointerPath(pointer.externalId), JSON.stringify(pointer, null, 2));
}

/**
 * Resolve a pointer by `externalId`. Returns `null` when the id is malformed,
 * the pointer file is absent (deleted / stale link), or it fails to parse.
 */
export async function resolveWebArtifact(externalId: string): Promise<WebArtifactPointer | null> {
  if (!EXTERNAL_ID_RE.test(externalId)) return null;
  const path = getPointerPath(externalId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as WebArtifactPointer;
  } catch (err) {
    logger.warn('web-artifacts', `Failed to parse pointer ${externalId}: ${err}`);
    return null;
  }
}

// =============================================================================
// Publish / update
// =============================================================================

/**
 * Publish a new web artifact: snapshot the already-validated source into the
 * task's immutable shared substrate, mint an unguessable `externalId`, and write
 * the pointer. Returns the new id and the snapshot path.
 */
export async function publishWebArtifact(args: {
  taskId: string;
  resolvedSourcePath: string;
  sourceFilename: string;
}): Promise<{ externalId: string; snapshotPath: string }> {
  const { taskId, resolvedSourcePath, sourceFilename } = args;
  const { artifactPath } = await copyArtifactToShared(taskId, resolvedSourcePath);
  const externalId = randomUUID();
  const now = new Date().toISOString();
  const pointer: WebArtifactPointer = {
    externalId,
    taskId,
    snapshotPath: artifactPath,
    sourceFilename,
    format: 'markdown',
    createdAt: now,
    updatedAt: now,
  };
  await savePointer(pointer);
  logger.debug('web-artifacts', `Published web artifact ${externalId} for task ${taskId}`);
  return { externalId, snapshotPath: artifactPath };
}

/**
 * Advance an existing web artifact in place, keeping its `externalId`. An
 * artifact is advanced only from within its producing task: the caller's
 * `taskId` must match `pointer.taskId`, otherwise this throws a clear error.
 * Snapshots the new (already-validated) content and bumps `snapshotPath` +
 * `updatedAt`. Returns the updated pointer.
 */
export async function updateWebArtifact(args: {
  externalId: string;
  taskId: string;
  resolvedSourcePath: string;
}): Promise<WebArtifactPointer> {
  const { externalId, taskId, resolvedSourcePath } = args;
  const pointer = await resolveWebArtifact(externalId);
  if (!pointer) {
    throw new Error(`Unknown web artifact: ${externalId}`);
  }
  if (pointer.taskId !== taskId) {
    throw new Error(
      `Web artifact ${externalId} belongs to a different task and cannot be updated from here.`,
    );
  }
  const { artifactPath } = await copyArtifactToShared(taskId, resolvedSourcePath);
  pointer.snapshotPath = artifactPath;
  pointer.updatedAt = new Date().toISOString();
  await savePointer(pointer);
  logger.debug('web-artifacts', `Updated web artifact ${externalId} for task ${taskId}`);
  return pointer;
}

// =============================================================================
// Rendering
// =============================================================================

// markdown-it with raw HTML disabled: `html: false` escapes any inline
// `<script>` / `<img onerror>` in the source, and markdown-it already refuses
// `javascript:` / `vbscript:` hrefs. `linkify` turns bare URLs into links.
const md = new MarkdownIt({ html: false, linkify: true });

// A module-level DOMPurify singleton bound to one jsdom window — defense in
// depth over the rendered HTML, and avoids per-render jsdom construction.
const purifier = createDOMPurify(
  new JSDOM('').window as unknown as Parameters<typeof createDOMPurify>[0],
);

/**
 * Render Markdown source to sanitized HTML: markdown-it render → DOMPurify
 * sanitize. Strips/neutralizes `<script>`, event handlers (e.g. `onerror`), and
 * `javascript:` links while preserving ordinary structure (headings, lists,
 * links, emphasis).
 */
export function renderMarkdownArtifact(markdownSource: string): string {
  return purifier.sanitize(md.render(markdownSource ?? ''));
}
