// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ThreadSnapshot } from './types.js';

export function extractionBatch(threads: ThreadSnapshot[], fits: (batch: ThreadSnapshot[]) => boolean): ThreadSnapshot[] {
  let current: ThreadSnapshot[] = [];
  batch: for (const thread of threads) {
    const pieces = thread.evidence.flatMap((e) => {
      const result = [];
      for (let offset = 0; offset < Math.max(1, e.text.length); offset += 1000) result.push({ ...e, text: e.text.slice(offset, offset + 1000) });
      return result;
    });
    for (const piece of pieces.length ? pieces : [null]) {
      const candidate = current.map((t) => ({ ...t, evidence: [...t.evidence] }));
      const last = candidate.at(-1);
      if (last?.channel === thread.channel && last.thread === thread.thread) last.evidence.push(...(piece ? [piece] : []));
      else candidate.push({ ...thread, gap: [thread.gap, 'This is a partition; other context may appear in another part.'].filter(Boolean).join('; '), evidence: piece ? [piece] : [] });
      if (candidate.length > 16 || !fits(candidate)) {
        if (!current.length) throw new Error('One evidence fragment exceeds the configured context bound');
        break batch;
      }
      current = candidate;
    }
  }
  for (const part of current) {
    const original = threads.find((t) => t.channel === part.channel && t.thread === part.thread)!;
    if (part.evidence.length === original.evidence.length && part.evidence.every((e, i) => e.id === original.evidence[i].id && e.text === original.evidence[i].text)) part.gap = original.gap;
  }
  return current;
}
