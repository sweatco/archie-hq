// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * When each input last refused a delivery whose signature or token did not verify.
 * Kept in memory, because a refused delivery must never cost a write; lost on restart.
 * Only known inputs are noted, so the map holds at most one entry per input.
 */
const lastRefusedAt = new Map<string, number>();

export function noteRefusedDelivery(inputId: string, at: number): void {
  lastRefusedAt.set(inputId, at);
}

export function lastRefusedDelivery(inputId: string): number | null {
  return lastRefusedAt.get(inputId) ?? null;
}
