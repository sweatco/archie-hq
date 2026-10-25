// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

export const LocalDeadline = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  timeZone: z.string().min(1).max(80),
}).nullable();

export function deadlineAt(deadline: z.infer<typeof LocalDeadline>): number | null {
  if (!deadline) return null;
  const local = `${deadline.date}T${deadline.time}:00`;
  const wall = Date.parse(`${local}Z`);
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 19) !== local) return null;
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: deadline.timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const localAt = (at: number): string => {
      const parts = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]));
      return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
    };
    // Adjacent-day offsets expose both sides of a DST fold; require exactly one round trip.
    const candidates = new Set([-86_400_000, 0, 86_400_000].map(shift => {
      const at = wall + shift;
      const offset = Date.parse(`${localAt(at)}Z`) - at;
      return wall - offset;
    }));
    const matches = [...candidates].filter(at => localAt(at) === local);
    return matches.length === 1 ? matches[0] : null;
  } catch { return null; }
}
