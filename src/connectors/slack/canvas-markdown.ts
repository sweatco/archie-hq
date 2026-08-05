/**
 * Convert the HTML a Slack canvas download returns (`text/html`,
 * `<div class="quip-canvas-content">…`) into Markdown, and extract the ids of
 * every file / canvas / image referenced inside it — in a single pass.
 *
 * Why: a bot token can only fetch a canvas body as HTML (Slack has no markdown
 * read API for bots). `turndown` handles the standard elements; the four custom
 * rules below handle Slack's non-standard embed tags and double as the file-id
 * extractor the "load referenced files" feature needs.
 *
 * The mapping below was validated end-to-end against a real labelled canvas
 * (see docs/plans/20260627-channel-canvas-project-context.md). A reference
 * "collapsed to a title chip" carries no id — Slack strips it from the bot
 * export — so it surfaces as `[unreadable embed]` with nothing to fetch.
 */
import TurndownService from 'turndown';
import { createRequire } from 'module';

// turndown-plugin-gfm ships no types; load it via createRequire (the codebase's
// established pattern for untyped/CJS deps, cf. @slack/bolt in events.ts).
const require = createRequire(import.meta.url);
const { gfm } = require('turndown-plugin-gfm') as { gfm: TurndownService.Plugin };

/**
 * The subset of DOM node API the rules use. The project's tsconfig doesn't
 * include the `dom` lib, so we cast turndown's node to this minimal shape
 * rather than depend on global DOM types.
 */
interface CanvasNode {
  nodeName: string;
  textContent: string | null;
  getAttribute(name: string): string | null;
}

const asNode = (node: unknown): CanvasNode => node as CanvasNode;

/**
 * Make Slack's canvas tables digestible by turndown-plugin-gfm. Two rewrites:
 *
 * 1. **Promote row 1 from `<td>` to `<th>`.** gfm only renders a table when its
 *    first row `isHeadingRow`, which requires *every* cell to be a `<th>`. Slack
 *    tables have no `<thead>` and use `<td>` throughout, so gfm classifies them as
 *    headerless and registers a `keep()`: the whole `<table>` lands in the output
 *    as **raw HTML**. That is not merely ugly — `keep` stops turndown descending
 *    into the cells, so the rules below never run on their contents. A mention in
 *    a table stays a raw `<control>` tag, and a file referenced in a table never
 *    enters `fileIds`, silently putting it out of reach of `fetch_slack_reference`.
 *
 * 2. **Flatten `<p class="line">` inside cells.** Slack wraps every line of a cell
 *    in a paragraph, and turndown renders `<p>` as a blank-line-separated block —
 *    inside a cell that yields embedded newlines, which breaks the GFM row it sits
 *    in (a row must be one line). Paragraph boundaries become a single space, so a
 *    multi-line cell reads as one run of text instead of splitting the table.
 *
 * Row 1 is promoted unconditionally because **Slack's bot export carries no header
 * information at all** — verified against a canvas holding two tables, one with the
 * canvas header row toggled on and one without: both export as plain `<td>`, no
 * `<thead>`, no `<th>`. The header row is display-only state in Slack and is lost on
 * export, so there is nothing to branch on. GFM has no headerless table either, so
 * some row must fill that slot. Promoting row 1 is lossless (every cell survives)
 * and right for the common case where row 1 really is the header; for a genuinely
 * headerless table it only misplaces emphasis, and the alternative — synthesising a
 * blank header — reads as a malformed table. The `<th>` check below is kept for
 * robustness if Slack ever starts emitting real headers.
 *
 * Slack's HTML is machine-generated and flat (`<table><tr><td>…`; the `<tbody>` in
 * DOM dumps is inserted by the parser, not by Slack), so a string-level rewrite
 * suffices; nested tables are not a shape Slack emits.
 */
function normalizeTables(html: string): string {
  return html.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (table) => {
    let out = table.replace(/<p\b[^>]*>/gi, '').replace(/<\/p>/gi, ' ');
    if (!/<th\b/i.test(out)) {
      let promoted = false;
      out = out.replace(/<tr\b[^>]*>[\s\S]*?<\/tr>/i, (row) => {
        if (promoted) return row;
        promoted = true;
        return row.replace(/<(\/?)td\b/gi, '<$1th');
      });
    }
    return out;
  });
}

/**
 * @param html Raw canvas HTML (the body of url_private_download).
 * @returns markdown — converted body; fileIds — every recoverable F… id
 *   (files, images, nested canvases). Collapsed "as title" embeds carry no id
 *   and are omitted.
 */
