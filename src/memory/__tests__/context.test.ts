/**
 * Memory Context Builder Tests
 *
 * Uses temp directories and mocked paths/store modules to test context assembly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Set up the mocks before importing the module under test
let tempDir: string;
let usersDir: string;
let activityPath: string;
let memoryEnabled = true;
let injectionEnabled = false;

let entitiesDir: string;
let tasksDir: string;
let touchedByMax = 10;

vi.mock('../paths.js', () => ({
  isMemoryEnabled: () => memoryEnabled,
  isInjectionEnabled: () => injectionEnabled,
  getUserPath: (id: string) => {
    const safe = id.includes(':') ? id.replace(':', '__') : id;
    return join(usersDir, `${safe}.md`);
  },
  getUsersDir: () => usersDir,
  getMemoryDir: () => tempDir,
  getRecentActivityPath: () => activityPath,
  getEntitiesDir: () => entitiesDir,
  getEntityIndexPath: () => join(entitiesDir, 'index.md'),
  getEntityPath: (slug: string) => join(entitiesDir, `${slug}.md`),
  getEntityCap: () => 300,
  getEntityInjectMax: () => 8,
  getOrgInjectMax: () => 8,
  getEntityObsCap: () => 30,
  getTouchedByInjectMax: () => touchedByMax,
  getTaskTelemetryPath: (taskId: string) => join(tasksDir, taskId, 'telemetry.jsonl'),
  isValidEntitySlug: (s: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(s) && s !== 'index',
}));

// store.ts reads from paths.js which we've mocked above
import { buildMemoryContext, enrichPromptWithMemory } from '../context.js';
import { logger } from '../../system/logger.js';

describe('memory context builder', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'archie-context-test-'));
    usersDir = join(tempDir, 'users');
    activityPath = join(tempDir, 'recent-activity.md');
    entitiesDir = join(tempDir, 'entities');
    memoryEnabled = true;
    injectionEnabled = false; // production default; positive tests opt in explicitly
    touchedByMax = 10;
    tasksDir = join(tempDir, 'tasks');
  });

  // Helper: write an entity file into the temp entities dir.
  async function writeEntity(slug: string, frontmatter: Record<string, string>, facts: string[] = [], relations: string[] = []) {
    await mkdir(entitiesDir, { recursive: true });
    const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n');
    const body = [
      '---', `entity: ${slug}`, fm, '---', `<!-- L0: ${slug} summary -->`, '',
      '## Facts', ...facts, '', '## Relations', ...relations, '',
    ].join('\n');
    await writeFile(join(entitiesDir, `${slug}.md`), body, 'utf-8');
  }

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ---- buildMemoryContext ----

  describe('buildMemoryContext(usernames)', () => {
    it('never emits an <organizational_knowledge> block (org.md retired)', async () => {
      // Even with a stray org.md on disk, it is not read or injected.
      await writeFile(join(tempDir, 'org.md'), '## Engineering\n- Uses TypeScript\n', 'utf-8');

      const result = await buildMemoryContext([]);

      expect(result).not.toContain('<organizational_knowledge>');
    });

    it('includes <user_preferences user_id="..."> block when user file exists', async () => {
      await mkdir(usersDir, { recursive: true });
      const userContent = '## Communication\n- Prefers async\n';
      await writeFile(join(usersDir, 'U07DANA001.md'), userContent, 'utf-8');

      const result = await buildMemoryContext([{ userId: 'U07DANA001', displayName: 'Dana L' }]);

      expect(result).toContain('<user_preferences user_id="U07DANA001"');
      expect(result).toContain('display_name="Dana L"');
      expect(result).toContain('</user_preferences>');
      expect(result).toContain('## Communication');
      expect(result).toContain('- Prefers async');
    });

    it('omits display_name attribute when it equals the user_id', async () => {
      await mkdir(usersDir, { recursive: true });
      await writeFile(join(usersDir, 'U07DANA001.md'), '- fact\n', 'utf-8');

      const result = await buildMemoryContext([{ userId: 'U07DANA001', displayName: 'U07DANA001' }]);

      expect(result).toContain('<user_preferences user_id="U07DANA001">');
      expect(result).not.toContain('display_name=');
    });

    it('accepts legacy string array for backward compatibility', async () => {
      await mkdir(usersDir, { recursive: true });
      await writeFile(join(usersDir, 'U07DANA001.md'), '- fact\n', 'utf-8');

      const result = await buildMemoryContext(['U07DANA001']);

      expect(result).toContain('<user_preferences user_id="U07DANA001">');
    });

    it('includes <recent_activity> block when recent-activity.md has content', async () => {
      const activityContent = '# Recent Activity\n\n| Date | Task ID | Summary | Domain | User |\n|------|---------|---------|--------|------|\n| 2026-04-10 | task-001 | Fixed bug | engineering | dana |\n';
      await writeFile(activityPath, activityContent, 'utf-8');

      const result = await buildMemoryContext([]);

      expect(result).toContain('<recent_activity>');
      expect(result).toContain('</recent_activity>');
      expect(result).toContain('task-001');
    });

    it('skips users with no memory file (no user_preferences tag)', async () => {
      // Do not create any user file for U07UNKNOWN
      const result = await buildMemoryContext([{ userId: 'U07UNKNOWN', displayName: 'Unknown' }]);

      expect(result).not.toContain('<user_preferences');
    });

    it('returns empty string when all files are empty/missing', async () => {
      const result = await buildMemoryContext([]);

      expect(result).toBe('');
    });

    it('joins multiple non-empty blocks with double newlines', async () => {
      await mkdir(usersDir, { recursive: true });
      const userContent = '## Communication\n- Prefers async\n';
      await writeFile(join(usersDir, 'U07DANA001.md'), userContent, 'utf-8');

      const activityContent = '# Recent Activity\n\n| Date | Task ID | Summary | Domain | User |\n|------|---------|---------|--------|------|\n| 2026-04-10 | task-001 | Fixed bug | engineering | dana |\n';
      await writeFile(activityPath, activityContent, 'utf-8');

      const result = await buildMemoryContext([{ userId: 'U07DANA001', displayName: 'Dana' }]);

      expect(result).toContain('<user_preferences user_id="U07DANA001"');
      expect(result).toContain('<recent_activity>');
      expect(result).toContain('</user_preferences>\n\n<recent_activity>');
    });
  });

  // ---- enrichPromptWithMemory ----

  describe('enrichPromptWithMemory(systemPrompt, usernames)', () => {
    it('appends memory context to prompt when injection is enabled and memory exists', async () => {
      injectionEnabled = true;
      await mkdir(usersDir, { recursive: true });
      await writeFile(join(usersDir, 'U07DANA001.md'), '## Communication\n- Prefers async\n', 'utf-8');

      const result = await enrichPromptWithMemory('base prompt', [{ userId: 'U07DANA001', displayName: 'Dana' }]);

      expect(result).toContain('base prompt');
      expect(result).toContain('## Organizational Memory');
      expect(result).toContain('The following is what you know from previous tasks');
      expect(result).toContain('<user_preferences user_id="U07DANA001"');
    });

    it('returns systemPrompt unchanged when memory is disabled', async () => {
      memoryEnabled = false;
      await mkdir(usersDir, { recursive: true });
      await writeFile(join(usersDir, 'U07DANA001.md'), '## Communication\n- Prefers async\n', 'utf-8');

      const result = await enrichPromptWithMemory('base prompt', [{ userId: 'U07DANA001', displayName: 'Dana' }]);

      expect(result).toBe('base prompt');
    });

    it('returns systemPrompt unchanged when injection is on but all memory is empty', async () => {
      injectionEnabled = true;
      const result = await enrichPromptWithMemory('base prompt', []);

      expect(result).toBe('base prompt');
    });

    it('returns systemPrompt unchanged when injection is disabled, even with memory present', async () => {
      injectionEnabled = false; // production default
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
      await mkdir(usersDir, { recursive: true });
      await writeFile(join(usersDir, 'U07DANA001.md'), '## Communication\n- Prefers async\n', 'utf-8');

      const result = await enrichPromptWithMemory('base prompt', [{ userId: 'U07DANA001', displayName: 'Dana' }]);

      expect(result).toBe('base prompt');
      expect(result).not.toContain('## Organizational Memory');
      // Gate fires before any store read and logs exactly one debug line.
      expect(debugSpy).toHaveBeenCalledTimes(1);
      expect(debugSpy.mock.calls[0]?.[1]).toMatch(/injection disabled/i);
      debugSpy.mockRestore();
    });

    it('master flag wins: ARCHIE_MEMORY=false suppresses injection even when ARCHIE_MEMORY_INJECT=true', async () => {
      memoryEnabled = false;
      injectionEnabled = true;
      await mkdir(usersDir, { recursive: true });
      await writeFile(join(usersDir, 'U07DANA001.md'), '- fact\n', 'utf-8');

      const result = await enrichPromptWithMemory('base prompt', [{ userId: 'U07DANA001', displayName: 'Dana' }]);

      expect(result).toBe('base prompt');
    });
  });

  // ---- Entity layer injection ----

  describe('entity layer injection', () => {
    const FM = (over: Record<string, string>) => ({
      type: 'service',
      display_name: '"Entity"',
      aliases: '[]',
      scope: 'org',
      repos: '[]',
      domain: 'engineering',
      status: 'active',
      ...over,
    });

    it('injects <entity_index> whenever any entity exists', async () => {
      await writeEntity('payment-service', FM({ display_name: '"Payment Service"' }), [
        '- [fact] NestJS  <!-- touched: 2026-05-01 -->',
      ]);
      const result = await buildMemoryContext([]);
      expect(result).toContain('<entity_index>');
      expect(result).toContain('[[payment-service]]');
    });

    it('selects repo-scoped and signal-bearing org-scoped entities for a repo agent', async () => {
      await writeEntity('payment-service', FM({ display_name: '"Payment Service"', scope: 'repo', repos: '[backend]' }));
      await writeEntity('stripe', FM({ display_name: '"Stripe"', type: 'integration', scope: 'org' }));
      await writeEntity('mobile-app', FM({ display_name: '"Mobile App"', scope: 'repo', repos: '[mobile]' }));

      const result = await buildMemoryContext([], { repo: 'backend', taskTitle: 'stripe webhooks failing' });
      expect(result).toContain('<entity slug="payment-service"'); // repo match
      expect(result).toContain('<entity slug="stripe"'); // scope:org with a title-token signal
      expect(result).not.toContain('<entity slug="mobile-app"'); // other repo, no signal
    });

    it('keeps a zero-signal org entity index-only (org budget is a ceiling)', async () => {
      await writeEntity('launchdarkly', FM({ display_name: '"LaunchDarkly"', type: 'integration', scope: 'org' }));

      const result = await buildMemoryContext([], { repo: 'backend', taskTitle: 'fix login flow' });
      expect(result).toContain('<entity_index>');
      expect(result).toContain('[[launchdarkly]]'); // discoverable via its index row
      expect(result).not.toContain('<entity slug="launchdarkly"'); // no full page despite spare budget
    });

    it('pulls a one-hop linked entity even when not directly matched', async () => {
      await writeEntity(
        'payment-service',
        FM({ display_name: '"Payment Service"', scope: 'repo', repos: '[backend]' }),
        [],
        ['- depends_on [[postgres-prod]]'],
      );
      await writeEntity('postgres-prod', FM({ display_name: '"Postgres Prod"', type: 'system', scope: 'repo', repos: '[infra]' }));

      const result = await buildMemoryContext([], { repo: 'backend' });
      expect(result).toContain('<entity slug="payment-service"');
      expect(result).toContain('<entity slug="postgres-prod"'); // via depends_on edge
    });

    it('emits no entity blocks when there are no entities', async () => {
      const result = await buildMemoryContext([], { repo: 'backend' });
      expect(result).not.toContain('<entity_index>');
      expect(result).not.toContain('<entity slug=');
    });

    it('renders only the newest touched_by edges, leaves other relations and the file intact', async () => {
      touchedByMax = 2;
      await writeEntity(
        'payment-service',
        FM({ display_name: '"Payment Service"', scope: 'repo', repos: '[backend]' }),
        [],
        [
          '- depends_on [[postgres-prod]]',
          '- touched_by [[task-001]]',
          '- touched_by [[task-002]]',
          '- touched_by [[task-003]]',
          '- touched_by [[task-004]]',
        ],
      );

      const result = await buildMemoryContext([], { repo: 'backend' });
      const block = result.slice(result.indexOf('<entity slug="payment-service"'), result.indexOf('</entity>'));
      expect(block).toContain('depends_on [[postgres-prod]]'); // other types uncapped
      expect(block).not.toContain('touched_by [[task-001]]');
      expect(block).not.toContain('touched_by [[task-002]]');
      expect(block).toContain('touched_by [[task-003]]'); // newest two kept
      expect(block).toContain('touched_by [[task-004]]');

      // Render-time only: the stored page keeps the full history.
      const onDisk = await readFile(join(entitiesDir, 'payment-service.md'), 'utf-8');
      for (const t of ['task-001', 'task-002', 'task-003', 'task-004']) {
        expect(onDisk).toContain(`touched_by [[${t}]]`);
      }
    });

    it('renders no touched_by edges when the render cap is 0', async () => {
      touchedByMax = 0;
      await writeEntity(
        'payment-service',
        FM({ display_name: '"Payment Service"', scope: 'repo', repos: '[backend]' }),
        [],
        ['- depends_on [[postgres-prod]]', '- touched_by [[task-001]]'],
      );

      const result = await buildMemoryContext([], { repo: 'backend' });
      expect(result).toContain('depends_on [[postgres-prod]]');
      expect(result).not.toContain('touched_by');
    });
  });

  describe('selection sensor (memory/tasks/<taskId>/telemetry.jsonl)', () => {
    const TASK = 'task-20260702-0001-sensor';
    const FM = (over: Record<string, string>) => ({
      type: 'service',
      display_name: '"Entity"',
      aliases: '[]',
      scope: 'org',
      repos: '[]',
      domain: 'engineering',
      status: 'active',
      ...over,
    });
    const sensorFile = () => join(tasksDir, TASK, 'telemetry.jsonl');

    it('appends one parseable record per enriched spawn, with context, outcome, and cost', async () => {
      injectionEnabled = true;
      await writeEntity('payment-service', FM({ display_name: '"Payment Service"', scope: 'repo', repos: '[backend]' }));
      await writeEntity('launchdarkly', FM({ display_name: '"LaunchDarkly"', type: 'integration' })); // zero-signal org
      await mkdir(usersDir, { recursive: true });
      await writeFile(join(usersDir, 'U07DANA001.md'), '- prefers async\n', 'utf-8');

      await buildMemoryContext([{ userId: 'U07DANA001', displayName: 'Dana' }], {
        repo: 'backend',
        taskTitle: 'payment bug',
        taskId: TASK,
        agent: 'backend-agent',
      });

      const lines = (await readFile(sensorFile(), 'utf-8')).trim().split('\n');
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]);
      expect(record.v).toBe(1);
      expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(record.taskId).toBe(TASK);
      expect(record.agent).toBe('backend-agent');
      expect(record.ctx).toEqual({ repo: 'backend', plugin: null, taskTitle: 'payment bug', userIds: ['U07DANA001'] });
      expect(record.selected).toEqual([{ slug: 'payment-service', score: expect.any(Number), scope: 'repo' }]);
      expect(record.dropped).toEqual([]);
      expect(record.zeroSignalExcluded).toBe(1);
      expect(record.candidates).toBe(1);
      expect(record.budgets).toEqual({ org: 8, nonOrg: 8 });
      expect(record.renderedTokensEst).toBeGreaterThan(0);
    });

    it('appends one line per enrichment — a zero-injection spawn still leaves a record', async () => {
      injectionEnabled = true;
      await buildMemoryContext([], { taskId: TASK, agent: 'pm' });
      await buildMemoryContext([], { taskId: TASK, agent: 'backend-agent' });

      const lines = (await readFile(sensorFile(), 'utf-8')).trim().split('\n');
      expect(lines).toHaveLength(2);
      const record = JSON.parse(lines[1]);
      expect(record.agent).toBe('backend-agent');
      expect(record.selected).toEqual([]);
      expect(record.renderedTokensEst).toBe(0);
    });

    it('sensor failure never affects enrichment: unwritable telemetry path → warning, identical context', async () => {
      injectionEnabled = true;
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      await writeFile(tasksDir, 'blocks mkdir', 'utf-8'); // a file where the tasks dir should be
      await writeEntity('payment-service', FM({ display_name: '"Payment Service"', scope: 'repo', repos: '[backend]' }));

      const withSensor = await buildMemoryContext([], { repo: 'backend', taskId: TASK });
      const withoutSensor = await buildMemoryContext([], { repo: 'backend' });

      expect(withSensor).toBe(withoutSensor);
      expect(warn).toHaveBeenCalledWith('memory', expect.stringContaining('selection sensor write failed'));
      expect(existsSync(sensorFile())).toBe(false);
      warn.mockRestore();
    });

    it('disabled injection writes nothing even when a taskId is supplied', async () => {
      await writeEntity('payment-service', FM({ display_name: '"Payment Service"', scope: 'repo', repos: '[backend]' }));

      await buildMemoryContext([], { repo: 'backend', taskId: TASK });

      expect(existsSync(sensorFile())).toBe(false);
    });

    it('missing taskId: context still built, no record written', async () => {
      injectionEnabled = true;
      await writeEntity('payment-service', FM({ display_name: '"Payment Service"', scope: 'repo', repos: '[backend]' }));

      const result = await buildMemoryContext([], { repo: 'backend', agent: 'backend-agent' });

      expect(result).toContain('<entity slug="payment-service"');
      expect(existsSync(tasksDir)).toBe(false);
    });
  });
});
