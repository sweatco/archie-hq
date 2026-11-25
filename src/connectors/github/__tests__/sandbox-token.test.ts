import { describe, it, expect } from 'vitest';
import { sandboxReadPermissions } from '../sandbox-token.js';

describe('sandboxReadPermissions', () => {
  it('asks for read access only, whatever the installation holds', () => {
    const permissions = sandboxReadPermissions({
      metadata: 'read',
      contents: 'write',
      pull_requests: 'write',
      checks: 'read',
      statuses: 'read',
      actions: 'read',
      workflows: 'write',
      security_events: 'write',
      issues: 'write',
    });

    expect(Object.values(permissions).every((level) => level === 'read')).toBe(true);
    expect(permissions).not.toHaveProperty('workflows');
  });

  it('adds an optional permission only when the installation was granted it', () => {
    const withoutOptional = sandboxReadPermissions({ metadata: 'read', contents: 'write' });
    expect(withoutOptional).not.toHaveProperty('security_events');
    expect(withoutOptional).not.toHaveProperty('issues');

    const withIssues = sandboxReadPermissions({ metadata: 'read', issues: 'read' });
    expect(withIssues.issues).toBe('read');
    expect(withIssues).not.toHaveProperty('security_events');
  });

  it('always requests what the read commands need', () => {
    expect(sandboxReadPermissions({})).toEqual({
      metadata: 'read',
      contents: 'read',
      pull_requests: 'read',
      checks: 'read',
      statuses: 'read',
      actions: 'read',
    });
  });
});
