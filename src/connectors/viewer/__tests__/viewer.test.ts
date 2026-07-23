/**
 * Integration tests for the web-artifact feature end to end: the PM-only MCP
 * tool handlers (`publish_web_artifact` / `update_web_artifact`) driven over a
 * temp WORKDIR/SESSIONS with a real task metadata file, the public first-party
 * viewer routes mounted on a real (ephemeral) Express app, the immutable
 * snapshot substrate, the pointer store, and the in-process event bus.
 *
 * This is the machine verification for AC1–AC7, AC9, and AC10. The pieces are
 * wired together for real — only leaf/heavy deps unrelated to the feature
 * (GitHub/Slack clients, the Task class, the agent registry) are stubbed. In
 * particular persistence, artifacts, web-artifacts, the event bus, and the
 * viewer routes are all the real modules sharing one temp workdir, so the
 * snapshot writes, pointer files, event persistence, and SSE projection all
 * exercise production code paths.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
import { JSDOM } from 'jsdom';
import http from 'http';
import type { AddressInfo } from 'net';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, realpath } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ---- Mutable temp-dir bindings, redirected into the workdir mock via getters ----
let sessionsDir: string;
let webArtifactsDir: string;
let triggersDir: string;

// Redirect the runtime storage the real modules under test write to into temp
// dirs (persistence → SESSIONS_DIR, web-artifacts → WEB_ARTIFACTS_DIR,
// trigger-store → TRIGGERS_DIR). Partial mock: every other workdir export (e.g.
// WORKDIR, consumed by unrelated transitively-imported modules) stays real. The
// getters are evaluated lazily at call time, after beforeAll sets the bindings.
vi.mock('../../../system/workdir.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../system/workdir.js')>();
  return {
    ...actual,
    get SESSIONS_DIR() {
      return sessionsDir;
    },
    get WEB_ARTIFACTS_DIR() {
      return webArtifactsDir;
    },
    get TRIGGERS_DIR() {
      return triggersDir;
    },
  };
});

// Silence logging from the real modules under test.
vi.mock('../../../system/logger.js', () => ({
  logger: {
    plain: vi.fn(), system: vi.fn(), debug: vi.fn(), info: vi.fn(),
    warn: vi.fn(), error: vi.fn(), agentAction: vi.fn(), agentFinding: vi.fn(),
    agentToSlack: vi.fn(),
  },
}));

// Heavy, feature-irrelevant deps tools.ts pulls in — stubbed so the comms/base
// MCP servers can be constructed without a live GitHub/registry.
vi.mock('../../github/client.js', () => ({
  getGitHubClient: vi.fn().mockReturnValue({}),
  parseCheckRef: vi.fn(),
}));
vi.mock('../../github/repo-clone.js', () => ({
  gitExec: vi.fn().mockResolvedValue(''),
  githubRepoToUrl: vi.fn().mockReturnValue(''),
  setupSharedClone: vi.fn(),
  cloneExists: vi.fn(),
  isWorktree: vi.fn(),
  fetchOrigin: vi.fn(),
}));
vi.mock('../../../agents/registry.js', () => ({
  getVisiblePeerIdsForSender: vi.fn().mockReturnValue([]),
  findAgentDefsContainingRepo: vi.fn().mockReturnValue([]),
  synthesizeDynamicAgentDef: vi.fn(),
  isAutoMergeRepo: vi.fn().mockReturnValue(false),
}));
// Cut the Task-class subtree: real persistence only needs `activeTasks` as a
// value import (used by findTaskByThread, which these tests never call).
vi.mock('../../../tasks/task.js', () => ({
  activeTasks: new Map(),
}));

import { mountViewerRoutes } from '../routes.js';
import { createCommsMcpServer, createBaseAgentMcpServer } from '../../../agents/tools.js';
import {
  getSharedPath,
  getMetadataPath,
  getEventsLogPath,
  readEvents,
  initEventPersistence,
} from '../../../tasks/persistence.js';
import { resolveWebArtifact } from '../../../agents/web-artifacts.js';
import { emitEvent } from '../../../system/event-bus.js';
import type { TaskMetadata } from '../../../types/task.js';
import type { Agent } from '../../../agents/agent.js';
import type { Task } from '../../../tasks/task.js';

const require = createRequire(import.meta.url);
const express = require('express');

// ---- Ephemeral HTTP server hosting the real viewer routes ----
let server: http.Server;
let port: number;
let readSandbox: string; // realpath of the source-file sandbox root

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'archie-viewer-e2e-'));
  sessionsDir = join(base, 'sessions');
  webArtifactsDir = join(base, 'web-artifacts');
  triggersDir = join(base, 'triggers');
  const src = join(base, 'src');
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(src, { recursive: true });
  readSandbox = await realpath(src);

  // One real event-persistence subscription mirrors bus events to
  // <task>/shared/events.jsonl — the substrate AC6 reads back.
  initEventPersistence();

  const app = express();
  mountViewerRoutes(app);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---- Fakes ----

function makeAgent(): Agent {
  return {
    def: { id: 'pm-agent', key: 'pm', role: 'PM', expertise: '', pluginName: 'pm', isPm: true },
    sandbox: { allowReadPaths: [readSandbox], allowWritePaths: [] },
    queue: {} as never,
    session: { active: false },
  } as unknown as Agent;
}

/**
 * A minimal Task whose `save` writes the real metadata.json to the temp
 * SESSIONS dir — so publish/update operate against a real on-disk task file and
 * event persistence (which no-ops until the shared dir exists) has somewhere to
 * write.
 */
