/**
 * Paths Tests
 *
 * Validates user-identifier acceptance rules and filename construction.
 */

import { describe, it, expect } from 'vitest';
import {
  isSlackUserId,
  isFallbackUserId,
  isAllowedUserId,
  isAllowedTaskId,
  isValidEntitySlug,
  getUserPath,
  getSummaryPath,
  getEntityPath,
  getEntityCap,
  getEntityInjectMax,
} from '../paths.js';

describe('isSlackUserId', () => {
  it.each([
    'U07ABC123',
    'W123456789',
    'B0X1Y2Z3A4',
    'T07TEAM01',
    'U0123456',
  ])('accepts %s', (id) => {
    expect(isSlackUserId(id)).toBe(true);
  });

  it.each([
    '',
    'u07abc123',
    'U123',
    'X07ABC123',
    'cli:abc',
    'alex',
    'U07ABC 123',
  ])('rejects %j', (id) => {
    expect(isSlackUserId(id)).toBe(false);
  });
});

describe('isFallbackUserId', () => {
  it.each(['cli:s-001', 'cli:task-abc', 'local:igor', 'local:bot_x'])('accepts %s', (id) => {
    expect(isFallbackUserId(id)).toBe(true);
  });

  it.each([
    '',
    'cli',
    'cli:',
    ':abc',
    'cli:has spaces',
    'CLI:upper',
    'U07ABC123',
  ])('rejects %j', (id) => {
    expect(isFallbackUserId(id)).toBe(false);
  });
});

describe('isAllowedUserId', () => {
  it.each(['U07ABC123', 'cli:s-001', 'local:igor', 'B0X1Y2Z3A4'])('accepts %s', (id) => {
    expect(isAllowedUserId(id)).toBe(true);
  });

  it.each(['alex', 'egor', 'admin', '', 'foo:bar'])('rejects %j', (id) => {
    expect(isAllowedUserId(id)).toBe(false);
  });
});

describe('isAllowedTaskId', () => {
  it.each(['task-20260410-1000-abc', 'abc.123', 'plain'])('accepts %s', (id) => {
    expect(isAllowedTaskId(id)).toBe(true);
  });

  it.each(['has space', 'has/slash', 'has\\back', ''])('rejects %j', (id) => {
    expect(isAllowedTaskId(id)).toBe(false);
  });
});

describe('getUserPath', () => {
  it('places Slack-ID files directly under users/', () => {
    expect(getUserPath('U07ABC123')).toMatch(/users\/U07ABC123\.md$/);
  });

  it('normalises the colon in fallback IDs to a double underscore', () => {
    expect(getUserPath('cli:task-abc')).toMatch(/users\/cli__task-abc\.md$/);
    expect(getUserPath('local:igor')).toMatch(/users\/local__igor\.md$/);
  });

  it('throws on bare first names', () => {
    expect(() => getUserPath('alex')).toThrow(/invalid user identifier/);
  });

  it('throws on empty input', () => {
    expect(() => getUserPath('')).toThrow();
  });

  it('throws on non-Slack-shaped prefixes', () => {
    expect(() => getUserPath('admin:igor')).toThrow();
  });
});

describe('getSummaryPath', () => {
  it('places summaries under memory/summaries/', () => {
    expect(getSummaryPath('task-20260410-1000-abc')).toMatch(/memory\/summaries\/task-20260410-1000-abc\.md$/);
  });

  it('throws on malformed taskId', () => {
    expect(() => getSummaryPath('has space')).toThrow(/invalid taskId/);
  });
});

describe('isValidEntitySlug', () => {
  it.each(['payment-service', 'stripe', 'postgres-prod', 'a', 'v1', 'x'.repeat(64)])(
    'accepts %s',
    (slug) => expect(isValidEntitySlug(slug)).toBe(true),
  );

  it.each([
    '',
    'Payment-Service', // uppercase
    'payment service', // whitespace
    'payment_service', // underscore
    '../../etc/passwd', // traversal
    'a/b', // separator
    '-leading', // leading hyphen
    'index', // reserved (collides with index.md)
    'x'.repeat(65), // too long
  ])('rejects %s', (slug) => expect(isValidEntitySlug(slug)).toBe(false));
});

describe('getEntityPath', () => {
  it('places entities under memory/entities/', () => {
    expect(getEntityPath('payment-service')).toMatch(/memory\/entities\/payment-service\.md$/);
  });
  it('throws on an invalid slug (no traversal reaches the filesystem)', () => {
    expect(() => getEntityPath('../../etc/passwd')).toThrow(/invalid entity slug/);
    expect(() => getEntityPath('index')).toThrow(/invalid entity slug/);
  });
});

describe('entity caps', () => {
  it('default entity cap and inject max are positive integers', () => {
    expect(getEntityCap()).toBeGreaterThan(0);
    expect(getEntityInjectMax()).toBeGreaterThan(0);
  });
});
