import { describe, expect, it } from 'vitest';
import { selectPluginHooks } from '../spawn.js';

describe('selectPluginHooks', () => {
  const hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'inspect' }] }] };

  it('omits plugin command hooks from a memory-authorized session', () => {
    expect(selectPluginHooks(hooks, true)).toBeUndefined();
  });

  it('keeps plugin hooks when the session cannot receive memory', () => {
    expect(selectPluginHooks(hooks, false)).toBe(hooks);
  });
});
