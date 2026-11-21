/**
 * promptfoo provider that replays a finished task instead of calling a model:
 * the test's `taskDir` var names a task folder, and the response is built from
 * its session record. Relative paths resolve against the working directory,
 * which run.ts sets to the config file's directory.
 *
 * Typed against the provider contract by hand, so the repository typechecks
 * without this package's dependencies installed.
 */

import { resolve } from 'path';
import { formatToolCall, measureRecord } from '../graders.js';
import { buildSessionRecord, type SessionRecord } from '../session-record.js';

interface ProviderOptions {
  id?: string;
  config?: { source?: SessionRecord['source'] };
}

interface CallApiContext {
  vars?: Record<string, unknown>;
}

/** The fields of promptfoo's ProviderResponse this provider fills. */
interface ReplayResponse {
  output?: string;
  cost?: number;
  error?: string;
  metadata?: ReplayMetadata;
}

export interface ReplayMetadata {
  record: SessionRecord;
  /** Why `record.complete` is false. */
  gaps: string[];
  /** Printed tool calls in order, for reading results. */
  toolSequence: string[];
  /** The shape promptfoo's `skill-used` assertion reads. */
  skillCalls: { name: string; is_error: boolean; source: 'tool' }[];
  measures: ReturnType<typeof measureRecord>;
}

export default class ReplayProvider {
  private readonly providerId: string;
  private readonly source: SessionRecord['source'];

  constructor(options: ProviderOptions = {}) {
    this.providerId = options.id ?? 'archie-replay';
    this.source = options.config?.source ?? 'production';
  }

  id(): string {
    return this.providerId;
  }

  async callApi(_prompt: string, context?: CallApiContext): Promise<ReplayResponse> {
    const taskDir = context?.vars?.taskDir;
    if (typeof taskDir !== 'string' || !taskDir) {
      return { error: 'the test needs a taskDir var naming a task folder' };
    }

    const { record, gaps } = await buildSessionRecord(resolve(taskDir), this.source);
    const replies = record.turns.flatMap((turn) => turn.replies);
    const metadata: ReplayMetadata = {
      record,
      gaps,
      toolSequence: record.toolCalls.map(formatToolCall),
      skillCalls: record.toolCalls.flatMap((call) =>
        call.skill === undefined
          ? []
          : [{ name: call.skill, is_error: call.failed, source: 'tool' }],
      ),
      measures: measureRecord(record),
    };
    return {
      output: replies.join('\n\n'),
      ...(record.usage.costUsd === null ? {} : { cost: record.usage.costUsd }),
      metadata,
    };
  }
}
