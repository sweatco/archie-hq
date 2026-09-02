import { getChannelRenderer } from '../tasks/channel-delivery.js';
import type { Channel } from '../types/task.js';

export function renderChannel(id: string, ch: Channel): string {
  if (ch.type === 'slack') {
    const name = ch.channel_name || ch.channel_id;
    return name.startsWith('DM with ') ? name : `#${name}`;
  }
  if (ch.type === 'cli') return 'CLI session';
  const render = getChannelRenderer(ch.type);
  // A record can outlive its connector's registration (e.g. unconfigured after a restart);
  // falls back to the raw id rather than fabricate a status like "ended" or "live".
  return render ? render(ch) : id;
}
