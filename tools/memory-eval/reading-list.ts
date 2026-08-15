/**
 * memory:eval — store-review reading list (enablement gate, `--report`).
 *
 * Orders the human review over EVERY block the injection flag enables:
 * entities (by connectedness / observation count / page bytes, with a
 * staleness distribution) plus the non-entity blocks — every user file,
 * recent-activity, and the persisted entity index (injected verbatim as
 * <entity_index>). The script only sorts the pile; the review stays human.
 */

import { serializeEntity } from '../../src/memory/entities.js';
import { lastTouched } from '../../src/memory/entity-index.js';
import type { EntityRecord } from './types.js';

/** Suspicious-content patterns: prompt-injection residue, exfil-ish blobs. */
const SUSPICIOUS: Array<{ flag: string; re: RegExp }> = [
  { flag: 'url', re: /https?:\/\/[^\s)>\]]+/i },
  {
    flag: 'imperative-override',
    re: /\b(ignore (all |any )?(previous|prior|above)|disregard (the |all )?(instructions|rules)|you must (now|always)|always run|never reveal|system prompt|do not tell|pretend (to be|you are)|act as)\b/i,
  },
  { flag: 'base64-blob', re: /[A-Za-z0-9+/]{48,}={0,2}/ },
  { flag: 'secret-shaped', re: /\b(sk-[A-Za-z0-9_\-]{16,}|xox[abps]-[A-Za-z0-9\-]{10,}|ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/ },
];

export function suspiciousFlags(text: string): string[] {
  return SUSPICIOUS.filter((s) => s.re.test(text)).map((s) => s.flag);
}

export interface EntityReviewRow {
  slug: string;
  scope: string;
  status: string;
  relations: number;
  observations: number;
  bytes: number;
  lastTouched: string;
  flags: string[];
}

export interface FileReviewRow {
  file: string;
  bytes: number;
  flags: string[];
}

export interface ReadingList {
  entities: EntityReviewRow[];
  files: FileReviewRow[];
  flaggedCount: number;
}

export function buildReadingList(
  records: EntityRecord[],
  files: Array<{ file: string; text: string }>,
): ReadingList {
  const entities: EntityReviewRow[] = records
    .map((r) => {
      const text = serializeEntity(r);
      return {
        slug: r.entity,
        scope: r.scope,
        status: r.status,
        relations: r.relations.length,
        observations: r.observations.length,
        bytes: text.length,
        lastTouched: lastTouched(r) || '—',
        flags: suspiciousFlags(text),
      };
    })
    // Review order: flagged first, then most-connected/largest (blast radius).
    .sort(
      (a, b) =>
        b.flags.length - a.flags.length ||
        b.relations - a.relations ||
        b.observations - a.observations ||
        b.bytes - a.bytes,
    );

  const fileRows: FileReviewRow[] = files.map((f) => ({
    file: f.file,
    bytes: f.text.length,
    flags: suspiciousFlags(f.text),
  }));

  return {
    entities,
    files: fileRows,
    flaggedCount:
      entities.filter((e) => e.flags.length > 0).length + fileRows.filter((f) => f.flags.length > 0).length,
  };
}
