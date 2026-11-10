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
import { getArchieConfig } from '../system/plugin-loader.js';
import type { InitiativeRuntime } from './index.js';

export async function startInitiative(
  team: string,
  mode: 'shadow' | 'live',
): Promise<InitiativeRuntime> {
  const dir = join(WORKDIR, 'initiative');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const store = new InitiativeStore(join(dir, 'state.sqlite'), team);
  try {
    const slack = new PublicSlack();
    const gateway = new ModelGateway(store);
    const investigationModel =
      process.env.ARCHIE_PROACTIVITY_INVESTIGATION_MODEL ?? 'claude-sonnet-5-5';
    const service = new InitiativeService(
      store,
      slack,
      gateway,
      {
        mode,
        extractionModel: process.env.ARCHIE_PROACTIVITY_EXTRACTION_MODEL ?? 'claude-haiku-5-5',
        investigationModel,
        repositories: Object.keys(getArchieConfig().repos),
      },
      Date.now,
    );
    const handoff = new ProposalHandoff(
      store,
      slack,
      () => Object.keys(getArchieConfig().repos),
      (source) => service.refreshEvidence(source),
    );
    await gateway.verify([service.config.extractionModel, service.config.investigationModel]);
    if (!store.setting('activated')) {
      store.set('watermark', String(Date.now() / 1000));
      store.set('activated', 'true');
    } else {
      store.set(
        'intake_gap',
        'Restart coverage: replies in previously unknown older threads may be missing. Known matters are rechecked before delivery.',
      );
    }
    service.seed();
    installObservationAPI(new ObservationRecall(store, slack));
    let running: Promise<void> | undefined;
    let recoveringTasks: Promise<void> | undefined;
    const operations = new Set<Promise<unknown>>();
    async function operation<T>(work: () => Promise<T>): Promise<T> {
      const pending = work();
      operations.add(pending);
      try {
        return await pending;
      } finally {
        operations.delete(pending);
      }
    }
    let captures = Promise.resolve();
    let queued = 0;
    let closing = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    function start(): void {
      if (timer || closing) return;
      timer = setInterval(() => {
        if (closing) return;
        if (!recoveringTasks)
          recoveringTasks = handoff
            .recover()
            .catch((error) => logger.warn('initiative', 'Approved task recovery deferred', error))
            .finally(() => {
              recoveringTasks = undefined;
            });
        if (running) return;
        running = (async () => {
          if (mode === 'live') await handoff.present(Date.now());
          await service.tick();
        })()
          .catch((error) => logger.warn('initiative', 'Scheduler tick failed', error))
          .finally(() => {
            running = undefined;
          });
      }, 60_000);
      timer.unref();
    }

    async function control(user: string, command: string): Promise<void> {
      const parts = command.trim().split(/\s+/);
      const action = parts[0];
      const channel = await slack.dm(user);
      if (action === 'proposal' && parts.length === 2) {
        await postSlackMessage({
          channel,
          text: JSON.stringify(await handoff.describe(parts[1], user)),
        });
        return;
      }
      const match = command.match(/^(handled|later|not useful|stop following)\s+(.+)$/);
      if (match) {
        const matter = store.matter(match[2]);
        if (!matter?.valid || matter.owner !== user) return;
        const access = await slack.inspect(matter.channel, user);
        const current = store.matter(matter.id);
        if (!access?.recipientCanRead || !current?.valid || current.owner !== user) return;
        store.feedback(matter.id, match[1], Date.now(), nextMorning(Date.now()));
        await postSlackMessage({ channel, text: `Recorded: ${match[1]}.` });
        return;
      }
      await postSlackMessage({
        channel,
        text: 'Use initiative handled/later/not useful/stop following followed by a matter ID for your own matters. Inspect your linked task with initiative proposal <id>. Proactivity is configured through ARCHIE_PROACTIVITY_MODE=off|shadow|live.',
      });
    }

    async function handleAction(user: string, value: string): Promise<void> {
      if (closing) return;
      const start = value.match(/^(.{1,240}):start:([a-f0-9]{24})$/);
      const feedback = value.match(/^(.{1,240}):(handled|later|not useful|stop following)$/);
      const id = start?.[1] ?? feedback?.[1];
      if (!id) return;
      const delivery = store.delivery(id);
      if (
        !delivery ||
        !delivery.channel.startsWith('D') ||
        delivery.state !== 'sent' ||
        delivery.recipient !== user ||
        !store.deliveryRecipientCurrent(delivery)
      )
        return;
      if (start) {
        try {
          await handoff.approve(user, start[1], start[2]);
        } catch (error) {
          const delivery = store.delivery(start[1]);
          const approved = delivery?.proposal ? store.handoff(delivery.proposal.id) : null;
          if (
            !approved ||
            approved.actor !== user ||
            approved.delivery !== start[1] ||
            approved.version !== start[2]
          )
            throw error;
          logger.warn('initiative', 'Approved task start deferred', error);
        }
        return;
      }
      if (!feedback) return;
      for (const id of delivery.matters) {
        const matter = store.matter(id);
        if (
          !matter?.valid ||
          matter.owner !== user ||
          !(await slack.inspect(matter.channel, user))?.recipientCanRead
        )
          return;
      }
      if (!store.deliveryRecipientCurrent(delivery)) return;
      if (delivery.matters.some((id) => !store.matter(id)?.valid)) return;
      for (const matter of delivery.matters)
        store.feedback(matter, feedback[2], Date.now(), nextMorning(Date.now()));
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
        if (original)
          store.record(
            {
              channel,
              thread: String(original.thread),
              ts,
              version: String(event.event_ts ?? event.ts),
              author: String(original.author),
              text: '',
              deleted: true,
              own: original.own === 1,
              bot: original.bot === 1,
              eventId: typeof event.event_id === 'string' ? event.event_id : undefined,
            },
            Date.now(),
          );
        else if (previous && typeof previous.thread_ts === 'string')
          store.coverageGap(channel, 'unknown', 'Deletion of an unobserved message');
        return;
      }
      const raw = (event.subtype === 'message_changed' ? event.message : event) as
        Record<string, unknown> | undefined;
      if (!raw) return;
      const source = await normalizeSlackSource(raw, channel);
      if (source) {
        await service.capture({
          ...source,
          eventId: typeof event.event_id === 'string' ? event.event_id : undefined,
        });
        if (
          !source.own &&
          source.thread !== source.ts &&
          !store.attention.messageKnown(channel, source.thread)
        ) {
          const parent = await slack.page(channel, source.thread, source.thread);
          if (await slack.inspect(channel)) {
            for (const message of parent.messages.filter((m) => m.ts === source.thread))
              store.record({ ...message, context: true });
            if (!parent.messages.length)
              store.attention.setThreadGap(
                'Thread parent unavailable; context incomplete',
                channel,
                source.thread,
              );
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
          if (
            typeof event.user === 'string' &&
            !event.bot_id &&
            !event.bot_profile &&
            !event.subtype &&
            typeof event.text === 'string' &&
            /^initiative\s/i.test(event.text) &&
            (await slack.verifyDm(channel, event.user))
          ) {
            try {
              await control(event.user, String(event.text).replace(/^initiative\s+/i, ''));
            } catch (error) {
              logger.warn('initiative', 'Employee control rejected', error);
              await postSlackMessage({
                channel,
                text: 'That initiative control could not be applied. Its sources or review may be unavailable or out of date. Use initiative proposal <id> to inspect your linked task.',
              });
            }
            return true;
          }
          if (!channel.startsWith('C')) return false;
          if (queued >= 256) {
            store.set(
              'intake_gap',
              'Intake overflow: some activity may be missing, including replies in previously unknown older threads.',
            );
            store.coverageGap(channel, 'unknown', 'Intake queue overflow; reconciliation required');
            store.schedule('reconcile', 'global', Date.now());
            return false;
          }
          queued++;
          captures = captures
            .then(() => capturePublic(event))
            .catch((error) => logger.warn('initiative', 'Source collection deferred', error))
            .finally(() => {
              queued--;
            });
          return false;
        });
      },
      action(user, value) {
        return operation(async () => {
          try {
            await handleAction(user, value);
          } catch (error) {
            if (closing) return;
            const delivery = store.delivery(value.split(':start:')[0]);
            if (delivery?.recipient !== user || !(await slack.verifyDm(delivery.channel, user)))
              return;
            const message =
              error instanceof HandoffRejection
                ? error.message
                : 'The task start could not be confirmed. Use initiative proposal followed by the proposal ID to inspect its linked task before retrying.';
            await postSlackMessage({ channel: delivery.channel, text: message });
          }
        });
      },
      async origin(channel, thread) {
        if (closing) return null;
        return operation(async () => {
          const row = store.attention.deliveryOrigin(channel, thread, thread);
          if (!row) return null;
          const unavailable = {
            deliveryId: String(row.id),
            matterIds: [],
            brief: 'Source context is currently unavailable.',
          };
          try {
            if (
              channel.startsWith('D')
                ? !row.recipient || !(await slack.verifyDm(channel, row.recipient))
                : !(await slack.inspect(channel))
            )
              return unavailable;
            const matterIds = JSON.parse(String(row.matters)) as string[];
            const matters = [];
            const allowedIds = [];
            for (const id of matterIds) {
              const matter = store.matter(id);
              if (!matter?.valid) continue;
              const access = await slack.inspect(
                matter.channel,
                channel.startsWith('D') ? row.recipient! : undefined,
              );
              if (
                !access ||
                (channel.startsWith('D') && !access.recipientCanRead) ||
                (!channel.startsWith('D') && matter.channel !== channel)
              )
                continue;
              allowedIds.push(id);
              matters.push({
                title: matter.title,
                detail: matter.detail,
                source: slack.link(matter.channel, matter.thread),
              });
            }
            return {
              deliveryId: String(row.id),
              matterIds: allowedIds,
              brief: JSON.stringify(matters),
            };
          } catch (error) {
            logger.warn('initiative', 'Handoff source verification failed', error);
            return unavailable;
          }
        });
      },
      async close() {
        clearInterval(timer);
        closing = true;
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
  } catch (error) {
    store.close();
    throw error;
  }
}
