import { describe, it, expect } from 'vitest';
import { canvasHtmlToMarkdown } from '../canvas-markdown.js';

// Representative canvas HTML covering every embed form documented in the
// bot-token feasibility findings (docs/plans/20260627-channel-canvas-project-context.md):
// file-as-URL, file-as-card, nested canvas, inline image, and a collapsed
// "title chip" (which Slack strips of its id and must surface as unreadable).
const CANVAS_HTML = `
<div class="quip-canvas-content">
  <h1>Archie — bot-test</h1>
  <p class="line">So this should be the main channel instructions. Archie should now know the pin code for this channel is 1652</p>
  <p class="line">Files to load for additional context:</p>
  <lnk href="https://sweatcoin.slack.com/files/U08JNK1A6/F0BDH8SN79P/trust_classification_proposal.md" data-slack-file-id="sf:F0BDH8SN79P">https://sweatcoin.slack.com/files/U08JNK1A6/F0BDH8SN79P/trust_classification_proposal.md</lnk>
  <p class='embedded-file'>File ID: sf:F0BE9MEESC8, File URL: https://sweatcoin.slack.com/files/U08JNK1A6/F0BE9MEESC8/untitled_discover_session.csv</p>
  <control data-remapped="true"><a>F0BDGH1HNK0</a></control>
  <img src='https://sweatcoin.slack.com/collab-slack-blob/T03PDDDEK/F0BDL5AGCKU?token=1' alt="IMG_2953.jpg_SLACK_FILE_ALT_PLACEHOLDER_F0BDL5AGCKU">
  <control data-remapped="true"></control>
</div>
`;

describe('canvasHtmlToMarkdown', () => {
  const { markdown, fileIds } = canvasHtmlToMarkdown(CANVAS_HTML);

  it('keeps the prose', () => {
    expect(markdown).toContain('Archie — bot-test');
    expect(markdown).toContain('pin code for this channel is 1652');
  });

  it('renders a pasted-URL file reference as a markdown link', () => {
    expect(markdown).toContain('(https://sweatcoin.slack.com/files/U08JNK1A6/F0BDH8SN79P/trust_classification_proposal.md)');
  });

  it('renders an expanded-card file reference as a markdown link', () => {
    expect(markdown).toContain('untitled_discover_session.csv');
  });

  it('marks a nested canvas and an inline image', () => {
    expect(markdown).toContain('[embedded:F0BDGH1HNK0]');
    expect(markdown).toContain('![image](file:F0BDL5AGCKU)');
  });

  it('surfaces a collapsed title chip as unreadable (no id)', () => {
    expect(markdown).toContain('[unreadable embed]');
  });

  it('extracts every recoverable file id, and only those', () => {
    expect(new Set(fileIds)).toEqual(
      new Set(['F0BDH8SN79P', 'F0BE9MEESC8', 'F0BDGH1HNK0', 'F0BDL5AGCKU']),
    );
  });
});

// Slack overloads <control> for mentions as well as embeds — the id prefix is the
// only discriminator. Captured verbatim from the real `Archie — bot-test` canvas:
//   Testing users: <control data-remapped="true"><a>@U08JNK1A6</a></control>
describe('canvasHtmlToMarkdown — @/# mentions', () => {
  const control = (text: string) => `<p class="line">x: <control data-remapped="true"><a>${text}</a></control></p>`;

  it('emits a user mention in native Slack syntax instead of dropping it', () => {
    const { markdown, fileIds } = canvasHtmlToMarkdown(control('@U08JNK1A6'));
    expect(markdown).toContain('<@U08JNK1A6>');
    expect(markdown).not.toContain('unreadable');
    expect(fileIds).toEqual([]);
  });

  it('emits a channel mention in native Slack syntax', () => {
    const { markdown, fileIds } = canvasHtmlToMarkdown(control('#C0A5HHGDFJQ'));
    expect(markdown).toContain('<#C0A5HHGDFJQ>');
    expect(fileIds).toEqual([]);
  });

  it('emits a usergroup mention in native Slack syntax', () => {
    const { markdown, fileIds } = canvasHtmlToMarkdown(control('@S0123ABC'));
    expect(markdown).toContain('<!subteam^S0123ABC>');
    expect(fileIds).toEqual([]);
  });

  it('passes @here/@channel through unchanged', () => {
    expect(canvasHtmlToMarkdown(control('@here')).markdown).toContain('@here');
    expect(canvasHtmlToMarkdown(control('@channel')).markdown).toContain('@channel');
  });

  // Regression: the unanchored /F[0-9A-Z]+/ scan turned the tail of any id
  // containing an F into a file id — `#C0A5HHGDFJQ` → `[embedded:FJQ]` + a bogus
  // `FJQ` in fileIds, which then entered the fetch_slack_reference allowlist.
  it('never mints a file id from an F inside a user or channel id', () => {
    for (const id of ['@U0BF3BYG99C', '#C0BFT4YS4JV']) {
      const { markdown, fileIds } = canvasHtmlToMarkdown(control(id));
      expect(fileIds).toEqual([]);
      expect(markdown).not.toContain('embedded:');
    }
  });

  it('still treats a bare F… control as an embedded file', () => {
    const { markdown, fileIds } = canvasHtmlToMarkdown(control('F0BDGH1HNK0'));
    expect(markdown).toContain('[embedded:F0BDGH1HNK0]');
    expect(fileIds).toEqual(['F0BDGH1HNK0']);
  });

  it('still surfaces an empty control as unreadable', () => {
    expect(canvasHtmlToMarkdown('<p class="line">x: <control data-remapped="true"></control></p>').markdown)
      .toContain('[unreadable embed]');
  });
});

