/**
 * Wall-clock task timeout: the `ARCHIE_TASK_TIMEOUT_MS` override and, more
 * importantly, what it refuses to do. The cap is a backstop against a task
 * running forever, so a malformed or non-positive value must fall back to the
 * 60-minute default rather than switch the backstop off.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getTaskTimeoutMs } from '../task.js';

const DEFAULT = 3_600_000;
let saved: string | undefined;

beforeEach(() => { saved = process.env.ARCHIE_TASK_TIMEOUT_MS; });
afterEach(() => {
  if (saved === undefined) delete process.env.ARCHIE_TASK_TIMEOUT_MS;
  else process.env.ARCHIE_TASK_TIMEOUT_MS = saved;
});

describe('getTaskTimeoutMs', () => {
  it('defaults to 60 minutes when unset', () => {
    delete process.env.ARCHIE_TASK_TIMEOUT_MS;
    expect(getTaskTimeoutMs()).toBe(DEFAULT);
  });

  it('honours a positive integer override', () => {
    process.env.ARCHIE_TASK_TIMEOUT_MS = '900000';
    expect(getTaskTimeoutMs()).toBe(900_000);
  });

  it('falls back to the default rather than letting a bad value disable the cap', () => {
    for (const bad of ['', '0', '-1', 'abc', 'NaN']) {
      process.env.ARCHIE_TASK_TIMEOUT_MS = bad;
      expect(getTaskTimeoutMs()).toBe(DEFAULT);
    }
  });
});
