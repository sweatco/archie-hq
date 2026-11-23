/**
 * The promptfoo response both Archie providers return for a session record:
 * the PM's replies as output, the recorded cost, and the record in metadata,
 * where the assertions in assertions.ts read it.
 *
 * Typed against the provider contract by hand, so the repository typechecks
 * without this package's dependencies installed.
 */

import { formatToolCall, measureRecord } from '../graders.js';
import type { BuiltRecord, SessionRecord } from '../session-record.js';

export interface RecordMetadata {
  record: SessionRecord;
  /** Why `record.complete` is false. */
  gaps: string[];
  /** Printed tool calls in order, for reading results. */
  toolSequence: string[];
  /** The shape promptfoo's `skill-used` assertion reads. */
  skillCalls: { name: string; is_error: boolean; source: 'tool' }[];
  measures: ReturnType<typeof measureRecord>;
}

/** The fields of promptfoo's ProviderResponse the providers fill. */
export interface RecordResponse<Metadata extends RecordMetadata = RecordMetadata> {
  output?: string;
  cost?: number;
  error?: string;
  metadata?: Metadata;
}

export function buildRecordResponse({
  record,
  gaps,
}: BuiltRecord): RecordResponse & { metadata: RecordMetadata } {
  const replies = record.turns.flatMap((turn) => turn.replies);
  return {
    output: replies.join('\n\n'),
    ...(record.usage.costUsd === null ? {} : { cost: record.usage.costUsd }),
    metadata: {
      record,
      gaps,
      toolSequence: record.toolCalls.map(formatToolCall),
      skillCalls: record.toolCalls.flatMap((call) =>
        call.skill === undefined
          ? []
          : [{ name: call.skill, is_error: call.failed, source: 'tool' }],
      ),
      measures: measureRecord(record),
    },
  };
}
