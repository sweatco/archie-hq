import type { Application, NextFunction, Request, Response } from 'express';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const express = require('express');

import { readFile } from 'fs/promises';
import { basename } from 'path';
import { redeemCode, findConnection, type ClaudeConnection } from './connections.js';
import { resolveApproval } from '../api/routes.js';
import { Task } from '../../tasks/task.js';
import {
  appendCliMessage,
  readEvents,
  loadMetadata,
  findTaskOnDisk,
  eventsFlushed,
} from '../../tasks/persistence.js';
import { AGENT_PROMPTS } from '../../agents/prompts.js';
import { getUserInfo } from '../slack/client.js';
import { createKeyedLock } from '../../system/keyed-lock.js';
import { logger } from '../../system/logger.js';
import type { SystemEvent } from '../../system/event-bus.js';

interface ApprovalView {
  approval_id: number;
  type: string;
  text: string;
  state: 'pending' | 'approved' | 'denied';
  decided_by?: string;
  decided_at?: string;
  request: Record<string, unknown>;
}

const decisionLock = createKeyedLock();

async function person(c: ClaudeConnection) {
  const info = await getUserInfo(c.user_id);
  return { id: c.user_id, name: info.realName || info.name, email: info.email };
}

async function ownedTask(id: unknown, c: ClaudeConnection) {
  const taskId = typeof id === 'string' ? findTaskOnDisk(id) : undefined;
  const metadata = taskId ? await loadMetadata(taskId) : null;
  return taskId && metadata && metadata.created_by === c.user_id ? { taskId, metadata } : null;
}

function approvalViews(events: SystemEvent[]): ApprovalView[] {
  const views: ApprovalView[] = [];
  events.forEach((e, i) => {
    if (e.type === 'approval:requested') {
      views.push({
        approval_id: i,
        type: String(e.data.approvalType),
        text: String(e.data.text ?? ''),
        state: 'pending',
        request: e.data,
      });
    } else if (e.type === 'approval:resolved') {
      const target = typeof e.data.approval_id === 'number'
        ? views.find((v) => v.approval_id === e.data.approval_id)
        : [...views].reverse().find((v) => v.state === 'pending' && v.type === e.data.type);
      if (target && target.state === 'pending') {
        target.state = e.data.approve ? 'approved' : 'denied';
        target.decided_at = e.timestamp;
        if (typeof e.data.approver_name === 'string') {
          target.decided_by = e.data.approver_name;
        }
      }
    }
  });
  return views;
}

const view = ({ request, ...rest }: ApprovalView) => rest;

async function readAttachment(path: string): Promise<{ name: string; text: string } | { name: string; note: string }> {
  const name = basename(path);
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch {
    return { name, note: `${name} could not be read.` };
  }
  if (buf.length > 100_000) {
    return { name, note: `${name} (${buf.length} bytes) is too large to show here.` };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return { name, note: `${name} is not a text file, so it is not shown here.` };
  }
  if (text.includes('\u0000')) {
    return { name, note: `${name} is not a text file, so it is not shown here.` };
  }
  return { name, text };
}

