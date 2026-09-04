import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const VOICE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every module specifier this file imports, re-exports, or dynamically imports. */
function specifiers(source: string): string[] {
  return [...source.matchAll(/(?:^|[^\w$])(?:import|export)(?:[^'";]*\sfrom\s*|\s*)['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .concat([...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]));
}

describe('the voice medium depends on no connector', () => {
  it('imports nothing from src/connectors/', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(VOICE_DIR).filter((f) => f.endsWith('.ts'))) {
      for (const specifier of specifiers(readFileSync(join(VOICE_DIR, file), 'utf8'))) {
        if (specifier.includes('connectors/')) {
          offenders.push(`${file} → ${specifier}`);
        }
      }
    }

    expect(
      offenders,
      'A connector depends on the medium, never the reverse, so a second channel (a phone line, a Telegram call) can plug in without touching src/voice/. Move whatever these modules need behind VoiceTransport, AudioSink or MeetingHost in src/voice/types.ts:\n' +
      offenders.join('\n'),
    ).toEqual([]);
  });
});
