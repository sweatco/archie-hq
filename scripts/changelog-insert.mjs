// Insert a generated changelog entry into CHANGELOG.md in the right place.
//
// Used by .github/workflows/daily-changelog.yml: the workflow gathers a day's
// commits, has Claude write the dated entry to a file, and this script splices
// that entry into CHANGELOG.md deterministically — so the file structure (the
// [Unreleased] section and the bottom "Before this log" snapshot) is never
// touched by the model.
//
// Usage: node scripts/changelog-insert.mjs <CHANGELOG.md> <new-entry.md>
//
// Exit codes:
//   0  inserted successfully
//   1  the entry file has no "## YYYY-MM-DD" heading (refuse to insert)
//   2  bad arguments
//   3  an entry for that date is already present (no-op; safe to ignore)

import { readFileSync, writeFileSync } from 'node:fs';

const DATE_HEADING = /^## (\d{4}-\d{2}-\d{2})\b/m;

const [, , changelogPath, entryPath] = process.argv;
if (!changelogPath || !entryPath) {
  console.error('usage: node scripts/changelog-insert.mjs <CHANGELOG.md> <new-entry.md>');
  process.exit(2);
}

const changelog = readFileSync(changelogPath, 'utf8');
const raw = readFileSync(entryPath, 'utf8');

// Tolerate minor model noise: strip any preamble/fences before the dated
// heading, and keep only the first "## " section (one day per entry).
const start = raw.search(DATE_HEADING);
if (start === -1) {
  console.error('Refusing to insert: entry has no "## YYYY-MM-DD" heading. Got:\n' + raw.slice(0, 160));
  process.exit(1);
}
const fromHeading = raw.slice(start);
const headingLineEnd = fromHeading.indexOf('\n');
const afterHeading = fromHeading.slice(headingLineEnd);
const nextSection = afterHeading.search(/^## /m);
let entry = (nextSection === -1
  ? fromHeading
  : fromHeading.slice(0, headingLineEnd) + afterHeading.slice(0, nextSection)
).replace(/```[a-z]*\s*$/i, '').trim();

const date = entry.match(DATE_HEADING)[1];

// Idempotency: never add a second section for the same date.
if (new RegExp(`^## ${date}\\b`, 'm').test(changelog)) {
  console.error(`Entry for ${date} already present in ${changelogPath}; nothing to do.`);
  process.exit(3);
}

// Insert immediately before the newest existing dated entry (reverse
// chronological). Fall back to the "Before this log" snapshot, then EOF.
const lines = changelog.split('\n');
let at = lines.findIndex((l) => /^## \d{4}-\d{2}-\d{2}\b/.test(l));
if (at === -1) at = lines.findIndex((l) => /^## Before this log\b/.test(l));
if (at === -1) at = lines.length;

const head = lines.slice(0, at).join('\n').replace(/\s+$/, '');
const tail = lines.slice(at).join('\n').replace(/^\s+/, '');
const result = `${head}\n\n${entry}\n\n${tail}`.replace(/\n*$/, '\n');

writeFileSync(changelogPath, result);
console.log(`Inserted entry for ${date} (before line ${at + 1}).`);
