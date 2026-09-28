/**
 * Memory Annotations
 *
 * Inline metadata annotations attached to bullets in org.md / users/*.md.
 * Currently only one kind: `<!-- touched: YYYY-MM-DD -->` for housekeeping
 * staleness tracking. Co-located in its own module so both store.ts and
 * housekeeping.ts can use it without circular imports.
 */

const TOUCHED_RE = /<!--\s*touched:\s*(\d{4}-\d{2}-\d{2})\s*-->/;

/** Extract the touched date from a bullet line, or null when absent. */
export function parseLastTouched(line: string): string | null {
  const m = TOUCHED_RE.exec(line);
  return m ? m[1] : null;
}

/** Remove the touched annotation from a line, returning just the visible text. */
export function stripLastTouched(line: string): string {
  return line.replace(TOUCHED_RE, '').replace(/\s+$/, '');
}

/** Append (or refresh) a touched annotation. Defaults to today's UTC date. */
export function appendLastTouched(line: string, date?: string): string {
  const d = date ?? new Date().toISOString().slice(0, 10);
  const stripped = stripLastTouched(line);
  return `${stripped}  <!-- touched: ${d} -->`;
}