function makeTask(taskId: string, opts: { withChannel?: boolean } = {}): Task {
  const metadata = {
    task_id: taskId,
    task_owner: null,
    participants: [],
    channels: opts.withChannel
      ? { 'slack:C1:1.0': { type: 'slack', channel_id: 'C1', thread_id: '1.0', channel_name: 'origin', last_processed_ts: '0' } }
      : {},
    default_channel: opts.withChannel ? 'slack:C1:1.0' : null,
    agent_sessions: {},
    repositories: {},
    status: 'in_progress',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as TaskMetadata;

  const save = async () => {
    await mkdir(getSharedPath(taskId), { recursive: true });
    await writeFile(getMetadataPath(taskId), JSON.stringify(metadata, null, 2));
  };

  return {
    taskId,
    metadata,
    save,
    touch: vi.fn(),
    debouncedSave: vi.fn(),
    postFilesToUser: vi.fn().mockResolvedValue(undefined),
  } as unknown as Task;
}

/** Pull an invokable handler out of an SDK MCP server's registry. */
function handlerOf(
  server: { instance: unknown },
  name: string,
): (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }> {
  const inst = server.instance as { _registeredTools?: Record<string, unknown>; _tools?: Iterable<[string, unknown]> };
  const raw = inst._registeredTools ?? Object.fromEntries(inst._tools ?? []);
  const entry = raw[name] as { callback?: unknown; handler?: unknown; cb?: unknown };
  const fn = (entry.callback ?? entry.handler ?? entry.cb) as (a: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>;
  return (args) => fn(args, {});
}

function commsHandler(name: string, agent: Agent, task: Task) {
  return handlerOf(createCommsMcpServer(agent, task) as unknown as { instance: unknown }, name);
}
function baseHandler(name: string, agent: Agent, task: Task) {
  return handlerOf(createBaseAgentMcpServer(agent, task) as unknown as { instance: unknown }, name);
}

/** Write a source file inside the read sandbox and return its absolute path. */
async function writeSource(name: string, content: string): Promise<string> {
  const path = join(readSandbox, name);
  await writeFile(path, content, 'utf-8');
  return path;
}

const textOf = (r: { content: { text: string }[] }) => r.content[0].text;
const EXTERNAL_ID_RE = /\/a\/([0-9a-f-]{36})/;

function extractId(toolText: string): string {
  const m = toolText.match(EXTERNAL_ID_RE);
  if (!m) throw new Error(`no /a/<id> in tool output: ${toolText}`);
  return m[1];
}

async function countPointers(): Promise<number> {
  if (!existsSync(webArtifactsDir)) return 0;
  return (await readdir(webArtifactsDir)).filter((f) => f.endsWith('.json')).length;
}

// ---- Minimal HTTP client (no supertest dependency) ----

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function httpGet(path: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }),
      );
    });
    req.on('error', reject);
  });
}

