// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from 'vitest';
import { deadlineAt, LocalDeadline } from '../deadline.js';

it.each([
  ['2026-10-27', '17:00', 'Europe/Lisbon', '2026-10-27T17:00:00Z'],
  ['2026-10-24', '17:00', 'Europe/Lisbon', '2026-10-24T16:00:00Z'],
  ['2026-10-25', '17:00', 'Europe/Lisbon', '2026-10-25T17:00:00Z'],
  ['2026-03-28', '17:00', 'Europe/Lisbon', '2026-03-28T17:00:00Z'],
  ['2026-03-29', '17:00', 'Europe/Lisbon', '2026-03-29T16:00:00Z'],
  ['2026-03-29', '01:30', 'UTC', '2026-03-29T01:30:00Z'],
  ['2026-10-27', '00:00', 'UTC', '2026-10-27T00:00:00Z'],
])('resolves %s %s in %s to one exact instant', (date, time, timeZone, expected) => {
  expect(deadlineAt({ date, time, timeZone })).toBe(Date.parse(expected));
});

it.each([
  ['2026-10-25', '01:30', 'Europe/Lisbon'],
  ['2026-03-29', '01:30', 'Europe/Lisbon'],
  ['2026-04-05', '01:45', 'Australia/Lord_Howe'],
  ['2026-02-30', '17:00', 'Europe/Lisbon'],
  ['2026-10-27', '24:00', 'Europe/Lisbon'],
  ['2026-10-27', '17:61', 'UTC'],
  ['2026-10-27', '17:00', 'Unknown/Zone'],
])('keeps invalid or ambiguous %s %s in %s unknown', (date, time, timeZone) => {
  expect(deadlineAt({ date, time, timeZone })).toBeNull();
});

it('preserves no deadline and refuses the old epoch output contract', () => {
  expect(deadlineAt(null)).toBeNull();
  expect(LocalDeadline.safeParse(1793116800000).success).toBe(false);
});

it('does not depend on the host timezone', () => {
  vi.stubEnv('TZ', 'America/Los_Angeles');
  try { expect(deadlineAt({ date: '2026-10-27', time: '17:00', timeZone: 'Europe/Lisbon' })).toBe(1793120400000); }
  finally { vi.unstubAllEnvs(); }
});
