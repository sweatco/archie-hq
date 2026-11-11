// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';

export function expectDefined<T>(value: T): NonNullable<T> {
  assert(value !== null && value !== undefined, 'Expected a defined test value');
  return value;
}

export async function expectNext<T>(iterator: AsyncIterator<T, void, void>): Promise<T> {
  const next = await iterator.next();
  assert(!next.done, 'Expected another iterator value');
  return next.value;
}
