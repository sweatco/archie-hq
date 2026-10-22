// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKDIR } from '../system/workdir.js';
import { logger } from '../system/logger.js';
import { postSlackMessage } from '../connectors/slack/client.js';
import { InitiativeStore } from './store.js';
import { HandoffRejection, ProposalHandoff } from './handoff.js';
import { ObservationRecall } from './recall.js';
import { drainObservationReads, installObservationAPI } from './api.js';
import { InitiativeService, nextMorning } from './service.js';
import { PublicSlack, normalizeSlackSource } from './slack.js';
import { ModelGateway } from './model.js';
import { SourceAccess } from './access.js';
import { getArchieConfig } from '../system/plugin-loader.js';
import type { InitiativeRuntime } from './index.js';

export async function startInitiative(team: string, mode: 'shadow' | 'live'): Promise<InitiativeRuntime> {
  const owner = process.env.ARCHIE_PROACTIVITY_OWNER;
  if (!owner || !/^[UW][A-Z0-9]{6,}$/.test(owner)) throw new Error('ARCHIE_PROACTIVITY_OWNER must be a human Slack ID');
  const dir = join(WORKDIR, 'initiative');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const store = new InitiativeStore(join(dir, 'state.sqlite'), team, Date.now(), { owner });
  try {
    const slack = new PublicSlack(owner);
    const gateway = new ModelGateway(store);
    const investigationModel = process.env.ARCHIE_PROACTIVITY_INVESTIGATION_MODEL ?? 'claude-sonnet-5-5';
    const enabled = process.env.ARCHIE_SELF_EVOLUTION === 'true';
    store.set('self_evolution', String(enabled));
    const authorizeChannels = (channels: string[]) => new SourceAccess(store, slack).all(channels);
    const learning = enabled ? new (await import('./learning.js')).LearningService(store, gateway, investigationModel, Object.keys(getArchieConfig().repos), authorizeChannels) : undefined;
    if (learning) learning.revalidateApproval();
    else store.useBaseline(Date.now());
    const service = new InitiativeService(store, slack, gateway, {
      mode, owner,
      extractionModel: process.env.ARCHIE_PROACTIVITY_EXTRACTION_MODEL ?? 'claude-haiku-5-5',
      investigationModel, repositories: Object.keys(getArchieConfig().repos),
    }, Date.now, learning);
    const handoff = new ProposalHandoff(store, slack, owner, () => Object.keys(getArchieConfig().repos), source => service.refreshEvidence(source));
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
    installObservationAPI(new ObservationRecall(store, slack));
    let running: Promise<void> | undefined;
    let recoveringTasks: Promise<void> | undefined;
    const operations = new Set<Promise<unknown>>();
    async function operation<T>(work: () => Promise<T>): Promise<T> {
      const pending = work();
      operations.add(pending);
      try { return await pending; } finally { operations.delete(pending); }
    }
    let captures = Promise.resolve();
    let queued = 0;
    let closing = false;
    const reconciliation = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;
    function start(): void {
      if (timer || closing) return;
      timer = setInterval(() => {
        if (closing) return;
        if (!recoveringTasks) recoveringTasks = handoff.recover().catch(error => logger.warn('initiative', 'Approved task recovery deferred', error)).finally(() => { recoveringTasks = undefined; });
        if (running) return;
        running = (async () => {
          try { await gateway.poll(AbortSignal.any([reconciliation.signal, AbortSignal.timeout(45_000)])); }
          catch (error) { logger.warn('initiative', 'Batch reconciliation deferred', error); }
          await learning?.process(Date.now(), reconciliation.signal);
          gateway.expire(Date.now());
          if (mode === 'live') await handoff.present(Date.now());
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
      if (action === 'proposal' && parts.length === 2) {
        await postSlackMessage({ channel: await slack.ownerDm(), text: JSON.stringify(await handoff.describe(parts[1])) });
        return;
      }
      if (action === 'outcome' && parts.length >= 5) {
        const state = parts[2];
        if (!['implemented', 'released', 'rejected'].includes(state)) throw new Error('Outcome must be implemented, released or rejected');
        await handoff.acknowledge(user, parts[1], state as 'implemented' | 'released' | 'rejected', parts[3], parts.slice(4).join(' '));
        await postSlackMessage({ channel: await slack.ownerDm(), text: 'Recorded the owner-acknowledged outcome and supporting artifact.' });
        return;
      }
      if (learning && action === 'policy') {
        const policy = store.learning.policy(parts[1] ?? '');
        if (policy && !await authorizeChannels(learning.approvalChannels(String(policy.id), String(policy.evaluation ?? '')))) throw new Error('Policy sources unavailable');
        await postSlackMessage({ channel: await slack.ownerDm(), text: policy ? JSON.stringify(policy) : 'Unknown policy version.' });
        return;
      }
      if (learning && action === 'approve' && parts.length === 3) {
        if (!await authorizeChannels(learning.approvalChannels(parts[1], parts[2]))) throw new Error('Policy or evaluation sources unavailable');
        learning.approve(parts[1], parts[2], Date.now());
        await postSlackMessage({ channel: await slack.ownerDm(), text: `Approved policy ${parts[1]} with evaluation ${parts[2]}.` });
        return;
      }
      if (learning && action === 'rollback' && parts.length === 2) {
        learning.rollback(parts[1]);
        await postSlackMessage({ channel: await slack.ownerDm(), text: `Restored policy ${parts[1]}.` });
        return;
      }
      if (action === 'delivery' && parts.length === 2 && ['on', 'off'].includes(parts[1])) {
        store.set('delivery_enabled', String(parts[1] === 'on'));
        await postSlackMessage({ channel: await slack.ownerDm(), text: `Proactive delivery ${parts[1]}. Source, audience, budget and interruption checks still apply.` });
        return;
      }
      if (['mute', 'unmute', 'pause', 'resume', 'stop', 'start'].includes(action)) {
        const key = ['mute', 'unmute'].includes(action) ? 'mute' : ['pause', 'resume'].includes(action) ? 'pause' : 'stop';
        store.set(key, String(['mute', 'pause', 'stop'].includes(action)));
        if (action === 'pause' || action === 'stop') service.cancelAnalysis();
        if (action === 'stop') {
          store.attention.stopAnalysis();
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
      await postSlackMessage({ channel: await slack.ownerDm(), text: 'Use initiative status, delivery on/off, mute/unmute, pause/resume, stop/start, or handled/later/not useful/stop following followed by a matter ID. Inspect a proposal with initiative proposal <id>; record its outcome with initiative outcome <id> <implemented|released|rejected> <repository artifact URL> <acceptance result>.' });
    }

    async function handleAction(user: string, value: string): Promise<void> {
      if (closing || user !== owner) return;
      const start = value.match(/^(.{1,240}):start:([a-f0-9]{24})$/);
      if (start) {
        try { await handoff.approve(user, start[1], start[2]); }
        catch (error) {
          const delivery = store.delivery(start[1]);
          const approved = delivery?.proposal ? store.handoff(delivery.proposal.id) : null;
          if (!approved || approved.actor !== user || approved.delivery !== start[1] || approved.version !== start[2]) throw error;
          logger.warn('initiative', 'Approved task start deferred', error);
        }
        return;
      }
      const split = value.indexOf(':');
      if (split < 0) return;
      const id = value.slice(0, split);
      const action = value.slice(split + 1);
      const matters = store.attention.deliveryMatters(id);
      if (!matters || !['handled', 'later', 'not useful', 'stop following'].includes(action)) return;
      for (const matter of matters) store.feedback(matter, action, Date.now(), nextMorning(Date.now()));
    }

    async function capturePublic(event: Record<string, unknown>): Promise<void> {
      const channel = typeof event.channel === 'string' ? event.channel : '';
      const access = await slack.inspect(channel);
      store.channel(channel, !!access, access?.shared ?? false);
      if (!access) return;
      if (event.subtype === 'message_deleted') {
        const previous = event.previous_message as Record<string, unknown> | undefined;
        const ts = String(event.deleted_ts ?? '');
        const original = store.attention.currentMessage(channel, ts);
        if (original) store.record({ channel, thread: String(original.thread), ts, version: String(event.event_ts ?? event.ts),
          author: String(original.author), text: '', deleted: true, own: original.own === 1, bot: original.bot === 1, eventId: typeof event.event_id === 'string' ? event.event_id : undefined }, Date.now());
        else if (previous && typeof previous.thread_ts === 'string') store.coverageGap(channel, 'unknown', 'Deletion of an unobserved message');
        return;
      }
      const raw = (event.subtype === 'message_changed' ? event.message : event) as Record<string, unknown> | undefined;
      if (!raw) return;
      const source = await normalizeSlackSource(raw, channel);
      if (source) {
        await service.capture({ ...source, eventId: typeof event.event_id === 'string' ? event.event_id : undefined });
        if (!source.own && source.thread !== source.ts && !store.attention.messageKnown(channel, source.thread)) {
          const parent = await slack.page(channel, source.thread, source.thread);
          if (await slack.inspect(channel)) {
            for (const message of parent.messages.filter((m) => m.ts === source.thread)) store.record({ ...message, context: true });
            if (!parent.messages.length) store.attention.setThreadGap('Thread parent unavailable; context incomplete', channel, source.thread);
          }
        }
      }
    }

    return {
      start,
      async capture(event) {
        if (closing) return false;
        return operation(async () => {
          const channel = typeof event.channel === 'string' ? event.channel : '';
          if (event.user === owner && !event.bot_id && !event.bot_profile && !event.subtype && typeof event.text === 'string' && /^initiative\s/i.test(event.text) && await slack.verifyDm(channel)) {
            try { await control(owner, String(event.text).replace(/^initiative\s+/i, '')); }
            catch (error) {
              logger.warn('initiative', 'Owner control rejected', error);
              await postSlackMessage({ channel, text: 'That initiative control could not be applied. Its sources or review may be unavailable or out of date. Use initiative status to inspect the current state.' });
            }
            return true;
          }
          if (!channel.startsWith('C')) return false;
          if (queued >= 256) {
            store.set('intake_gap', 'Intake overflow: some activity may be missing, including replies in previously unknown older threads.');
            store.coverageGap(channel, 'unknown', 'Intake queue overflow; reconciliation required');
            store.schedule('reconcile', 'global', Date.now());
            return false;
          }
          queued++;
          captures = captures.then(() => capturePublic(event))
            .catch((error) => logger.warn('initiative', 'Source collection deferred', error)).finally(() => { queued--; });
          return false;
        });
      },
      action(user, value) {
        return operation(async () => {
          try { await handleAction(user, value); }
          catch (error) {
            if (user !== owner || closing) return;
            const message = error instanceof HandoffRejection ? error.message
              : 'The task start could not be confirmed. Use initiative proposal followed by the proposal ID to inspect its linked task before retrying.';
            await postSlackMessage({ channel: await slack.ownerDm(), text: message });
          }
        });
      },
      async origin(channel, thread) {
        if (closing) return null;
        return operation(async () => {
          const row = store.attention.deliveryOrigin(channel, thread, thread);
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
        });
      },
      async close() {
        clearInterval(timer);
        closing = true;
        reconciliation.abort();
        installObservationAPI(undefined);
        service.stop();
        await running;
        await recoveringTasks;
        await Promise.allSettled(operations);
        await handoff.drainCards();
        await captures;
        await drainObservationReads();
        service.release();
        store.close();
      },
    };
  } catch (error) { store.close(); throw error; }
}
