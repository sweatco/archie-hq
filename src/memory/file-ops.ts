/**
 * Memory File Operations
 *
 * Markdown file read/write/update with section-aware editing.
 * Serialized writes via per-file write queues.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';

// ---- Per-file write queues (ensures ordering, prevents corruption) ----

const writeQueues = new Map<string, Promise<void>>();

/**
 * Queue a write operation for a file. Ensures serialized writes per path.
 */
function queueWrite(filePath: string, fn: () => Promise<void>): Promise<void> {
  const prev = writeQueues.get(filePath) ?? Promise.resolve();
  const next = prev.then(fn, fn); // Run even if previous failed
  writeQueues.set(filePath, next);
  return next;
}

// ---- Read operations ----

/**
 * Read a markdown file. Returns empty string if file doesn't exist.
 */
export async function readMarkdownFile(filePath: string): Promise<string> {
  if (!existsSync(filePath)) return '';
  return readFile(filePath, 'utf-8');
}

// ---- Write operations ----

/**
 * Write a markdown file, creating parent directories if needed.
 */
export async function writeMarkdownFile(filePath: string, content: string): Promise<void> {
  return queueWrite(filePath, async () => {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  });
}

/**
 * Append a bullet point to a section in a markdown file.
 * Finds `## {section}` header and inserts the bullet before the next `## ` or EOF.
 * Creates the section if it doesn't exist.
 * Skips if a near-duplicate already exists in the section.
 */
export async function appendToSection(
  filePath: string,
  section: string,
  bullet: string,
): Promise<void> {
  return queueWrite(filePath, async () => {
    if (!existsSync(filePath)) {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, `## ${section}\n\n- ${bullet}\n`);
      return;
    }

    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    // Check for near-duplicate in the section
    const normalized = bullet.trim().toLowerCase();
    const sectionHeaderIdx = lines.findIndex(
      (l) => l.trim().toLowerCase() === `## ${section.toLowerCase()}`,
    );

    if (sectionHeaderIdx !== -1) {
      // Find section end
      let sectionEnd = lines.length;
      for (let i = sectionHeaderIdx + 1; i < lines.length; i++) {
        if (lines[i].startsWith('## ')) {
          sectionEnd = i;
          break;
        }
      }

      // Check for duplicate within section
      for (let i = sectionHeaderIdx + 1; i < sectionEnd; i++) {
        const lineTrimmed = lines[i].replace(/^[-*]\s*/, '').trim().toLowerCase();
        if (lineTrimmed && lineTrimmed === normalized) {
          return; // Near-duplicate found, skip
        }
      }

      // Insert bullet before section end
      lines.splice(sectionEnd, 0, `- ${bullet}`);
    } else {
      // Section doesn't exist — append at end
      if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
        lines.push('');
      }
      lines.push(`## ${section}`, '', `- ${bullet}`);
    }

    await writeFile(filePath, lines.join('\n'));
  });
}

/**
 * Replace a line within a section. Falls back to append if `oldText` not found.
 */
export async function replaceInSection(
  filePath: string,
  section: string,
  oldText: string,
  newText: string,
): Promise<void> {
  return queueWrite(filePath, async () => {
    if (!existsSync(filePath)) {
      // File doesn't exist — fall back to creating with the new text
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, `## ${section}\n\n- ${newText}\n`);
      return;
    }

    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const oldLower = oldText.trim().toLowerCase();

    // Find the section
    const sectionHeaderIdx = lines.findIndex(
      (l) => l.trim().toLowerCase() === `## ${section.toLowerCase()}`,
    );

    if (sectionHeaderIdx === -1) {
      // Section doesn't exist — append section with new text
      const result = content.endsWith('\n') ? content : content + '\n';
      await writeFile(filePath, result + `\n## ${section}\n\n- ${newText}\n`);
      return;
    }

    // Find section end
    let sectionEnd = lines.length;
    for (let i = sectionHeaderIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) {
        sectionEnd = i;
        break;
      }
    }

    // Find and replace the old text within the section
    let replaced = false;
    for (let i = sectionHeaderIdx + 1; i < sectionEnd; i++) {
      const stripped = lines[i].replace(/^[-*]\s*/, '').trim().toLowerCase();
      if (stripped.includes(oldLower)) {
        lines[i] = `- ${newText}`;
        replaced = true;
        break;
      }
    }

    if (!replaced) {
      // Fall back to append before section end
      lines.splice(sectionEnd, 0, `- ${newText}`);
    }

    await writeFile(filePath, lines.join('\n'));
  });
}

/**
 * Remove a bullet from a section.
 */
export async function removeFromSection(
  filePath: string,
  section: string,
  text: string,
): Promise<void> {
  return queueWrite(filePath, async () => {
    if (!existsSync(filePath)) return;

    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const textLower = text.trim().toLowerCase();

    const sectionHeaderIdx = lines.findIndex(
      (l) => l.trim().toLowerCase() === `## ${section.toLowerCase()}`,
    );
    if (sectionHeaderIdx === -1) return;

    let sectionEnd = lines.length;
    for (let i = sectionHeaderIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) {
        sectionEnd = i;
        break;
      }
    }

    for (let i = sectionHeaderIdx + 1; i < sectionEnd; i++) {
      const stripped = lines[i].replace(/^[-*]\s*/, '').trim().toLowerCase();
      if (stripped.includes(textLower)) {
        lines.splice(i, 1);
        break;
      }
    }

    await writeFile(filePath, lines.join('\n'));
  });
}

/**
 * Prepend a row to a markdown table in a file. Caps at maxRows.
 * Expected format: the file has a header row, separator row, then data rows.
 */
export async function prependTableRow(
  filePath: string,
  row: string,
  maxRows: number = 100,
): Promise<void> {
  return queueWrite(filePath, async () => {
    if (!existsSync(filePath)) {
      await mkdir(dirname(filePath), { recursive: true });
      const header = '| Date | Task | Summary | Tags |\n| --- | --- | --- | --- |';
      await writeFile(filePath, `# Recent Activity\n\n${header}\n${row}\n`);
      return;
    }

    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    // Find the separator row (| --- | ... |)
    const sepIdx = lines.findIndex((l) => /^\|\s*---/.test(l));
    if (sepIdx === -1) {
      // No table found — append one
      lines.push('', '| Date | Task | Summary | Tags |', '| --- | --- | --- | --- |', row);
    } else {
      // Insert after separator
      lines.splice(sepIdx + 1, 0, row);

      // Cap data rows
      const dataStartIdx = sepIdx + 1;
      const dataRows = lines.slice(dataStartIdx).filter((l) => l.startsWith('|'));
      if (dataRows.length > maxRows) {
        // Find and remove excess rows from the end
        let removed = 0;
        for (let i = lines.length - 1; i > sepIdx && removed < dataRows.length - maxRows; i--) {
          if (lines[i].startsWith('|')) {
            lines.splice(i, 1);
            removed++;
          }
        }
      }
    }

    await writeFile(filePath, lines.join('\n'));
  });
}
