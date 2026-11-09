// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TaskMetadata } from '../types/task.js';

export interface InitiativeRuntime {
  start(): void;
  capture(event: Record<string, unknown>): Promise<boolean>;
  action(user: string, value: string): Promise<void>;
  origin(channel: string, thread: string): Promise<{ deliveryId: string; matterIds: string[]; brief: string } | null>;
  close(): Promise<void>;
}

let runtime: InitiativeRuntime | undefined;

export async function initInitiative(team: string | null): Promise<void> {
  if (runtime) return;
  const mode = process.env.ARCHIE_PROACTIVITY_MODE ?? 'off';
  if (mode === 'off') return;
  const { logger } = await import('../system/logger.js');
  try {
    if (mode !== 'shadow' && mode !== 'live') throw new Error('Invalid ARCHIE_PROACTIVITY_MODE');
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Proactive observation requires Node 24 or later');
    if (!team) throw new Error('Initiative requires an authenticated Slack workspace');
    const { startInitiative } = await import('./runtime.js');
    runtime = await startInitiative(team, mode);
  } catch (error) { logger.warn('initiative', 'Proactive observation unavailable', error); }
}

export function startInitiativeScheduler(): void { runtime?.start(); }

export async function observeSlack(event: Record<string, unknown>): Promise<boolean> {
  let consumed = false;
  try {
    if (typeof event.channel === 'string' && event.channel.startsWith('D') && typeof event.user === 'string'
      && !event.bot_id && !event.bot_profile && !event.subtype && typeof event.text === 'string'
      && /^initiative\s+(?:status|delivery\s+(?:on|off)|mute|unmute|pause|resume|stop|start)\s*$/i.test(event.text.trim())) {
      consumed = true;
      const { PublicSlack } = await import('./slack.js');
      if (await new PublicSlack().verifyDm(event.channel, event.user)) {
        const { postSlackMessage } = await import('../connectors/slack/client.js');
        await postSlackMessage({ channel: event.channel, text: 'Global initiative commands have retired. Configure ARCHIE_PROACTIVITY_MODE=off|shadow|live in the deployment: off skips proactivity, shadow analyzes without new proactive messages, live permits eligible sends. Private feedback and Start task approvals still belong to the responsible employee.' });
      }
      return true;
    }
    return runtime ? await runtime.capture(event) : false;
  }
  catch (error) {
    const { logger } = await import('../system/logger.js');
    logger.warn('initiative', consumed ? 'Retired command consumed; deployment help unavailable' : 'Slack observation failed; normal task routing continues', error);
    return consumed;
  }
}

export async function initiativeAction(user: string, value: string): Promise<void> { await runtime?.action(user, value); }
export async function initiativeOrigin(channel: string, thread: string) {
  try { return await runtime?.origin(channel, thread) ?? null; }
  catch (error) {
    const { logger } = await import('../system/logger.js');
    logger.warn('initiative', 'Observation handoff unavailable', error);
    return null;
  }
}
export async function shutdownInitiative(): Promise<void> { const current = runtime; runtime = undefined; await current?.close(); }

export function attachInitiativeOrigin(metadata: TaskMetadata, origin: NonNullable<Awaited<ReturnType<typeof initiativeOrigin>>>): string {
  metadata.initiative_origin = { delivery_id: origin.deliveryId, matter_ids: origin.matterIds };
  return `\n\n<initiative_context untrusted="true">${origin.brief.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 6000)}</initiative_context>`;
}
