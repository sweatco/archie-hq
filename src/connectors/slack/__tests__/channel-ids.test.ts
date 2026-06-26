import { describe, it, expect } from 'vitest';
import { isDmOrUserId } from '../channel-ids.js';

describe('isDmOrUserId', () => {
  it('flags 1:1 DM channel ids', () => {
    expect(isDmOrUserId('D0123ABCD')).toBe(true);
  });

  it('flags user ids that Slack would coerce into a DM', () => {
    expect(isDmOrUserId('U0123ABCD')).toBe(true);
    expect(isDmOrUserId('W0123ABCD')).toBe(true); // enterprise-grid user id
  });

  it('allows public/private channel ids (those are gated at the API layer)', () => {
    expect(isDmOrUserId('C0123ABCD')).toBe(false); // public/private channel
    expect(isDmOrUserId('G0123ABCD')).toBe(false); // legacy private channel / mpim
  });
});
