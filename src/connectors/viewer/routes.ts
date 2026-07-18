/**
 * Web Artifact Viewer — first-party public routes
 *
 * Serves published web artifacts at a stable, unguessable `/a/<externalId>`
 * URL, OUTSIDE the `/api` surface. These routes are the only public projection
 * of the pointer layer: they resolve a pointer from the `externalId` alone
 * (the viewer never sees a `taskId`), read the immutable snapshot, and render
 * our own sanitized Markdown into first-party chrome.
 *
 * Open viewers hot-reload via a narrow public SSE projection of the in-process
 * event bus (`/a/<externalId>/events`): it forwards ONLY `artifact:published` /
 * `artifact:updated` events for this exact `externalId`, and emits ONLY a
 * minimal `{"type":"update"}` signal — never the `taskId` or any other event.
 * It deliberately does NOT reuse `/api/events/stream`.
 *
 * All artifact content and the source download set `X-Content-Type-Options:
 * nosniff`.
 */

import type { Application, Request, Response } from 'express';
import { readFile } from 'fs/promises';
import { onEvent, offEvent, type SystemEvent } from '../../system/event-bus.js';
import { resolveWebArtifact, renderMarkdownArtifact } from '../../agents/web-artifacts.js';
import { logger } from '../../system/logger.js';

/** Escape text for safe interpolation into HTML (title, etc.). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sanitize a filename for use in a `Content-Disposition` header value. Strips
 * anything that could break out of the quoted string or inject header lines
 * (quotes, backslashes, CR/LF, control chars, path separators). Falls back to
 * a safe default when nothing usable remains.
 */
