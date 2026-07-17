/**
 * Slack manifest — group-DM (mpim) runtime unlock.
 *
 * Group DMs surface as `G…` conversation ids with `is_mpim: true`. For those
 * events to flow to Archie the app must hold the mpim history/read scopes and
 * subscribe to the `message.mpim` event. There is no YAML dependency in the
 * repo, so this reads the manifest as text and scans the relevant sections
 * (the `oauth_config.scopes.bot` block and `bot_events`) by substring. (AC5)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/connectors/slack/__tests__ → repo root is four levels up.
const manifestPath = join(__dirname, '..', '..', '..', '..', 'slack-manifest.yaml');
const manifest = readFileSync(manifestPath, 'utf-8');

/** Extract the lines of a YAML block that starts at `headerKey` and runs until
 * the next line whose indentation is less than or equal to the header's. */
function section(text: string, headerKey: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trimEnd().endsWith(headerKey) || l.trimEnd().endsWith(`${headerKey}:`));
  if (start === -1) throw new Error(`section ${headerKey} not found`);
  const headerIndent = lines[start].length - lines[start].trimStart().length;
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const indent = lines[i].length - lines[i].trimStart().length;
    if (indent <= headerIndent) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

describe('slack-manifest.yaml — mpim unlock', () => {
  it('grants mpim:history and mpim:read in the bot scopes block', () => {
    const botScopes = section(manifest, 'bot');
    expect(botScopes).toContain('mpim:history');
    expect(botScopes).toContain('mpim:read');
  });

  it('subscribes to the message.mpim bot event', () => {
    const botEvents = section(manifest, 'bot_events');
    expect(botEvents).toContain('message.mpim');
  });
});