/**
 * Load a served viewer page into a real (headless) DOM via jsdom and run its
 * ACTUAL inline hot-reload script (runScripts: 'dangerously' executes the exact
 * `<script>` bytes emitted by `renderViewerPage` in routes.ts — not a copy).
 *
 * The browser primitives the script relies on — `EventSource` and `fetch` — are
 * the only things jsdom lacks, so we polyfill them to point at the SAME real
 * Express server the page came from. The result is a genuine end-to-end browser
 * loop with no chromium: the script opens a real SSE connection to
 * `/a/<id>/events`, and on each frame really fetches `/a/<id>/body` and performs
 * the literal `el.innerHTML = html` DOM write — all observable on the live jsdom
 * DOM. This executes the browser-DOM half of AC8 that a Playwright-less QA boot
 * could not, closing the manual-check gap.
 */
function openBrowserViewer(pageHtml: string, id: string) {
  const openStreams: Array<{ close(): void }> = [];
  const bodyFetches: string[] = [];

  const dom = new JSDOM(pageHtml, {
    runScripts: 'dangerously',
    url: `http://127.0.0.1:${port}/a/${id}`,
    beforeParse(window: any) {
      // Minimal EventSource that connects to the real SSE route and parses
      // `data:`-carrying frames into onmessage calls (keepalive comments ignored).
      window.EventSource = class {
        onmessage: ((ev: { data: string }) => void) | null = null;
        onerror: ((ev: unknown) => void) | null = null;
        private req: http.ClientRequest;
        constructor(path: string) {
          const url = path.startsWith('http') ? path : `http://127.0.0.1:${port}${path}`;
          this.req = http.get(url, (res) => {
            res.setEncoding('utf-8');
            let buf = '';
            res.on('data', (c: string) => {
              buf += c;
              let idx: number;
              while ((idx = buf.indexOf('\n\n')) !== -1) {
                const block = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
                if (dataLine && this.onmessage) {
                  this.onmessage({ data: dataLine.slice('data:'.length).trim() });
                }
              }
            });
          });
          this.req.on('error', () => {});
          openStreams.push(this);
        }
        close() {
          this.req.destroy();
        }
      };
      // fetch that delegates to the real routes over HTTP.
      window.fetch = (path: string) => {
        const p = path.startsWith('http') ? new URL(path).pathname : path;
        if (p.endsWith('/body')) bodyFetches.push(p);
        return httpGet(p).then((r) => ({
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          text: () => Promise.resolve(r.body),
        }));
      };
    },
  });

  const content = () => dom.window.document.getElementById('artifact-content');
  const close = () => {
    openStreams.forEach((s) => s.close());
    dom.window.close();
  };
  return { dom, content, bodyFetches, openStreams, close };
}

/**
 * Publish a markdown artifact through the real tool handler and return the id.
 * Waits for the async event-persistence write to flush.
 */
async function publish(task: Task, agent: Agent, filename: string, content: string): Promise<string> {
  const path = await writeSource(filename, content);
  const out = await textOf(await commsHandler('publish_web_artifact', agent, task)({ path }));
  return extractId(out);
}

/** Poll the events.jsonl until a matching event lands (or time out). */
async function waitForEvent(taskId: string, type: string, externalId: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { events } = await readEvents(taskId);
    if (events.some((e) => e.type === type && e.taskId === taskId && (e.data as { externalId?: string }).externalId === externalId)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`event ${type}/${externalId} never appeared for ${taskId}`);
}

