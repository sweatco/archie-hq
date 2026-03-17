/**
 * Shutdown State
 *
 * Process-wide shutdown flag. Extracted from server.ts so tasks can check
 * shutdown state without depending on the connector layer.
 */

let isShuttingDown = false;

export function getIsShuttingDown(): boolean {
  return isShuttingDown;
}

export function setShuttingDown(value: boolean): void {
  isShuttingDown = value;
}
