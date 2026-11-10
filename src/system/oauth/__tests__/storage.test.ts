import { expect, it, vi } from 'vitest';
import { join } from 'node:path';

vi.mock('../../workdir.js', () => ({
  OAUTH_DIR: '/vault',
  OAUTH_PENDING_DIR: '/pending',
}));

import { pendingPathFor } from '../storage.js';

it.each(['', '.', '..', '../outside', 'state/child', 'state\\child'])(
  'rejects path-shaped OAuth state %j',
  (state) => {
    expect(() => pendingPathFor(state)).toThrow('Invalid OAuth state token');
  },
);

it('preserves the generated base64url state as one filename', () => {
  expect(pendingPathFor('valid_Ab-9')).toBe(join('/pending', 'valid_Ab-9.json'));
});
