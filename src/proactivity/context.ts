// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ThreadSnapshot } from './types.js';

export function partitionThreads(threads: ThreadSnapshot[], fits: (batch: ThreadSnapshot[]) => boolean): ThreadSnapshot[][] {
  const batches: ThreadSnapshot[][] = [];
  let current: ThreadSnapshot[] = [];
  for (const thread of threads) {
    const pieces = thread.evidence.flatMap((e) => {
      const result = [];
      for (let offset = 0; offset < Math.max(1, e.text.length); offset += 1000) result.push({ ...e, text: e.text.slice(offset, offset + 1000) });
      return result;
    });
    for (const piece of pieces.length ? pieces : [null]) {
      const add = (batch: ThreadSnapshot[]) => {
        const last = batch.at(-1);
        const gap = [thread.gap, 'This is a partition; other context may appear in another part.'].filter(Boolean).join('; ');
        if (last?.channel === thread.channel && last.thread === thread.thread) last.evidence.push(...(piece ? [piece] : []));
        else batch.push({ ...thread, gap, evidence: piece ? [piece] : [] });
      };
      const candidate = current.map((t) => ({ ...t, evidence: [...t.evidence] }));
      add(candidate);
      if (candidate.length <= 16 && fits(candidate)) current = candidate;
      else {
        if (current.length) batches.push(current);
        current = [];
        add(current);
        if (!fits(current)) throw new Error('One evidence fragment exceeds the configured context bound');
      }
    }
  }
  if (current.length) batches.push(current);
  for (const batch of batches) for (const part of batch) {
    const original = threads.find((t) => t.channel === part.channel && t.thread === part.thread)!;
    if (part.evidence.length === original.evidence.length && part.evidence.every((e, i) => e.id === original.evidence[i].id && e.text === original.evidence[i].text)) part.gap = original.gap;
  }
  return batches;
}
