import Redis from "ioredis";

type GlobalWithRedis = typeof globalThis & {
  __foundrRedis?: Redis;
};

/**
 * Returns the Redis key prefix ("test:" during automated tests, "" in dev/prod).
 */
export function getRedisKeyPrefix(): string {
  if (process.env.REDIS_KEY_PREFIX !== undefined) {
    return process.env.REDIS_KEY_PREFIX;
  }
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return "test:";
  }
  return "";
}

/**
 * Returns the process-wide shared TCP ioredis singleton.
 * Respects Redis Cloud free-tier limits (max 30 connections) by keeping 1 connection in the web process.
 */
export function getRedisConnection(): Redis {
  const g = globalThis as GlobalWithRedis;
  if (g.__foundrRedis) {
    return g.__foundrRedis;
  }

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl || redisUrl.trim().length === 0) {
    throw new Error("Fatal: REDIS_URL environment variable must be defined.");
  }

  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });

  client.on("error", (err) => {
    console.error("[Redis Error]:", err.message);
  });

  g.__foundrRedis = client;
  return client;
}

/**
 * Publishes a live funding progress payload to the Redis channel consumed by /worker SSE streams.
 */
export async function publishFundingUpdate(payload: {
  projectId: string;
  currentFunding: number;
  totalValuation: number;
  status: string;
  percentage: number;
}): Promise<void> {
  const redis = getRedisConnection();
  await redis.publish(
    `${getRedisKeyPrefix()}funding:${payload.projectId}`,
    JSON.stringify(payload),
  );
}
