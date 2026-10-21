// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKDIR } from '../system/workdir.js';
import { logger } from '../system/logger.js';
import { postSlackMessage } from '../connectors/slack/client.js';
import { ObservationStore } from '../memory/observation-store.js';
import { installObservationMemory } from '../memory/observations.js';
import { InitiativeService, nextMorning } from './service.js';
import { PublicSlack, normalizeSlackSource } from './slack.js';
import { ModelGateway } from './model.js';
import { LearningService } from './learning.js';
import { getArchieConfig } from '../system/plugin-loader.js';
import type { InitiativeRuntime } from './index.js';

export async function startInitiative(team: string, mode: 'shadow' | 'live'): Promise<InitiativeRuntime> {
  const owner = process.env.ARCHIE_PROACTIVITY_OWNER;
  if (!owner || !/^[UW][A-Z0-9]{6,}$/.test(owner)) throw new Error('ARCHIE_PROACTIVITY_OWNER must be a human Slack ID');
  const dir = join(WORKDIR, 'initiative');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const store = new ObservationStore(join(dir, 'state.sqlite'), team);
  try {
    const slack = new PublicSlack(owner);
    const gateway = new ModelGateway(store);
    const investigationModel = process.env.ARCHIE_PROACTIVITY_INVESTIGATION_MODEL ?? 'claude-sonnet-5-5';
    const authorizeChannels = async (channels: string[]): Promise<boolean> => {
      for (const channel of channels) {
        try {
          const access = await slack.inspect(channel, true);
          store.channel(channel, !!access, access?.shared ?? false);
          if (!access?.ownerCanRead) return false;
        } catch {
          store.channel(channel, false, false, 'Learning source access lookup failed');
          return false;
        }
      }
      return channels.length > 0;
    };
    const learning = new LearningService(store, gateway, investigationModel, Object.keys(getArchieConfig().repos), authorizeChannels);
    const service = new InitiativeService(store, slack, gateway, {
      mode, owner,
      extractionModel: process.env.ARCHIE_PROACTIVITY_EXTRACTION_MODEL ?? 'claude-haiku-5-5',
      investigationModel,
    }, Date.now, learning);
    learning.revalidateApproval();
    await slack.ownerDm();
    await gateway.verify([service.config.extractionModel, service.config.investigationModel]);
    if (store.setting('owner') && store.setting('owner') !== owner) throw new Error('Observation owner mismatch');
    store.set('owner', owner);
    if (!store.setting('activated')) {
      store.set('watermark', String(Date.now() / 1000));
      store.set('activated', 'true');
    } else {
      store.set('intake_gap', 'Restart coverage: replies in previously unknown older threads may be missing. Known matters are rechecked before delivery.');
    }
    service.seed();
    installObservationMemory(service);
    let running: Promise<void> | undefined;
    let captures = Promise.resolve();
    let queued = 0;
    let closing = false;
    const reconciliation = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;
    function start(): void {
      if (timer || closing) return;
      timer = setInterval(() => {
        if (running || closing) return;
        running = (async () => {
          try { await gateway.poll(reconciliation.signal); }
          catch (error) { logger.warn('initiative', 'Batch reconciliation deferred', error); }
          await learning.process(Date.now(), reconciliation.signal);
          learning.expire(Date.now());
          gateway.expire(Date.now());
          await service.tick();
        })().catch((error) => logger.warn('initiative', 'Scheduler tick failed', error)).finally(() => { running = undefined; });
      }, 60_000);
      timer.unref();
    }

    async function control(user: string, command: string): Promise<void> {
      if (user !== owner) return;
      const parts = command.trim().split(/\s+/);
      const action = parts[0];
      if (action === 'status') {
        await postSlackMessage({ channel: await slack.ownerDm(), text: service.status() });
        return;
      }
      if (action === 'policy') {
        const policy = store.row('SELECT id,body,base,evaluation,state FROM policies WHERE id=?', parts[1] ?? '');
        if (policy && !await authorizeChannels(learning.approvalChannels(String(policy.id), String(policy.evaluation ?? '')))) throw new Error('Policy sources unavailable');
        await postSlackMessage({ channel: await slack.ownerDm(), text: policy ? JSON.stringify(policy) : 'Unknown policy version.' });
        return;
      }
      if (action === 'approve' && parts.length === 3) {
        if (!await authorizeChannels(learning.approvalChannels(parts[1], parts[2]))) throw new Error('Policy or evaluation sources unavailable');
        learning.approve(parts[1], parts[2], Date.now());
        await postSlackMessage({ channel: await slack.ownerDm(), text: `Approved policy ${parts[1]} with evaluation ${parts[2]}.` });
        return;
      }
      if (action === 'rollback' && parts.length === 2) {
        learning.rollback(parts[1]);
        await postSlackMessage({ channel: await slack.ownerDm(), text: `Restored policy ${parts[1]}.` });
        return;
      }
      if (['mute', 'unmute', 'pause', 'resume', 'stop', 'start'].includes(action)) {
        const key = ['mute', 'unmute'].includes(action) ? 'mute' : ['pause', 'resume'].includes(action) ? 'pause' : 'stop';
        store.set(key, String(['mute', 'pause', 'stop'].includes(action)));
        if (action === 'pause' || action === 'stop') service.cancelAnalysis();
        if (action === 'stop') {
          store.set('analysis_epoch', String(Number(store.setting('analysis_epoch') ?? 0) + 1));
          store.run("UPDATE deliveries SET state='cancelled' WHERE state='pending'");
          store.run("DELETE FROM jobs WHERE kind IN ('extract','investigate','reflection','digest')");
          await gateway.cancel(AbortSignal.timeout(15_000));
        }
        if (action === 'start' || action === 'resume') service.seed();
        await postSlackMessage({ channel: await slack.ownerDm(), text: `Initiative ${action} applied.` });
        return;
      }
      const match = command.match(/^(handled|later|not useful|stop following)\s+(.+)$/);
      if (match) {
        store.feedback(match[2], match[1], Date.now(), nextMorning(Date.now()));
        await postSlackMessage({ channel: await slack.ownerDm(), text: `Recorded: ${match[1]}.` });
        return;
      }
      await postSlackMessage({ channel: await slack.ownerDm(), text: 'Use initiative status, mute/unmute, pause/resume, stop/start, or handled/later/not useful/stop following followed by a matter ID.' });
    }

    async function capturePublic(event: Record<string, unknown>): Promise<void> {
      const channel = typeof event.channel === 'string' ? event.channel : '';
      const access = await slack.inspect(channel);
      store.channel(channel, !!access, access?.shared ?? false);
      if (!access) return;
      if (event.subtype === 'message_deleted') {
        const previous = event.previous_message as Record<string, unknown> | undefined;
        const ts = String(event.deleted_ts ?? '');
        const original = store.row('SELECT r.thread,r.author,r.own,r.bot FROM revisions r JOIN messages m ON m.revision=r.id WHERE m.channel=? AND m.ts=?', channel, ts);
        if (original) store.record({ channel, thread: String(original.thread), ts, version: String(event.event_ts ?? event.ts),
          author: String(original.author), text: '', deleted: true, own: original.own === 1, bot: original.bot === 1, eventId: typeof event.event_id === 'string' ? event.event_id : undefined }, Date.now());
        else if (previous && typeof previous.thread_ts === 'string') store.run('UPDATE channels SET gap=? WHERE id=?', 'Deletion of an unobserved message', channel);
        return;
      }
      const raw = (event.subtype === 'message_changed' ? event.message : event) as Record<string, unknown> | undefined;
      if (!raw) return;
      const source = await normalizeSlackSource(raw, channel);
      if (source) {
        await service.capture({ ...source, eventId: typeof event.event_id === 'string' ? event.event_id : undefined });
        if (!source.own && source.thread !== source.ts && !store.row('SELECT revision FROM messages WHERE channel=? AND ts=?', channel, source.thread)) {
          const parent = await slack.page(channel, source.thread, source.thread);
          if (await slack.inspect(channel)) {
            for (const message of parent.messages.filter((m) => m.ts === source.thread)) store.record({ ...message, context: true });
          if (!parent.messages.length) store.run('UPDATE threads SET gap=? WHERE channel=? AND thread=?', 'Thread parent unavailable; context incomplete', channel, source.thread);
          }
        }
      }
    }

    return {
      start,
      async capture(event) {
        if (closing) return false;
        const channel = typeof event.channel === 'string' ? event.channel : '';
        if (event.user === owner && typeof event.text === 'string' && /^initiative\s/i.test(event.text) && await slack.verifyDm(channel)) {
          try { await control(owner, event.text.replace(/^initiative\s+/i, '')); }
          catch (error) {
            logger.warn('initiative', 'Owner control rejected', error);
            await postSlackMessage({ channel, text: 'That initiative control could not be applied. Its sources or review may be unavailable or out of date. Use initiative status to inspect the current state.' });
          }
          return true;
        }
        if (!channel.startsWith('C')) return false;
        if (queued >= 256) {
          store.set('intake_gap', 'Intake overflow: some activity may be missing, including replies in previously unknown older threads.');
          store.run('UPDATE channels SET gap=? WHERE id=?', 'Intake queue overflow; reconciliation required', channel);
          store.schedule('reconcile', 'global', Date.now());
          return false;
        }
        queued++;
        captures = captures.then(() => capturePublic(event))
          .catch((error) => logger.warn('initiative', 'Source collection deferred', error)).finally(() => { queued--; });
        return false;
      },
      async action(user, value) {
        if (user !== owner) return;
        const split = value.indexOf(':');
        if (split < 0) return;
        const id = value.slice(0, split);
        const action = value.slice(split + 1);
        const row = store.row('SELECT matters FROM deliveries WHERE id=?', id);
        if (!row || !['handled', 'later', 'not useful', 'stop following'].includes(action)) return;
        const matters = JSON.parse(String(row.matters)) as string[];
        for (const matter of matters) store.feedback(matter, action, Date.now(), nextMorning(Date.now()));
      },
      async origin(channel, thread) {
        const row = store.row("SELECT id,matters FROM deliveries WHERE channel=? AND (thread=? OR ts=?) AND state='sent' ORDER BY created DESC LIMIT 1", channel, thread, thread);
        if (!row) return null;
        const unavailable = { deliveryId: String(row.id), matterIds: [], brief: 'Source context is currently unavailable.' };
        try {
          if (channel.startsWith('D') ? !await slack.verifyDm(channel) : !await slack.inspect(channel)) return unavailable;
          const matterIds = JSON.parse(String(row.matters)) as string[];
          const matters = [];
          for (const id of matterIds) {
            const matter = store.matter(id);
            if (!matter?.valid) continue;
            const access = await slack.inspect(matter.channel, channel.startsWith('D'));
            if (!access || (channel.startsWith('D') && !access.ownerCanRead) || (!channel.startsWith('D') && matter.channel !== channel)) continue;
            matters.push({ title: matter.title, detail: matter.detail, source: slack.link(matter.channel, matter.thread) });
          }
          return { deliveryId: String(row.id), matterIds, brief: JSON.stringify(matters) };
        } catch (error) { logger.warn('initiative', 'Handoff source verification failed', error); return unavailable; }
      },
      async close() {
        clearInterval(timer);
        closing = true;
        reconciliation.abort();
        installObservationMemory(undefined);
        service.stop();
        await running;
        await captures;
        service.release();
        store.close();
      },
    };
  } catch (error) { store.close(); throw error; }
}
