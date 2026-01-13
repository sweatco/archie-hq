/**
 * Queue Definitions
 *
 * Defines the two queues for the queue-based architecture:
 * 1. Triage Queue - Fast event classification (FIFO per thread/task)
 * 2. Spawn Queue - PM agent lifecycle management (FIFO per task, blocking)
 */

import { Queue } from 'groupmq';
import { getRedisConnection } from './redis.js';
import { logger } from './logger.js';

// Job data types
export interface TriageJobData {
  source: 'slack' | 'github';
  payload: Record<string, unknown>;
  taskId?: string; // For GitHub events where taskId is already known
}

export type SpawnReason = 'new_task' | 'existing_task';

export interface SpawnJobData {
  taskId: string;
  reason: SpawnReason;
}

// Queue instances (lazy initialized)
let triageQueue: Queue<TriageJobData> | null = null;
let spawnQueue: Queue<SpawnJobData> | null = null;

/**
 * Get or create the triage queue
 *
 * Triage queue processes events requiring classification:
 * - Slack messages (grouped by thread ID for FIFO within conversation)
 * - GitHub issue_comment (grouped by taskId for FIFO within task)
 *
 * Fast processing (~2 seconds per job)
 */
export function getTriageQueue(): Queue<TriageJobData> {
  if (!triageQueue) {
    triageQueue = new Queue<TriageJobData>({
      redis: getRedisConnection(),
      namespace: 'archie:triage-events',
      jobTimeoutMs: 60000, // 1 minute timeout for triage (includes LLM call)
      maxAttempts: 3,
      keepCompleted: 100,
      keepFailed: 100,
      logger: false,
    });
    logger.system('Triage queue initialized');
  }
  return triageQueue;
}

/**
 * Get or create the spawn queue
 *
 * Spawn queue manages PM agent lifecycle:
 * - Grouped by taskId (ensures only one PM per task at a time)
 * - Jobs block until PM completes (can be hours)
 * - Acts as distributed lock per task
 *
 * Long-running jobs (hours per job)
 */
export function getSpawnQueue(): Queue<SpawnJobData> {
  if (!spawnQueue) {
    spawnQueue = new Queue<SpawnJobData>({
      redis: getRedisConnection(),
      namespace: 'archie:spawn-tasks',
      jobTimeoutMs: 60 * 60 * 1000, // 1 hour timeout for PM agents
      maxAttempts: 1, // No retry - PM will read full log on restart
      keepCompleted: 100,
      keepFailed: 100,
      logger: false,
    });
    logger.system('Spawn queue initialized');
  }
  return spawnQueue;
}

/**
 * Close all queue connections
 *
 * Should be called during graceful shutdown.
 */
export async function closeQueues(): Promise<void> {
  const closePromises: Promise<void>[] = [];

  if (triageQueue) {
    closePromises.push(triageQueue.close());
    triageQueue = null;
  }

  if (spawnQueue) {
    closePromises.push(spawnQueue.close());
    spawnQueue = null;
  }

  await Promise.all(closePromises);
  logger.system('Queues closed');
}
