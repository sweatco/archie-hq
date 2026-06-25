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
import { listTriggers, loadTrigger, saveTrigger, deleteTrigger, countActiveTriggers } from '../../system/trigger-store.js';
import { indexTrigger, deindexTrigger, announceTriggerChange, describeTrigger, MAX_TRIGGERS_PER_USER, MAX_TRIGGERS_PER_CHANNEL } from '../../system/trigger-scheduler.js';
import type { Trigger } from '../../types/trigger.js';

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

  // ---- POST /tasks/:id/approve — approve/deny edit mode or research budget ----

  router.post('/tasks/:id/approve', async (req: Request, res: Response) => {
    try {
      const taskId = req.params.id as string;
      const { type, approve, approver, ref } = req.body as {
        type: string;
        approve: boolean;
        // Optional resolved human (id/name/email) to author commits as. CLI/API
        // callers have no Slack identity by default; when omitted, commits stay
        // bot-authored.
        approver?: { id: string; name: string; email?: string };
        // Optional opaque id the approval applies to (e.g. a trigger id), echoed
        // from the approval event so the right pending item resolves.
        ref?: string;
      };

      if (!type || typeof approve !== 'boolean') {
        res.status(400).json({ error: 'type and approve are required' });
        return;
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
      } else if (type === 'trigger') {
        // CLI [y]/[n] on a proposed trigger — same task-level handler the Slack
        // Approve/Deny buttons call. `ref` carries the specific trigger id (the
        // CLI echoes it from the approval event), so the right one resolves even
        // when several proposals are outstanding. Approver is the CLI operator.
        if (approve) {
          await task.handleTriggerApproval('cli', ref);
        } else {
          await task.handleTriggerDenial(ref);
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

  // ---- Triggers (operator surface — full visibility, mirrors /tasks) ----

  /** Shape a trigger for the CLI/API, surfacing its bound channel like /tasks. */
  const shapeTrigger = (t: Trigger) => ({
    id: t.id,
    status: t.status,
    created_by: t.created_by,
    created_at: t.created_at,
    last_fired_at: t.last_fired_at ?? null,
    binding_kind: t.binding.type,
    channel_name: t.binding.type === 'channel' ? t.binding.channel_name : 'DM',
    action_prompt: t.action.prompt,
    summary: describeTrigger(t),
  });

  // GET /triggers — list all triggers with their bound channel
  router.get('/triggers', async (_req: Request, res: Response) => {
    try {
      const triggers = (await listTriggers())
        .filter((t) => t.status !== 'pending')
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      res.json({ triggers: triggers.map(shapeTrigger), total: triggers.length });
    } catch (error) {
      logger.error('api', 'Failed to list triggers', error);
      res.status(500).json({ error: 'Failed to list triggers' });
    }
  });

  // GET /triggers/:id — trigger detail
  router.get('/triggers/:id', async (req: Request, res: Response) => {
    try {
      const trigger = await loadTrigger(req.params.id as string);
      if (!trigger || trigger.status === 'pending') {
        res.status(404).json({ error: 'Trigger not found' });
        return;
      }
      res.json({ trigger });
    } catch (error) {
      logger.error('api', 'Failed to get trigger', error);
      res.status(500).json({ error: 'Failed to get trigger' });
    }
  });

  // PATCH /triggers/:id — pause/resume or edit the action prompt
  router.patch('/triggers/:id', async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const { status, action_prompt } = req.body as { status?: 'paused' | 'enabled'; action_prompt?: string };
      const trigger = await loadTrigger(id);
      if (!trigger || trigger.status === 'pending') {
        res.status(404).json({ error: 'Trigger not found' });
        return;
      }

      const editedContent = typeof action_prompt === 'string';
      let statusChange: 'paused' | 'resumed' | null = null;
      if (editedContent) trigger.action.prompt = action_prompt as string;
      if (status && status !== trigger.status) {
        // Re-check caps on resume so pause→resume can't bypass the limit.
        if (status === 'enabled') {
          if (trigger.binding.type === 'channel') {
            const channelId = trigger.binding.channel_id;
            const perChannel = await countActiveTriggers((t) => t.binding.type === 'channel' && t.binding.channel_id === channelId);
            if (perChannel >= MAX_TRIGGERS_PER_CHANNEL) {
              res.status(409).json({ error: `Channel is at the maximum of ${MAX_TRIGGERS_PER_CHANNEL} active triggers.` });
              return;
            }
          }
          if (trigger.created_by && trigger.created_by !== 'unknown') {
            const createdBy = trigger.created_by;
            const perUser = await countActiveTriggers((t) => t.created_by === createdBy);
            if (perUser >= MAX_TRIGGERS_PER_USER) {
              res.status(409).json({ error: `User is at the maximum of ${MAX_TRIGGERS_PER_USER} active triggers.` });
              return;
            }
          }
        }
        trigger.status = status;
        statusChange = status === 'paused' ? 'paused' : 'resumed';
      }
      if (!editedContent && !statusChange) {
        res.status(400).json({ error: 'Pass status or action_prompt to update.' });
        return;
      }

      await saveTrigger(trigger);
      if (trigger.status === 'enabled') indexTrigger(trigger);
      else deindexTrigger(trigger.id);

      if (statusChange === 'paused') emitEvent('trigger:paused', trigger.id, { trigger_id: trigger.id });
      else if (statusChange === 'resumed') emitEvent('trigger:resumed', trigger.id, { trigger_id: trigger.id });
      await announceTriggerChange(trigger, editedContent ? 'edited' : statusChange!);

      res.json({ ok: true, trigger: shapeTrigger(trigger) });
    } catch (error) {
      logger.error('api', 'Failed to update trigger', error);
      res.status(500).json({ error: 'Failed to update trigger' });
    }
  });

  // DELETE /triggers/:id — remove a trigger
  router.delete('/triggers/:id', async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const trigger = await loadTrigger(id);
      if (!trigger) {
        res.status(404).json({ error: 'Trigger not found' });
        return;
      }
      deindexTrigger(id);
      await deleteTrigger(id);
      emitEvent('trigger:deleted', id, { trigger_id: id });
      if (trigger.status !== 'pending') await announceTriggerChange(trigger, 'deleted');
      res.json({ ok: true });
    } catch (error) {
      logger.error('api', 'Failed to delete trigger', error);
      res.status(500).json({ error: 'Failed to delete trigger' });
    }
  });

  app.use('/api', router);
  logger.plain('API routes: /api/tasks, /api/triggers, /api/events/stream');
}
