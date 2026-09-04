// The one handler `main()` installs: a rejection nobody handled is logged, and the process keeps running.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../system/logger.js';
import { installUnhandledRejectionLogger } from '../system/process-errors.js';

/** Vitest installs its own listeners; ours is whatever the install added on top, and it is removed again after each case. */
function installOurs(): (reason: unknown, promise: Promise<unknown>) => void {
  const before = process.listeners('unhandledRejection');
  installUnhandledRejectionLogger();
  const after = process.listeners('unhandledRejection');
  expect(after.length).toBe(before.length + 1);
  return after[after.length - 1] as (reason: unknown, promise: Promise<unknown>) => void;
}

const installed: Array<(reason: unknown, promise: Promise<unknown>) => void> = [];

afterEach(() => {
  for (const listener of installed.splice(0, installed.length)) {
    process.off('unhandledRejection', listener);
  }
  vi.restoreAllMocks();
});

describe('installUnhandledRejectionLogger', () => {
  it('registers one listener on unhandledRejection', () => {
    installed.push(installOurs());
  });

  it('logs the reason through the logger and does not exit', () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const listener = installOurs();
    installed.push(listener);

    const reason = new Error('nobody was waiting on this');
    expect(() => listener(reason, Promise.resolve())).not.toThrow();

    expect(error).toHaveBeenCalledWith('process', 'Unhandled promise rejection', reason);
    expect(exit).not.toHaveBeenCalled();
  });
});
