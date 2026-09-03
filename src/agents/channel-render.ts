import { getChannelRenderer } from '../tasks/channel-delivery.js';
import type { Channel } from '../types/task.js';

export function renderChannel(id: string, ch: Channel): string {
  if (ch.type === 'slack') {
    const name = ch.channel_name || ch.channel_id;
    return name.startsWith('DM with ') ? name : `#${name}`;
  }
  if (ch.type === 'cli') return 'CLI session';
  const render = getChannelRenderer(ch.type);
  // A record outlives its connector's registration, so an unmounted kind renders as its raw id rather than a fabricated "live"/"ended".
  return render ? render(ch) : id;
}
