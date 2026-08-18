/**
 * `read_channel_history` / `read_thread` share the ingestion extractor but had
 * their own renderer, which printed only `m.text`. An attachment-only message —
 * a Grafana alert, a Bugsnag error, 57 of 60 messages in #mobile-alerts —
 * therefore reached the agent completely blank.
 */
import { describe, it, expect } from 'vitest';
import { formatExploreMessages } from '../tools.js';

const author = { id: 'U1', username: 'ramin', realName: 'Ramin M' };

describe('formatExploreMessages', () => {
  it('renders an attachment-only message instead of an empty body', () => {
    const out = formatExploreMessages([{
      user: author,
      ts: '1786127951.864179',
      ownText: '',
      attachments: [{ text: '[FIRING:10] StepsConversion (https://grafana.example.com/a)\n**Firing**\nValue: C=1' }],
    }]);

    expect(out).toContain('[FIRING:10] StepsConversion');
    expect(out).toContain('https://grafana.example.com/a');
    expect(out).toContain('msg:1786127951.864179');
  });

  it('still renders plain text, files and reactions', () => {
    const out = formatExploreMessages([{
      user: author,
      ts: '2.0',
      ownText: 'have a look',
      files: [{ id: 'F1', name: 'shot.png', mimetype: 'image/png', url_private: 'https://x/y' }],
      reactions: [{ name: 'eyes', count: 2 }],
    }]);

    expect(out).toContain('have a look');
    expect(out).toContain('shot.png');
    expect(out).toContain('eyes');
  });
});
