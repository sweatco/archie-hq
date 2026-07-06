/**
 * API Routes — REST + SSE endpoints for CLI and external clients
 *
 * Mounted on the existing Express app. Provides:
 * - SSE event stream (real-time updates)
 * - Task CRUD (list, detail, create, message, approve)
 */

import type { Application, Request, Response } from 'express';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const express = require('express');

import { readdirSync } from 'fs';
import { onEvent, offEvent, emitEvent } from '../../system/event-bus.js';
import { Task, activeTasks } from '../../tasks/task.js';
import {
  readKnowledgeLog,
  loadMetadata,
  appendCliMessage,
  readEvents,
} from '../../tasks/persistence.js';
import { SESSIONS_DIR } from '../../system/workdir.js';
import { AGENT_PROMPTS } from '../../agents/prompts.js';
import { logger } from '../../system/logger.js';

/**
 * Mount API routes on an existing Express app.
 */
export function mountApiRoutes(app: Application): void {
  const router = express.Router();
  router.use(express.json());

  // ---- SSE: real-time event stream ----

  router.get('/events/stream', (req: Request, res: Response) => {
    const taskIdFilter = req.query.taskId as string | undefined;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx/proxy buffering for SSE
    });

    // Send initial connected event
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    const listener = (event: any) => {
      if (taskIdFilter && event.taskId !== taskIdFilter) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
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

  // ---- GET /tasks — list tasks ----

  router.get('/tasks', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
      const offset = parseInt(req.query.offset as string, 10) || 0;

      // Read task dirs from disk, sorted newest first
      const allDirs = readdirSync(SESSIONS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith('task-'))
        .map((d) => d.name)
        .sort((a, b) => b.localeCompare(a));

      const total = allDirs.length;
      const dirs = allDirs.slice(offset, offset + limit);

      const tasks = [];
      for (const dir of dirs) {
        const metadata = await loadMetadata(dir);
        if (!metadata) continue;

        const activeTask = activeTasks.get(dir);

        // Extract channel name from default channel
        let channel_name: string | null = null;
        if (metadata.default_channel && metadata.channels[metadata.default_channel]) {
          const ch = metadata.channels[metadata.default_channel];
          if (ch.type === 'slack') channel_name = ch.channel_name;
          else if (ch.type === 'cli') channel_name = 'cli';
        }

        tasks.push({
          task_id: metadata.task_id,
          status: metadata.status,
          task_owner: metadata.task_owner,
          participants: metadata.participants,
          created_at: metadata.created_at,
          updated_at: metadata.updated_at,
          title: metadata.title ?? null,
          channel_name,
          reminder: metadata.reminder ?? null,
          agents: activeTask ? activeTask.getAgentStatus() : [],
        });
      }

      res.json({ tasks, total, offset, limit });
    } catch (error) {
      logger.error('api', 'Failed to list tasks', error);
      res.status(500).json({ error: 'Failed to list tasks' });
    }
  });

  // ---- GET /tasks/:id — task detail ----

  router.get('/tasks/:id', async (req: Request, res: Response) => {
    try {
      const taskId = req.params.id as string;
      const metadata = await loadMetadata(taskId);
      if (!metadata) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }

      const knowledgeLog = await readKnowledgeLog(taskId);
      const activeTask = activeTasks.get(taskId);

      // Build agents list: start from metadata (all agents that ever participated),
      // then overlay live status from in-memory task if available
      const liveAgents = activeTask ? activeTask.getAgentStatus() : [];
      const liveMap = new Map(liveAgents.map((a) => [a.agent, a]));
      const agents = Object.entries(metadata.agent_sessions).map(([name, session]) => {
        const live = liveMap.get(name);
        if (live) return live;
        const s = typeof session === 'string' ? { active: false } : session;
        return { agent: name, active: s.active, last_activity: s.last_activity };
      });
      // Add any live agents not in metadata (shouldn't happen, but be safe)
      for (const live of liveAgents) {
        if (!metadata.agent_sessions[live.agent]) {
          agents.push(live);
        }
      }

      res.json({ metadata, knowledgeLog, agents });
    } catch (error) {
      logger.error('api', 'Failed to get task detail', error);
      res.status(500).json({ error: 'Failed to get task detail' });
    }
  });

  // ---- GET /tasks/:id/events — event log (JSONL replay) ----

  router.get('/tasks/:id/events', async (req: Request, res: Response) => {
    try {
      const after = req.query.after ? parseInt(req.query.after as string, 10) : undefined;
      const result = await readEvents(req.params.id as string, after);
      res.json(result);
    } catch (error) {
      logger.error('api', 'Failed to read events', error);
      res.status(500).json({ error: 'Failed to read events' });
    }
  });

  // ---- POST /tasks — create task from CLI ----

  router.post('/tasks', async (req: Request, res: Response) => {
    try {
      const { message } = req.body;
      if (!message || typeof message !== 'string') {
        res.status(400).json({ error: 'message is required' });
        return;
      }

      const task = await Task.create();
      task.linkCliChannel();
      await appendCliMessage(task.taskId, message);
      await task.sendMessage(AGENT_PROMPTS.newTask);

      res.status(201).json({ task_id: task.taskId });
    } catch (error) {
      logger.error('api', 'Failed to create task', error);
      res.status(500).json({ error: 'Failed to create task' });
    }
  });

  // ---- POST /tasks/:id/message — send message to PM ----

  router.post('/tasks/:id/message', async (req: Request, res: Response) => {
    try {
      const taskId = req.params.id as string;
      const { message } = req.body;
      if (!message || typeof message !== 'string') {
        res.status(400).json({ error: 'message is required' });
        return;
      }

      await appendCliMessage(taskId, message);

      const task = await Task.get(taskId);
      task.linkCliChannel();
      await task.sendMessage(AGENT_PROMPTS.existingTask);

      res.json({ ok: true });
    } catch (error) {
      logger.error('api', 'Failed to send message', error);
      res.status(500).json({ error: 'Failed to send message' });
    }
  });

  // ---- POST /tasks/:id/approve — approve/deny edit mode, research budget, or merge ----

  router.post('/tasks/:id/approve', async (req: Request, res: Response) => {
    try {
      const taskId = req.params.id as string;
      const { type, approve, approver, github, pr_number } = req.body as {
        type: string;
        approve: boolean;
        // Optional resolved human (id/name/email) to author commits as. CLI/API
        // callers have no Slack identity by default; when omitted, commits stay
        // bot-authored.
        approver?: { id: string; name: string; email?: string };
        // PR identity — required for merge-type requests, verified against the
        // pending request inside the Task resolution methods.
        github?: string;
        pr_number?: number;
      };

      if (!type || typeof approve !== 'boolean') {
        res.status(400).json({ error: 'type and approve are required' });
        return;
      }

      // Merge-type requests must name the PR being resolved; the Task method
      // verifies it against the pending request atomically.
      let mergeExpected: { github: string; pr_number: number } | undefined;
      if (type === 'merge') {
        if (typeof github !== 'string' || !github || typeof pr_number !== 'number') {
          res.status(400).json({ error: 'merge approval requires github and pr_number' });
          return;
        }
        mergeExpected = { github, pr_number };
      }

      // Normalize the optional approver: a non-empty name is required (an empty
      // git author name fatals every commit), so drop the approver entirely when
      // it's missing/blank rather than persisting garbage — authoring then falls
      // back to the bot.
      const cleanApprover =
        approver && typeof approver.name === 'string' && approver.name.trim()
          ? {
              id: typeof approver.id === 'string' ? approver.id : '',
              name: approver.name.trim(),
              email:
                typeof approver.email === 'string' && approver.email.trim()
                  ? approver.email.trim()
                  : undefined,
            }
          : undefined;

      const task = await Task.get(taskId);

      if (type === 'edit_mode') {
        if (approve) {
          await task.handleEditModeApproval(cleanApprover);
        } else {
          await task.handleEditModeDenial();
        }
      } else if (type === 'research_budget') {
        if (approve) {
          await task.handleResearchBudgetApproval();
        } else {
          await task.handleResearchBudgetDenial();
        }
      } else if (mergeExpected) {
        if (approve) {
          await task.handleMergeApproval(cleanApprover, mergeExpected);
        } else {
          await task.handleMergeDenial(mergeExpected);
        }
      } else {
        res.status(400).json({ error: `Unknown approval type: ${type}` });
        return;
      }

      emitEvent('approval:resolved', taskId, { type, approve });
      res.json({ ok: true });
    } catch (error) {
      logger.error('api', 'Failed to process approval', error);
      res.status(500).json({ error: 'Failed to process approval' });
    }
  });

  app.use('/api', router);
  logger.plain('API routes: /api/tasks, /api/events/stream');
}
