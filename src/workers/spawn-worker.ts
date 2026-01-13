/**
 * Spawn Worker
 *
 * Manages PM agent lifecycle:
 * - One spawn job per task at a time (GroupMQ FIFO per group)
 * - Job blocks until PM finishes (can be hours)
 * - Acts as distributed lock per task
 * - PM reads full shared-knowledge.log on start
 *
 * Key properties:
 * - No duplicate PMs (GroupMQ FIFO ensures serialization)
 * - No lost messages (all appended to log before routing)
 * - Clean handoff during deployment (new pod waits behind old pod's blocking job)
 */

import { Worker, type ReservedJob } from 'groupmq';
import { getRedisConnection } from '../system/redis.js';
import { getSpawnQueue, type SpawnJobData } from '../system/queues.js';
import { pendingSpawns, localActiveTasks } from './triage-worker.js';
import { initializeTaskRuntime, startTask, waitForTaskCompletion } from '../system/task-runtime.js';
import { loadMetadata, updateTaskStatus } from '../system/task-manager.js';
import { logger } from '../system/logger.js';

// ============================================================================
// Worker Instance
// ============================================================================

let spawnWorker: Worker<SpawnJobData> | null = null;

/**
 * Start the spawn worker
 */
export function startSpawnWorker(): Worker<SpawnJobData> {
  if (spawnWorker) {
    return spawnWorker;
  }

  const queue = getSpawnQueue();

  spawnWorker = new Worker<SpawnJobData>({
    queue,
    name: 'spawn-worker',
    concurrency: 10, // Allow up to 10 PMs running in parallel
    handler: processSpawnJob,
    onError: (err, job) => {
      logger.error('spawn-worker', `Error processing job ${job?.id}`, err);
      if (job?.data?.taskId) {
        // Clean up state on error
        pendingSpawns.delete(job.data.taskId);
        localActiveTasks.delete(job.data.taskId);
      }
    },
    // Long-running jobs - 1 hour timeout with heartbeat
    heartbeatMs: 30000, // 30 second heartbeat
    maxAttempts: 1, // No retry - PM will read full log on restart
    // Enable cleanup but with longer intervals
    enableCleanup: true,
    cleanupIntervalMs: 600000, // 10 minutes
    schedulerIntervalMs: 30000, // 30 seconds
    // Stalled job detection
    stalledInterval: 120000, // 2 minutes
    maxStalledCount: 1,
    stalledGracePeriod: 30000, // 30 seconds grace
  });

  spawnWorker.on('completed', (job) => {
    const taskId = job.data?.taskId;
    if (taskId) {
      localActiveTasks.delete(taskId);
    }
    logger.spawnQueue(`Job ${job.id} completed (task: ${taskId})`);
  });

  spawnWorker.on('failed', (job) => {
    const taskId = job.data?.taskId;
    if (taskId) {
      pendingSpawns.delete(taskId);
      localActiveTasks.delete(taskId);
    }
    logger.error('spawn-worker', `Spawn job ${job.id} failed: ${job.failedReason}`);
  });

  spawnWorker.on('stalled', (jobId, groupId) => {
    logger.warn('spawn-worker', `Spawn job ${jobId} stalled (group: ${groupId})`);
    // Clean up state for stalled jobs
    pendingSpawns.delete(groupId);
    localActiveTasks.delete(groupId);
  });

  spawnWorker.run().catch((err) => {
    logger.error('spawn-worker', 'Worker failed to start', err);
  });

  logger.system('Spawn worker started');
  return spawnWorker;
}

/**
 * Stop the spawn worker
 *
 * Waits for all spawn jobs (PM agents) to complete before returning.
 * This is key for graceful shutdown - ensures PMs finish cleanly.
 *
 * @param gracefulTimeoutMs - Maximum time to wait for jobs to complete
 */
export async function stopSpawnWorker(gracefulTimeoutMs: number = 3600000): Promise<void> {
  if (!spawnWorker) {
    return;
  }

  logger.spawnQueue(`Stopping (waiting up to ${gracefulTimeoutMs / 1000}s for ${localActiveTasks.size} jobs)`);

  // close() waits for current jobs to finish
  await spawnWorker.close(gracefulTimeoutMs);
  spawnWorker = null;

  logger.spawnQueue('Stopped');
}

/**
 * Get count of active spawn jobs
 */
export function getActiveSpawnJobCount(): number {
  return localActiveTasks.size;
}

/**
 * Get list of active task IDs
 */
export function getActiveSpawnTaskIds(): string[] {
  return Array.from(localActiveTasks);
}

// ============================================================================
// Job Handler
// ============================================================================

/**
 * Process a spawn job
 *
 * This job BLOCKS until the PM agent finishes (can be hours).
 * The blocking behavior acts as a distributed lock per task.
 *
 * Also handles reactivation of stopped/completed tasks.
 */
async function processSpawnJob(job: ReservedJob<SpawnJobData>): Promise<void> {
  const { taskId, reason } = job.data;

  logger.spawnQueue(`Processing task ${taskId} (reason: ${reason})`);

  // Transition: pending → active
  pendingSpawns.delete(taskId);
  localActiveTasks.add(taskId);

  try {
    // Load and verify task exists
    const metadata = await loadMetadata(taskId);
    if (!metadata) {
      throw new Error(`Task ${taskId} not found`);
    }

    // Ensure task status is in_progress
    await updateTaskStatus(taskId, 'in_progress');

    // Initialize runtime (creates queues, loads sessions)
    // This overwrites any stale runtime state
    await initializeTaskRuntime(taskId);

    // Start task (spawns PM agent, adds initial prompt based on reason)
    await startTask(taskId, reason);

    // Wait for task to complete (via completeTask or stopTask)
    const completionPromise = waitForTaskCompletion(taskId);
    if (completionPromise) {
      await completionPromise;
    }

  } finally {
    // Cleanup
    localActiveTasks.delete(taskId);

    logger.spawnQueue(`Task ${taskId} finished`);
  }
}

