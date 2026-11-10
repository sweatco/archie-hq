// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { systemEventSchema } from '../system/event-bus.js';

const reminderSchema = z.object({ trigger_at: z.string(), reason: z.string() });
export const taskListSchema = z.object({
  tasks: z.array(
    z.object({
      task_id: z.string(),
      status: z.string(),
      created_at: z.string(),
      updated_at: z.string(),
      title: z.string().nullable(),
      channel_name: z.string().nullable(),
      reminder: reminderSchema.nullable(),
    }),
  ),
  total: z.number(),
});
export type TaskSummary = z.infer<typeof taskListSchema>['tasks'][number];
export const taskDetailSchema = z.object({
  metadata: z
    .object({
      status: z.string(),
      title: z.string().nullish(),
      reminder: reminderSchema.nullish(),
    })
    .passthrough(),
});
export { systemEventSchema };
export type CliSystemEvent = z.infer<typeof systemEventSchema>;
export const taskEventsSchema = z.object({ events: z.array(systemEventSchema), total: z.number() });
export const sseEventSchema = z.union([
  z.object({ type: z.literal('connected') }),
  systemEventSchema,
]);
export type SseEvent = z.infer<typeof sseEventSchema>;
export const triggerListSchema = z.object({
  triggers: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      created_by: z.string(),
      created_at: z.string(),
      last_fired_at: z.string().nullable(),
      binding_kind: z.enum(['channel', 'user']),
      channel_name: z.string(),
      action_prompt: z.string(),
      summary: z.string(),
    }),
  ),
  total: z.number(),
});
export type TriggerSummary = z.infer<typeof triggerListSchema>['triggers'][number];
