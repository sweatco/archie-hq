/**
 * Redis Connection Management
 *
 * Singleton Redis connection with configuration required for GroupMQ.
 * Uses ioredis with maxRetriesPerRequest: null for blocking operations.
 */

import { Redis } from 'ioredis';
import { logger } from './logger.js';

// Redis configuration from environment
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const REDIS_USERNAME = process.env.REDIS_USERNAME || undefined;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const REDIS_TLS = process.env.REDIS_TLS === 'true' || process.env.NODE_ENV === 'production';

// Singleton Redis connection
let redisConnection: Redis | null = null;

/**
 * Get or create the Redis connection
 *
 * GroupMQ requires maxRetriesPerRequest: null for blocking operations.
 * This allows the client to wait indefinitely for queue operations.
 */
export function getRedisConnection(): Redis {
  if (!redisConnection) {
    const connection = new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      username: REDIS_USERNAME,
      password: REDIS_PASSWORD,
      tls: REDIS_TLS ? {} : undefined,
      maxRetriesPerRequest: null, // Required for GroupMQ blocking operations
      enableReadyCheck: true,
      retryStrategy: (times: number) => {
        // Exponential backoff with max 30 seconds
        const delay = Math.min(times * 1000, 30000);
        logger.system(`Redis connection retry in ${delay}ms (attempt ${times})`);
        return delay;
      },
    });

    connection.on('connect', () => {
      const protocol = REDIS_TLS ? 'rediss' : 'redis';
      logger.system(`Redis connected to ${protocol}://${REDIS_HOST}:${REDIS_PORT}`);
    });

    connection.on('error', (err: Error) => {
      logger.error('Redis', 'Connection error', err);
    });

    connection.on('close', () => {
      logger.system('Redis connection closed');
    });

    redisConnection = connection;
  }

  return redisConnection;
}

/**
 * Close the Redis connection
 *
 * Should be called during graceful shutdown.
 */
export async function closeRedisConnection(): Promise<void> {
  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = null;
    logger.system('Redis connection closed gracefully');
  }
}

/**
 * Check if Redis is connected and ready
 */
export function isRedisReady(): boolean {
  return redisConnection?.status === 'ready';
}