function sanitizeFilename(name: string): string {
  const cleaned = (name || '')
    // drop any path components
    .replace(/[\\/]+/g, '_')
    // strip quotes, control chars, CR/LF
    // eslint-disable-next-line no-control-regex
    .replace(/["\r\n\x00-\x1f\x7f]/g, '')
    .trim();
  return cleaned || 'artifact.md';
}

/**
 * First-party viewer chrome. Wraps the sanitized content fragment with a title,
 * a download-source link, and an inline hot-reload script that subscribes to the
 * artifact's SSE stream and swaps the content container on each signal.
 */
function renderViewerPage(externalId: string, title: string, contentHtml: string): string {
  const safeTitle = escapeHtml(title);
  // externalId is UUID-shaped (validated by resolveWebArtifact upstream), so it
  // is safe to embed in URLs and the inline script.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1a1a1a;
    background: #ffffff;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem 1.5rem;
    border-bottom: 1px solid rgba(0,0,0,0.1);
  }
  header .title { font-weight: 600; }
  header a {
    font-size: 0.85rem;
    color: #2563eb;
    text-decoration: none;
  }
  header a:hover { text-decoration: underline; }
  main { max-width: 48rem; margin: 0 auto; padding: 2rem 1.5rem 4rem; }
  main img { max-width: 100%; height: auto; }
  main pre { overflow-x: auto; padding: 1rem; background: rgba(0,0,0,0.05); border-radius: 6px; }
  main code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
  main table { border-collapse: collapse; }
  main th, main td { border: 1px solid rgba(0,0,0,0.15); padding: 0.4rem 0.6rem; }
  @media (prefers-color-scheme: dark) {
    body { color: #e6e6e6; background: #16181c; }
    header { border-bottom-color: rgba(255,255,255,0.12); }
    header a { color: #6ea8fe; }
    main pre { background: rgba(255,255,255,0.06); }
    main th, main td { border-color: rgba(255,255,255,0.18); }
  }
</style>
</head>
<body>
<header>
  <span class="title">${safeTitle}</span>
  <a href="/a/${externalId}/source" download>Download source</a>
</header>
<main id="artifact-content">${contentHtml}</main>
<script>
(function () {
  var id = ${JSON.stringify(externalId)};
  try {
    var es = new EventSource('/a/' + id + '/events');
    es.onmessage = function () {
      fetch('/a/' + id + '/body', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.text() : Promise.reject(); })
        .then(function (html) {
          var el = document.getElementById('artifact-content');
          if (el) el.innerHTML = html;
        })
        .catch(function () { /* leave current content in place on failure */ });
    };
  } catch (e) { /* EventSource unavailable — page stays static */ }
})();
</script>
</body>
</html>`;
}

/**
 * Mount the public web-artifact viewer routes on the shared Express app.
 * Mounted top-level (OUTSIDE `/api`) by `src/index.ts`.
 */
export function mountViewerRoutes(app: Application): void {
  // ---- GET /a/:externalId — rendered viewer page ----
  app.get('/a/:externalId', async (req: Request, res: Response) => {
    try {
      const externalId = req.params.externalId as string;
      const pointer = await resolveWebArtifact(externalId);
      if (!pointer) {
        res.status(404).type('text/plain').send('Web artifact not found');
        return;
      }
      const source = await readFile(pointer.snapshotPath, 'utf-8');
      const contentHtml = renderMarkdownArtifact(source);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.status(200).type('text/html; charset=utf-8');
      res.send(renderViewerPage(pointer.externalId, pointer.sourceFilename, contentHtml));
    } catch (error) {
      logger.error('viewer', 'Failed to render web artifact', error);
      res.status(500).type('text/plain').send('Failed to render web artifact');
    }
  });

  // ---- GET /a/:externalId/body — sanitized rendered fragment (hot reload) ----
  app.get('/a/:externalId/body', async (req: Request, res: Response) => {
    try {
      const externalId = req.params.externalId as string;
      const pointer = await resolveWebArtifact(externalId);
      if (!pointer) {
        res.status(404).type('text/plain').send('Web artifact not found');
        return;
      }
      const source = await readFile(pointer.snapshotPath, 'utf-8');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.status(200).type('text/html; charset=utf-8');
      res.send(renderMarkdownArtifact(source));
    } catch (error) {
      logger.error('viewer', 'Failed to render web artifact body', error);
      res.status(500).type('text/plain').send('Failed to render web artifact body');
    }
  });

  // ---- GET /a/:externalId/source — original snapshot bytes as a download ----
  app.get('/a/:externalId/source', async (req: Request, res: Response) => {
    try {
      const externalId = req.params.externalId as string;
      const pointer = await resolveWebArtifact(externalId);
      if (!pointer) {
        res.status(404).type('text/plain').send('Web artifact not found');
        return;
      }
      const bytes = await readFile(pointer.snapshotPath);
      const filename = sanitizeFilename(pointer.sourceFilename);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.status(200).send(bytes);
    } catch (error) {
      logger.error('viewer', 'Failed to serve web artifact source', error);
      res.status(500).type('text/plain').send('Failed to serve web artifact source');
    }
  });

  // ---- GET /a/:externalId/events — narrow public SSE projection ----
  // Forwards ONLY artifact:published/artifact:updated events for THIS exact
  // externalId, emitting ONLY a minimal update signal — never taskId, never any
  // other event or artifact. Deliberately NOT /api/events/stream. Keepalive +
  // close cleanup mirror the existing /api/events/stream.
  app.get('/a/:externalId/events', (req: Request, res: Response) => {
    const externalId = req.params.externalId as string;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx/proxy buffering for SSE
      'X-Content-Type-Options': 'nosniff',
    });

    const listener = (event: SystemEvent) => {
      if (event.type !== 'artifact:published' && event.type !== 'artifact:updated') return;
      if (event.data?.externalId !== externalId) return;
      // Emit ONLY a minimal signal — never taskId or any other event data.
      res.write(`data: ${JSON.stringify({ type: 'update' })}\n\n`);
    };

    onEvent(listener);

    // 30s keepalive
    const keepalive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 30_000);

    req.on('close', () => {
      clearInterval(keepalive);
      offEvent(listener);
    });
  });

  logger.plain('Viewer routes: /a/:externalId (+ /body, /source, /events)');
}
