/**
 * Redis client for phone-terminal backend.
 *
 * Security notes:
 * - Connection string from env only
 * - TLS supported via rediss:// URL scheme
 * - Connection string never logged
 */

import { Redis } from "ioredis";

let redis: Redis | null = null;

export function getRedis(redisUrl: string): Redis {
  if (!redis) {
    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy(times: number) {
        // Exponential backoff, max 5 seconds
        const delay = Math.min(times * 200, 5000);
        return delay;
      },
    });

    redis.on("error", (err: Error) => {
      console.error("[redis] Connection error:", err.message);
    });
  }
  return redis;
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}

export type { Redis as RedisClient };
