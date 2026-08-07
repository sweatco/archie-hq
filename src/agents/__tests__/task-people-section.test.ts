/**
 * Tests for the `<people_in_task>` prompt block: the roster the PM uses to pitch
 * a message at its actual audience. The resolver itself is covered in
 * connectors/slack/__tests__/client.test.ts — here we assert only the assembly:
 * the framing sits above the tag, each person is one `marker - title` line, and a
 * task with nobody to name contributes no block at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../tasks/persistence.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../tasks/persistence.js')>()),
  readKnowledgeLog: vi.fn(),
}));
vi.mock('../../connectors/slack/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../connectors/slack/client.js')>()),
  resolvePeopleFromTranscript: vi.fn(),
}));

const { readKnowledgeLog } = await import('../../tasks/persistence.js');
const { resolvePeopleFromTranscript } = await import('../../connectors/slack/client.js');
const { buildTaskPeopleSection } = await import('../spawn.js');

beforeEach(() => {
  vi.mocked(readKnowledgeLog).mockResolvedValue('a log with markers in it');
});

describe('buildTaskPeopleSection', () => {
  it('puts the framing above the tag and one person per line', async () => {
    vi.mocked(resolvePeopleFromTranscript).mockResolvedValue([
      { id: 'U1', marker: '<@U1:Irina Ashkenazy>', title: 'Head of Growth Marketing, London' },
      { id: 'U2', marker: '<@U2:Nikita Sidorin>', title: 'Full Stack Engineer | DAU Squad' },
    ]);

    const section = await buildTaskPeopleSection('task-1');

    // Framing precedes the element — attributes carry parameters, not paragraphs.
    expect(section.indexOf('Titles set register only')).toBeLessThan(section.indexOf('<people_in_task>'));
    expect(section).toContain('\n<@U1:Irina Ashkenazy> Head of Growth Marketing, London\n');
    expect(section).toContain('\n<@U2:Nikita Sidorin> Full Stack Engineer | DAU Squad\n');
    expect(section.endsWith('\n</people_in_task>')).toBe(true);
  });

  it('renders an untitled person as a bare marker, with no dangling separator', async () => {
    vi.mocked(resolvePeopleFromTranscript).mockResolvedValue([
      { id: 'UEXT', marker: '<@UEXT:external>', title: '' },
    ]);
    const section = await buildTaskPeopleSection('task-1');
    expect(section).toContain('\n<@UEXT:external>\n');
    expect(section).not.toContain('external> ');
  });

  it('contributes nothing when the log names nobody — no empty roster to invent from', async () => {
    vi.mocked(resolvePeopleFromTranscript).mockResolvedValue([]);
    expect(await buildTaskPeopleSection('task-1')).toBe('');
  });

  it('contributes nothing when the log cannot be read', async () => {
    vi.mocked(readKnowledgeLog).mockRejectedValue(new Error('ENOENT'));
    expect(await buildTaskPeopleSection('task-1')).toBe('');
  });
});
