/**
 * Paths Tests
 *
 * Validates user-identifier acceptance rules and filename construction.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  isSlackUserId,
  isFallbackUserId,
  isAllowedUserId,
  isAllowedTaskId,
  isValidEntitySlug,
  getUserPath,
  getSummaryPath,
  getTaskTelemetryPath,
  getEntityPath,
  getEntityCap,
  getEntityInjectMax,
  getOrgInjectMax,
  getEntityObsCap,
  getTouchedByInjectMax,
  isInjectionEnabled,
} from '../paths.js';
import { logger } from '../../system/logger.js';

describe('envInt flag parsing (inject maxes / obs cap / touched_by render max)', () => {
  const ORG = 'ARCHIE_MEMORY_ORG_INJECT_MAX';
  const OBS = 'ARCHIE_MEMORY_ENTITY_OBS_CAP';
  const NONORG = 'ARCHIE_MEMORY_ENTITY_INJECT_MAX';
  const TOUCHED = 'ARCHIE_MEMORY_TOUCHED_BY_INJECT_MAX';
  afterEach(() => {
    delete process.env[ORG];
    delete process.env[OBS];
    delete process.env[NONORG];
    delete process.env[TOUCHED];
    vi.clearAllMocks();
  });

  it('uses defaults when unset (no warning)', () => {
    expect(getOrgInjectMax()).toBe(8);
    expect(getEntityObsCap()).toBe(30);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('honors ARCHIE_MEMORY_ORG_INJECT_MAX=0 (index-only), without warning', () => {
    process.env[ORG] = '0';
    expect(getOrgInjectMax()).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('honors ARCHIE_MEMORY_ENTITY_INJECT_MAX=0 (index-only for non-org pages), without warning', () => {
    process.env[NONORG] = '0';
    expect(getEntityInjectMax()).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('touched_by render max defaults to 10 and honors 0', () => {
    expect(getTouchedByInjectMax()).toBe(10);
    process.env[TOUCHED] = '0';
    expect(getTouchedByInjectMax()).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
    process.env[TOUCHED] = '-3';
    expect(getTouchedByInjectMax()).toBe(10);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('accepts a valid positive value', () => {
    process.env[ORG] = '12';
    expect(getOrgInjectMax()).toBe(12);
  });

  it('warns and falls back on a non-integer value like "8x"', () => {
    process.env[ORG] = '8x';
    expect(getOrgInjectMax()).toBe(8);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('warns and falls back when below the per-flag minimum', () => {
    process.env[OBS] = '0'; // obs cap min is 1 → falls back to default 30
    expect(getEntityObsCap()).toBe(30);
    process.env[ORG] = '-1'; // org min is 0 → -1 still invalid
    expect(getOrgInjectMax()).toBe(8);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});

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
  it.each(['cli:s-001', 'cli:task-abc', 'local:riley', 'local:bot_x'])('accepts %s', (id) => {
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
  it.each(['U07ABC123', 'cli:s-001', 'local:riley', 'B0X1Y2Z3A4'])('accepts %s', (id) => {
    expect(isAllowedUserId(id)).toBe(true);
  });

  it.each(['alex', 'dana', 'admin', '', 'foo:bar'])('rejects %j', (id) => {
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
    expect(getUserPath('local:riley')).toMatch(/users\/local__riley\.md$/);
  });

  it('throws on bare first names', () => {
    expect(() => getUserPath('alex')).toThrow(/invalid user identifier/);
  });

  it('throws on empty input', () => {
    expect(() => getUserPath('')).toThrow();
  });

  it('throws on non-Slack-shaped prefixes', () => {
    expect(() => getUserPath('admin:riley')).toThrow();
  });
});

describe('getSummaryPath', () => {
  it('places summaries under memory/tasks/<taskId>/', () => {
    expect(getSummaryPath('task-20260410-1000-abc')).toMatch(/memory\/tasks\/task-20260410-1000-abc\/summary\.md$/);
  });

  it('throws on malformed taskId', () => {
    expect(() => getSummaryPath('has space')).toThrow(/invalid taskId/);
  });
});

describe('getTaskTelemetryPath', () => {
  it('places telemetry next to the task summary', () => {
    expect(getTaskTelemetryPath('task-20260410-1000-abc')).toMatch(/memory\/tasks\/task-20260410-1000-abc\/telemetry\.jsonl$/);
  });

  it('throws on malformed or traversal taskIds', () => {
    expect(() => getTaskTelemetryPath('../escape')).toThrow(/invalid taskId/);
    expect(() => getTaskTelemetryPath('..')).toThrow(/invalid taskId/);
    expect(() => getTaskTelemetryPath('.')).toThrow(/invalid taskId/);
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

describe('isInjectionEnabled', () => {
  const KEY = 'ARCHIE_MEMORY_INJECT';
  const original = process.env[KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it('defaults to off when unset (inverts the default-enabled convention)', () => {
    delete process.env[KEY];
    expect(isInjectionEnabled()).toBe(false);
  });

  it('is on only for the exact string "true"', () => {
    process.env[KEY] = 'true';
    expect(isInjectionEnabled()).toBe(true);
  });

  it.each(['false', '1', 'TRUE', 'True', 'yes', ''])('stays off for %j', (v) => {
    process.env[KEY] = v;
    expect(isInjectionEnabled()).toBe(false);
  });
});