// Captured verbatim from the real `Archie — bot-test` canvas: no <thead>, <td>
// header row, and every cell line wrapped in <p class="line">.
const TABLE_HTML = `
<table><tbody>
  <tr><td><p class="line">What</p></td><td><p class="line">Test</p></td></tr>
  <tr><td><p class="line">User</p></td><td><p class="line"><control data-remapped="true"><a>@U08NCDXUGHK</a></control> <control data-remapped="true"><a>@U08JNK1A6</a></control></p></td></tr>
  <tr><td><p class="line">File</p></td><td><p class="line"><control data-remapped="true"><a>F0BDGH1HNK0</a></control></p></td></tr>
  <tr><td><p class="line">Multi</p></td><td><p class="line">first</p><p class="line">second</p></td></tr>
</tbody></table>
`;

describe('canvasHtmlToMarkdown — tables', () => {
  const { markdown, fileIds } = canvasHtmlToMarkdown(TABLE_HTML);

  // turndown-plugin-gfm's isHeadingRow requires EVERY first-row cell to be a <th>.
  // Slack uses <td>, so gfm registered a keep() and emitted the whole <table> as
  // raw HTML — which also stopped turndown descending into the cells.
  it('renders as a GFM table, not raw HTML', () => {
    expect(markdown).not.toContain('<table');
    expect(markdown).not.toContain('<td');
    expect(markdown).toContain('| What | Test |');
    expect(markdown).toContain('| --- | --- |');
  });

  // Each row must stay on ONE line — Slack's per-line <p> in a cell would
  // otherwise inject blank lines and split the row apart.
  it('keeps every row on a single line', () => {
    const rows = markdown.split('\n').filter((l) => l.startsWith('|'));
    expect(rows).toHaveLength(5); // header + separator + 3 body rows
    expect(rows.some((r) => r.includes('first second'))).toBe(true);
  });

  // The keep() meant cell contents were never converted: a mention stayed a raw
  // <control> tag and a file id in a table never reached the fetch allowlist.
  it('converts mentions and file embeds inside cells', () => {
    expect(markdown).toContain('| User | <@U08NCDXUGHK> <@U08JNK1A6> |');
    expect(markdown).toContain('[embedded:F0BDGH1HNK0]');
    expect(fileIds).toEqual(['F0BDGH1HNK0']);
  });

  // Slack's export carries no header information: a canvas table with the header
  // row toggled ON and one with it OFF export identically (plain <td>, no <thead>).
  // So there is nothing to branch on — every row must survive either way, and no
  // table may ever reach the PM as raw HTML.
  it('renders a table with no header row at all, losing no rows', () => {
    const noHeader =
      '<table>' +
      '<tr><td><p class="line">Table without a heading</p></td><td><p class="line">and its content here</p></td></tr>' +
      '<tr><td><p class="line">not header</p></td><td><p class="line">...</p></td></tr>' +
      '</table>';

    const { markdown: md } = canvasHtmlToMarkdown(noHeader);

    expect(md).not.toContain('<table');
    expect(md).toContain('| Table without a heading | and its content here |');
    expect(md).toContain('| not header | ... |');
    expect(md.split('\n').filter((l) => l.startsWith('|'))).toHaveLength(3);
  });

  it('leaves a table that already has a <th> header alone', () => {
    const { markdown: md } = canvasHtmlToMarkdown(
      '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    );
    expect(md).toContain('| A | B |');
    expect(md).toContain('| 1 | 2 |');
  });
});
