import { logger } from './logger.js';

// The one place a promise rejection nobody handled is caught — no `uncaughtException` twin, since a synchronous throw should still crash.
export function installUnhandledRejectionLogger(): void {
  process.on('unhandledRejection', (reason) => {
    logger.error('process', 'Unhandled promise rejection', reason);
  });
}
