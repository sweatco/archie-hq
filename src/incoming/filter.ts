// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PointerCheck } from './types.js';

type Resolved = { found: true; value: unknown } | { found: false };

/** A filter is a list of conditions on the event JSON; an event passes when all of them hold. */
export function passesFilter(checks: readonly PointerCheck[], event: unknown): boolean {
  return checks.every((check) => passesCheck(check, event));
}

function passesCheck(check: PointerCheck, event: unknown): boolean {
  const target = resolvePointer(event, check.pointer);
  if (!target.found) return false;
  if (check.op === 'present') return true;
  if (check.op === 'equals') return target.value === check.value;
  return check.values.some((value) => value === target.value);
}

/** RFC 6901 lookup over parsed JSON, through own properties only. */
function resolvePointer(document: unknown, pointer: string): Resolved {
  if (pointer === '') return { found: true, value: document };
  let current = document;
  for (const token of pointer.slice(1).split('/')) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      const items: unknown[] = current;
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= items.length) return { found: false };
      current = items[Number(key)];
      continue;
    }
    if (typeof current !== 'object' || current === null) return { found: false };
    const property = Object.getOwnPropertyDescriptor(current, key);
    if (!property) return { found: false };
    current = property.value;
  }
  return { found: true, value: current };
}
