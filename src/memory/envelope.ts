const TRUNCATION_MARKER = '\n[result truncated]';

export function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderXmlEnvelope(
  openTag: string,
  closeTag: string,
  body: string,
  options: { preamble?: string; maxChars?: number } = {},
): string {
  const prefix = `${openTag}\n${options.preamble ? `${options.preamble}\n` : ''}`;
  const suffix = `\n${closeTag}`;
  let escaped = escapeXmlText(body.trimEnd());
  const maxChars = options.maxChars;

  if (maxChars !== undefined && prefix.length + escaped.length + suffix.length > maxChars) {
    const bodyLimit = Math.max(0, maxChars - prefix.length - suffix.length - TRUNCATION_MARKER.length);
    escaped = `${escaped.slice(0, bodyLimit).trimEnd()}${TRUNCATION_MARKER}`;
  }

  return `${prefix}${escaped}${suffix}`;
}