// =============================================================================
// AC1 + AC4 — publish returns a /a/<id> URL, records metadata, and the viewer
// serves rendered + sanitized HTML with a download link.
// =============================================================================
describe('publish + viewer render (AC1, AC4)', () => {
  it('publishes, records a web_artifacts entry, and serves sanitized HTML with a download link', async () => {
    const agent = makeAgent();
    const task = makeTask('task-ac1');
    const md = '# Report Title\n\nHello **world**.\n\n<script>alert(1)</script>\n\n[safe](https://example.com)\n';
    const out = await textOf(await commsHandler('publish_web_artifact', agent, task)({ path: await writeSource('report.md', md) }));

    // Returns a /a/<id> path-form URL.
    expect(out).toMatch(/\/a\/[0-9a-f-]{36}/);
    const id = extractId(out);

    // Writes a web_artifacts metadata entry (in memory and on disk).
    expect(task.metadata.web_artifacts).toHaveLength(1);
    expect(task.metadata.web_artifacts![0]).toMatchObject({
      external_id: id,
      source_filename: 'report.md',
      format: 'markdown',
    });
    const onDisk = JSON.parse(await readFile(getMetadataPath('task-ac1'), 'utf-8')) as TaskMetadata;
    expect(onDisk.web_artifacts![0].external_id).toBe(id);

    // A pointer file was written and resolves.
    const pointer = await resolveWebArtifact(id);
    expect(pointer).not.toBeNull();

    // GET /a/<id> serves rendered + sanitized HTML with a download link and nosniff.
    const res = await httpGet(`/a/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toMatch(/<h1[^>]*>Report Title<\/h1>/); // rendered markdown
    expect(res.body).not.toMatch(/<script>alert/i);          // sanitized (AC4)
    expect(res.body).toContain(`href="/a/${id}/source"`);    // download link
    expect(res.body).toMatch(/<a[^>]*href="https:\/\/example\.com"/); // safe link preserved
  });
});

// =============================================================================
// AC2 — update advances the pointer, keeps the URL, and the viewer serves the
// new content.
// =============================================================================
describe('update in place (AC2)', () => {
  it('advances the snapshot, keeps the same /a/<id>, and re-serves new content', async () => {
    const agent = makeAgent();
    const task = makeTask('task-ac2');
    const id = await publish(task, agent, 'v.md', '# Version One\n');

    const before = await resolveWebArtifact(id);
    const v1 = await httpGet(`/a/${id}`);
    expect(v1.body).toMatch(/Version One/);

    const v2Path = await writeSource('v2.md', '# Version Two Rewritten\n');
    const out = await textOf(
      await commsHandler('update_web_artifact', agent, task)({ external_id_or_url: `/a/${id}`, path: v2Path }),
    );

    // Same URL / id after update.
    expect(extractId(out)).toBe(id);

    // Pointer advanced to a new snapshot.
    const after = await resolveWebArtifact(id);
    expect(after!.snapshotPath).not.toBe(before!.snapshotPath);
    expect(task.metadata.web_artifacts).toHaveLength(1);
    expect(task.metadata.web_artifacts![0].external_id).toBe(id);

    // Viewer now serves the new content at the unchanged URL.
    const v2 = await httpGet(`/a/${id}`);
    expect(v2.status).toBe(200);
    expect(v2.body).toMatch(/Version Two Rewritten/);
    expect(v2.body).not.toMatch(/Version One/);
  });
});

// =============================================================================
// AC3 — two publishes across two tasks yield unique ids; no taskId in the URLs.
// =============================================================================
describe('taskId-free public identity across tasks (AC3)', () => {
  it('mints distinct ids and never encodes the taskId in the URL', async () => {
    const agent = makeAgent();
    const taskA = makeTask('task-ac3-alpha');
    const taskB = makeTask('task-ac3-beta');

    const outA = await textOf(await commsHandler('publish_web_artifact', agent, taskA)({ path: await writeSource('a.md', '# A\n') }));
    const outB = await textOf(await commsHandler('publish_web_artifact', agent, taskB)({ path: await writeSource('b.md', '# B\n') }));

    const idA = extractId(outA);
    const idB = extractId(outB);
    expect(idA).not.toBe(idB);
    expect(outA).not.toContain('task-ac3-alpha');
    expect(outB).not.toContain('task-ac3-beta');
    expect(`/a/${idA}`).not.toContain('task-ac3-alpha');
    expect(`/a/${idB}`).not.toContain('task-ac3-beta');
  });
});

// =============================================================================
// AC5 — the source download serves the original bytes as an attachment with the
// original filename and nosniff.
// =============================================================================
describe('source download (AC5)', () => {
  it('serves the original bytes as an attachment with the original filename + nosniff', async () => {
    const agent = makeAgent();
    const task = makeTask('task-ac5');
    const original = '# Original\n\nRaw markdown bytes.\n';
    const id = await publish(task, agent, 'original-name.md', original);

    const res = await httpGet(`/a/${id}/source`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="original-name.md"');
    expect(res.headers['content-type']).toMatch(/text\/markdown/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body).toBe(original);
  });
});

// =============================================================================
// AC10 — publishing .html is rejected with the #224 message; nothing is created.
// =============================================================================
describe('HTML rejection (AC10)', () => {
  it('rejects .html with the #224 deferral and creates no pointer or metadata entry', async () => {
    const agent = makeAgent();
    const task = makeTask('task-ac10');
    const pointersBefore = await countPointers();

    const out = await textOf(
      await commsHandler('publish_web_artifact', agent, task)({ path: await writeSource('page.html', '<h1>hi</h1>') }),
    );

    expect(out).toMatch(/^Error:/);
    expect(out).toMatch(/#224/);
    // No pointer file, no metadata entry, no on-disk task file.
    expect(await countPointers()).toBe(pointersBefore);
    expect(task.metadata.web_artifacts).toBeUndefined();
    expect(existsSync(getMetadataPath('task-ac10'))).toBe(false);
  });
});

// =============================================================================
// AC6 — publish/update persist artifact:published / artifact:updated events with
// the correct taskId to the task's events.jsonl.
// =============================================================================
describe('event persistence (AC6)', () => {
  it('writes artifact:published and artifact:updated events keyed by taskId', async () => {
    const agent = makeAgent();
    const task = makeTask('task-ac6');
    const id = await publish(task, agent, 'e.md', '# Events\n');
    await waitForEvent('task-ac6', 'artifact:published', id);

    const v2 = await writeSource('e2.md', '# Events v2\n');
    await commsHandler('update_web_artifact', agent, task)({ external_id_or_url: id, path: v2 });
    await waitForEvent('task-ac6', 'artifact:updated', id);

    const { events } = await readEvents('task-ac6');
    const published = events.find((e) => e.type === 'artifact:published');
    const updated = events.find((e) => e.type === 'artifact:updated');
    expect(published).toBeDefined();
    expect(updated).toBeDefined();
    expect(published!.taskId).toBe('task-ac6');
    expect(updated!.taskId).toBe('task-ac6');
    expect((published!.data as { externalId: string }).externalId).toBe(id);
    expect((updated!.data as { externalId: string }).externalId).toBe(id);

    // The events actually live in the task's events.jsonl on disk.
    expect(existsSync(getEventsLogPath('task-ac6'))).toBe(true);
  });
});

// =============================================================================
// AC9 — inter-agent sharing and file delivery never touch the web-artifact
// pointer store or metadata projection.
// =============================================================================
describe('sharing/delivery create no web artifacts (AC9)', () => {
  it('share_artifact and post_files_to_user create no pointer file and no web_artifacts entry', async () => {
    const agent = makeAgent();
    const task = makeTask('task-ac9', { withChannel: true });
    const pointersBefore = await countPointers();

    const doc = await writeSource('shared-doc.md', '# Shared\n');
    const shareOut = await textOf(await baseHandler('share_artifact', agent, task)({ path: doc, description: 'a doc' }));
    expect(shareOut).not.toMatch(/^Error:/);

    const fileOut = await textOf(await commsHandler('post_files_to_user', agent, task)({ paths: [doc] }));
    expect(fileOut).not.toMatch(/^Error:/);
    expect(task.postFilesToUser).toHaveBeenCalled();

    // Neither tool created a pointer or a web_artifacts metadata entry.
    expect(await countPointers()).toBe(pointersBefore);
    expect(task.metadata.web_artifacts).toBeUndefined();
  });
});

// =============================================================================
// AC7 — the viewer SSE is a narrow projection: only the target id's update
// signal is delivered; no taskId, no unrelated event, no other artifact leaks.
// =============================================================================
describe('narrow SSE projection (AC7)', () => {
  it('delivers only the target id\'s {type:"update"} signal and nothing else', async () => {
    const agent = makeAgent();
    const task = makeTask('task-ac7');
    const targetId = await publish(task, agent, 'target.md', '# Target\n');
    const otherId = await publish(makeTask('task-ac7-other'), agent, 'other.md', '# Other\n');

    // Open the raw SSE stream for the target id. The viewer route flushes
    // headers lazily (on first write), so the client's data callback fires only
    // once a signal is actually forwarded — attach the collector there and give
    // the server a beat to register its bus listener before emitting.
    const chunks: string[] = [];
    const req = http.get({ host: '127.0.0.1', port, path: `/a/${targetId}/events` }, (res) => {
      res.setEncoding('utf-8');
      res.on('data', (c: string) => chunks.push(c));
    });
    req.on('error', () => {}); // ignore the destroy-induced ECONNRESET below
    await new Promise((r) => setTimeout(r, 250)); // ensure onEvent listener is registered

    // 1) An unrelated task event (different type, different task).
    emitEvent('message', 'task-ac7-unrelated', { from: 'x', to: 'pm-agent', message: 'hi' });
    // 2) A second artifact's update — must NOT reach the target's stream.
    emitEvent('artifact:updated', 'task-ac7-other', { externalId: otherId });
    // 3) The target id's update — the ONLY signal that should be delivered.
    emitEvent('artifact:updated', 'task-ac7', { externalId: targetId });

    await new Promise((r) => setTimeout(r, 300));
    req.destroy();

    const raw = chunks.join('');
    const dataPayloads = raw
      .split('\n\n')
      .map((block) => block.split('\n').find((l) => l.startsWith('data:')))
      .filter((l): l is string => !!l)
      .map((l) => l.slice('data:'.length).trim());

    // Exactly one signal, and it is the minimal {type:'update'}.
    expect(dataPayloads).toHaveLength(1);
    expect(JSON.parse(dataPayloads[0])).toEqual({ type: 'update' });

    // No taskId, no other artifact id, no unrelated event content leaked.
    expect(raw).not.toContain('task-ac7');
    expect(raw).not.toContain('task-ac7-unrelated');
    expect(raw).not.toContain(otherId);
    expect(raw).not.toContain('message');
  });
});

// =============================================================================
// AC8 — hot reload end to end: an open viewer re-renders updated content with no
// manual refresh. This drives the EXACT contract the viewer's inline script runs
// (see renderViewerPage in routes.ts): open EventSource('/a/<id>/events'), and on
// each message re-fetch '/a/<id>/body' (cache: no-store) and swap it into the
// #artifact-content container. Here we exercise that whole loop over real HTTP
// against the real Express routes + real update tool handler.
//
// Two tests cover the AC. The first asserts the HTTP/SSE half: the frame is
// delivered and the /body fragment carries the new content. The second (via
// jsdom) closes what a Playwright-less QA boot could not: it runs the page's
// ACTUAL inline script in a real DOM and asserts the literal `el.innerHTML =
// html` DOM re-render happens on-screen — no chromium required, no manual check
// left to waive.
// =============================================================================
describe('hot reload end-to-end (AC8)', () => {
  it('an open SSE stream signals an update, and re-fetching /body serves the new content in place', async () => {
    const agent = makeAgent();
    const task = makeTask('task-ac8');
    const id = await publish(task, agent, 'live.md', '# Version One\n\nOriginal body.\n');

    // The page as first served shows v1 (this is the DOM's starting state).
    const initial = await httpGet(`/a/${id}`);
    expect(initial.status).toBe(200);
    expect(initial.body).toContain('Version One');
    // The inline hot-reload script is wired in: it binds this artifact's id and
    // opens an EventSource to /a/<id>/events (the URL is assembled from the id var).
    expect(initial.body).toContain(`var id = ${JSON.stringify(id)}`);
    expect(initial.body).toContain("new EventSource('/a/' + id + '/events')");

    // Open the artifact's SSE stream — this is `new EventSource('/a/<id>/events')`.
    const chunks: string[] = [];
    const sse = http.get({ host: '127.0.0.1', port, path: `/a/${id}/events` }, (res) => {
      res.setEncoding('utf-8');
      res.on('data', (c: string) => chunks.push(c));
    });
    sse.on('error', () => {}); // ignore destroy-induced ECONNRESET on teardown
    await new Promise((r) => setTimeout(r, 250)); // let the route register its bus listener

    // Advance the artifact in place through the real update tool handler — this
    // emits artifact:updated, which the SSE route projects to the open stream.
    const v2 = await writeSource('live.md', '# Version Two\n\nUpdated body.\n');
    await commsHandler('update_web_artifact', agent, task)({ external_id_or_url: `/a/${id}`, path: v2 });

    // Wait for the SSE frame to arrive — this is what fires the script's onmessage.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !chunks.join('').includes('"update"')) {
      await new Promise((r) => setTimeout(r, 25));
    }
    sse.destroy();

    // The minimal update signal was delivered to the open viewer.
    const frame = chunks
      .join('')
      .split('\n\n')
      .map((b) => b.split('\n').find((l) => l.startsWith('data:')))
      .find((l): l is string => !!l);
    expect(frame).toBeDefined();
    expect(JSON.parse(frame!.slice('data:'.length).trim())).toEqual({ type: 'update' });

    // onmessage → fetch('/a/<id>/body', { cache: 'no-store' }): the fragment the
    // script swaps into #artifact-content now carries the NEW content, and the old
    // content is gone — i.e. the open page re-renders without a manual refresh.
    const body = await httpGet(`/a/${id}/body`);
    expect(body.status).toBe(200);
    expect(body.body).toContain('Version Two');
    expect(body.body).toContain('Updated body.');
    expect(body.body).not.toContain('Version One');
    expect(body.body).not.toContain('Original body.');

    // And the URL never changed across the update — same /a/<id> throughout.
    const reopened = await httpGet(`/a/${id}`);
    expect(reopened.status).toBe(200);
    expect(reopened.body).toContain('Version Two');
  });

  it('re-renders the live DOM in place: the page\'s own script performs el.innerHTML = <new body> (no chromium)', async () => {
    const agent = makeAgent();
    const task = makeTask('task-ac8-dom');
    const id = await publish(task, agent, 'live-dom.md', '# Version One\n\nOriginal body.\n');

    // Load the REAL served page into a real DOM and run its REAL inline script.
    const page = await httpGet(`/a/${id}`);
    expect(page.status).toBe(200);
    const viewer = openBrowserViewer(page.body, id);

    try {
      // Starting DOM state — this is exactly what a viewer sees before any update.
      expect(viewer.content()).not.toBeNull();
      expect(viewer.content()!.innerHTML).toContain('Version One');
      expect(viewer.content()!.innerHTML).toContain('Original body.');

      // The script opened exactly one live SSE connection to this artifact's stream.
      expect(viewer.openStreams).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 250)); // let the route register its bus listener

      // Advance in place through the real update tool. This emits artifact:updated,
      // the SSE route projects a frame to the open connection, the page's onmessage
      // fires, it fetches /body, and executes `el.innerHTML = html` — all for real.
      const v2 = await writeSource('live-dom.md', '# Version Two\n\nUpdated body.\n');
      await commsHandler('update_web_artifact', agent, task)({ external_id_or_url: `/a/${id}`, path: v2 });

      // Poll the LIVE DOM until the in-place re-render lands.
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !viewer.content()!.innerHTML.includes('Version Two')) {
        await new Promise((r) => setTimeout(r, 25));
      }

      // The literal browser DOM re-render executed: #artifact-content now holds the
      // NEW rendered content and the OLD content is gone — with no manual refresh.
      expect(viewer.content()!.innerHTML).toContain('Version Two');
      expect(viewer.content()!.innerHTML).toContain('Updated body.');
      expect(viewer.content()!.innerHTML).not.toContain('Version One');
      expect(viewer.content()!.innerHTML).not.toContain('Original body.');

      // The swap went through the /body fragment fetch the script wires up.
      expect(viewer.bodyFetches).toContain(`/a/${id}/body`);
    } finally {
      viewer.close();
    }
  });
});
