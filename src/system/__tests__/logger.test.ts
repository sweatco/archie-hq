/**
 * Unit tests for logger output and the Agent tool_use log-line formatter.
 *
 * Before this, the container log printed only "Tool: Agent" for every spawn,
 * so operators checking production could not tell which agent type or model
 * was behind it. `formatAgentSpawnLine` fills that in from the tool_use
 * input — and must never surface the prompt body.
 */

import { describe, it, expect, vi } from 'vitest';
import { format } from 'node:util';
import { formatAgentSpawnLine, Logger } from '../logger.js';

it('keeps format specifiers in debug messages literal when data is attached', () => {
  const calls: unknown[][] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    calls.push(args);
  });
  try {
    new Logger().debug('request', 'ID=%s', 'payload');
    expect(format(...calls[0])).toBe('[request] ID=%s payload');
  } finally {
    log.mockRestore();
  }
});

describe('formatAgentSpawnLine', () => {
  it('names a plugin-defined agent type, its model, and its description', () => {
    expect(
      formatAgentSpawnLine({
        subagent_type: 'marketing:tov-reviewer',
        model: 'sonnet',
        description: 'ToV review of one line',
      }),
    ).toBe('Agent → marketing:tov-reviewer (sonnet) — ToV review of one line');
  });

  it('falls back to general-purpose when subagent_type is absent', () => {
    expect(formatAgentSpawnLine({ model: 'opus', description: 'quick lookup' })).toBe(
      'Agent → general-purpose (opus) — quick lookup',
    );
  });

  it('falls back to inherited when model is absent', () => {
    expect(
      formatAgentSpawnLine({
        subagent_type: 'engineering:coder',
        description: 'implement the fix',
      }),
    ).toBe('Agent → engineering:coder (inherited) — implement the fix');
  });

  it('omits the description entirely when none is given', () => {
    expect(formatAgentSpawnLine({ subagent_type: 'engineering:coder', model: 'sonnet' })).toBe(
      'Agent → engineering:coder (sonnet)',
    );
  });

  it('never includes the prompt body, even when the caller passes one through', () => {
    const line = formatAgentSpawnLine({
      subagent_type: 'engineering:coder',
      model: 'sonnet',
      description: 'short summary',
      ...{ prompt: 'a very long prompt body that must never reach the log' },
    });
    expect(line).not.toContain('very long prompt body');
  });
});
