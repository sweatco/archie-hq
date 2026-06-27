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
