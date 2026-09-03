import type { Channel, ChannelType } from '../types/task.js';
import type { Task } from './task.js';

export interface ChannelDeliveryContext {
  task: Task;
  // From task.metadata.channels; typed `Channel` but always this deliverer's own kind.
  channel: Channel;
  message: string;
  // Agent name passed to `postToUser`, or `'system'`.
  sender: string;
}

export interface ChannelDeliveryOutcome {
  // `postToUser` gates the `knowledge.log` append on this alone, never on `note`.
  delivered: boolean;
  // Relayed verbatim either way to `postToUser`'s caller; `undefined` → generic wording.
  note?: string;
}

// Never assigns `Task.metadata.default_channel`; only Slack's `??=` sites do. `undefined` means nothing could be reported at all — a real attempt returns a full outcome.
export type ChannelDeliverer = (ctx: ChannelDeliveryContext) => Promise<ChannelDeliveryOutcome | undefined>;

export type ChannelRenderer = (channel: Channel) => string;

interface ChannelRegistration {
  deliver: ChannelDeliverer;
  render?: ChannelRenderer;
}

const registrations = new Map<ChannelType, ChannelRegistration>();

// Full replace: omitting `render` clears any prior one (deliberate — one owner per kind).
export function registerChannelDeliverer(
  type: ChannelType,
  deliverer: ChannelDeliverer,
  render?: ChannelRenderer,
): void {
  registrations.set(type, { deliver: deliverer, render });
}

export function getChannelDeliverer(type: ChannelType): ChannelDeliverer | undefined {
  return registrations.get(type)?.deliver;
}

export function getChannelRenderer(type: ChannelType): ChannelRenderer | undefined {
  return registrations.get(type)?.render;
}