export function mountClaudeRoutes(app: Application): void {
  const router = express.Router();
  router.use(express.json());

  router.post('/connect', async (req: Request, res: Response) => {
    try {
      const { code } = req.body ?? {};
      if (typeof code !== 'string' || !code) {
        res.status(400).json({ error: 'code is required' });
        return;
      }
      const result = await redeemCode(code);
      if (!result) {
        res.status(401).json({ error: 'That code is invalid, already used or expired. Say "connect claude" to Archie in Slack for a new one.' });
        return;
      }
      const p = await person(result.connection);
      logger.system(`Claude connected for ${result.connection.user_id}`);
      res.json({ credential: result.credential, name: p.name });
    } catch (error) {
      logger.error('claude', 'Failed to connect Claude', error);
      res.status(500).json({ error: 'Archie could not handle that request' });
    }
  });

  // Every route below acts as the connected person and only on tasks they started.
  router.use(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
      const connection = match ? await findConnection(match[1]) : null;
      if (!connection) {
        res.status(401).json({ error: 'Not connected to Archie. Say "connect claude" to Archie in Slack, then pass the code to connect_archie.' });
        return;
      }
      res.locals.connection = connection;
      next();
    } catch (error) {
      logger.error('claude', 'Failed to check the Claude credential', error);
      res.status(500).json({ error: 'Archie could not handle that request' });
    }
  });

  router.post('/sessions', async (req: Request, res: Response) => {
    try {
      const c = res.locals.connection as ClaudeConnection;
      const { message, session_id } = req.body ?? {};
      if (typeof message !== 'string' || !message) {
        res.status(400).json({ error: 'message is required' });
        return;
      }
      if (session_id !== undefined) {
        const owned = await ownedTask(session_id, c);
        if (!owned) {
          res.status(404).json({ error: 'Session not found' });
          return;
        }
        const { taskId } = owned;
        const p = await person(c);
        const line = await appendCliMessage(taskId, message, { id: p.id, name: p.name });
        const task = await Task.get(taskId);
        task.linkCliChannel();
        await task.sendMessage(AGENT_PROMPTS.inboundActivity([line]));
        res.json({ session_id: taskId });
      } else {
        const p = await person(c);
        const task = await Task.create();
        task.metadata.created_by = c.user_id;
        task.metadata.home_channel = { channel_id: c.channel_id, channel_name: c.channel_name };
        task.metadata.memory_authors = { ...task.metadata.memory_authors, [p.id]: p.name };
        task.setMemoryDestination(c.channel_id);
        task.linkCliChannel();
        await task.save(true);
        const line = await appendCliMessage(task.taskId, message, { id: p.id, name: p.name });
        await task.sendMessage(AGENT_PROMPTS.inboundNewTask([line]));
        res.status(201).json({ session_id: task.taskId });
      }
    } catch (error) {
      logger.error('claude', 'Failed to send a Claude message', error);
      res.status(500).json({ error: 'Archie could not handle that request' });
    }
  });

  router.get('/sessions/:id', async (req: Request, res: Response) => {
    try {
      const c = res.locals.connection as ClaudeConnection;
      const owned = await ownedTask(req.params.id, c);
      if (!owned) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      const { taskId, metadata } = owned;
      const { events } = await readEvents(taskId);
      const after = Math.max(0, Number.parseInt(String(req.query.after ?? '0'), 10) || 0);
      const replies: Array<{ text: string; files: Array<{ name: string; text: string } | { name: string; note: string }> }> = [];
      for (const e of events.slice(after)) {
        if (e.type === 'message' && e.data.to === 'user') {
          replies.push({
            text: String(e.data.message ?? ''),
            files: await Promise.all(
              (Array.isArray(e.data.files) ? e.data.files : [])
                .filter((f): f is string => typeof f === 'string')
                .map(readAttachment),
            ),
          });
        }
      }
      const status = metadata.status === 'completed' ? 'done' : metadata.status === 'stopped' ? 'paused' : 'working';
      const approvals = approvalViews(events).filter((v) => v.state === 'pending').map(view);
      res.json({ status, replies, approvals, cursor: events.length });
    } catch (error) {
      logger.error('claude', 'Failed to check a Claude session', error);
      res.status(500).json({ error: 'Archie could not handle that request' });
    }
  });

  router.get('/sessions/:id/approvals/:aid', async (req: Request, res: Response) => {
    try {
      const c = res.locals.connection as ClaudeConnection;
      const owned = await ownedTask(req.params.id, c);
      if (!owned) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      const aid = Number(req.params.aid);
      if (!Number.isInteger(aid)) {
        res.status(404).json({ error: 'Approval not found' });
        return;
      }
      const { events } = await readEvents(owned.taskId);
      const v = approvalViews(events).find((a) => a.approval_id === aid);
      if (!v) {
        res.status(404).json({ error: 'Approval not found' });
        return;
      }
      res.json(view(v));
    } catch (error) {
      logger.error('claude', 'Failed to read a Claude approval', error);
      res.status(500).json({ error: 'Archie could not handle that request' });
    }
  });

  router.post('/sessions/:id/approvals/:aid', async (req: Request, res: Response) => {
    try {
      const c = res.locals.connection as ClaudeConnection;
      const { approve } = req.body ?? {};
      if (typeof approve !== 'boolean') {
        res.status(400).json({ error: 'approve must be true or false' });
        return;
      }
      const owned = await ownedTask(req.params.id, c);
      if (!owned) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      const { taskId } = owned;
      const aid = Number(req.params.aid);
      await decisionLock(taskId, async () => {
        await eventsFlushed(taskId);
        const { events } = await readEvents(taskId);
        const v = approvalViews(events).find((a) => a.approval_id === aid);
        if (!v) {
          res.status(404).json({ error: 'Approval not found' });
          return;
        }
        if (v.state !== 'pending') {
          res.json({ ...view(v), already_decided: true });
          return;
        }
        const p = await person(c);
        const r = await resolveApproval(
          taskId,
          { type: v.type, approve, github: v.request.github, pr_number: v.request.pr_number, ref: v.request.ref },
          { approval_id: v.approval_id, approver: p },
        );
        if (r.status !== 200) {
          res.status(r.status).json(r.body);
          return;
        }
        await eventsFlushed(taskId);
        res.json({
          ...view(v),
          state: approve ? 'approved' : 'denied',
          decided_by: p.name,
          decided_at: new Date().toISOString(),
          already_decided: false,
        });
      });
    } catch (error) {
      logger.error('claude', 'Failed to decide a Claude approval', error);
      res.status(500).json({ error: 'Archie could not handle that request' });
    }
  });

  app.use('/mcp', router);
  logger.plain('Claude routes: /mcp');
}