export function canvasHtmlToMarkdown(html: string): { markdown: string; fileIds: string[] } {
  const fileIds = new Set<string>();

  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    // A collapsed "title chip" is an EMPTY <control>; turndown routes empty
    // nodes through blankReplacement, bypassing the slackControl rule below — so
    // surface the unreadable marker here. Otherwise mirror turndown's default.
    blankReplacement: (_content, node) => {
      if (asNode(node).nodeName === 'CONTROL') return '[unreadable embed]';
      return (node as unknown as { isBlock?: boolean }).isBlock ? '\n\n' : '';
    },
  });
  td.use(gfm); // tables, task lists, strikethrough

  // 1. File pasted as a URL → <lnk href data-slack-file-id="sf:F…">text</lnk>
  td.addRule('slackLnk', {
    filter: (node) => asNode(node).nodeName === 'LNK',
    replacement: (_content, node) => {
      const el = asNode(node);
      const href = el.getAttribute('href') || '';
      const sf = (el.getAttribute('data-slack-file-id') || '').replace(/^sf:/, '');
      if (sf) fileIds.add(sf);
      return href ? `[${el.textContent || href}](${href})` : (el.textContent || '');
    },
  });

  // 2. File as expanded card → <p class='embedded-file'>File ID: sf:F…, File URL: https://…</p>
  td.addRule('slackCard', {
    filter: (node) => {
      const el = asNode(node);
      return el.nodeName === 'P' && (el.getAttribute('class') || '').includes('embedded-file');
    },
    replacement: (_content, node) => {
      const text = asNode(node).textContent || '';
      const sf = (text.match(/sf:(F[0-9A-Z]+)/) || [])[1];
      const url = (text.match(/https?:\/\/\S+/) || [])[0];
      if (sf) fileIds.add(sf);
      const name = url ? decodeURIComponent(url.split('/').pop() || '') : (sf || 'file');
      return url ? `[${name}](${url})` : (sf ? `\`${sf}\`` : '');
    },
  });

  // 3. Remapped control → <control data-remapped><a>@U…|#C…|F…</a></control> (or empty).
  //
  // Slack overloads `<control>` for BOTH embedded files/canvases and @/# mentions,
  // distinguished only by the id prefix in the text. The match must be ANCHORED to
  // the whole (trimmed, sigil-stripped) text: an unanchored /F[0-9A-Z]+/ scan finds
  // a stray `F` *inside* a user or channel id and mints a file id out of the tail —
  // `#C0A5HHGDFJQ` became `[embedded:FJQ]` plus a bogus `FJQ` in fileIds, which then
  // entered the fetch_slack_reference allowlist as a file that never existed.
  //
  // Mentions are emitted in native Slack syntax; readCanvas resolves them to the
  // `<@ID:Name>` form used everywhere else via the shared mention resolver. Only
  // `F…` ids may enter fileIds.
  td.addRule('slackControl', {
    filter: (node) => asNode(node).nodeName === 'CONTROL',
    replacement: (_content, node) => {
      const text = (asNode(node).textContent || '').trim();
      // Special mentions carry no id and need no resolution — pass them through.
      const special = text.match(/^@(here|channel|everyone)$/i);
      if (special) return `@${special[1].toLowerCase()}`;

      const id = text.match(/^[@#]?([A-Z][A-Z0-9]+)$/)?.[1];
      if (id) {
        // U/W = member, C/G = channel, S = usergroup, F = file/canvas.
        if (/^[UW]/.test(id)) return `<@${id}>`;
        if (/^[CG]/.test(id)) return `<#${id}>`;
        if (/^S/.test(id)) return `<!subteam^${id}>`;
        if (/^F/.test(id)) {
          fileIds.add(id);
          return `[embedded:${id}]`;
        }
      }
      return '[unreadable embed]'; // collapsed-to-title: Slack stripped the id
    },
  });

  // 4. Inline image → <img src='…/F…' alt="…_SLACK_FILE_ALT_PLACEHOLDER_F…">
  td.addRule('slackImg', {
    filter: 'img',
    replacement: (_content, node) => {
      const el = asNode(node);
      const alt = el.getAttribute('alt') || '';
      const src = el.getAttribute('src') || '';
      const id =
        (alt.match(/_SLACK_FILE_ALT_PLACEHOLDER_(F[0-9A-Z]+)/) || [])[1] ||
        (src.match(/\/(F[0-9A-Z]+)(?:\?|$)/) || [])[1];
      if (id) {
        fileIds.add(id);
        return `![image](file:${id})`;
      }
      return '';
    },
  });

  // Slack appends a zero-width space (U+200B) after inline images — strip it.
  const markdown = td.turndown(normalizeTables(html)).replace(/​/g, '').trim();

  return { markdown, fileIds: [...fileIds] };
}
