import type { Event, History } from './schema.js';

export function replayLogEntry(event: Event, history: History): string {
  const audience = event.audience ?? history.scope;
  const verified = event.role === 'user' && event.authorId && event.authorName && event.messageTs;
  const source = verified
    ? `<@${event.authorId}:${event.authorName}> in slack:#<${audience.channelId}:eval>:${event.taskId ?? history.id} | msg:${event.messageTs}`
    : event.role === 'assistant' ? 'pm-agent' : event.role === 'user' ? 'unverified-user' : 'system';
  return `[${event.at}] [${source}] ${event.text}\n`;
}
