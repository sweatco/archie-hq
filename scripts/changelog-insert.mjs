// Insert generated changelog entries into CHANGELOG.md in the right place.
//
// Used by .github/workflows/daily-changelog.yml: the workflow gathers each
// undocumented day's changes, has Claude write the dated entries to a file,
// and this script splices them into CHANGELOG.md deterministically — so the
// file structure (the [Unreleased] section and the bottom "Before this log"
// snapshot) is never touched by the model.
//
// The entry file may contain SEVERAL "## YYYY-MM-DD" sections (one per
// backfilled day). Each section is validated and inserted independently into
// its reverse-chronological slot, so the changelog stays strictly newest-first
// regardless of the order the model wrote them in.
//
// Usage: node scripts/changelog-insert.mjs <CHANGELOG.md> <new-entry.md>
//
// Exit codes:
//   0  inserted at least one entry successfully
//   1  the entry file is malformed (no "## YYYY-MM-DD" heading, or two
//      sections for the same date) — refuse to insert
//   2  bad arguments
//   3  every entry's date is already present (no-op; safe to ignore)
//   4  an entry has a heading but no bullets (an empty "no changes" record; refuse)

import { readFileSync, writeFileSync } from 'node:fs';

const DATE_HEADING = /^## (\d{4}-\d{2}-\d{2})\b/m;

const [, , changelogPath, entryPath] = process.argv;
if (!changelogPath || !entryPath) {
  console.error('usage: node scripts/changelog-insert.mjs <CHANGELOG.md> <new-entry.md>');
  process.exit(2);
}

let changelog = readFileSync(changelogPath, 'utf8');
const raw = readFileSync(entryPath, 'utf8');

// Tolerate minor model noise: strip any preamble/fences before the first dated
// heading, then split what remains into one chunk per "## " section. Sections
// without a dated heading (stray model noise) are dropped with a warning.
const start = raw.search(DATE_HEADING);
if (start === -1) {
  console.error('Refusing to insert: entry has no "## YYYY-MM-DD" heading. Got:\n' + raw.slice(0, 160));
  process.exit(1);
}
const sections = raw
  .slice(start)
  .split(/^(?=## )/m)
  .map((text) => text.replace(/```[a-z]*\s*$/i, '').trim())
  .filter(Boolean)
  .map((text) => ({ text, date: text.match(DATE_HEADING)?.[1] }))
  .filter(({ text, date }) => {
    if (!date) console.error(`Dropping undated section (model noise): ${text.slice(0, 80)}`);
    return Boolean(date);
  });

// Two sections claiming the same date means the model misfired — merging or
// picking one would silently lose bullets, so fail loudly instead.
const dates = sections.map((s) => s.date);
if (new Set(dates).size !== dates.length) {
  console.error(`Refusing to insert: duplicate dated sections in the entry file (${dates.join(', ')}).`);
  process.exit(1);
}

// Insert oldest first for deterministic output (placement below is date-aware,
// so the final result is the same either way).
sections.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

let inserted = 0;
for (const { date, text } of sections) {
  // Refuse an empty day record. The automation is supposed to skip a day with
  // nothing to report (changelog-gather.sh bails before the model runs), so a
  // bulletless entry arriving here means something upstream misfired — never
  // commit a hollow "_No changes landed_" section. Fail loudly instead.
  //
  // The test is "does the body have a markdown list item?": every real entry —
  // including a pure-plumbing day, written as `- _Technical: …_` — leads its
  // content with a bullet, while the empty-day draft is a bare italic line.
  // Match only list markers (`-`, `*`, `+`), NEVER a leading `_`: accepting `_`
  // would let the empty "_No changes landed_" sentinel pass straight through.
  const body = text.slice(text.indexOf('\n') + 1);
  if (!/^\s*[-*+] /m.test(body)) {
    console.error(
      `Refusing to insert: entry for ${date} has a heading but no changelog bullets ` +
        `(an empty "no changes" record). A quiet day should be skipped upstream, not committed.\n` +
        'Got:\n' + text.slice(0, 200),
    );
    process.exit(4);
  }

  // Idempotency: never add a second section for the same date.
  if (new RegExp(`^## ${date}\\b`, 'm').test(changelog)) {
    console.error(`Entry for ${date} already present in ${changelogPath}; skipping it.`);
    continue;
  }

  // Insert immediately before the first existing entry OLDER than this one, so
  // the file stays reverse-chronological even when backfilling a gap. Fall back
  // to the "Before this log" snapshot, then EOF.
  const lines = changelog.split('\n');
  let at = lines.findIndex((l) => {
    const m = l.match(/^## (\d{4}-\d{2}-\d{2})\b/);
    return m !== null && m[1] < date;
  });
  if (at === -1) at = lines.findIndex((l) => /^## Before this log\b/.test(l));
  if (at === -1) at = lines.length;

  const head = lines.slice(0, at).join('\n').replace(/\s+$/, '');
  const tail = lines.slice(at).join('\n').replace(/^\s+/, '');
  changelog = `${head}\n\n${text}\n\n${tail}`.replace(/\n*$/, '\n');
  inserted += 1;
  console.log(`Inserted entry for ${date} (before line ${at + 1}).`);
}

if (inserted === 0) {
  console.error('Every entry is already present; nothing to do.');
  process.exit(3);
}

writeFileSync(changelogPath, changelog);
