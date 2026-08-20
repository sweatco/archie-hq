import { describe, expect, it } from 'vitest';
import type { Channel, TaskMetadata } from '../../types/task.js';
import { CLI_CHANNEL_KEY } from '../../types/task.js';
import { migrateTaskVisibility } from '../task.js';

function metadata(visibility?: unknown, channels: Record<string, Channel> = {}): TaskMetadata {
  return {
    task_id: 'task-test',
    task_owner: null,
    participants: [],
    channels,
    default_channel: null,
    agent_sessions: {},
    repositories: {},
    status: 'completed',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...(visibility === undefined ? {} : { visibility }),
  } as TaskMetadata;
}

const cliChannel: Channel = { type: 'cli', id: CLI_CHANNEL_KEY };
const slackChannel: Channel = {
  type: 'slack',
  thread_id: '100.000',
  channel_id: 'C1',
  channel_name: 'ops',
  last_processed_ts: '100.000',
};

describe('migrateTaskVisibility', () => {
  it.each(['public', 'private'] as const)('preserves valid %s visibility', (visibility) => {
    const value = metadata(visibility);

    expect(migrateTaskVisibility(value)).toBe(false);
    expect(value.visibility).toBe(visibility);
  });

  it('fails closed for legacy metadata without visibility and is idempotent', () => {
    const value = metadata();

    expect(migrateTaskVisibility(value)).toBe(true);
    expect(value.visibility).toBe('private');
    expect(migrateTaskVisibility(value)).toBe(false);
  });

  it('fails closed for an unrecognized runtime value', () => {
    const value = metadata('shared');

    expect(migrateTaskVisibility(value)).toBe(true);
    expect(value.visibility).toBe('private');
  });

  it('migrates a CLI-only legacy task to public', () => {
    const value = metadata(undefined, { [CLI_CHANNEL_KEY]: cliChannel });

    expect(migrateTaskVisibility(value)).toBe(true);
    expect(value.visibility).toBe('public');
  });

  it('fails closed when a CLI task also linked a Slack channel', () => {
    const value = metadata(undefined, {
      [CLI_CHANNEL_KEY]: cliChannel,
      'slack:C1:100.000': slackChannel,
    });

    expect(migrateTaskVisibility(value)).toBe(true);
    expect(value.visibility).toBe('private');
  });

  it('fails closed for a legacy task with no channels at all', () => {
    const value = metadata(undefined, {});

    expect(migrateTaskVisibility(value)).toBe(true);
    expect(value.visibility).toBe('private');
  });
});
