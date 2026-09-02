import { describe, it, expect } from 'vitest';
import { registerConnectorPmTools, getRegisteredConnectorPmTools } from '../connector-tools.js';

// Don't import the Recall connector: registry is a process-wide Map that connector-mount.test.ts leaves
// mounted for the worker; "starts empty" below depends on this file never mounting it.
describe('registerConnectorPmTools / getRegisteredConnectorPmTools', () => {
  it('starts empty — nothing registered means nothing to hand the PM', () => {
    expect(getRegisteredConnectorPmTools().size).toBe(0);
  });

  it('registers a factory under its name', () => {
    const factory = () => ({ name: 'fake-tools' });
    registerConnectorPmTools('fake-tools', factory);

    expect(getRegisteredConnectorPmTools().get('fake-tools')).toBe(factory);
  });

  it('a second registration under the same name replaces the first', () => {
    const first = () => ({ name: 'first' });
    const second = () => ({ name: 'second' });
    registerConnectorPmTools('replaced-name', first);
    registerConnectorPmTools('replaced-name', second);

    expect(getRegisteredConnectorPmTools().get('replaced-name')).toBe(second);
  });

  it('a registration under a different name does not replace or remove another', () => {
    const a = () => ({ name: 'a' });
    const b = () => ({ name: 'b' });
    registerConnectorPmTools('tools-a', a);
    registerConnectorPmTools('tools-b', b);

    expect(getRegisteredConnectorPmTools().get('tools-a')).toBe(a);
    expect(getRegisteredConnectorPmTools().get('tools-b')).toBe(b);
  });
});
