/**
 * Tests for pendingSince — which clock the 24h pending-proposal GC measures from.
 *
 * Proposals are now editable while pending, so measuring purely from `created_at`
 * would reap a proposal that was revised minutes ago simply because the original
 * was made a day earlier — taking the freshly posted Approve/Deny card down with
 * it, mid-conversation, with no listing entry left to explain the disappearance.
 */
import { describe, it, expect } from 'vitest';
import { pendingSince } from '../trigger-scheduler.js';

const CREATED = '2026-07-29T10:56:00.000Z';

describe('pendingSince', () => {
  it('uses created_at for a proposal that was never edited', () => {
    expect(pendingSince({ created_at: CREATED })).toBe(new Date(CREATED).getTime());
  });

  it('uses updated_at once the proposal has been revised', () => {
    const edited = '2026-07-30T09:30:00.000Z';
    expect(pendingSince({ created_at: CREATED, updated_at: edited })).toBe(new Date(edited).getTime());
  });

  it('an edit renews the lifetime — a 23h-old proposal revised now is not near the reaper', () => {
    const TTL = 24 * 60 * 60_000;
    const now = new Date('2026-07-30T09:56:00.000Z').getTime(); // 23h after creation
    const justEdited = new Date(now - 60_000).toISOString();    // revised a minute ago

    // Unedited: 23h in, one hour from being GC'd.
    expect(now - pendingSince({ created_at: CREATED })).toBeGreaterThan(22 * 60 * 60_000);
    // Edited: the clock restarted, so it is nowhere near the TTL.
    expect(now - pendingSince({ created_at: CREATED, updated_at: justEdited })).toBeLessThan(TTL);
    expect(now - pendingSince({ created_at: CREATED, updated_at: justEdited })).toBeLessThan(5 * 60_000);
  });

  it('an abandoned proposal still ages out — renewal requires an actual edit', () => {
    const TTL = 24 * 60 * 60_000;
    const now = new Date('2026-07-30T11:00:00.000Z').getTime(); // >24h after creation
    expect(now - pendingSince({ created_at: CREATED })).toBeGreaterThan(TTL);
  });
});
