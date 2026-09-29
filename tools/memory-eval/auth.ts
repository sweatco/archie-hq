import type { SlackMemoryClassification } from '../../src/types/task.js';
import type { Case } from './schema.js';

export function classificationForCase(c: Case): SlackMemoryClassification {
  const audience = c.audience;
  if (audience.kind === 'none' || audience.authorization && audience.authorization !== 'verified') return { kind: 'none' };
  if (audience.kind === 'user') {
    return audience.userId === c.requester ? { kind: 'user', user_id: c.requester } : { kind: 'none' };
  }
  return { kind: audience.kind, channel_id: audience.channelId };
}
