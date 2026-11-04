// SPDX-License-Identifier: AGPL-3.0-or-later
export const REPLAY_NATIVE_TOOLS: string[] = [];

export function assertNoNativeTools(catalog: unknown): asserts catalog is string[] {
  if (!Array.isArray(catalog) || catalog.some((name) => typeof name !== 'string' || !name.startsWith('mcp__'))) {
    throw new Error('Replay SDK catalog must contain no native tools');
  }
}
