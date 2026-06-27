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

  // 3. Nested canvas / remapped control → <control data-remapped><a>F…</a></control> (or empty)
  td.addRule('slackControl', {
    filter: (node) => asNode(node).nodeName === 'CONTROL',
    replacement: (_content, node) => {
      const id = (asNode(node).textContent || '').match(/F[0-9A-Z]+/)?.[0];
      if (id) {
        fileIds.add(id);
        return `[embedded:${id}]`;
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
  const markdown = td.turndown(html).replace(/​/g, '').trim();

  return { markdown, fileIds: [...fileIds] };
}
